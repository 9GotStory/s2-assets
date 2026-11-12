import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, lockAssetsInIdentifierOrder, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { hasStrictControlChars } from './control-characters.ts';
import { loanReturnsOf } from './loan-return-read.ts';
import { loansHoldingAssets } from './loan.service.ts';
import { underRepairOfAssets, type RepairKind, type RepairOutcomeValue, type RepairerKind, type UnderWarranty } from './repair-read.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

export const REPAIRER_NAME_MAX_LENGTH = 200;
export const SYMPTOM_OR_WORK_MAX_LENGTH = REMARK_MAX_LENGTH;
export const OUTCOME_NOTE_MAX_LENGTH = REMARK_MAX_LENGTH;

// Baht, not negative, with at most two decimals, within numeric(12, 2) (#98 Q8).
const COST_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;

export interface StartRepairInput {
  asset_id: string;
  repair_kind: RepairKind;
  start_date: string;
  repairer: { kind: RepairerKind; name?: string | null };
  symptom_or_work: string;
  under_warranty?: UnderWarranty;
  warranty_end_date?: string | null;
  cost?: string | null;
  document_reference?: string | null;
  remark?: string | null;
  // The Loan Return recorded ชำรุด that led to it, when there was one (F005-T5, LR-13, RM-08, #98 Q5).
  repair_source?: { loan_return_id: string } | null;
  // Work finished in one visit, or an old repair, is recorded with its outcome in one write (#98 Q1, Q22).
  outcome?: RepairOutcomeInput | null;
}

// How a Repair Record ended (#98 Q10, Q22). The record's one cost is not part of it.
export interface RepairOutcomeInput {
  outcome: RepairOutcomeValue;
  outcome_date: string;
  note?: string | null;
  document_reference?: string | null;
  next_recommended_maintenance_date?: string | null;
}

export interface RecordRepairOutcomeInput extends RepairOutcomeInput {
  expected_version: number;
  // The record's one cost once the outcome is recorded; left out, it stays as it is (#98 Q22).
  cost?: string | null;
}

// What a Repair write answers: the record it wrote and the version a later write must expect.
export interface RepairRecordVersion {
  repair_record_id: string;
  version: number;
}

// Why an Asset cannot be sent, naming the Loan or the Repair Record that keeps it (#98 Q3, Q15).
export type RepairStartRefusal = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'ON_LOAN' | 'NOT_RETURNED'; loan_id: string }
  | { reason: 'UNDER_REPAIR'; repair_record_id: string; repair_kind: RepairKind }
);

/** A Repair Start names an Asset that cannot be sent now. Nothing is saved, and the answer says why. */
export class RepairStartRefusedError extends Error {
  statusCode = 409;
  code = 'REPAIR_START_REFUSED';
  asset: RepairStartRefusal;

  constructor(asset: RepairStartRefusal) {
    super(`${asset.name ?? asset.asset_number ?? asset.asset_id} cannot be sent for repair or maintenance now: ${asset.reason}`);
    this.name = 'RepairStartRefusedError';
    this.asset = asset;
  }
}

/**
 * Why an Asset whose lock the caller holds cannot be Under Repair now: a Loan holds it, or another Repair
 * Record keeps it (#98 Q3, Q15). Null when it can. A Repair Start and voiding a Repair Outcome both ask.
 */
export async function underRepairRefusalOf(
  client: pg.PoolClient,
  asset: { asset_id: string; name: string | null; asset_number: string | null }
): Promise<RepairStartRefusal | null> {
  const held = (await loansHoldingAssets(client, [asset.asset_id])).get(asset.asset_id);
  if (held) {
    return { ...asset, ...held };
  }
  const repair = (await underRepairOfAssets(client, [asset.asset_id])).get(asset.asset_id);
  return repair ? { ...asset, reason: 'UNDER_REPAIR', repair_record_id: repair.repair_record_id, repair_kind: repair.repair_kind } : null;
}

// Why a Loan Return cannot be a Repair Source: it must be a non-voided Loan Return of a LoanItem of the
// same Asset, recorded ชำรุด (#98). An id that names no Loan Return, a Not Returned among them, is NOT_LOAN_RETURN.
export interface RepairSourceRefusal {
  loan_return_id: string;
  reason: 'NOT_LOAN_RETURN' | 'VOIDED' | 'OTHER_ASSET' | 'NOT_DAMAGED';
}

/** A Repair Start cites a Repair Source it cannot have. Nothing is saved, and the answer says why. */
export class RepairSourceRefusedError extends Error {
  statusCode = 409;
  code = 'REPAIR_SOURCE_REFUSED';
  repair_source: RepairSourceRefusal;

  constructor(repairSource: RepairSourceRefusal) {
    super(`The Loan Return cannot be the Repair Source: ${repairSource.reason}`);
    this.name = 'RepairSourceRefusedError';
    this.repair_source = repairSource;
  }
}

// Why a Repair Record cannot take a Repair Outcome.
export interface RepairOutcomeRefusal {
  repair_record_id: string;
  reason: 'VOIDED' | 'HAS_OUTCOME';
}

/** A Repair Outcome names a record that cannot take one. Nothing is saved, and the answer says why. */
export class RepairOutcomeRefusedError extends Error {
  statusCode = 409;
  code = 'REPAIR_OUTCOME_REFUSED';
  record: RepairOutcomeRefusal;

  constructor(record: RepairOutcomeRefusal) {
    super(`The Repair Record cannot take a Repair Outcome: ${record.reason}`);
    this.name = 'RepairOutcomeRefusedError';
    this.record = record;
  }
}

// A Repair Outcome's facts once validated.
interface RepairOutcomeFacts {
  outcome: RepairOutcomeValue;
  outcome_date: string;
  note: string | null;
  document_reference: string | null;
  next_recommended_maintenance_date: string | null;
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface RepairStartFacts {
  asset_id: string;
  repair_kind: RepairKind;
  start_date: string;
  repairer_kind: RepairerKind;
  repairer_name: string | null;
  symptom_or_work: string;
  under_warranty: UnderWarranty;
  warranty_end_date: string | null;
  cost: string | null;
  document_reference: string | null;
  remark: string | null;
  repair_source_loan_return_id: string | null;
  outcome: RepairOutcomeFacts | null;
}

// A cost is one line, so a control character is refused before trimming, even at its ends.
export const normalizeCost = (value: string | null | undefined): string | null => {
  if (hasStrictControlChars(value ?? '')) {
    throw new ValidationError('cost must not contain control characters');
  }
  const cost = value?.trim() ?? '';
  if (cost === '') {
    return null;
  }
  if (!COST_PATTERN.test(cost)) {
    throw new ValidationError('cost must be baht, not negative, with at most two decimals');
  }
  return cost;
};

// #98 Q4: an Outcome Date is not before its record's Start Date. Dates compare as text in YYYY-MM-DD.
const assertOutcomeNotBeforeStart = (outcomeDate: string, startDate: string): void => {
  if (outcomeDate < startDate) {
    throw new ValidationError('outcome_date must not be before the Start Date');
  }
};

// #98 Q4, Q7: the Outcome Date is no later than today, and a Next Recommended Maintenance Date is after it.
const normalizeOutcome = (input: RepairOutcomeInput, today: string): RepairOutcomeFacts => {
  if (!isCalendarDate(input.outcome_date)) {
    throw new ValidationError('outcome_date must be a date (YYYY-MM-DD)');
  }
  if (input.outcome_date > today) {
    throw new ValidationError(`outcome_date must not be after today (${today}, Asia/Bangkok)`);
  }
  const nextDate = input.next_recommended_maintenance_date ?? null;
  if (nextDate !== null && !isCalendarDate(nextDate)) {
    throw new ValidationError('next_recommended_maintenance_date must be a date (YYYY-MM-DD)');
  }
  if (nextDate !== null && nextDate <= input.outcome_date) {
    throw new ValidationError('next_recommended_maintenance_date must be after outcome_date');
  }
  return {
    outcome: input.outcome,
    outcome_date: input.outcome_date,
    note: normalizeText(input.note, 'note', OUTCOME_NOTE_MAX_LENGTH, ''),
    document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
    next_recommended_maintenance_date: nextDate,
  };
};

const normalizeFacts = (input: StartRepairInput, today: string): RepairStartFacts => {
  if (!isValidUuid(input.asset_id)) {
    throw new ValidationError('asset_id must be a valid UUID');
  }
  // #98 Q4: no lower bound, not even the Asset's registration. Dates compare as text in YYYY-MM-DD.
  if (!isCalendarDate(input.start_date)) {
    throw new ValidationError('start_date must be a date (YYYY-MM-DD)');
  }
  if (input.start_date > today) {
    throw new ValidationError(`start_date must not be after today (${today}, Asia/Bangkok)`);
  }
  const warrantyEndDate = input.warranty_end_date ?? null;
  if (warrantyEndDate !== null && !isCalendarDate(warrantyEndDate)) {
    throw new ValidationError('warranty_end_date must be a date (YYYY-MM-DD)');
  }
  const symptomOrWork = normalizeText(input.symptom_or_work, 'symptom_or_work', SYMPTOM_OR_WORK_MAX_LENGTH, '');
  if (symptomOrWork === null) {
    throw new ValidationError('symptom_or_work is required');
  }
  const sourceId = input.repair_source?.loan_return_id ?? null;
  if (sourceId !== null && !isValidUuid(sourceId)) {
    throw new ValidationError('repair_source.loan_return_id must be a valid UUID');
  }
  const outcome = input.outcome ? normalizeOutcome(input.outcome, today) : null;
  if (outcome) {
    assertOutcomeNotBeforeStart(outcome.outcome_date, input.start_date);
  }
  return {
    asset_id: input.asset_id.trim().toLowerCase(),
    repair_kind: input.repair_kind,
    start_date: input.start_date,
    repairer_kind: input.repairer.kind,
    repairer_name: normalizeLine(input.repairer.name, 'repairer.name', REPAIRER_NAME_MAX_LENGTH),
    symptom_or_work: symptomOrWork,
    under_warranty: input.under_warranty ?? 'UNSPECIFIED',
    warranty_end_date: warrantyEndDate,
    cost: normalizeCost(input.cost),
    document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
    remark: normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, ''),
    repair_source_loan_return_id: sourceId?.trim().toLowerCase() ?? null,
    outcome,
  };
};

/**
 * #98: a Repair Source is a non-voided Loan Return of a LoanItem of the same Asset, recorded ชำรุด. The
 * caller holds the Asset locked, as a Loan Correction voiding that Loan Return locks it, so the check
 * holds until commit.
 */
export async function assertRepairSource(client: pg.PoolClient, assetId: string, loanReturnId: string): Promise<void> {
  const cited = (await loanReturnsOf(client, [loanReturnId])).get(loanReturnId);
  const refuse = (reason: RepairSourceRefusal['reason']) => new RepairSourceRefusedError({ loan_return_id: loanReturnId, reason });
  if (!cited) {
    throw refuse('NOT_LOAN_RETURN');
  }
  if (cited.asset_id !== assetId) {
    throw refuse('OTHER_ASSET');
  }
  if (cited.is_voided) {
    throw refuse('VOIDED');
  }
  if (cited.condition !== 'DAMAGED') {
    throw refuse('NOT_DAMAGED');
  }
}

// What a write on an existing Repair Record reads of it, once locked.
export interface LockedRepairRecord {
  id: string;
  asset_id: string;
  start_date: string;
  cost: string | null;
  has_outcome: boolean;
  is_voided: boolean;
  // What a refusal names the Asset by.
  asset: { name: string | null; asset_number: string | null };
}

/**
 * The first steps of every write on an existing Repair Record (#98): it locks the record row, then its
 * Asset, the lock a Loan start takes, and refuses a client that read another version.
 */
export async function lockRepairRecordForWrite(client: pg.PoolClient, repairRecordId: string, expectedVersion: number): Promise<LockedRepairRecord> {
  const res = await client.query(
    `SELECT id, asset_id, to_char(start_date, 'YYYY-MM-DD') AS start_date, cost::text AS cost, has_outcome, is_voided, version
     FROM repair_records WHERE id = $1 FOR UPDATE`,
    [repairRecordId]
  );
  const record = res.rows[0];
  if (!record) {
    throw new NotFoundError('Repair Record not found');
  }
  const [{ name, asset_number }] = await lockAssetsInIdentifierOrder(client, [record.asset_id]);
  if (record.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Repair Record changed since it was read', { version: record.version }, { version: expectedVersion });
  }
  return { ...record, asset: { name, asset_number } };
}

// Records the outcome fact, which keeps the record's cost before this write set it (#98 Q22).
async function insertOutcome(
  client: pg.PoolClient,
  { repairRecordId, facts, costBefore, actorId }: { repairRecordId: string; facts: RepairOutcomeFacts; costBefore: string | null; actorId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO repair_outcomes (repair_record_id, outcome, outcome_date, note, document_reference, next_recommended_maintenance_date, cost_before, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [repairRecordId, facts.outcome, facts.outcome_date, facts.note, facts.document_reference, facts.next_recommended_maintenance_date, costBefore, actorId]
  );
}

// A Repair fact a Repair Correction names (#98 Q18): the record, or one of its Repair Outcomes.
export type RepairCorrectionTarget = { kind: 'REPAIR_RECORD' } | { kind: 'REPAIR_OUTCOME'; id: string };

// One field a correction changed, with its before and after, as the correction record keeps it.
export type CorrectedField = { field: string; before: string | null; after: string | null };

// The fields a correction compares and amends, by the names its record keeps, and each one's column.
const AMENDABLE_COLUMNS = {
  REPAIR_RECORD: {
    repair_kind: 'repair_kind',
    start_date: 'start_date',
    repairer_kind: 'repairer_kind',
    repairer_name: 'repairer_name',
    symptom_or_work: 'symptom_or_work',
    under_warranty: 'under_warranty',
    warranty_end_date: 'warranty_end_date',
    cost: 'cost',
    document_reference: 'document_reference',
    remark: 'remark',
    repair_source_loan_return_id: 'repair_source_loan_return_id',
  },
  REPAIR_OUTCOME: {
    outcome: 'outcome',
    outcome_date: 'outcome_date',
    note: 'note',
    document_reference: 'document_reference',
    next_recommended_maintenance_date: 'next_recommended_maintenance_date',
  },
} as const;

const TARGET_TABLES = { REPAIR_RECORD: 'repair_records', REPAIR_OUTCOME: 'repair_outcomes' } as const;

// The column of a correction record that names a fact of each kind.
const TARGET_COLUMNS = { REPAIR_RECORD: 'repair_record_id', REPAIR_OUTCOME: 'repair_outcome_id' } as const;

// A Repair fact as a correction finds it, under its record's lock: its amendable fields, by the names the
// correction record keeps. Dates read as YYYY-MM-DD and a cost as text with two decimals.
export interface StoredRepairFact {
  id: string;
  is_voided: boolean;
  fields: Record<string, string | null>;
}

/** A fact of a Repair Record whose row the caller holds locked, or null when the record has no such fact. */
export async function readStoredRepairFact(client: pg.PoolClient, repairRecordId: string, target: RepairCorrectionTarget): Promise<StoredRepairFact | null> {
  const res =
    target.kind === 'REPAIR_RECORD'
      ? await client.query(
          `SELECT id, is_voided, repair_kind, to_char(start_date, 'YYYY-MM-DD') AS start_date, repairer_kind, repairer_name, symptom_or_work,
                  under_warranty, to_char(warranty_end_date, 'YYYY-MM-DD') AS warranty_end_date, cost::text AS cost, document_reference, remark,
                  repair_source_loan_return_id
           FROM repair_records WHERE id = $1`,
          [repairRecordId]
        )
      : await client.query(
          `SELECT id, is_voided, outcome, to_char(outcome_date, 'YYYY-MM-DD') AS outcome_date, note, document_reference,
                  to_char(next_recommended_maintenance_date, 'YYYY-MM-DD') AS next_recommended_maintenance_date
           FROM repair_outcomes WHERE repair_record_id = $1 AND id = $2`,
          [repairRecordId, target.id]
        );
  if (res.rows.length === 0) {
    return null;
  }
  const { id, is_voided, ...fields } = res.rows[0];
  return { id, is_voided, fields };
}

/** Leaves the amended values on one fact, in the caller's transaction. `values` names fields as readStoredRepairFact does. */
export async function amendRepairFact(client: pg.PoolClient, target: RepairCorrectionTarget, factId: string, values: Record<string, string | null>): Promise<void> {
  const columns: Record<string, string> = AMENDABLE_COLUMNS[target.kind];
  const fields = Object.keys(values);
  if (fields.length === 0) {
    return;
  }
  const unknown = fields.find((field) => !Object.hasOwn(columns, field));
  if (unknown !== undefined) {
    throw new Error(`${unknown} is not an amendable field of a ${target.kind}`);
  }
  const assignments = fields.map((field, i) => `${columns[field]} = $${i + 2}`).join(', ');
  await client.query(`UPDATE ${TARGET_TABLES[target.kind]} SET ${assignments} WHERE id = $1`, [factId, ...fields.map((field) => values[field])]);
}

/**
 * Voids one fact, in the caller's transaction (#98 Q18), and returns what it changed besides voiding.
 * Voiding a record voids its Repair Outcome with it, which ends Under Repair when it had none. Voiding a
 * Repair Outcome puts the record back without one, so the Asset is Under Repair again, and restores the
 * cost the outcome replaced (#98 Q22); the cost it replaced is returned as the before.
 */
export async function voidRepairFact(client: pg.PoolClient, repairRecordId: string, target: RepairCorrectionTarget, fact: StoredRepairFact): Promise<CorrectedField[]> {
  if (target.kind === 'REPAIR_RECORD') {
    await client.query('UPDATE repair_outcomes SET is_voided = true WHERE repair_record_id = $1 AND NOT is_voided', [repairRecordId]);
    await client.query('UPDATE repair_records SET is_voided = true, has_outcome = false WHERE id = $1', [repairRecordId]);
    return [];
  }
  const current = await client.query('SELECT cost::text AS cost FROM repair_records WHERE id = $1', [repairRecordId]);
  const voided = await client.query('UPDATE repair_outcomes SET is_voided = true WHERE id = $1 RETURNING cost_before::text AS cost_before', [fact.id]);
  await client.query('UPDATE repair_records SET has_outcome = false, cost = $2 WHERE id = $1', [repairRecordId, voided.rows[0].cost_before]);
  const before: string | null = current.rows[0].cost;
  const after: string | null = voided.rows[0].cost_before;
  return before === after ? [] : [{ field: 'cost', before, after }];
}

// A date rule of a Repair Record that a correction would break (#98 Q4, Q7, Q18).
// A Next Recommended Maintenance Date after its Outcome Date is the constraint
// repair_outcomes_next_recommended_maintenance_date, so a correction checks it before it writes.
export type BrokenRepairDateRule = 'START_DATE_AFTER_TODAY' | 'OUTCOME_DATE_AFTER_TODAY' | 'OUTCOME_DATE_BEFORE_START_DATE';

/**
 * The date rules a Repair Record breaks as it now stands in the caller's transaction, with its non-voided
 * Repair Outcome: the Start Date and Outcome Date are no later than today, and the Outcome Date is not
 * before the Start Date.
 */
export async function brokenRepairDateRules(client: pg.PoolClient, repairRecordId: string, today: string): Promise<BrokenRepairDateRule[]> {
  const res = await client.query(
    `SELECT r.start_date > $2::date AS "START_DATE_AFTER_TODAY",
            coalesce(o.outcome_date > $2::date, false) AS "OUTCOME_DATE_AFTER_TODAY",
            coalesce(o.outcome_date < r.start_date, false) AS "OUTCOME_DATE_BEFORE_START_DATE"
     FROM repair_records r
     LEFT JOIN repair_outcomes o ON o.repair_record_id = r.id AND NOT o.is_voided
     WHERE r.id = $1`,
    [repairRecordId, today]
  );
  return Object.entries(res.rows[0]).flatMap(([rule, broken]) => (broken ? [rule as BrokenRepairDateRule] : []));
}

/** Keeps one Repair Correction record, in the caller's transaction, and returns its id. */
export async function recordRepairCorrection(
  client: pg.PoolClient,
  {
    target,
    factId,
    action,
    reason,
    changes,
    actorId,
  }: { target: RepairCorrectionTarget; factId: string; action: 'AMENDED' | 'VOIDED'; reason: string; changes: CorrectedField[]; actorId: string }
): Promise<string> {
  const res = await client.query(
    `INSERT INTO repair_corrections (${TARGET_COLUMNS[target.kind]}, action, reason, changes, recorded_by)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [factId, action, reason, JSON.stringify(changes), actorId]
  );
  return res.rows[0].id;
}

/** Increments a locked Repair Record's version, as every write on it does, and returns the new version. */
export async function incrementRepairVersion(client: pg.PoolClient, repairRecordId: string): Promise<number> {
  const res = await client.query('UPDATE repair_records SET version = version + 1 WHERE id = $1 RETURNING version', [repairRecordId]);
  return res.rows[0].version;
}

/**
 * F005-T1 (#99): sending one Asset for repair or maintenance; F005-T2 (#100): recording how it ended. A
 * Repair Record never touches an assignment fact (RM-05). The reads are in repair-read.service.ts.
 */
export class RepairService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Locks the Asset, the lock a Loan start takes, and refuses it while a Loan holds it or it is Under
  // Repair (RM-07, DR-16, #98 Q3, Q15). A Repair Start and a Loan start of one Asset therefore serialize.
  private async assertRepairMayStart(client: pg.PoolClient, assetId: string): Promise<void> {
    const [asset] = await lockAssetsInIdentifierOrder(client, [assetId]);
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }
    const refusal = await underRepairRefusalOf(client, { asset_id: assetId, name: asset.name, asset_number: asset.asset_number });
    if (refusal) {
      throw new RepairStartRefusedError(refusal);
    }
  }

  async start(actorId: string, input: StartRepairInput, { retryToken }: { retryToken: string }): Promise<RepairRecordVersion> {
    const { outcome, repair_source_loan_return_id: sourceId, ...facts } = normalizeFacts(input, bangkokDate(this.clock()));
    // A Repair Start without an outcome or a Repair Source keeps the fingerprint it had before either existed.
    const payload = { version: 1, ...facts, ...(outcome ? { outcome } : {}), ...(sourceId ? { repair_source_loan_return_id: sourceId } : {}) };
    return commitOnce(
      this.db,
      { actorId, operation: 'repair:start', retryToken, payload, explicitContinuation: false },
      async (client) => {
        await this.assertRepairMayStart(client, facts.asset_id);
        if (sourceId) {
          await assertRepairSource(client, facts.asset_id, sourceId);
        }
        const res = await client.query(
          `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, repairer_name, symptom_or_work, under_warranty,
                                       warranty_end_date, cost, document_reference, remark, repair_source_loan_return_id, has_outcome, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, version`,
          [
            facts.asset_id,
            facts.repair_kind,
            facts.start_date,
            facts.repairer_kind,
            facts.repairer_name,
            facts.symptom_or_work,
            facts.under_warranty,
            facts.warranty_end_date,
            facts.cost,
            facts.document_reference,
            facts.remark,
            sourceId,
            outcome !== null,
            actorId,
          ]
        );
        // One write, so the Asset is never Under Repair in between (#98 Q1). The outcome set no cost:
        // the record's cost is the one this write started it with.
        if (outcome) {
          await insertOutcome(client, { repairRecordId: res.rows[0].id, facts: outcome, costBefore: facts.cost, actorId });
        }
        return { repair_record_id: res.rows[0].id, version: res.rows[0].version };
      }
    );
  }

  /**
   * F005-T2 (#100): how a Repair Record ended. The Asset is no longer Under Repair; ซ่อมไม่ได้ does not
   * retire it (RM-11, DR-17). The record keeps one cost, which this write may change (#98 Q22).
   */
  async recordOutcome(
    actorId: string,
    repairRecordId: string,
    input: RecordRepairOutcomeInput,
    { retryToken }: { retryToken: string }
  ): Promise<RepairRecordVersion> {
    const today = bangkokDate(this.clock());
    const facts = {
      expected_version: input.expected_version,
      ...normalizeOutcome(input, today),
      ...(input.cost !== undefined ? { cost: normalizeCost(input.cost) } : {}),
    };
    return commitOnce(
      this.db,
      { actorId, operation: `repair:outcome:${repairRecordId}`, retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        const record = await lockRepairRecordForWrite(client, repairRecordId, facts.expected_version);
        if (record.is_voided || record.has_outcome) {
          throw new RepairOutcomeRefusedError({ repair_record_id: repairRecordId, reason: record.is_voided ? 'VOIDED' : 'HAS_OUTCOME' });
        }
        assertOutcomeNotBeforeStart(facts.outcome_date, record.start_date);

        await insertOutcome(client, { repairRecordId, facts, costBefore: record.cost, actorId });
        const res = await client.query(
          `UPDATE repair_records SET has_outcome = true, cost = $2, version = version + 1 WHERE id = $1 RETURNING version`,
          [repairRecordId, 'cost' in facts ? facts.cost : record.cost]
        );
        return { repair_record_id: repairRecordId, version: res.rows[0].version };
      }
    );
  }
}
