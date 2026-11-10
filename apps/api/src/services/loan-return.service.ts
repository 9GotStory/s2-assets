import * as crypto from 'node:crypto';
import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import {
  CONDITION_NOTE_MAX_LENGTH,
  MAX_ASSETS,
  incrementLoanVersion,
  lockLoanForWrite,
  recordLoanReturns,
  type LoanCondition,
  type LoanItemOfLockedLoan,
  type LoanReturnFacts,
} from './loan.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

export interface LoanReturnItemInput {
  loan_item_id: string;
  condition: LoanCondition;
  condition_note?: string | null;
}

export interface RecordLoanReturnInput {
  expected_version: number;
  return_date: string;
  document_reference?: string | null;
  remark?: string | null;
  items: LoanReturnItemInput[];
}

// What a Loan Return answers. It carries no Borrower detail, as for starting a Loan (LR-15, #74 Q24).
export interface RecordedLoanReturn {
  loan_id: string;
  version: number;
  action_reference: string;
  items: { id: string; asset_id: string }[];
}

// A LoanItem that cannot take this Loan Return, and why.
export interface RefusedLoanItem {
  loan_item_id: string;
  asset_id: string | null;
  name: string | null;
  asset_number: string | null;
  reason: 'NOT_FOUND' | 'VOIDED' | 'ALREADY_RETURNED';
}

/** A Loan Return names items that cannot take one. Nothing is saved, and the answer names each one and why. */
export class LoanItemsNotReturnableError extends Error {
  statusCode = 409;
  code = 'LOAN_ITEMS_NOT_RETURNABLE';
  items: RefusedLoanItem[];

  constructor(items: RefusedLoanItem[]) {
    super(`These items cannot take a Loan Return: ${items.map(({ loan_item_id, name, asset_number }) => name ?? asset_number ?? loan_item_id).join(', ')}`);
    this.name = 'LoanItemsNotReturnableError';
    this.items = items;
  }
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface LoanReturnRequestFacts extends LoanReturnFacts {
  expected_version: number;
}

// The items of a request in LoanItem identifier order.
const normalizeItems = (items: LoanReturnItemInput[]): LoanReturnFacts['items'] => {
  if (items.length < 1 || items.length > MAX_ASSETS) {
    throw new ValidationError(`A Loan Return names 1 to ${MAX_ASSETS} items`);
  }
  if (items.some(({ loan_item_id }) => !isValidUuid(loan_item_id))) {
    throw new ValidationError('loan_item_id must be a valid UUID');
  }
  const normalized = items
    .map(({ loan_item_id, condition, condition_note }) => ({
      loan_item_id: loan_item_id.trim().toLowerCase(),
      condition,
      condition_note: normalizeText(condition_note, 'condition_note', CONDITION_NOTE_MAX_LENGTH, ''),
    }))
    .sort((a, b) => (a.loan_item_id < b.loan_item_id ? -1 : 1));
  if (new Set(normalized.map(({ loan_item_id }) => loan_item_id)).size !== normalized.length) {
    throw new ValidationError('A Loan Return names each item once');
  }
  return normalized;
};

// #74 Q3: dates compare as text, which YYYY-MM-DD keeps in calendar order.
const normalizeFacts = (input: RecordLoanReturnInput, today: string): LoanReturnRequestFacts => {
  if (!isCalendarDate(input.return_date)) {
    throw new ValidationError('return_date must be a date (YYYY-MM-DD)');
  }
  if (input.return_date > today) {
    throw new ValidationError(`return_date must not be after today (${today}, Asia/Bangkok)`);
  }
  return {
    expected_version: input.expected_version,
    return_date: input.return_date,
    document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
    remark: normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, ''),
    items: normalizeItems(input.items),
  };
};

// One item's refusal, as a list that is empty when the item can take this Loan Return.
const refusalsOfItem = (loanItemId: string, item: LoanItemOfLockedLoan | undefined): RefusedLoanItem[] => {
  if (!item) {
    return [{ loan_item_id: loanItemId, asset_id: null, name: null, asset_number: null, reason: 'NOT_FOUND' }];
  }
  const { asset_id, name, asset_number } = item;
  if (item.is_voided) {
    return [{ loan_item_id: loanItemId, asset_id, name, asset_number, reason: 'VOIDED' }];
  }
  // A Not Returned item that turns up takes its Loan Return (#74 Q21).
  return item.ending_kind === 'LOAN_RETURN' ? [{ loan_item_id: loanItemId, asset_id, name, asset_number, reason: 'ALREADY_RETURNED' }] : [];
};

/**
 * F004-T2 (#76): records that Assets came back from a Loan, some or all of them, an item closed as
 * Not Returned among them (F004-T5). A Loan Return writes
 * no assignment fact (MR-15, MR-16), and a Condition of ชำรุด records only that (#74 Q16).
 */
export class LoanReturnService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  async record(actorId: string, loanId: string, input: RecordLoanReturnInput, { retryToken }: { retryToken: string }): Promise<RecordedLoanReturn> {
    const facts = normalizeFacts(input, bangkokDate(this.clock()));
    return commitOnce(
      this.db,
      { actorId, operation: `loan:return:${loanId}`, retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        const { loan, items: loanItems } = await lockLoanForWrite(client, loanId, facts.expected_version);
        const itemById = new Map(loanItems.map((item) => [item.id, item]));
        const refused = facts.items.flatMap(({ loan_item_id }) => refusalsOfItem(loan_item_id, itemById.get(loan_item_id)));
        if (refused.length > 0) {
          throw new LoanItemsNotReturnableError(refused);
        }
        if (facts.return_date < loan.loan_date) {
          throw new ValidationError('return_date must not be before the Loan Date');
        }
        // An earlier date means the Not Returned was wrong, which a Loan Correction fixes (#74 Q21).
        const notReturnedLater = facts.items
          .map(({ loan_item_id }) => itemById.get(loan_item_id)!)
          .filter(({ not_returned_date: notReturnedDate }) => notReturnedDate !== null && facts.return_date < notReturnedDate);
        if (notReturnedLater.length > 0) {
          const names = notReturnedLater.map(({ name, asset_number, asset_id }) => name ?? asset_number ?? asset_id).join(', ');
          throw new ValidationError(`return_date must not be before the Not Returned date of ${names}`);
        }

        const actionReference = crypto.randomUUID();
        await recordLoanReturns(client, { facts, actionReference, actorId });
        return {
          loan_id: loanId,
          version: await incrementLoanVersion(client, loanId),
          action_reference: actionReference,
          items: facts.items.map(({ loan_item_id: id }) => ({ id, asset_id: itemById.get(id)!.asset_id })),
        };
      }
    );
  }
}
