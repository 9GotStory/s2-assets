import pg from 'pg';
import { REMARK_MAX_LENGTH, assignmentSearch, bangkokDate, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { findUnassignableEntry } from './reference.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

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

// The open Round a refusal names (#125 Q17).
export interface OpenVerificationRound {
  id: string;
  name: string;
  fiscal_year: number;
  start_date: string;
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

/** The open Round, or null when none is. */
export async function openVerificationRoundOf(client: pg.PoolClient | pg.Pool): Promise<OpenVerificationRound | null> {
  const res = await client.query(
    `SELECT id, name, fiscal_year, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM verification_rounds WHERE state = 'OPEN'`
  );
  return res.rows[0] ?? null;
}

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
 * Locations, with its Scope Snapshot. The reads are in verification-read.service.ts.
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
}
