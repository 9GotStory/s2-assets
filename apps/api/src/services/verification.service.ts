import pg from 'pg';
import { assetExists } from './asset-lookups.ts';
import { REMARK_MAX_LENGTH, assignmentSearch, bangkokDate, isCalendarDate, normalizeLine, normalizeText, readAssignmentsAt } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { findUnassignableEntry } from './reference.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';
import {
  currentRevisionsOf,
  openVerificationRoundOf,
  recordingContextOf,
  type OpenVerificationRound,
  type RecordedResult,
  type VerificationCondition,
  type VerificationRevision,
} from './verification-read.service.ts';

export const ROUND_NAME_MAX_LENGTH = 200;
export const ROUND_NOTES_MAX_LENGTH = REMARK_MAX_LENGTH;
// How many entries one filter of a Round may name.
export const ROUND_FILTER_MAX_ENTRIES = 1000;

export interface OpenVerificationRoundInput {
  name: string;
  // A four-digit Buddhist-era year, a label only (#125 Q2).
  fiscal_year: number;
  notes?: string | null;
  // The Round covers only the Assets whose Current Assignment is in one of these, in each dimension named (Q3, P3).
  organization_unit_ids?: string[];
  location_ids?: string[];
}

// What a Round write answers: the Round it wrote and the version a later write must expect.
export interface VerificationRoundVersion {
  verification_round_id: string;
  version: number;
}

/** A Round cannot be opened while another is open. Nothing is saved, and the answer names the open one. */
export class AnotherVerificationRoundOpenError extends Error {
  statusCode = 409;
  code = 'ANOTHER_VERIFICATION_ROUND_OPEN';
  open_round: OpenVerificationRound;

  constructor(openRound: OpenVerificationRound) {
    super(`Another Verification Round is open: ${openRound.name}`);
    this.name = 'AnotherVerificationRoundOpenError';
    this.open_round = openRound;
  }
}

/** A Round whose filters match no Asset is not opened, and nothing is saved (#125 Q23). */
export class EmptyVerificationScopeError extends Error {
  statusCode = 409;
  code = 'EMPTY_VERIFICATION_SCOPE';

  constructor() {
    super('No registered Asset matches the filters of the Verification Round');
    this.name = 'EmptyVerificationScopeError';
  }
}

export const VERIFICATION_NOTE_MAX_LENGTH = REMARK_MAX_LENGTH;
// The reason of a Verification Correction (F006-T4).
export const VERIFICATION_CORRECTION_REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

// F006-T2 (#127): a first result for one Asset of the open Round (#125 Q6, Q7, Q8). F006-T3 (#128): where a
// Found Asset was seen and the Discrepancies Verification Staff tick.
export interface RecordVerificationInput {
  result: RecordedResult;
  // Required when Found and refused when Not Found (AV-05, AV-06).
  condition?: VerificationCondition | null;
  // When Found, an active Location Reference List entry, left out when it matched the register (AV-07, Q7).
  observed_location_id?: string | null;
  // When Found: "ป้าย/QR หายหรือชำรุด" (AR-14), and "ข้อมูลไม่ตรงทะเบียน" with its required note (AV-08).
  label_missing_or_damaged?: boolean;
  data_mismatch?: boolean;
  data_mismatch_note?: string | null;
  note?: string | null;
  // Today when left out (Q8).
  verification_date?: string | null;
  // F006-T4 (#129): a Re-verification names the current revision it saw; a first result names none (AV-23, Q20).
  expected_revision_id?: string | null;
}

// F006-T4 (#129): a Verification Correction voids the current revision the user saw, with a reason (#125 Q18).
export interface CorrectVerificationInput {
  verification_revision_id: string;
  reason: string;
}

// What a Verification Correction answers: its record and the scope entry's version after it.
export interface VerificationCorrectionVersion {
  verification_correction_id: string;
  version: number;
}

// F006-T5 (#130): a Late Addition adds one registered Asset to the open Round, with a reason (#125 Q11, AV-21).
export interface AddLateInput {
  asset_id: string;
  reason: string;
}

// The reason of a Late Addition.
export const LATE_ADDITION_REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

// What a Late Addition answers: the scope entry it added and the version a first result on it must expect.
export interface VerificationScopeEntryVersion {
  verification_scope_entry_id: string;
  version: number;
}

// What recording a result answers: its revision and the version a later write on the result must expect.
export interface VerificationRevisionVersion {
  verification_revision_id: string;
  revision_number: number;
  version: number;
}

/** A result for a Round that is not open is refused, and nothing is saved (#125 AV-17). */
export class VerificationRoundNotOpenError extends Error {
  statusCode = 409;
  code = 'VERIFICATION_ROUND_NOT_OPEN';

  constructor() {
    super('The Verification Round is not open');
    this.name = 'VerificationRoundNotOpenError';
  }
}

/** A result for an Asset outside the Round's Scope Snapshot is refused, and nothing is saved (#125 AV-18). */
export class AssetNotInVerificationScopeError extends Error {
  statusCode = 409;
  code = 'ASSET_NOT_IN_VERIFICATION_SCOPE';

  constructor() {
    super('The Asset is not in the Scope Snapshot of the Verification Round');
    this.name = 'AssetNotInVerificationScopeError';
  }
}

/** A Late Addition of an Asset already in the Round's Scope Snapshot is refused, and nothing is saved (#125 Q11). */
export class AssetAlreadyInVerificationScopeError extends Error {
  statusCode = 409;
  code = 'ASSET_ALREADY_IN_VERIFICATION_SCOPE';

  constructor() {
    super('The Asset is already in the Scope Snapshot of the Verification Round');
    this.name = 'AssetAlreadyInVerificationScopeError';
  }
}

/** A result write refused over the Asset's current result, naming it, or none while it is Not Yet Verified (#125 AV-23). */
export abstract class CurrentResultRefusal extends Error {
  statusCode = 409;
  abstract code: string;
  current: VerificationRevision | null;

  constructor(message: string, current: VerificationRevision | null) {
    super(message);
    this.current = current;
  }
}

/** A first result for an Asset that already has a current result is refused, naming it (#125 AV-23, Q20). */
export class AssetAlreadyVerifiedError extends CurrentResultRefusal {
  code = 'ASSET_ALREADY_VERIFIED';

  constructor(current: VerificationRevision) {
    super('The Asset already has a result in this Verification Round', current);
    this.name = 'AssetAlreadyVerifiedError';
  }
}

/**
 * A Re-verification or a Verification Correction whose seen revision is no longer the current one is refused,
 * naming the latest result, or none when the Asset is Not Yet Verified again (#125 AV-23, Q18, Q20).
 */
export class VerificationResultChangedError extends CurrentResultRefusal {
  code = 'VERIFICATION_RESULT_CHANGED';

  constructor(current: VerificationRevision | null) {
    super('The current result of the Asset has changed in this Verification Round', current);
    this.name = 'VerificationResultChangedError';
  }
}

/** A revision voided already is not voided again (#125 Q18). The answer names the latest result, or none. */
export class VerificationRevisionAlreadyVoidedError extends CurrentResultRefusal {
  code = 'VERIFICATION_REVISION_ALREADY_VOIDED';

  constructor(current: VerificationRevision | null) {
    super('The Verification Revision is voided already', current);
    this.name = 'VerificationRevisionAlreadyVoidedError';
  }
}

/** A Round, an Asset, or a revision of the Asset in the Round, that does not exist. */
export class VerificationTargetNotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';

  constructor(what: 'Verification Round' | 'Asset' | 'Verification Revision') {
    super(`${what} not found`);
    this.name = 'VerificationTargetNotFoundError';
  }
}

// A result's facts once validated. The retry fingerprint covers these, with the Round and the Asset.
interface ResultFacts {
  result: RecordedResult;
  condition: VerificationCondition | null;
  observed_location_id: string | null;
  label_missing_or_damaged: boolean;
  data_mismatch: boolean;
  data_mismatch_note: string | null;
  note: string | null;
  // Null for today: a replay on a later day still matches.
  verification_date: string | null;
  // Null for a first result.
  expected_revision_id: string | null;
}

const normalizeResult = (input: RecordVerificationInput, today: string): ResultFacts => {
  if (input.result !== 'FOUND' && input.result !== 'NOT_FOUND') {
    throw new ValidationError("result must be 'FOUND' or 'NOT_FOUND'");
  }
  const condition = input.condition ?? null;
  if (input.result === 'FOUND' && condition !== 'NORMAL' && condition !== 'DAMAGED') {
    throw new ValidationError("condition must be 'NORMAL' or 'DAMAGED' when the Asset is Found");
  }
  if (input.result === 'NOT_FOUND' && condition !== null) {
    throw new ValidationError('condition must not be given when the Asset is Not Found');
  }
  const observedLocationId = input.observed_location_id ?? null;
  if (observedLocationId !== null && !isValidUuid(observedLocationId)) {
    throw new ValidationError('observed_location_id must be a valid UUID');
  }
  const tickedDiscrepancies = { label_missing_or_damaged: input.label_missing_or_damaged ?? false, data_mismatch: input.data_mismatch ?? false };
  if (input.result === 'NOT_FOUND') {
    // An Asset not seen has no Observed Location and no Discrepancy to tick (#125 AV-07, AV-08).
    for (const [field, given] of [['observed_location_id', observedLocationId !== null], ...Object.entries(tickedDiscrepancies)] as const) {
      if (given) {
        throw new ValidationError(`${field} must not be given when the Asset is Not Found`);
      }
    }
  }
  const dataMismatchNote = normalizeText(input.data_mismatch_note, 'data_mismatch_note', VERIFICATION_NOTE_MAX_LENGTH, '');
  if (tickedDiscrepancies.data_mismatch && dataMismatchNote === null) {
    throw new ValidationError('data_mismatch_note is required when data_mismatch is ticked');
  }
  if (!tickedDiscrepancies.data_mismatch && dataMismatchNote !== null) {
    throw new ValidationError('data_mismatch_note must not be given unless data_mismatch is ticked');
  }
  const date = input.verification_date ?? null;
  if (date !== null && (typeof date !== 'string' || !isCalendarDate(date))) {
    throw new ValidationError('verification_date must be a date (YYYY-MM-DD)');
  }
  if (date !== null && date > today) {
    throw new ValidationError(`verification_date must not be after today (${today}, Asia/Bangkok)`);
  }
  const expectedRevisionId = input.expected_revision_id ?? null;
  if (expectedRevisionId !== null && !isValidUuid(expectedRevisionId)) {
    throw new ValidationError('expected_revision_id must be a valid UUID');
  }
  return {
    result: input.result,
    condition,
    observed_location_id: observedLocationId?.trim().toLowerCase() ?? null,
    ...tickedDiscrepancies,
    data_mismatch_note: dataMismatchNote,
    note: normalizeText(input.note, 'note', VERIFICATION_NOTE_MAX_LENGTH, ''),
    verification_date: date,
    expected_revision_id: expectedRevisionId?.trim().toLowerCase() ?? null,
  };
};

// A request's facts once validated. The retry fingerprint covers these.
interface OpeningFacts {
  name: string;
  fiscal_year: number;
  notes: string | null;
  organization_unit_ids: string[];
  location_ids: string[];
}

// The entries one filter names: UUIDs, each once, in a stable order so that a replay fingerprints alike.
const normalizeFilter = (ids: string[] | undefined, field: string): string[] => {
  if (ids === undefined) {
    return [];
  }
  if (ids.length > ROUND_FILTER_MAX_ENTRIES) {
    throw new ValidationError(`${field} must name at most ${ROUND_FILTER_MAX_ENTRIES} entries`);
  }
  for (const id of ids) {
    if (!isValidUuid(id)) {
      throw new ValidationError(`${field} must hold valid UUIDs`);
    }
  }
  return [...new Set(ids.map((id) => id.trim().toLowerCase()))].sort();
};

const normalizeOpening = (input: OpenVerificationRoundInput): OpeningFacts => {
  // A name is one line; notes, such as the committee members, are free text (#125 Q2).
  const name = normalizeLine(input.name, 'name', ROUND_NAME_MAX_LENGTH);
  if (name === null) {
    throw new ValidationError('name is required');
  }
  if (!Number.isInteger(input.fiscal_year) || input.fiscal_year < 1000 || input.fiscal_year > 9999) {
    throw new ValidationError('fiscal_year must be a four-digit Buddhist-era year');
  }
  return {
    name,
    fiscal_year: input.fiscal_year,
    notes: normalizeText(input.notes, 'notes', ROUND_NOTES_MAX_LENGTH, ''),
    organization_unit_ids: normalizeFilter(input.organization_unit_ids, 'organization_unit_ids'),
    location_ids: normalizeFilter(input.location_ids, 'location_ids'),
  };
};

// The two dimensions a Round filters by: each its request field and the column it fills (#125 Q3).
const FILTER_DIMENSIONS = [
  { field: 'organization_unit_ids', column: 'organization_unit_id' },
  { field: 'location_ids', column: 'location_id' },
] as const;

/**
 * Inserts a Round in the open state, or refuses while another is open, naming it (#125 Q17). The one-open-Round
 * index decides, between concurrent opens too: an insert meeting an uncommitted open Round waits for it and,
 * once that commits, fails; the savepoint keeps the transaction usable to read the Round that is open.
 */
async function insertOpenRound(client: pg.PoolClient, facts: OpeningFacts, startDate: string, actorId: string): Promise<VerificationRoundVersion> {
  await client.query('SAVEPOINT open_verification_round');
  try {
    const res = await client.query(
      `INSERT INTO verification_rounds (name, fiscal_year, start_date, notes, opened_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, version`,
      [facts.name, facts.fiscal_year, startDate, facts.notes, actorId]
    );
    await client.query('RELEASE SAVEPOINT open_verification_round');
    return { verification_round_id: res.rows[0].id, version: res.rows[0].version };
  } catch (err: any) {
    if (err?.code !== '23505' || err?.constraint !== 'verification_rounds_one_open') {
      throw err;
    }
    await client.query('ROLLBACK TO SAVEPOINT open_verification_round');
    const openRound = await openVerificationRoundOf(client);
    if (!openRound) {
      throw err;
    }
    throw new AnotherVerificationRoundOpenError(openRound);
  }
}

// What a scope entry snapshots of an Asset: its identity and its Current Assignment (#125 Q4).
const SNAPSHOT_COLUMNS = [
  'asset_number',
  'serial_number',
  'name',
  'category',
  'location_id',
  'legacy_location_text',
  'organization_unit_id',
  'legacy_organization_unit_text',
  'responsible_person_id',
  'legacy_responsible_person_text',
] as const;

// The registered Assets that pass `conditions`, as `s`, each with its id and its SNAPSHOT_COLUMNS now.
const currentAssetsWhere = (conditions: string[]) => `(
       SELECT a.id, a.asset_number, a.serial_number, a.name, a.category, ${assignmentSearch.columns}
       FROM assets a ${assignmentSearch.joins('a')}
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ) s`;

/**
 * Takes the Scope Snapshot of an opening Round: each registered Asset that passes its filters, with its
 * identity and Current Assignment now (#125 Q3, Q4, P3). Returns how many Assets joined.
 */
async function snapshotScope(client: pg.PoolClient, roundId: string, facts: OpeningFacts, actorId: string): Promise<number> {
  const params: unknown[] = [roundId, actorId];
  const conditions: string[] = [];
  for (const { field, column } of FILTER_DIMENSIONS) {
    if (facts[field].length > 0) {
      params.push(facts[field]);
      conditions.push(assignmentSearch.entryAmongFilter(column, `$${params.length}`));
    }
  }
  const res = await client.query(
    `INSERT INTO verification_scope_entries (verification_round_id, asset_id, joined_as, recorded_by, ${SNAPSHOT_COLUMNS.join(', ')})
     SELECT $1, s.id, 'OPENING', $2, ${SNAPSHOT_COLUMNS.map((column) => `s.${column}`).join(', ')}
     FROM ${currentAssetsWhere(conditions)}`,
    params
  );
  return res.rowCount ?? 0;
}

/**
 * Locks an open Round in share mode, so that results and Verification Corrections run beside each other and wait
 * for a write that changes the Round. Refuses a Round that is not there or not open (#125 AV-17).
 */
async function lockOpenRound(client: pg.PoolClient, roundId: string): Promise<{ start_date: string }> {
  const round = await client.query(`SELECT state, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM verification_rounds WHERE id = $1 FOR SHARE`, [roundId]);
  if (round.rows.length === 0) {
    throw new VerificationTargetNotFoundError('Verification Round');
  }
  if (round.rows[0].state !== 'OPEN') {
    throw new VerificationRoundNotOpenError();
  }
  return { start_date: round.rows[0].start_date };
}

/**
 * Locks an Asset's scope entry in a Round for update, after its Round, and reads its current result under the
 * lock: concurrent results and Verification Corrections of one Asset serialize, and the later finds the earlier.
 */
async function lockScopeEntry(client: pg.PoolClient, roundId: string, assetId: string): Promise<{ id: string; version: number; current: VerificationRevision | null }> {
  const scoped = await client.query('SELECT id FROM verification_scope_entries WHERE verification_round_id = $1 AND asset_id = $2', [roundId, assetId]);
  if (scoped.rows.length === 0) {
    throw (await assetExists(client, assetId)) ? new AssetNotInVerificationScopeError() : new VerificationTargetNotFoundError('Asset');
  }
  const id: string = scoped.rows[0].id;
  const entry = await client.query('SELECT version FROM verification_scope_entries WHERE id = $1 FOR UPDATE', [id]);
  return { id, version: entry.rows[0].version, current: (await currentRevisionsOf(client, [id])).get(id) ?? null };
}

// The scope entry's next version, written: every change of its current result moves it.
async function incrementEntryVersion(client: pg.PoolClient, entryId: string, version: number): Promise<number> {
  await client.query('UPDATE verification_scope_entries SET version = $2 WHERE id = $1', [entryId, version + 1]);
  return version + 1;
}

/**
 * F006-T1 (#126): opening a Verification Round over the whole register or chosen OrganizationUnits and
 * Locations, with its Scope Snapshot. F006-T2 (#127): recording an Asset's first result in the open Round.
 * F006-T4 (#129): a Re-verification, and a Verification Correction that voids the current result. F006-T5 (#130): a
 * Late Addition. The reads are in verification-read.service.ts.
 */
export class VerificationService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  async open(actorId: string, input: OpenVerificationRoundInput, { retryToken }: { retryToken: string }): Promise<VerificationRoundVersion> {
    const facts = normalizeOpening(input);
    const startDate = bangkokDate(this.clock());
    return commitOnce(
      this.db,
      { actorId, operation: 'verification:open', retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        // Each filter names an entry of its own list, active or not: Assets may still be assigned to a closed one.
        for (const { field, column } of FILTER_DIMENSIONS) {
          for (const id of facts[field]) {
            if ((await findUnassignableEntry(client, { [column]: id }, { allowInactive: true })) !== null) {
              throw new ValidationError(`${field} must name entries of its Reference List`);
            }
          }
        }

        const round = await insertOpenRound(client, facts, startDate, actorId);
        for (const { field, column } of FILTER_DIMENSIONS) {
          for (const id of facts[field]) {
            await client.query(`INSERT INTO verification_round_filters (verification_round_id, ${column}) VALUES ($1, $2)`, [round.verification_round_id, id]);
          }
        }
        if ((await snapshotScope(client, round.verification_round_id, facts, actorId)) === 0) {
          throw new EmptyVerificationScopeError();
        }
        await client.query(`INSERT INTO verification_round_events (verification_round_id, kind, recorded_by) VALUES ($1, 'OPENED', $2)`, [
          round.verification_round_id,
          actorId,
        ]);
        return round;
      }
    );
  }

  /**
   * Adds a registered Asset to the open Round as a Late Addition, with a reason, snapshotting its identity and
   * Current Assignment now (#125 AV-18, AV-21, Q11). The Round row is locked in share mode, as for a result, so a
   * write that changes the Round waits for it. The unique scope entry decides between concurrent additions of one
   * Asset: an insert meeting an uncommitted one waits for it and, once that commits, adds nothing and is refused.
   */
  async addLate(actorId: string, roundId: string, input: AddLateInput, { retryToken }: { retryToken: string }): Promise<VerificationScopeEntryVersion> {
    if (!isValidUuid(input.asset_id)) {
      throw new ValidationError('asset_id must be a valid UUID');
    }
    const assetId = input.asset_id.trim().toLowerCase();
    const reason = normalizeText(input.reason, 'reason', LATE_ADDITION_REASON_MAX_LENGTH, '');
    if (reason === null) {
      throw new ValidationError('A Late Addition needs a reason');
    }
    return commitOnce(
      this.db,
      { actorId, operation: 'verification:add-late', retryToken, payload: { version: 1, verification_round_id: roundId, asset_id: assetId, reason }, explicitContinuation: false },
      async (client) => {
        await lockOpenRound(client, roundId);
        if (!(await assetExists(client, assetId))) {
          throw new VerificationTargetNotFoundError('Asset');
        }
        const res = await client.query(
          `INSERT INTO verification_scope_entries (verification_round_id, asset_id, joined_as, reason, recorded_by, ${SNAPSHOT_COLUMNS.join(', ')})
           SELECT $1, s.id, 'LATE_ADDITION', $3, $4, ${SNAPSHOT_COLUMNS.map((column) => `s.${column}`).join(', ')}
           FROM ${currentAssetsWhere(['a.id = $2'])}
           ON CONFLICT (verification_round_id, asset_id) DO NOTHING
           RETURNING id, version`,
          [roundId, assetId, reason, actorId]
        );
        if (res.rows.length === 0) {
          throw new AssetAlreadyInVerificationScopeError();
        }
        return { verification_scope_entry_id: res.rows[0].id, version: res.rows[0].version };
      }
    );
  }

  /**
   * Records an Asset's first result in a Round (#125 AV-05, AV-06, AV-23), or a Re-verification over the current
   * revision it saw, which becomes the earlier revision and stays unchanged (F006-T4, AV-12, AV-13, Q20). The
   * Round row is locked in share mode, then the scope entry for update, so concurrent results for one Asset
   * serialize and the later one finds the earlier. The server derives the Permanent Assignment in effect on the Verification Date and
   * the Loan and Repair context in the same transaction; neither refuses a result, and nothing but the
   * revision and the entry's version is written (AV-09, AV-14).
   */
  async record(actorId: string, roundId: string, assetId: string, input: RecordVerificationInput, { retryToken }: { retryToken: string }): Promise<VerificationRevisionVersion> {
    const today = bangkokDate(this.clock());
    const { expected_revision_id: expectedRevisionId, ...facts } = normalizeResult(input, today);
    // A first result keeps the fingerprint it had before Re-verification existed, so its replay still matches.
    const payload = { version: 1, verification_round_id: roundId, asset_id: assetId, ...facts, ...(expectedRevisionId ? { expected_revision_id: expectedRevisionId } : {}) };
    return commitOnce(
      this.db,
      { actorId, operation: 'verification:record', retryToken, payload, explicitContinuation: false },
      async (client) => {
        const { start_date: startDate } = await lockOpenRound(client, roundId);
        const verificationDate = facts.verification_date ?? today;
        if (verificationDate < startDate) {
          throw new ValidationError(`verification_date must not be before the start date of the Verification Round (${startDate})`);
        }
        if (facts.observed_location_id !== null && (await findUnassignableEntry(client, { location_id: facts.observed_location_id })) !== null) {
          throw new ValidationError('observed_location_id must name an active entry of the Location Reference List');
        }

        const { id: entryId, version: entryVersion, current } = await lockScopeEntry(client, roundId, assetId);
        if (expectedRevisionId === null && current) {
          throw new AssetAlreadyVerifiedError(current);
        }
        if (expectedRevisionId !== null && current?.id !== expectedRevisionId) {
          throw new VerificationResultChangedError(current);
        }

        const inEffect = (await readAssignmentsAt(client, [assetId], verificationDate)).get(assetId)!;
        const { loan_context: loan, repair_context: repair } = await recordingContextOf(client, assetId);
        const revision = await client.query(
          `INSERT INTO verification_revisions
             (verification_scope_entry_id, revision_number, result, condition, observed_location_id,
              label_missing_or_damaged, data_mismatch, data_mismatch_note, note, verification_date,
              location_id, legacy_location_text, organization_unit_id, legacy_organization_unit_text,
              responsible_person_id, legacy_responsible_person_text,
              loan_context, loan_item_id, loan_borrower_display, loan_due_date, repair_record_id, repair_kind, recorded_by)
           SELECT $1, coalesce(max(revision_number), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                  $19, $20, $21, $22
           FROM verification_revisions WHERE verification_scope_entry_id = $1
           RETURNING id, revision_number`,
          [
            entryId,
            facts.result,
            facts.condition,
            facts.observed_location_id,
            facts.label_missing_or_damaged,
            facts.data_mismatch,
            facts.data_mismatch_note,
            facts.note,
            verificationDate,
            inEffect.location?.id ?? null,
            inEffect.legacy_location_text,
            inEffect.organization_unit?.id ?? null,
            inEffect.legacy_organization_unit_text,
            inEffect.responsible_person?.id ?? null,
            inEffect.legacy_responsible_person_text,
            loan?.kind ?? null,
            loan?.loan_item_id ?? null,
            loan?.borrower_display ?? null,
            loan?.due_date ?? null,
            repair?.repair_record_id ?? null,
            repair?.repair_kind ?? null,
            actorId,
          ]
        );
        const version = await incrementEntryVersion(client, entryId, entryVersion);
        return { verification_revision_id: revision.rows[0].id, revision_number: revision.rows[0].revision_number, version };
      }
    );
  }

  /**
   * Voids the current revision of an Asset in an open Round, with a reason (#125 Q18, AV-24). The revision stays,
   * voided, with its Verification Correction; the latest revision not voided becomes the current result again, or
   * the Asset is Not Yet Verified. It locks as a result does, so a void and a Re-verification of one Asset
   * serialize, and a void of a revision that is no longer current is refused, naming the latest result. A
   * Repair Record or Reassignment citing the revision is left as it is (P1).
   */
  async correct(actorId: string, roundId: string, assetId: string, input: CorrectVerificationInput, { retryToken }: { retryToken: string }): Promise<VerificationCorrectionVersion> {
    if (!isValidUuid(input.verification_revision_id)) {
      throw new ValidationError('verification_revision_id must be a valid UUID');
    }
    const revisionId = input.verification_revision_id.trim().toLowerCase();
    const reason = normalizeText(input.reason, 'reason', VERIFICATION_CORRECTION_REASON_MAX_LENGTH, '');
    if (reason === null) {
      throw new ValidationError('A Verification Correction needs a reason');
    }
    return commitOnce(
      this.db,
      {
        actorId,
        operation: 'verification:correct',
        retryToken,
        payload: { version: 1, verification_round_id: roundId, asset_id: assetId, verification_revision_id: revisionId, reason },
        explicitContinuation: false,
      },
      async (client) => {
        await lockOpenRound(client, roundId);
        const { id: entryId, version: entryVersion, current } = await lockScopeEntry(client, roundId, assetId);
        if (current?.id !== revisionId) {
          const target = await client.query('SELECT is_voided FROM verification_revisions WHERE id = $1 AND verification_scope_entry_id = $2', [revisionId, entryId]);
          if (target.rows.length === 0) {
            throw new VerificationTargetNotFoundError('Verification Revision');
          }
          throw target.rows[0].is_voided ? new VerificationRevisionAlreadyVoidedError(current) : new VerificationResultChangedError(current);
        }

        const correction = await client.query(`INSERT INTO verification_corrections (verification_revision_id, reason, recorded_by) VALUES ($1, $2, $3) RETURNING id`, [
          revisionId,
          reason,
          actorId,
        ]);
        await client.query('UPDATE verification_revisions SET is_voided = true WHERE id = $1', [revisionId]);
        return { verification_correction_id: correction.rows[0].id, version: await incrementEntryVersion(client, entryId, entryVersion) };
      }
    );
  }
}
