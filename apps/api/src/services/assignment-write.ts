import * as crypto from 'node:crypto';
import pg from 'pg';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError, canonicalJson } from './asset.service.ts';
import { AssignmentConflictWarningError, newAssignmentConflicts } from './assignment-conflict.ts';
import {
  readAssignmentConflicts,
  readAssignmentTimeline,
  readCurrentAssignment,
  type AssignmentEvent,
  type CurrentAssignment,
} from './assignment.service.ts';

export interface RecordedAssignment {
  event: AssignmentEvent;
  current_assignment: CurrentAssignment;
  assignment_version: number;
}

export interface AssignmentWriteRequest {
  actorId: string;
  assetId: string;
  // Scopes the retry token, together with the actor.
  operation: string;
  retryToken: string;
  expectedVersion: number;
  // The normalized request, which the retry fingerprint covers.
  payload: unknown;
  // Whether the request confirms the Assignment Conflicts this write would create (#50 Q12).
  explicitContinuation: boolean;
  // Whether `write` records a new fact, whose id does not outlive a refusal.
  recordsNewFact: boolean;
}

/**
 * One write of an Asset's assignment facts, in one transaction, under the contract every such write
 * keeps. It locks the Asset, checks the client's expected assignment version and writes; `write`
 * returns the id of the event it wrote and increments the version. Feature 002's retry-token
 * contract holds: an identical replay returns the committed result, and a changed payload under the
 * same token is refused without writes. A write that would create new Assignment Conflicts is refused
 * with a warning unless the request confirms them, and the expected version ties that confirmation to
 * the timeline the user saw.
 */
export async function writeAssignmentOnce(
  db: pg.Pool | any,
  { actorId, assetId, operation, retryToken, expectedVersion, payload, explicitContinuation, recordsNewFact }: AssignmentWriteRequest,
  write: (client: pg.PoolClient) => Promise<string>
): Promise<RecordedAssignment> {
  const fingerprint = crypto.createHash('sha256').update(canonicalJson({ payload, explicit_continuation: explicitContinuation })).digest('hex');
  const client: pg.PoolClient = await db.connect();
  try {
    await client.query('BEGIN');
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
      await client.query('COMMIT');
      return tokenRes.rows[0].response_body as RecordedAssignment;
    }

    const assetRes = await client.query('SELECT assignment_version FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
    if (assetRes.rows.length === 0) {
      throw new NotFoundError('Asset not found');
    }
    const currentVersion: number = assetRes.rows[0].assignment_version;
    if (currentVersion !== expectedVersion) {
      throw new StaleBeforeConflictError(
        "The Asset's assignment changed since it was read",
        { assignment_version: currentVersion },
        { assignment_version: expectedVersion }
      );
    }

    const conflictsBefore = explicitContinuation ? [] : await readAssignmentConflicts(client, assetId);
    const eventId = await write(client);
    if (!explicitContinuation) {
      // The trial write lets the same reads decide; the refusal rolls it back, so nothing is saved.
      const created = newAssignmentConflicts(conflictsBefore, await readAssignmentConflicts(client, assetId));
      if (created.length > 0) {
        throw new AssignmentConflictWarningError(
          created.map((conflict) => (recordsNewFact && conflict.event_id === eventId ? { ...conflict, event_id: null } : conflict))
        );
      }
    }

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
