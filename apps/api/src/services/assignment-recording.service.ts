import * as crypto from 'node:crypto';
import pg from 'pg';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError, canonicalJson } from './asset.service.ts';
import {
  assertInitialAssignmentEntries,
  bangkokDate,
  normalizeInitialAssignment,
  normalizeReassignment,
  readAssignmentTimeline,
  readCurrentAssignment,
  recordInitialAssignment,
  recordReassignment,
  type AssignmentEvent,
  type CurrentAssignment,
  type InitialAssignmentInput,
} from './assignment.service.ts';
import { ValidationError } from './validation-error.ts';

export interface RecordAssignmentInput extends InitialAssignmentInput {
  kind: 'INITIAL' | 'REASSIGNMENT';
  expected_assignment_version: number;
}

export interface RecordedAssignment {
  event: AssignmentEvent;
  current_assignment: CurrentAssignment;
  assignment_version: number;
}

type Client = pg.PoolClient | pg.Pool;

/**
 * F003-T2 (#52): records one assignment fact for one Asset, an Initial Assignment or a Reassignment.
 * Each write locks the Asset, checks the client's expected assignment version and increments it, and
 * keeps Feature 002's retry-token contract: an identical replay returns the committed result, and a
 * changed payload under the same token is refused without writes.
 */
export class AssignmentRecordingService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Runs work in one transaction on one connection, rolling back on any error.
  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client: pg.PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Validates the request before any lock: its normalized facts, which the retry fingerprint covers,
  // and the write that records them.
  private prepare(
    actorId: string,
    assetId: string,
    input: RecordAssignmentInput,
    today: string
  ): { facts: unknown; write: (client: Client) => Promise<string> } {
    if (input.kind === 'INITIAL') {
      const facts = normalizeInitialAssignment(input, today);
      if (!facts) {
        throw new ValidationError('An Initial Assignment needs a Location, OrganizationUnit or Responsible Person value');
      }
      return {
        facts,
        write: async (client) => {
          await assertInitialAssignmentEntries(client, facts, today);
          return recordInitialAssignment(client, { assetId, actorId, facts });
        },
      };
    }
    const facts = normalizeReassignment(input, today);
    return { facts, write: (client) => recordReassignment(client, { assetId, actorId, facts, today }) };
  }

  async record(
    actorId: string,
    assetId: string,
    input: RecordAssignmentInput,
    { retryToken }: { retryToken: string }
  ): Promise<RecordedAssignment> {
    const { facts, write } = this.prepare(actorId, assetId, input, bangkokDate(this.clock()));
    const operation = `assignment:record:${assetId}`;
    const fingerprint = crypto
      .createHash('sha256')
      .update(canonicalJson({ version: 1, kind: input.kind, expected_assignment_version: input.expected_assignment_version, facts }))
      .digest('hex');

    return this.transaction(async (client) => {
      // Concurrent identical submissions wait here, then find the committed result.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`assignment_retry:${actorId}:${operation}:${retryToken}`]);
      const tokenRes = await client.query(
        `SELECT payload_fingerprint, response_body
         FROM registration_retry_tokens
         WHERE actor_id = $1 AND operation = $2 AND token = $3`,
        [actorId, operation, retryToken]
      );
      if (tokenRes.rows.length > 0) {
        if (tokenRes.rows[0].payload_fingerprint !== fingerprint) {
          throw new RetryTokenConflictError('Retry token reused with different payload is rejected without writes');
        }
        return tokenRes.rows[0].response_body as RecordedAssignment;
      }

      const assetRes = await client.query('SELECT assignment_version FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
      if (assetRes.rows.length === 0) {
        throw new NotFoundError('Asset not found');
      }
      const currentVersion: number = assetRes.rows[0].assignment_version;
      if (currentVersion !== input.expected_assignment_version) {
        throw new StaleBeforeConflictError(
          "The Asset's assignment changed since it was read",
          { assignment_version: currentVersion },
          { assignment_version: input.expected_assignment_version }
        );
      }

      const initialRes = await client.query(`SELECT 1 FROM assignment_events WHERE asset_id = $1 AND kind = 'INITIAL'`, [assetId]);
      const hasInitial = initialRes.rows.length > 0;
      if (input.kind === 'INITIAL' && hasInitial) {
        throw new ValidationError('This Asset already has an Initial Assignment; record a Reassignment instead');
      }
      if (input.kind === 'REASSIGNMENT' && !hasInitial) {
        throw new ValidationError('This Asset has no Initial Assignment yet; record one before a Reassignment');
      }

      const eventId = await write(client);
      const { current, version } = await readCurrentAssignment(client, assetId);
      const timeline = await readAssignmentTimeline(client, assetId);
      const result: RecordedAssignment = {
        event: timeline.find(({ id }) => id === eventId)!,
        current_assignment: current,
        assignment_version: version,
      };
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ($1, $2, $3, $4, 201, $5)`,
        [retryToken, actorId, operation, fingerprint, JSON.stringify(result)]
      );
      return result;
    });
  }
}
