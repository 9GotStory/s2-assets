import * as crypto from 'node:crypto';
import pg from 'pg';
import { NotFoundError, StaleBeforeConflictError } from './asset.service.ts';
import { REMARK_MAX_LENGTH, isCalendarDate, lockAssetsInIdentifierOrder, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { MAX_ASSETS, assertOutstanding, incrementLoanVersion, lockLoan, readItemsOfLockedLoan, recordDueDateExtensions } from './loan.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

// A reason is free text, bounded as a correction's (MR-06).
const REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

export interface RecordDueDateExtensionInput {
  expected_version: number;
  new_due_date: string;
  reason?: string | null;
  items: { loan_item_id: string }[];
}

// What a Due Date Extension answers. It carries no Borrower detail, as for starting a Loan (LR-15, #74 Q24).
export interface RecordedDueDateExtension {
  loan_id: string;
  version: number;
  action_reference: string;
  items: { id: string; asset_id: string }[];
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface DueDateExtensionRequestFacts {
  expected_version: number;
  new_due_date: string;
  reason: string | null;
  loan_item_ids: string[];
}

// The items of a request in LoanItem identifier order.
const normalizeItemIds = (items: { loan_item_id: string }[]): string[] => {
  if (items.length < 1 || items.length > MAX_ASSETS) {
    throw new ValidationError(`A Due Date Extension names 1 to ${MAX_ASSETS} items`);
  }
  if (items.some(({ loan_item_id }) => !isValidUuid(loan_item_id))) {
    throw new ValidationError('loan_item_id must be a valid UUID');
  }
  const ids = items.map(({ loan_item_id }) => loan_item_id.trim().toLowerCase()).sort();
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('A Due Date Extension names each item once');
  }
  return ids;
};

const normalizeFacts = (input: RecordDueDateExtensionInput): DueDateExtensionRequestFacts => {
  if (!isCalendarDate(input.new_due_date)) {
    throw new ValidationError('new_due_date must be a date (YYYY-MM-DD)');
  }
  return {
    expected_version: input.expected_version,
    new_due_date: input.new_due_date,
    reason: normalizeText(input.reason, 'reason', REASON_MAX_LENGTH, ''),
    loan_item_ids: normalizeItemIds(input.items),
  };
};

/**
 * F004-T5 (#79): moves the Due Date of Outstanding items later ("เลื่อนกำหนดคืน"), keeping the date each
 * replaces. The new date may come after the Due Date has passed; moving one earlier is a Loan
 * Correction (#74 Q28). An item that has ended keeps its own Due Date (#74 Q6).
 */
export class DueDateExtensionService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  async record(actorId: string, loanId: string, input: RecordDueDateExtensionInput, { retryToken }: { retryToken: string }): Promise<RecordedDueDateExtension> {
    const facts = normalizeFacts(input);
    return commitOnce(
      this.db,
      { actorId, operation: `loan:due-date-extension:${loanId}`, retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        const loan = await lockLoan(client, loanId);
        if (!loan) {
          throw new NotFoundError('Loan not found');
        }
        const loanItems = await readItemsOfLockedLoan(client, loanId);
        await lockAssetsInIdentifierOrder(client, [...new Set(loanItems.map(({ asset_id }) => asset_id))]);
        if (loan.version !== facts.expected_version) {
          throw new StaleBeforeConflictError('The Loan changed since it was read', { version: loan.version }, { version: facts.expected_version });
        }

        assertOutstanding(facts.loan_item_ids, loanItems);
        const itemById = new Map(loanItems.map((item) => [item.id, item]));
        const named = facts.loan_item_ids.map((id) => itemById.get(id)!);
        const notLater = named.filter(({ due_date: dueDate }) => facts.new_due_date <= dueDate);
        if (notLater.length > 0) {
          const names = notLater.map(({ name, asset_number, asset_id }) => name ?? asset_number ?? asset_id).join(', ');
          throw new ValidationError(`new_due_date must be later than the current Due Date of ${names}`);
        }

        const actionReference = crypto.randomUUID();
        await recordDueDateExtensions(client, {
          facts: { new_due_date: facts.new_due_date, reason: facts.reason, items: named.map(({ id, due_date }) => ({ loan_item_id: id, prior_due_date: due_date })) },
          actionReference,
          actorId,
        });
        return {
          loan_id: loanId,
          version: await incrementLoanVersion(client, loanId),
          action_reference: actionReference,
          items: named.map(({ id, asset_id }) => ({ id, asset_id })),
        };
      }
    );
  }
}
