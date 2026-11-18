import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, lockAssetsInIdentifierOrder, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { outstandingLoanItemsOf } from './loan-read.service.ts';
import { underRepairOfAssets, type RepairKind } from './repair-read.service.ts';
import { currentRetirementsOf, type RetirementMethod } from './retirement-read.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
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
const normalizeRetirementDate = (value: string, today: string): string => {
  if (!isCalendarDate(value)) {
    throw new ValidationError('retirement_date must be a date (YYYY-MM-DD)');
  }
  if (value > today) {
    throw new ValidationError(`retirement_date must not be after today (${today}, Asia/Bangkok)`);
  }
  return value;
};

const normalizeReference = (value: string | null | undefined) => normalizeText(value, 'retirement_reference', DOCUMENT_REFERENCE_MAX_LENGTH, '');
const normalizeNote = (value: string | null | undefined) => normalizeText(value, 'note', REMARK_MAX_LENGTH, '');

const normalizeFacts = (input: RecordRetirementInput, today: string): RetirementFacts => ({
  retirement_date: normalizeRetirementDate(input.retirement_date, today),
  retirement_method: input.retirement_method,
  retirement_reference: normalizeReference(input.retirement_reference),
  note: normalizeNote(input.note),
});

// What an amendment may name (#154 Q9, P2): every field of a Retirement but its Asset.
export type RetirementAmendmentInput = Partial<RecordRetirementInput>;

export interface CorrectRetirementInput {
  expected_version: number;
  action: 'AMEND' | 'VOID';
  reason: string;
  changes?: RetirementAmendmentInput;
}

// What a Retirement Correction answers.
export interface RecordedRetirementCorrection extends RetirementVersion {
  correction_id: string;
}

// The fields a correction record keeps, in the order it lists them.
const CORRECTED_FIELDS = ['retirement_date', 'retirement_method', 'retirement_reference', 'note'] as const;
type CorrectedFieldName = (typeof CORRECTED_FIELDS)[number];

// One changed field, as the correction record keeps it.
interface CorrectedField {
  field: CorrectedFieldName;
  before: string | null;
  after: string | null;
}

// A correction request's facts once validated, before any lock. The retry fingerprint covers these.
interface CorrectionFacts {
  expected_version: number;
  action: 'AMEND' | 'VOID';
  reason: string;
  // The amended values, in CORRECTED_FIELDS order; null for a void.
  values: Partial<Record<CorrectedFieldName, string | null>> | null;
}

const normalizeCorrection = (input: CorrectRetirementInput, today: string): CorrectionFacts => {
  const reason = normalizeText(input.reason, 'reason', REMARK_MAX_LENGTH, '');
  if (reason === null) {
    throw new ValidationError('A correction needs a reason');
  }
  if (input.action === 'VOID') {
    if (input.changes !== undefined) {
      throw new ValidationError('A void changes no field: leave changes out');
    }
    return { expected_version: input.expected_version, action: 'VOID', reason, values: null };
  }
  const { retirement_date, retirement_method, retirement_reference, note } = input.changes ?? {};
  const values: Partial<Record<CorrectedFieldName, string | null>> = {};
  if (retirement_date !== undefined) {
    values.retirement_date = normalizeRetirementDate(retirement_date, today);
  }
  if (retirement_method !== undefined) {
    values.retirement_method = retirement_method;
  }
  if (retirement_reference !== undefined) {
    values.retirement_reference = normalizeReference(retirement_reference);
  }
  if (note !== undefined) {
    values.note = normalizeNote(note);
  }
  return { expected_version: input.expected_version, action: 'AMEND', reason, values };
};

// A Retirement as a correction reads it, under its Asset's lock.
interface StoredRetirement extends Record<CorrectedFieldName, string | null> {
  id: string;
  asset_id: string;
  is_voided: boolean;
  version: number;
}

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

  // Locks the Retirement's Asset exclusively, the lock recording a Retirement takes, then reads the Retirement
  // under it: its version must be the one the client read, and a voided one is corrected no more (#154 P2, Q24).
  // Every Retirement write takes that lock first, so it alone orders them.
  private async lockRetirementForCorrection(client: pg.PoolClient, retirementId: string, expectedVersion: number): Promise<StoredRetirement> {
    const found = await client.query('SELECT asset_id FROM retirements WHERE id = $1', [retirementId]);
    if (!found.rows[0]) {
      throw new NotFoundError('Retirement not found');
    }
    await lockAssetsInIdentifierOrder(client, [found.rows[0].asset_id]);
    const res = await client.query(
      `SELECT id, asset_id, to_char(retirement_date, 'YYYY-MM-DD') AS retirement_date, retirement_method, retirement_reference, note, is_voided, version
       FROM retirements WHERE id = $1`,
      [retirementId]
    );
    const retirement: StoredRetirement = res.rows[0];
    if (retirement.version !== expectedVersion) {
      throw new StaleBeforeConflictError('The Retirement changed since it was read', { version: retirement.version }, { version: expectedVersion });
    }
    if (retirement.is_voided) {
      throw new ValidationError('This Retirement is voided: it can no longer be corrected');
    }
    return retirement;
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

  /**
   * F007-T5 (#159): fixes a Retirement recorded wrong, with a reason (DR-12, #154 Q9, P2). An amendment leaves
   * the corrected values on the Retirement; a void keeps it, struck through, and the Asset is no longer
   * Retired. No other record changes, and no Asset goes back into a Verification Round (Q18).
   */
  async correct(actorId: string, retirementId: string, input: CorrectRetirementInput, { retryToken }: { retryToken: string }): Promise<RecordedRetirementCorrection> {
    const facts = normalizeCorrection(input, bangkokDate(this.clock()));
    return commitOnce(
      this.db,
      { actorId, operation: `retirement:correct:${retirementId}`, retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        const retirement = await this.lockRetirementForCorrection(client, retirementId, facts.expected_version);
        let changes: CorrectedField[] = [];
        if (facts.values) {
          changes = CORRECTED_FIELDS.filter((field) => field in facts.values! && facts.values![field] !== retirement[field]).map((field) => ({
            field,
            before: retirement[field],
            after: facts.values![field]!,
          }));
          if (changes.length === 0) {
            throw new ValidationError('This amendment changes nothing');
          }
          await client.query(
            `UPDATE retirements SET ${changes.map(({ field }, i) => `${field} = $${i + 2}`).join(', ')} WHERE id = $1`,
            [retirementId, ...changes.map(({ after }) => after)]
          );
        } else {
          await client.query('UPDATE retirements SET is_voided = true WHERE id = $1', [retirementId]);
        }
        const correction = await client.query(
          `INSERT INTO retirement_corrections (retirement_id, action, reason, changes, recorded_by)
           VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
          [retirementId, facts.values ? 'AMENDED' : 'VOIDED', facts.reason, JSON.stringify(changes), actorId]
        );
        const res = await client.query('UPDATE retirements SET version = version + 1 WHERE id = $1 RETURNING version', [retirementId]);
        return { retirement_id: retirementId, version: res.rows[0].version, correction_id: correction.rows[0].id };
      }
    );
  }
}
