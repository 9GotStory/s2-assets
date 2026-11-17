import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, lockAssetsInIdentifierOrder, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { outstandingLoanItemsOf } from './loan-read.service.ts';
import { underRepairOfAssets, type RepairKind } from './repair-read.service.ts';
import { currentRetirementsOf, type RetirementMethod } from './retirement-read.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

export interface RecordRetirementInput {
  retirement_date: string;
  retirement_method: RetirementMethod;
  retirement_reference?: string | null;
  note?: string | null;
}

// What a Retirement write answers: the Retirement it wrote and the version a later write must expect.
export interface RetirementVersion {
  retirement_id: string;
  version: number;
}

// Why an Asset cannot be retired now, naming what keeps it: its Retirement not voided (#154 P2), the
// Outstanding LoanItem and its Loan (DR-14), or the Repair Record that keeps it Under Repair (DR-15).
export type RetirementRefusal = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'ALREADY_RETIRED'; retirement_id: string }
  | { reason: 'ON_LOAN'; loan_item_id: string; loan_id: string }
  | { reason: 'UNDER_REPAIR'; repair_record_id: string; repair_kind: RepairKind }
);

/** A Retirement names an Asset that cannot be retired now. Nothing is saved, and the answer says why. */
export class RetirementRefusedError extends Error {
  statusCode = 409;
  code = 'RETIREMENT_REFUSED';
  asset: RetirementRefusal;

  constructor(asset: RetirementRefusal) {
    super(`${asset.name ?? asset.asset_number ?? asset.asset_id} cannot be retired now: ${asset.reason}`);
    this.name = 'RetirementRefusedError';
    this.asset = asset;
  }
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface RetirementFacts {
  retirement_date: string;
  retirement_method: RetirementMethod;
  retirement_reference: string | null;
  note: string | null;
}

// #154 Q4: a Thai calendar day no later than today, with no lower bound. Dates compare as text in YYYY-MM-DD.
const normalizeFacts = (input: RecordRetirementInput, today: string): RetirementFacts => {
  if (!isCalendarDate(input.retirement_date)) {
    throw new ValidationError('retirement_date must be a date (YYYY-MM-DD)');
  }
  if (input.retirement_date > today) {
    throw new ValidationError(`retirement_date must not be after today (${today}, Asia/Bangkok)`);
  }
  return {
    retirement_date: input.retirement_date,
    retirement_method: input.retirement_method,
    retirement_reference: normalizeText(input.retirement_reference, 'retirement_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', REMARK_MAX_LENGTH, ''),
  };
};

/**
 * F007-T1 (#155): recording that an Asset left use for good. A Retirement writes no Loan Return, Not
 * Returned ending, Repair Outcome or assignment fact, and deletes nothing (DR-01, DR-16). The reads are in
 * retirement-read.service.ts.
 */
export class RetirementService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Locks the Asset row exclusively, the lock a Loan start and a Repair Start take, and refuses it while it
  // is Retired, On Loan or Under Repair (#154 Q3, Q24). A Not Returned ending and a Repair Outcome
  // ซ่อมไม่ได้ keep it from neither (DR-16, DR-17).
  private async assertRetirementMayBeRecorded(client: pg.PoolClient, assetId: string): Promise<void> {
    const [asset] = await lockAssetsInIdentifierOrder(client, [assetId]);
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }
    const named = { asset_id: assetId, name: asset.name, asset_number: asset.asset_number };
    const current = (await currentRetirementsOf(client, [assetId])).get(assetId);
    if (current) {
      throw new RetirementRefusedError({ ...named, reason: 'ALREADY_RETIRED', retirement_id: current.id });
    }
    const outstanding = (await outstandingLoanItemsOf(client, [assetId])).get(assetId);
    if (outstanding) {
      throw new RetirementRefusedError({ ...named, reason: 'ON_LOAN', ...outstanding });
    }
    const repair = (await underRepairOfAssets(client, [assetId])).get(assetId);
    if (repair) {
      throw new RetirementRefusedError({ ...named, reason: 'UNDER_REPAIR', repair_record_id: repair.repair_record_id, repair_kind: repair.repair_kind });
    }
  }

  async record(actorId: string, assetId: string, input: RecordRetirementInput, { retryToken }: { retryToken: string }): Promise<RetirementVersion> {
    if (!isValidUuid(assetId)) {
      throw new ValidationError('The Asset id must be a valid UUID');
    }
    const id = assetId.trim().toLowerCase();
    const facts = normalizeFacts(input, bangkokDate(this.clock()));
    return commitOnce(
      this.db,
      { actorId, operation: `retirement:record:${id}`, retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        await this.assertRetirementMayBeRecorded(client, id);
        const res = await client.query(
          `INSERT INTO retirements (asset_id, retirement_date, retirement_method, retirement_reference, note, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, version`,
          [id, facts.retirement_date, facts.retirement_method, facts.retirement_reference, facts.note, actorId]
        );
        return { retirement_id: res.rows[0].id, version: res.rows[0].version };
      }
    );
  }
}
