import * as crypto from 'node:crypto';

export interface Session {
  id: string; // SHA-256 digest in hex (64 chars)
  user_id: string; // UUID foreign key
  expires_at: Date;
  created_at: Date;
}

export interface SessionResult {
  token: string; // The raw opaque token (never stored in DB!)
  rawToken: string; // Alias for token
  session: Session;
}

export interface DatabaseClient {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface SessionServiceOptions {
  db?: DatabaseClient | any;
  ttlMs?: number;
}

export const SESSION_TTL_HOURS = 8;
export const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000; // 28,800,000 ms (8 hours)
export const RAW_TOKEN_BYTES = 32;

/**
 * Base64URL string pattern for 32-byte tokens.
 * 32 bytes encoded in Base64URL produces exactly 43 URL-safe characters without padding.
 */
export const BASE64URL_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

/**
 * SHA-256 hex digest pattern: 64 hexadecimal characters.
 */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Generates a cryptographically secure, opaque 32-byte session token using Base64URL encoding.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

export const generateToken = generateSessionToken;

/**
 * Validates whether the token is a valid 32-byte Base64URL token string.
 */
export function isValidRawToken(token: unknown): token is string {
  if (typeof token !== 'string' || token.length !== 43) {
    return false;
  }
  return BASE64URL_TOKEN_REGEX.test(token);
}

export const isSessionToken = isValidRawToken;

/**
 * Computes the SHA-256 digest (hex format) of a raw session token.
 */
export function hashToken(rawToken: string): string {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new Error('Token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export const deriveDigest = hashToken;
export const digestToken = hashToken;

/**
 * Service managing secure session lifecycle, SHA-256 digest persistence,
 * server-enforced rolling 8-hour expiration, and immediate revocation.
 */
export class SessionService {
  private db?: any;
  private defaultTtlMs: number;

  constructor(options?: SessionServiceOptions | DatabaseClient | any) {
    if (options && typeof options === 'object') {
      if ('query' in options || 'selectFrom' in options) {
        this.db = options;
      } else if ('db' in options && options.db) {
        this.db = options.db;
      }
    }
    this.defaultTtlMs =
      options && typeof options === 'object' && typeof (options as any).ttlMs === 'number'
        ? (options as any).ttlMs
        : SESSION_TTL_MS;
  }

  static generateToken = generateSessionToken;
  static generateSessionToken = generateSessionToken;
  static isValidRawToken = isValidRawToken;
  static isSessionToken = isValidRawToken;
  static hashToken = hashToken;
  static deriveDigest = deriveDigest;
  static digestToken = digestToken;
  static SESSION_TTL_MS = SESSION_TTL_MS;
  static SESSION_TTL_HOURS = SESSION_TTL_HOURS;
  static RAW_TOKEN_BYTES = RAW_TOKEN_BYTES;

  generateToken(): string {
    return generateSessionToken();
  }

  generateSessionToken(): string {
    return generateSessionToken();
  }

  isValidRawToken(token: unknown): token is string {
    return isValidRawToken(token);
  }

  hashToken(rawToken: string): string {
    return hashToken(rawToken);
  }

  deriveDigest(rawToken: string): string {
    return deriveDigest(rawToken);
  }

  /**
   * Creates a new session for the given user:
   * - Generates a raw opaque 32-byte Base64URL token.
   * - Derives the SHA-256 digest.
   * - Persists ONLY the digest in sessions.id with user_id and expires_at.
   * - Returns the raw token only to the caller (never persisted).
   */
  async createSession(
    userIdOrOptions: string | { userId: string; ttlMs?: number; expiresAt?: Date },
    options?: { ttlMs?: number; expiresAt?: Date }
  ): Promise<SessionResult> {
    let userId: string;
    let ttlMs = this.defaultTtlMs;
    let expiresAt: Date | undefined;

    if (typeof userIdOrOptions === 'string') {
      userId = userIdOrOptions;
      if (options?.ttlMs !== undefined) ttlMs = options.ttlMs;
      if (options?.expiresAt !== undefined) expiresAt = options.expiresAt;
    } else if (userIdOrOptions && typeof userIdOrOptions === 'object') {
      userId = userIdOrOptions.userId;
      if (userIdOrOptions.ttlMs !== undefined) ttlMs = userIdOrOptions.ttlMs;
      else if (options?.ttlMs !== undefined) ttlMs = options.ttlMs;
      if (userIdOrOptions.expiresAt !== undefined) expiresAt = userIdOrOptions.expiresAt;
      else if (options?.expiresAt !== undefined) expiresAt = options.expiresAt;
    } else {
      throw new Error('User ID must be a non-empty string');
    }

    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('User ID must be a non-empty string');
    }

    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    const rawToken = generateSessionToken();
    const digest = hashToken(rawToken);
    const finalExpiresAt = expiresAt ?? new Date(Date.now() + ttlMs);

    try {
      if (typeof client.insertInto === 'function') {
        const row = await client
          .insertInto('sessions')
          .values({
            id: digest,
            user_id: userId,
            expires_at: finalExpiresAt,
          })
          .returning(['id', 'user_id', 'expires_at', 'created_at'])
          .executeTakeFirstOrThrow();

        return {
          token: rawToken,
          rawToken,
          session: {
            id: row.id,
            user_id: row.user_id,
            expires_at: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
            created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
          },
        };
      }

      if (typeof client.query === 'function') {
        const result = await client.query(
          `INSERT INTO sessions (id, user_id, expires_at, created_at)
           VALUES ($1, $2, $3, NOW())
           RETURNING id, user_id, expires_at, created_at`,
          [digest, userId, finalExpiresAt]
        );
        const row = result.rows[0];
        return {
          token: rawToken,
          rawToken,
          session: {
            id: row.id,
            user_id: row.user_id,
            expires_at: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
            created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
          },
        };
      }

      throw new Error('Unsupported database client interface');
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Database client is not configured') ||
          err.message.includes('Unsupported database client interface'))
      ) {
        throw err;
      }
      throw new Error('Failed to create session');
    }
  }

  /**
   * Looks up a session by raw token.
   * Derives SHA-256 digest to query the database.
   * Strictly rejects missing, malformed, nonexistent, or expired tokens.
   */
  async lookupSession(
    rawToken: string,
    options?: { rolling?: boolean; ttlMs?: number }
  ): Promise<Session | null> {
    if (!isValidRawToken(rawToken)) {
      return null;
    }

    const digest = hashToken(rawToken);
    return this.lookupByDigest(digest, options);
  }

  async getSession(rawToken: string): Promise<Session | null> {
    return this.lookupSession(rawToken, { rolling: false });
  }

  async findByToken(rawToken: string): Promise<Session | null> {
    return this.lookupSession(rawToken, { rolling: false });
  }

  async findByDigest(digest: string): Promise<Session | null> {
    return this.lookupByDigest(digest, { rolling: false });
  }

  /**
   * Looks up session by its SHA-256 digest.
   * Strictly rejects expired sessions (server-side enforcement).
   * Supports rolling expiration extension if options.rolling is true.
   */
  async lookupByDigest(
    digest: string,
    options?: { rolling?: boolean; ttlMs?: number }
  ): Promise<Session | null> {
    if (!digest || typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) {
      return null;
    }

    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    try {
      let row: any = null;

      if (typeof client.selectFrom === 'function') {
        row = await client
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', digest)
          .executeTakeFirst();
      } else if (typeof client.query === 'function') {
        const result = await client.query(
          'SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = $1 LIMIT 1',
          [digest]
        );
        row = result.rows[0] ?? null;
      } else {
        throw new Error('Unsupported database client interface');
      }

      if (!row) {
        return null;
      }

      const expiresAtDate = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
      const expiresAtTime = expiresAtDate.getTime();

      if (isNaN(expiresAtTime) || expiresAtTime <= Date.now()) {
        // Expired session: strictly reject
        return null;
      }

      // If rolling expiration requested, extend the session
      if (options?.rolling) {
        const ttlMs = options.ttlMs ?? this.defaultTtlMs;
        const newExpiresAt = new Date(Date.now() + ttlMs);

        let updatedRow: any = null;
        if (typeof client.updateTable === 'function') {
          updatedRow = await client
            .updateTable('sessions')
            .set({ expires_at: newExpiresAt })
            .where('id', '=', digest)
            .where('expires_at', '>', new Date()) // atomic invariant: never revive expired sessions
            .returning(['id', 'user_id', 'expires_at', 'created_at'])
            .executeTakeFirst();
        } else if (typeof client.query === 'function') {
          const updateResult = await client.query(
            `UPDATE sessions
             SET expires_at = $1
             WHERE id = $2 AND expires_at > NOW()
             RETURNING id, user_id, expires_at, created_at`,
            [newExpiresAt, digest]
          );
          updatedRow = updateResult.rows[0] ?? null;
        }

        if (!updatedRow) {
          // If update returned no rows (e.g. expired during query), reject safely
          return null;
        }

        row = updatedRow;
      }

      return {
        id: row.id,
        user_id: row.user_id,
        expires_at: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
        created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      };
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Database client is not configured') ||
          err.message.includes('Unsupported database client interface'))
      ) {
        throw err;
      }
      throw new Error('Failed to lookup session');
    }
  }

  /**
   * Validates a session by raw token.
   * By default, enforces rolling 8-hour expiration on valid sessions.
   * Safely rejects missing, malformed, expired, or revoked tokens.
   */
  async validateSession(
    rawToken: string,
    options?: { rolling?: boolean; ttlMs?: number }
  ): Promise<Session | null> {
    const rolling = options?.rolling ?? true;
    return this.lookupSession(rawToken, { ...options, rolling });
  }

  /**
   * Refreshes / extends an active session's expiration time (rolling 8-hour lifetime).
   * Strict server enforcement: expired sessions CANNOT be revived and return null.
   */
  async refreshSession(
    rawToken: string,
    options?: { ttlMs?: number }
  ): Promise<Session | null> {
    if (!isValidRawToken(rawToken)) {
      return null;
    }

    const digest = hashToken(rawToken);
    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    const newExpiresAt = new Date(Date.now() + ttlMs);

    try {
      let updatedRow: any = null;

      if (typeof client.updateTable === 'function') {
        updatedRow = await client
          .updateTable('sessions')
          .set({ expires_at: newExpiresAt })
          .where('id', '=', digest)
          .where('expires_at', '>', new Date()) // MUST NOT revive expired sessions
          .returning(['id', 'user_id', 'expires_at', 'created_at'])
          .executeTakeFirst();
      } else if (typeof client.query === 'function') {
        const updateResult = await client.query(
          `UPDATE sessions
           SET expires_at = $1
           WHERE id = $2 AND expires_at > NOW()
           RETURNING id, user_id, expires_at, created_at`,
          [newExpiresAt, digest]
        );
        updatedRow = updateResult.rows[0] ?? null;
      } else {
        throw new Error('Unsupported database client interface');
      }

      if (!updatedRow) {
        return null;
      }

      return {
        id: updatedRow.id,
        user_id: updatedRow.user_id,
        expires_at: updatedRow.expires_at instanceof Date ? updatedRow.expires_at : new Date(updatedRow.expires_at),
        created_at: updatedRow.created_at instanceof Date ? updatedRow.created_at : new Date(updatedRow.created_at),
      };
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Database client is not configured') ||
          err.message.includes('Unsupported database client interface'))
      ) {
        throw err;
      }
      throw new Error('Failed to refresh session');
    }
  }

  async touchSession(rawToken: string, options?: { ttlMs?: number }): Promise<Session | null> {
    return this.refreshSession(rawToken, options);
  }

  /**
   * Detailed session verification returning status and reason.
   */
  async verifySession(rawToken: string): Promise<{
    valid: boolean;
    session?: Session;
    reason?: 'MALFORMED' | 'EXPIRED' | 'NOT_FOUND';
  }> {
    if (!isValidRawToken(rawToken)) {
      return { valid: false, reason: 'MALFORMED' };
    }

    const digest = hashToken(rawToken);
    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    try {
      let row: any = null;
      if (typeof client.selectFrom === 'function') {
        row = await client
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', digest)
          .executeTakeFirst();
      } else if (typeof client.query === 'function') {
        const result = await client.query(
          'SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = $1 LIMIT 1',
          [digest]
        );
        row = result.rows[0] ?? null;
      }

      if (!row) {
        return { valid: false, reason: 'NOT_FOUND' };
      }

      const expiresAtDate = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
      if (isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
        return { valid: false, reason: 'EXPIRED' };
      }

      return {
        valid: true,
        session: {
          id: row.id,
          user_id: row.user_id,
          expires_at: expiresAtDate,
          created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        },
      };
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Database client is not configured') ||
          err.message.includes('Unsupported database client interface'))
      ) {
        throw err;
      }
      throw new Error('Failed to verify session');
    }
  }

  /**
   * Immediately revokes a session via hard deletion of the stored digest.
   * Returns true if the session was found and deleted, false otherwise.
   */
  async revokeSession(rawToken: string): Promise<boolean> {
    if (!isValidRawToken(rawToken)) {
      return false;
    }

    const digest = hashToken(rawToken);
    return this.revokeByDigest(digest);
  }

  async deleteSession(rawToken: string): Promise<boolean> {
    return this.revokeSession(rawToken);
  }

  async revokeByDigest(digest: string): Promise<boolean> {
    if (!digest || typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) {
      return false;
    }

    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    try {
      if (typeof client.deleteFrom === 'function') {
        const result = await client
          .deleteFrom('sessions')
          .where('id', '=', digest)
          .executeTakeFirst();
        return Number(result.numDeletedRows ?? 0) > 0;
      }

      if (typeof client.query === 'function') {
        const result = await client.query('DELETE FROM sessions WHERE id = $1', [digest]);
        return (result.rowCount ?? 0) > 0;
      }

      throw new Error('Unsupported database client interface');
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Database client is not configured') ||
          err.message.includes('Unsupported database client interface'))
      ) {
        throw err;
      }
      throw new Error('Failed to revoke session');
    }
  }

  /**
   * Revokes all active sessions for a given user via hard deletion.
   */
  async revokeAllUserSessions(userId: string): Promise<number> {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      return 0;
    }

    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    try {
      if (typeof client.deleteFrom === 'function') {
        const result = await client
          .deleteFrom('sessions')
          .where('user_id', '=', userId)
          .executeTakeFirst();
        return Number(result.numDeletedRows ?? 0);
      }

      if (typeof client.query === 'function') {
        const result = await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        return result.rowCount ?? 0;
      }

      throw new Error('Unsupported database client interface');
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Database client is not configured') ||
          err.message.includes('Unsupported database client interface'))
      ) {
        throw err;
      }
      throw new Error('Failed to revoke user sessions');
    }
  }

  /**
   * Backward-compatible cleanup no-op.
   * Injected database clients are externally owned by the composition root
   * and must never be closed or destroyed by SessionService.
   */
  async close(): Promise<void> {
    // No-op: SessionService does not own externally injected database connections
  }
}

export default SessionService;
