import * as crypto from 'node:crypto';
import pg from 'pg';
import { bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import {
  REASON_MAX_LENGTH,
  assertOutstanding,
  incrementLoanVersion,
  lockLoanForWrite,
  normalizeLoanItemIds,
  recordNotReturned,
  type NotReturnedFacts,
} from './loan.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

export interface RecordNotReturnedInput {
  expected_version: number;
  not_returned_date: string;
  reason: string;
  items: { loan_item_id: string }[];
}

// What a Not Returned answers. It carries no Borrower detail, as for starting a Loan (LR-15, #74 Q24).
export interface RecordedNotReturned {
  loan_id: string;
  version: number;
  action_reference: string;
  items: { id: string; asset_id: string }[];
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface NotReturnedRequestFacts extends NotReturnedFacts {
  expected_version: number;
}

// #74 Q21: dates compare as text, which YYYY-MM-DD keeps in calendar order.
const normalizeFacts = (input: RecordNotReturnedInput, today: string): NotReturnedRequestFacts => {
  if (!isCalendarDate(input.not_returned_date)) {
    throw new ValidationError('not_returned_date must be a date (YYYY-MM-DD)');
  }
  if (input.not_returned_date > today) {
    throw new ValidationError(`not_returned_date must not be after today (${today}, Asia/Bangkok)`);
  }
  const reason = normalizeText(input.reason, 'reason', REASON_MAX_LENGTH, '');
  if (reason === null) {
    throw new ValidationError('Not Returned needs a reason');
  }
  return {
    expected_version: input.expected_version,
    not_returned_date: input.not_returned_date,
    reason,
    loan_item_ids: normalizeLoanItemIds(input.items, 'Not Returned'),
  };
};

/**
 * F004-T5 (#79): closes Outstanding items whose Assets did not come back ("ปิดโดยไม่ได้รับคืน"). It is
 * not a Loan Return, and it leaves the Asset and its assignment as they are (#74 Q11, DR-03).
 */
export class NotReturnedService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  async record(actorId: string, loanId: string, input: RecordNotReturnedInput, { retryToken }: { retryToken: string }): Promise<RecordedNotReturned> {
    const facts = normalizeFacts(input, bangkokDate(this.clock()));
    return commitOnce(
      this.db,
      { actorId, operation: `loan:not-returned:${loanId}`, retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        const { loan, items: loanItems } = await lockLoanForWrite(client, loanId, facts.expected_version);
        assertOutstanding(facts.loan_item_ids, loanItems);
        if (facts.not_returned_date < loan.loan_date) {
          throw new ValidationError('not_returned_date must not be before the Loan Date');
        }

        const actionReference = crypto.randomUUID();
        await recordNotReturned(client, { facts, actionReference, actorId });
        const assetIdOf = new Map(loanItems.map(({ id, asset_id }) => [id, asset_id]));
        return {
          loan_id: loanId,
          version: await incrementLoanVersion(client, loanId),
          action_reference: actionReference,
          items: facts.loan_item_ids.map((id) => ({ id, asset_id: assetIdOf.get(id)! })),
        };
      }
    );
  }
}
