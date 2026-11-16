import pg from 'pg';
import { REMARK_MAX_LENGTH, normalizeText } from './assignment.service.ts';
import { commitOnce } from './retryable-write.ts';
import { StaleBeforeConflictError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';
import { roundCountsOf, type VerificationRoundState } from './verification-read.service.ts';
import {
  VerificationRoundNotOpenError,
  VerificationTargetNotFoundError,
  asTheOpenRound,
  checkFiscalYear,
  normalizeRoundName,
  normalizeRoundNotes,
  type VerificationRoundVersion,
} from './verification.service.ts';

// The reason of a Reopen or of voiding a Round (#125 Q25, Q28).
export const ROUND_REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

// Every write on an existing Round names the version the client read (#125 Concurrency).
export interface RoundVersionInput {
  expected_version: number;
}

export interface ReasonedRoundInput extends RoundVersionInput {
  reason: string;
}

// #125 Q27: an edit names only the fields it sets; notes may be cleared with null.
export interface EditVerificationRoundInput extends RoundVersionInput {
  name?: string;
  fiscal_year?: number;
  notes?: string | null;
}

/** A Reopen of a Round that is not closed is refused, and nothing is saved (#125 Q10). */
export class VerificationRoundNotClosedError extends Error {
  statusCode = 409;
  code = 'VERIFICATION_ROUND_NOT_CLOSED';

  constructor() {
    super('The Verification Round is not closed');
    this.name = 'VerificationRoundNotClosedError';
  }
}

/** A Round that holds a result is not voided, and nothing is saved (#125 Q28). */
export class VerificationRoundHasResultsError extends Error {
  statusCode = 409;
  code = 'VERIFICATION_ROUND_HAS_RESULTS';

  constructor() {
    super('The Verification Round holds a result that is not voided');
    this.name = 'VerificationRoundHasResultsError';
  }
}

// The Round fields an edit may change, in the order its event lists them (#125 Q27).
const EDITABLE_FIELDS = ['name', 'fiscal_year', 'notes'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
type RoundFields = { name: string; fiscal_year: number; notes: string | null };

interface LockedRound extends RoundFields {
  state: VerificationRoundState;
  version: number;
}

/**
 * Locks a Round for update, so that results, Verification Corrections and Late Additions, which lock it in share
 * mode, wait for this write, and it for them; then refuses a client that read another version (#125 Concurrency).
 */
async function lockRoundForWrite(client: pg.PoolClient, roundId: string, expectedVersion: number): Promise<LockedRound> {
  const res = await client.query('SELECT state, name, fiscal_year, notes, version FROM verification_rounds WHERE id = $1 FOR UPDATE', [roundId]);
  const round = res.rows[0];
  if (!round) {
    throw new VerificationTargetNotFoundError('Verification Round');
  }
  if (round.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Verification Round changed since it was read', { version: round.version }, { version: expectedVersion });
  }
  return round;
}

// Sets the Round's state and moves its version; answers the version a later write must expect.
async function setState(client: pg.PoolClient, roundId: string, state: VerificationRoundState): Promise<VerificationRoundVersion> {
  const res = await client.query('UPDATE verification_rounds SET state = $2, version = version + 1 WHERE id = $1 RETURNING version', [roundId, state]);
  return { verification_round_id: roundId, version: res.rows[0].version };
}

const normalizeReason = (reason: string, what: string): string => {
  const normalized = normalizeText(reason, 'reason', ROUND_REASON_MAX_LENGTH, '');
  if (normalized === null) {
    throw new ValidationError(`${what} needs a reason`);
  }
  return normalized;
};

// The fields an edit sets, validated as an opening validates them; a field left out is not in the result.
const normalizeEdit = (input: EditVerificationRoundInput): Partial<RoundFields> => ({
  ...(input.name !== undefined ? { name: normalizeRoundName(input.name) } : {}),
  ...(input.fiscal_year !== undefined ? { fiscal_year: checkFiscalYear(input.fiscal_year) } : {}),
  ...(input.notes !== undefined ? { notes: normalizeRoundNotes(input.notes) } : {}),
});

/**
 * F006-T6 (#131): closing, reopening, editing and voiding a Verification Round, each against the version the client
 * read, each adding an event to the Round's history (#125 AV-17, AV-22, AV-24, Q9, Q10, Q25, Q27, Q28, P4). Opening
 * is in verification.service.ts.
 */
export class VerificationRoundService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /**
   * Closes an open Round, with Assets Not Yet Verified left so, and stores its counts at that moment in the close
   * event (#125 AV-22, Q9, P4). It takes the Round lock that a result waits on, so a result either lands before the
   * close and is counted, or finds the Round closed and is refused.
   */
  async close(actorId: string, roundId: string, input: RoundVersionInput, { retryToken }: { retryToken: string }): Promise<VerificationRoundVersion> {
    return commitOnce(
      this.db,
      { actorId, operation: 'verification:close', retryToken, payload: { version: 1, verification_round_id: roundId, expected_version: input.expected_version }, explicitContinuation: false },
      async (client) => {
        const round = await lockRoundForWrite(client, roundId, input.expected_version);
        if (round.state !== 'OPEN') {
          throw new VerificationRoundNotOpenError();
        }
        const counts = await roundCountsOf(client, roundId);
        const closed = await setState(client, roundId, 'CLOSED');
        await client.query(
          `INSERT INTO verification_round_events (verification_round_id, kind, found_count, not_found_count, not_yet_verified_count, discrepancy_count, recorded_by)
           VALUES ($1, 'CLOSED', $2, $3, $4, $5, $6)`,
          [roundId, counts.found, counts.not_found, counts.not_yet_verified, counts.with_discrepancy, actorId]
        );
        return closed;
      }
    );
  }

  /**
   * Opens a Closed Round again, with a reason, its Scope Snapshot and results as they were (#125 Q10, Q25).
   * Refused while another Round is open, naming it: the one-open-Round index decides, as for an opening.
   */
  async reopen(actorId: string, roundId: string, input: ReasonedRoundInput, { retryToken }: { retryToken: string }): Promise<VerificationRoundVersion> {
    const reason = normalizeReason(input.reason, 'A Reopen');
    return commitOnce(
      this.db,
      {
        actorId,
        operation: 'verification:reopen',
        retryToken,
        payload: { version: 1, verification_round_id: roundId, expected_version: input.expected_version, reason },
        explicitContinuation: false,
      },
      async (client) => {
        const round = await lockRoundForWrite(client, roundId, input.expected_version);
        if (round.state !== 'CLOSED') {
          throw new VerificationRoundNotClosedError();
        }
        const reopened = await asTheOpenRound(client, () => setState(client, roundId, 'OPEN'));
        await client.query(`INSERT INTO verification_round_events (verification_round_id, kind, reason, recorded_by) VALUES ($1, 'REOPENED', $2, $3)`, [
          roundId,
          reason,
          actorId,
        ]);
        return reopened;
      }
    );
  }

  /**
   * Changes an open Round's name, fiscal year or notes, and lists each changed field before and after in the edit
   * event (#125 Q27). An edit must change something; the start date and the Scope Snapshot are never edited.
   */
  async edit(actorId: string, roundId: string, input: EditVerificationRoundInput, { retryToken }: { retryToken: string }): Promise<VerificationRoundVersion> {
    const fields = normalizeEdit(input);
    return commitOnce(
      this.db,
      { actorId, operation: 'verification:edit', retryToken, payload: { version: 1, verification_round_id: roundId, expected_version: input.expected_version, ...fields }, explicitContinuation: false },
      async (client) => {
        const round = await lockRoundForWrite(client, roundId, input.expected_version);
        if (round.state !== 'OPEN') {
          throw new VerificationRoundNotOpenError();
        }
        const changes = EDITABLE_FIELDS.filter((field: EditableField) => field in fields && fields[field] !== round[field]).map((field) => ({
          field,
          before: round[field],
          after: fields[field],
        }));
        if (changes.length === 0) {
          throw new ValidationError('This edit changes nothing');
        }
        const after: RoundFields = { name: round.name, fiscal_year: round.fiscal_year, notes: round.notes, ...fields };
        const res = await client.query('UPDATE verification_rounds SET name = $2, fiscal_year = $3, notes = $4, version = version + 1 WHERE id = $1 RETURNING version', [
          roundId,
          after.name,
          after.fiscal_year,
          after.notes,
        ]);
        await client.query(`INSERT INTO verification_round_events (verification_round_id, kind, changes, recorded_by) VALUES ($1, 'EDITED', $2, $3)`, [
          roundId,
          JSON.stringify(changes),
          actorId,
        ]);
        return { verification_round_id: roundId, version: res.rows[0].version };
      }
    );
  }

  /**
   * Voids an open Round that holds no result, with a reason: it stays listed as ยกเลิกแล้ว and takes nothing more
   * (#125 Q28). It takes the Round lock that a result waits on, so a result either lands first and the void is
   * refused, or finds the Round voided and is refused.
   */
  async void(actorId: string, roundId: string, input: ReasonedRoundInput, { retryToken }: { retryToken: string }): Promise<VerificationRoundVersion> {
    const reason = normalizeReason(input.reason, 'Voiding a Verification Round');
    return commitOnce(
      this.db,
      {
        actorId,
        operation: 'verification:void-round',
        retryToken,
        payload: { version: 1, verification_round_id: roundId, expected_version: input.expected_version, reason },
        explicitContinuation: false,
      },
      async (client) => {
        const round = await lockRoundForWrite(client, roundId, input.expected_version);
        if (round.state !== 'OPEN') {
          throw new VerificationRoundNotOpenError();
        }
        // A current result is a revision not voided, so a Round whose every revision is voided may be voided (Q28).
        const counts = await roundCountsOf(client, roundId);
        if (counts.found + counts.not_found > 0) {
          throw new VerificationRoundHasResultsError();
        }
        const voided = await setState(client, roundId, 'VOIDED');
        await client.query(`INSERT INTO verification_round_events (verification_round_id, kind, reason, recorded_by) VALUES ($1, 'VOIDED', $2, $3)`, [
          roundId,
          reason,
          actorId,
        ]);
        return voided;
      }
    );
  }
}
