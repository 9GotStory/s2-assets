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

// F006-T2 (#127): a first result for one Asset of the open Round (#125 Q6, Q7, Q8).
export interface RecordVerificationInput {
  result: RecordedResult;
  // Required when Found and refused when Not Found (AV-05, AV-06).
  condition?: VerificationCondition | null;
  note?: string | null;
  // Today when left out (Q8).
  verification_date?: string | null;
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

/** A first result for an Asset that already has a current result is refused, naming it (#125 AV-23, Q20). */
export class AssetAlreadyVerifiedError extends Error {
  statusCode = 409;
  code = 'ASSET_ALREADY_VERIFIED';
  current: VerificationRevision;

  constructor(current: VerificationRevision) {
    super('The Asset already has a result in this Verification Round');
    this.name = 'AssetAlreadyVerifiedError';
    this.current = current;
  }
}

/** A Round or an Asset that does not exist. */
export class VerificationTargetNotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';

  constructor(what: 'Verification Round' | 'Asset') {
    super(`${what} not found`);
    this.name = 'VerificationTargetNotFoundError';
  }
}

// A result's facts once validated. The retry fingerprint covers these, with the Round and the Asset.
interface ResultFacts {
  result: RecordedResult;
  condition: VerificationCondition | null;
  note: string | null;
  // Null for today: a replay on a later day still matches.
  verification_date: string | null;
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
  const date = input.verification_date ?? null;
  if (date !== null && (typeof date !== 'string' || !isCalendarDate(date))) {
    throw new ValidationError('verification_date must be a date (YYYY-MM-DD)');
  }
  if (date !== null && date > today) {
    throw new ValidationError(`verification_date must not be after today (${today}, Asia/Bangkok)`);
  }
  return { result: input.result, condition, note: normalizeText(input.note, 'note', VERIFICATION_NOTE_MAX_LENGTH, ''), verification_date: date };
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
    `INSERT INTO verification_scope_entries
       (verification_round_id, asset_id, joined_as, recorded_by, asset_number, serial_number, name, category,
        location_id, legacy_location_text, organization_unit_id, legacy_organization_unit_text,
        responsible_person_id, legacy_responsible_person_text)
     SELECT $1, s.id, 'OPENING', $2, s.asset_number, s.serial_number, s.name, s.category,
            s.location_id, s.legacy_location_text, s.organization_unit_id, s.legacy_organization_unit_text,
            s.responsible_person_id, s.legacy_responsible_person_text
     FROM (
       SELECT a.id, a.asset_number, a.serial_number, a.name, a.category, ${assignmentSearch.columns}
       FROM assets a ${assignmentSearch.joins('a')}
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ) s`,
    params
  );
  return res.rowCount ?? 0;
}

/**
 * F006-T1 (#126): opening a Verification Round over the whole register or chosen OrganizationUnits and
 * Locations, with its Scope Snapshot. F006-T2 (#127): recording an Asset's first result in the open Round.
 * The reads are in verification-read.service.ts.
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
   * Records an Asset's first result in a Round (#125 AV-05, AV-06, AV-23). The Round row is locked in share
   * mode, then the scope entry for update, so concurrent first results for one Asset serialize and the later
   * one finds the earlier. The server derives the Permanent Assignment in effect on the Verification Date and
   * the Loan and Repair context in the same transaction; neither refuses a result, and nothing but the
   * revision and the entry's version is written (AV-09, AV-14).
   */
  async record(actorId: string, roundId: string, assetId: string, input: RecordVerificationInput, { retryToken }: { retryToken: string }): Promise<VerificationRevisionVersion> {
    const today = bangkokDate(this.clock());
    const facts = normalizeResult(input, today);
    return commitOnce(
      this.db,
      { actorId, operation: 'verification:record', retryToken, payload: { version: 1, verification_round_id: roundId, asset_id: assetId, ...facts }, explicitContinuation: false },
      async (client) => {
        const round = await client.query(`SELECT state, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM verification_rounds WHERE id = $1 FOR SHARE`, [roundId]);
        if (round.rows.length === 0) {
          throw new VerificationTargetNotFoundError('Verification Round');
        }
        if (round.rows[0].state !== 'OPEN') {
          throw new VerificationRoundNotOpenError();
        }
        const verificationDate = facts.verification_date ?? today;
        if (verificationDate < round.rows[0].start_date) {
          throw new ValidationError(`verification_date must not be before the start date of the Verification Round (${round.rows[0].start_date})`);
        }

        const scoped = await client.query('SELECT id FROM verification_scope_entries WHERE verification_round_id = $1 AND asset_id = $2', [roundId, assetId]);
        if (scoped.rows.length === 0) {
          throw (await assetExists(client, assetId)) ? new AssetNotInVerificationScopeError() : new VerificationTargetNotFoundError('Asset');
        }
        const entryId: string = scoped.rows[0].id;
        const entry = await client.query('SELECT version FROM verification_scope_entries WHERE id = $1 FOR UPDATE', [entryId]);
        const current = (await currentRevisionsOf(client, [entryId])).get(entryId);
        if (current) {
          throw new AssetAlreadyVerifiedError(current);
        }

        const inEffect = (await readAssignmentsAt(client, [assetId], verificationDate)).get(assetId)!;
        const { loan_context: loan, repair_context: repair } = await recordingContextOf(client, assetId);
        const revision = await client.query(
          `INSERT INTO verification_revisions
             (verification_scope_entry_id, revision_number, result, condition, note, verification_date,
              location_id, legacy_location_text, organization_unit_id, legacy_organization_unit_text,
              responsible_person_id, legacy_responsible_person_text,
              loan_context, loan_item_id, loan_borrower_display, loan_due_date, repair_record_id, repair_kind, recorded_by)
           SELECT $1, coalesce(max(revision_number), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
           FROM verification_revisions WHERE verification_scope_entry_id = $1
           RETURNING id, revision_number`,
          [
            entryId,
            facts.result,
            facts.condition,
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
        const version = entry.rows[0].version + 1;
        await client.query('UPDATE verification_scope_entries SET version = $2 WHERE id = $1', [entryId, version]);
        return { verification_revision_id: revision.rows[0].id, revision_number: revision.rows[0].revision_number, version };
      }
    );
  }
}
