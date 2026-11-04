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

export interface CreateSessionOptions {
  userId?: string;
  ttlMs?: number;
  expiresAt?: Date;
}

export interface SessionLifecycleOptions {
  rolling?: boolean;
  ttlMs?: number;
}

export const SESSION_TTL_HOURS = 8;
export const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000; // 28,800,000 ms (8 hours)
export const MAX_SESSION_TTL_MS = SESSION_TTL_MS;
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
 * Validates and enforces that a given session TTL is a finite, positive number
 * that does not exceed the approved 8-hour maximum policy (28,800,000 ms).
 */
export function validateSessionTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Session TTL must be a positive number');
  }
  if (ttlMs > MAX_SESSION_TTL_MS) {
    throw new Error(`Session TTL cannot exceed 8 hours (${MAX_SESSION_TTL_MS} ms)`);
  }
  return ttlMs;
}

/**
 * Validates and enforces that an expiration date does not exceed the approved
 * 8-hour maximum lifetime from the current server time and is not in the past.
 */
export function validateSessionExpiresAt(
  expiresAt: unknown,
  referenceNowMs: number = Date.now()
): Date {
  if (!(expiresAt instanceof Date) || isNaN(expiresAt.getTime())) {
    throw new Error('Invalid expiration date');
  }
  const expiryMs = expiresAt.getTime();
  if (expiryMs > referenceNowMs + MAX_SESSION_TTL_MS) {
    throw new Error(`Session expiration cannot exceed 8 hours (${MAX_SESSION_TTL_MS} ms)`);
  }
  if (expiryMs <= referenceNowMs) {
    throw new Error('Session expiration cannot be in the past');
  }
  return expiresAt;
}

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

type DatabaseKind = 'pg' | 'kysely';

interface ResolvedDatabaseClient {
  client: any;
  kind: DatabaseKind;
}

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

    if (options && typeof options === 'object' && 'ttlMs' in options && options.ttlMs !== undefined) {
      this.defaultTtlMs = validateSessionTtl(options.ttlMs);
    } else {
      this.defaultTtlMs = SESSION_TTL_MS;
    }
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
  static MAX_SESSION_TTL_MS = MAX_SESSION_TTL_MS;
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
   * Pre-flight evaluation of database configuration.
   * Evaluates client existence and interface capability BEFORE attempting
   * database operations, preventing catch-block string matching.
   */
  private getDatabaseClient(): ResolvedDatabaseClient {
    const client = this.db;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    if (typeof client.query === 'function') {
      return { client, kind: 'pg' };
    }

    if (
      typeof client.selectFrom === 'function' ||
      typeof client.insertInto === 'function' ||
      typeof client.updateTable === 'function' ||
      typeof client.deleteFrom === 'function'
    ) {
      return { client, kind: 'kysely' };
    }

    throw new Error('Unsupported database client interface');
  }

  /**
   * Creates a new session for the given user:
   * - Validates user ID and lifetime options (strictly bounded by 8-hour max policy).
   * - Generates a raw opaque 32-byte Base64URL token.
   * - Derives the SHA-256 digest.
   * - Persists ONLY the digest in sessions.id with user_id and expires_at.
   * - Returns the raw token only to the caller (never persisted).
   */
  async createSession(
    userIdOrOptions: string | CreateSessionOptions,
    options?: CreateSessionOptions
  ): Promise<SessionResult> {
    let userId: string;
    let ttlMs = this.defaultTtlMs;
    let expiresAt: Date | undefined;

    if (typeof userIdOrOptions === 'string') {
      userId = userIdOrOptions;
      if (options?.ttlMs !== undefined) ttlMs = validateSessionTtl(options.ttlMs);
      if (options?.expiresAt !== undefined) expiresAt = options.expiresAt;
    } else if (userIdOrOptions && typeof userIdOrOptions === 'object') {
      userId = userIdOrOptions.userId ?? '';
      if (userIdOrOptions.ttlMs !== undefined) {
        ttlMs = validateSessionTtl(userIdOrOptions.ttlMs);
      } else if (options?.ttlMs !== undefined) {
        ttlMs = validateSessionTtl(options.ttlMs);
      }

      if (userIdOrOptions.expiresAt !== undefined) {
        expiresAt = userIdOrOptions.expiresAt;
      } else if (options?.expiresAt !== undefined) {
        expiresAt = options.expiresAt;
      }
    } else {
      throw new Error('User ID must be a non-empty string');
    }

    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('User ID must be a non-empty string');
    }

    const currentNowMs = Date.now();
    let finalExpiresAt: Date;
    if (expiresAt !== undefined) {
      finalExpiresAt = validateSessionExpiresAt(expiresAt, currentNowMs);
    } else {
      finalExpiresAt = new Date(currentNowMs + ttlMs);
    }

    // Verify DB client existence before try/catch
    const { client, kind } = this.getDatabaseClient();

    const rawToken = generateSessionToken();
    const digest = hashToken(rawToken);

    try {
      if (kind === 'kysely') {
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

      // kind === 'pg'
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
    } catch {
      // Unconditionally sanitize database errors without string matching
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
    options?: SessionLifecycleOptions
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
    options?: SessionLifecycleOptions
  ): Promise<Session | null> {
    if (!digest || typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) {
      return null;
    }

    if (options?.ttlMs !== undefined) {
      validateSessionTtl(options.ttlMs);
    }

    // Verify DB client existence before try/catch
    const { client, kind } = this.getDatabaseClient();

    try {
      let row: any = null;

      if (kind === 'kysely') {
        row = await client
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', digest)
          .executeTakeFirst();
      } else {
        const result = await client.query(
          'SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = $1 LIMIT 1',
          [digest]
        );
        row = result.rows[0] ?? null;
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
        const ttlMs = options.ttlMs !== undefined ? validateSessionTtl(options.ttlMs) : this.defaultTtlMs;
        const newExpiresAt = new Date(Date.now() + ttlMs);

        let updatedRow: any = null;
        if (kind === 'kysely') {
          updatedRow = await client
            .updateTable('sessions')
            .set({ expires_at: newExpiresAt })
            .where('id', '=', digest)
            .where('expires_at', '>', new Date()) // atomic check: only update if currently unexpired
            .returning(['id', 'user_id', 'expires_at', 'created_at'])
            .executeTakeFirst();
        } else {
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
    } catch {
      // Unconditionally sanitize database errors without string matching
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
    options?: SessionLifecycleOptions
  ): Promise<Session | null> {
    if (options?.ttlMs !== undefined) {
      validateSessionTtl(options.ttlMs);
    }
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

    const ttlMs = options?.ttlMs !== undefined ? validateSessionTtl(options.ttlMs) : this.defaultTtlMs;

    // Verify DB client existence before try/catch
    const { client, kind } = this.getDatabaseClient();

    const digest = hashToken(rawToken);
    const newExpiresAt = new Date(Date.now() + ttlMs);

    try {
      let updatedRow: any = null;

      if (kind === 'kysely') {
        updatedRow = await client
          .updateTable('sessions')
          .set({ expires_at: newExpiresAt })
          .where('id', '=', digest)
          .where('expires_at', '>', new Date()) // MUST NOT revive expired sessions
          .returning(['id', 'user_id', 'expires_at', 'created_at'])
          .executeTakeFirst();
      } else {
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
        return null;
      }

      return {
        id: updatedRow.id,
        user_id: updatedRow.user_id,
        expires_at: updatedRow.expires_at instanceof Date ? updatedRow.expires_at : new Date(updatedRow.expires_at),
        created_at: updatedRow.created_at instanceof Date ? updatedRow.created_at : new Date(updatedRow.created_at),
      };
    } catch {
      // Unconditionally sanitize database errors without string matching
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

    // Verify DB client existence before try/catch
    const { client, kind } = this.getDatabaseClient();

    const digest = hashToken(rawToken);

    try {
      let row: any = null;
      if (kind === 'kysely') {
        row = await client
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', digest)
          .executeTakeFirst();
      } else {
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
    } catch {
      // Unconditionally sanitize database errors without string matching
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

    // Verify DB client existence before try/catch
    const { client, kind } = this.getDatabaseClient();

    try {
      if (kind === 'kysely') {
        const result = await client
          .deleteFrom('sessions')
          .where('id', '=', digest)
          .executeTakeFirst();
        return Number(result.numDeletedRows ?? 0) > 0;
      }

      const result = await client.query('DELETE FROM sessions WHERE id = $1', [digest]);
      return (result.rowCount ?? 0) > 0;
    } catch {
      // Unconditionally sanitize database errors without string matching
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

    // Verify DB client existence before try/catch
    const { client, kind } = this.getDatabaseClient();

    try {
      if (kind === 'kysely') {
        const result = await client
          .deleteFrom('sessions')
          .where('user_id', '=', userId)
          .executeTakeFirst();
        return Number(result.numDeletedRows ?? 0);
      }

      const result = await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      return result.rowCount ?? 0;
    } catch {
      // Unconditionally sanitize database errors without string matching
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
