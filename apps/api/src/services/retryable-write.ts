import * as crypto from 'node:crypto';
import pg from 'pg';
import { canonicalJson } from './canonical-json.ts';
import { RetryTokenConflictError } from './service-errors.ts';

// What makes one write retryable: who asked, for which operation, under which token, and the request
// itself. A confirmation is part of the request.
export interface RetryableWrite {
  actorId: string;
  // Scopes the retry token, together with the actor.
  operation: string;
  retryToken: string;
  // The normalized request, which the retry fingerprint covers.
  payload: unknown;
  // Whether the request confirms the conflicts it would create (#50 Q12).
  explicitContinuation: boolean;
}

// Ends a transaction that will not be kept. A connection already closed has nothing to roll back.
export async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // ignore rollback error on closed connection
  }
}

/**
 * One transaction under Feature 002's retry-token contract. `work` runs at most once per token: an
 * identical replay returns the committed result, and a changed payload under the same token is
 * refused without writes. A refusal `work` throws rolls everything back and stores nothing, so the
 * same token can then carry the confirmed request.
 */
export async function commitOnce<Result>(
  db: pg.Pool | any,
  { actorId, operation, retryToken, payload, explicitContinuation }: RetryableWrite,
  work: (client: pg.PoolClient) => Promise<Result>
): Promise<Result> {
  // An unconfirmed request keeps the fingerprint it had before confirmation existed, so its replay still matches.
  const fingerprint = crypto.createHash('sha256').update(canonicalJson(explicitContinuation ? { payload, explicit_continuation: true } : payload)).digest('hex');
  const client: pg.PoolClient = await db.connect();
  try {
    await client.query('BEGIN');
    // Concurrent identical submissions wait here, then find the committed result.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`retryable_write:${actorId}:${operation}:${retryToken}`]);
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
      return tokenRes.rows[0].response_body as Result;
    }

    const result = await work(client);
    await client.query(
      `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
       VALUES ($1, $2, $3, $4, 201, $5)`,
      [retryToken, actorId, operation, fingerprint, JSON.stringify(result)]
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  } finally {
    client.release();
  }
}
