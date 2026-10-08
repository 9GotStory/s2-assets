import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// Helper to hash password using argon2 if available, or fallback test hash representation
async function hashTestPassword(password: string): Promise<string> {
  try {
    const argon2 = await import('argon2' as string);
    if (argon2 && typeof argon2.hash === 'function') {
      return await argon2.hash(password);
    }
  } catch {
    // argon2 not installed yet in TDD RED state
  }
  return `$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgqlfreuzphiOZoHzAcTXbgFixda/50No`;
}

// Helper to setup test Fastify application
async function setupTestApp(options: { databaseUrl: string; secure?: boolean }): Promise<FastifyInstance> {
  // 1. Try to load buildApp / createApp factory if present
  try {
    const appMod = await import('../../src/app.ts' as string);
    const factory = appMod.buildApp || appMod.createApp || appMod.default;
    if (typeof factory === 'function') {
      return await factory({ databaseUrl: options.databaseUrl, secure: options.secure });
    }
  } catch {}

  const app = Fastify();
  await app.register(errorHandlerPlugin);

  // 2. Try to register cookie plugin
  try {
    const cookieMod = await import('@fastify/cookie' as string);
    const cookiePlugin = cookieMod.default || cookieMod;
    if (typeof cookiePlugin === 'function') {
      await app.register(cookiePlugin);
    }
  } catch {}

  // 3. Try to register csrf plugin
  try {
    const csrfMod = await import('../../src/plugins/csrf.ts' as string);
    const csrfPlugin = csrfMod.csrfPlugin || csrfMod.default;
    if (typeof csrfPlugin === 'function') {
      await app.register(csrfPlugin);
    }
  } catch {}

  // 4. Try to register auth plugin
  try {
    const authMod = await import('../../src/plugins/auth.ts' as string);
    const authPlugin = authMod.authPlugin || authMod.default;
    if (typeof authPlugin === 'function') {
      await app.register(authPlugin, { databaseUrl: options.databaseUrl, secure: options.secure });
    }
  } catch {}

  // 5. Try to register auth routes
  try {
    const routesMod = await import('../../src/routes/auth.routes.ts' as string);
    const routesPlugin = routesMod.authRoutes || routesMod.default;
    if (typeof routesPlugin === 'function') {
      await app.register(routesPlugin, { prefix: '/auth', databaseUrl: options.databaseUrl });
    }
  } catch {}

  await app.ready();
  return app;
}

// Database helper: insert a user
async function insertUser(
  databaseUrl: string,
  user: {
    id?: string;
    username: string;
    passwordHash?: string;
    isActive?: boolean;
  }
): Promise<{ id: string; username: string; passwordHash: string; isActive: boolean }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const id = user.id || crypto.randomUUID();
    const isActive = user.isActive ?? true;
    const passwordHash =
      user.passwordHash ||
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgqlfreuzphiOZoHzAcTXbgFixda/50No';
    await client.query(
      `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, user.username, passwordHash, isActive]
    );
    return { id, username: user.username, passwordHash, isActive };
  } finally {
    await client.end();
  }
}

// Database helper: insert a session directly
async function insertSession(
  databaseUrl: string,
  session: {
    userId: string;
    rawToken?: string;
    expiresAt: Date;
  }
): Promise<{ rawToken: string; digest: string; userId: string; expiresAt: Date }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rawToken = session.rawToken || crypto.randomBytes(32).toString('base64url');
    const digest = crypto.createHash('sha256').update(rawToken).digest('hex');
    await client.query(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [digest, session.userId, session.expiresAt]
    );
    return { rawToken, digest, userId: session.userId, expiresAt: session.expiresAt };
  } finally {
    await client.end();
  }
}

// Cookie helper: extract cookie header from inject response
function getCookieHeader(response: { headers: Record<string, any> }, cookieNameRegex: RegExp = /session/i): string | undefined {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return undefined;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  return headers.find((h: string) => cookieNameRegex.test(h));
}

// Cookie helper: extract cookie name and value for subsequent requests
function getCookieNameValuePair(response: { headers: Record<string, any> }, cookieNameRegex: RegExp = /session/i): string | undefined {
  const header = getCookieHeader(response, cookieNameRegex);
  if (!header) return undefined;
  return header.split(';')[0];
}

describe('Authentication & Session Integration Tests (T016)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
      process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    }
    if (!process.env.DOCKER_HOST) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1001;
      const podmanSocket = `/run/user/${uid}/podman/podman.sock`;
      if (fs.existsSync(podmanSocket)) {
        process.env.DOCKER_HOST = `unix://${podmanSocket}`;
      }
    }

    container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
    databaseUrl = container.getConnectionUri();

    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    app = await setupTestApp({ databaseUrl });
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (container) {
      await container.stop();
    }
  }, 30_000);

  beforeEach(async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('TRUNCATE TABLE sessions, user_roles, users, roles CASCADE;');
    } finally {
      await client.end();
    }
  });

  // =========================================================================
  // 1. Valid local login and invalid credentials
  // =========================================================================
  describe('Valid Local Login and Invalid Credentials', () => {
    it('successfully logs in with valid credentials, sets secure session cookie, and stores SHA-256 digest in DB', async () => {
      const password = 'CorrectPassword123!';
      const passwordHash = await hashTestPassword(password);
      const user = await insertUser(databaseUrl, {
        username: 'alice',
        passwordHash,
        isActive: true,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'alice',
          password,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(user.id);
      expect(body.user.username).toBe('alice');
      // Must not leak sensitive fields
      expect(body.user.password_hash).toBeUndefined();
      expect(body.password_hash).toBeUndefined();

      // Verify Set-Cookie header is returned with session cookie
      const sessionCookie = getCookieHeader(response);
      expect(sessionCookie).toBeDefined();

      // Extract raw token from cookie value (e.g., session=<rawToken>)
      const cookieValue = getCookieNameValuePair(response);
      expect(cookieValue).toBeDefined();
      const rawToken = cookieValue!.split('=')[1];
      expect(rawToken).toBeDefined();

      // Verify database contains the SHA-256 digest of the raw token, NOT the raw token itself
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const result = await client.query('SELECT * FROM sessions WHERE user_id = $1', [user.id]);
        expect(result.rows).toHaveLength(1);
        const sessionRow = result.rows[0];

        const expectedDigest = crypto.createHash('sha256').update(rawToken).digest('hex');
        expect(sessionRow.id).toBe(expectedDigest);
        expect(sessionRow.id).not.toBe(rawToken);

        // Verify 8-hour expiry window (future timestamp)
        const expiresAt = new Date(sessionRow.expires_at).getTime();
        const now = Date.now();
        expect(expiresAt).toBeGreaterThan(now);
        // Expiry should be around 8 hours (allow variance between 7h and 9h)
        const diffHours = (expiresAt - now) / (1000 * 60 * 60);
        expect(diffHours).toBeGreaterThanOrEqual(7);
        expect(diffHours).toBeLessThanOrEqual(9);
      } finally {
        await client.end();
      }
    });

    it('rejects login attempt with invalid password with HTTP 401 and INVALID_CREDENTIALS error code', async () => {
      const passwordHash = await hashTestPassword('CorrectPassword123!');
      await insertUser(databaseUrl, {
        username: 'bob',
        passwordHash,
        isActive: true,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'bob',
          password: 'WrongPassword456!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      expect(body.error.request_id).toBeDefined();

      // No session cookie set
      const sessionCookie = getCookieHeader(response);
      expect(sessionCookie).toBeUndefined();

      // No session created in DB
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const result = await client.query('SELECT * FROM sessions');
        expect(result.rows).toHaveLength(0);
      } finally {
        await client.end();
      }
    });

    it('rejects login attempt with non-existent user with HTTP 401 without user enumeration leakage', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'nonexistent_user',
          password: 'SomePassword123!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      // Must return standard INVALID_CREDENTIALS or UNAUTHORIZED, not leaking user non-existence
      expect(['INVALID_CREDENTIALS', 'UNAUTHORIZED']).toContain(body.error.code);
      expect(body.error.request_id).toBeDefined();

      const sessionCookie = getCookieHeader(response);
      expect(sessionCookie).toBeUndefined();
    });

    it('rejects malformed login payload missing required fields with HTTP 400 and VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: '',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toBeDefined();
    });
  });

  // =========================================================================
  // 2. Disabled user rejection
  // =========================================================================
  describe('Disabled User Rejection', () => {
    it('rejects login attempt for a disabled user (is_active = false) with fail-closed error', async () => {
      const password = 'ActivePassword123!';
      const passwordHash = await hashTestPassword(password);
      await insertUser(databaseUrl, {
        username: 'disabled_user',
        passwordHash,
        isActive: false,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'disabled_user',
          password,
        },
      });

      expect([401, 403]).toContain(response.statusCode);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['USER_DISABLED', 'FORBIDDEN', 'UNAUTHORIZED']).toContain(body.error.code);

      // No session cookie issued
      const sessionCookie = getCookieHeader(response);
      expect(sessionCookie).toBeUndefined();

      // No session created in DB
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const result = await client.query('SELECT * FROM sessions');
        expect(result.rows).toHaveLength(0);
      } finally {
        await client.end();
      }
    });

    it('denies existing session immediately when user is deactivated in the database', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'charlie',
        isActive: true,
      });

      // Insert active session for charlie
      const session = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      });

      // Deactivate user in the database
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
      } finally {
        await client.end();
      }

      // Attempt to access session check endpoint with the active session token
      const response = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: {
          cookie: `session=${session.rawToken}`,
        },
      });

      expect([401, 403]).toContain(response.statusCode);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['USER_DISABLED', 'FORBIDDEN', 'UNAUTHORIZED']).toContain(body.error.code);
    });
  });

  // =========================================================================
  // 3. Session expiry and revocation
  // =========================================================================
  describe('Session Expiry and Revocation', () => {
    it('denies access when session is expired with HTTP 401 and SESSION_EXPIRED error code', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'david',
        isActive: true,
      });

      // Insert expired session (1 hour in the past)
      const expiredSession = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: {
          cookie: `session=${expiredSession.rawToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['SESSION_EXPIRED', 'UNAUTHORIZED']).toContain(body.error.code);
    });

    it('revokes session on logout, deletes digest from database, and clears cookie', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'eve',
        isActive: true,
      });

      const session = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie: `session=${session.rawToken}`,
        },
      });

      expect([200, 204]).toContain(response.statusCode);

      // Verify session digest is deleted from DB
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const result = await client.query('SELECT * FROM sessions WHERE id = $1', [session.digest]);
        expect(result.rows).toHaveLength(0);
      } finally {
        await client.end();
      }

      // Verify Set-Cookie header clears the session cookie (Max-Age=0 or expired)
      const clearCookieHeader = getCookieHeader(response);
      if (clearCookieHeader) {
        expect(clearCookieHeader).toMatch(/(max-age=0|expires=)/i);
      }

      // Subsequent request using revoked session token must be denied
      const subsequentRes = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: {
          cookie: `session=${session.rawToken}`,
        },
      });

      expect(subsequentRes.statusCode).toBe(401);
      const subBody = subsequentRes.json();
      expect(subBody.error).toBeDefined();
      expect(['SESSION_REVOKED', 'SESSION_NOT_FOUND', 'UNAUTHORIZED']).toContain(subBody.error.code);
    });

    it('denies access immediately when session record is deleted directly from the database', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'frank',
        isActive: true,
      });

      const session = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      });

      // Hard delete session from DB
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('DELETE FROM sessions WHERE id = $1', [session.digest]);
      } finally {
        await client.end();
      }

      const response = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: {
          cookie: `session=${session.rawToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(body.error.code);
    });

    it('denies access when session cookie contains an invalid or forged token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: {
          cookie: 'session=forged_invalid_token_value_12345',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['UNAUTHORIZED', 'SESSION_NOT_FOUND']).toContain(body.error.code);
    });
  });

  // =========================================================================
  // 4. Secure cookie attributes
  // =========================================================================
  describe('Secure Cookie Attributes', () => {
    it('sets HttpOnly, SameSite=Lax, and Path=/ attributes on the session cookie upon login', async () => {
      const password = 'CookiePassword123!';
      const passwordHash = await hashTestPassword(password);
      await insertUser(databaseUrl, {
        username: 'grace',
        passwordHash,
        isActive: true,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'grace',
          password,
        },
      });

      expect(response.statusCode).toBe(200);

      const cookieHeader = getCookieHeader(response);
      expect(cookieHeader).toBeDefined();

      // Enforce HttpOnly
      expect(cookieHeader).toMatch(/;\s*HttpOnly/i);

      // Enforce SameSite=Lax
      expect(cookieHeader).toMatch(/;\s*SameSite=Lax/i);

      // Enforce Path=/
      expect(cookieHeader).toMatch(/;\s*Path=\//i);
    });

    it('enforces Secure attribute on session cookie in production/secure environment', async () => {
      const secureApp = await setupTestApp({ databaseUrl, secure: true });
      try {
        const password = 'SecurePassword123!';
        const passwordHash = await hashTestPassword(password);
        await insertUser(databaseUrl, {
          username: 'heidi',
          passwordHash,
          isActive: true,
        });

        const response = await secureApp.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'heidi',
            password,
          },
        });

        expect(response.statusCode).toBe(200);

        const cookieHeader = getCookieHeader(response);
        expect(cookieHeader).toBeDefined();
        expect(cookieHeader).toMatch(/;\s*Secure/i);
        expect(cookieHeader).toMatch(/;\s*HttpOnly/i);
        expect(cookieHeader).toMatch(/;\s*SameSite=Lax/i);
      } finally {
        await secureApp.close();
      }
    });

    it('preserves HttpOnly and SameSite=Lax when clearing session cookie on logout', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'ivan',
        isActive: true,
      });

      const session = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie: `session=${session.rawToken}`,
        },
      });

      expect([200, 204]).toContain(response.statusCode);

      const cookieHeader = getCookieHeader(response);
      if (cookieHeader) {
        expect(cookieHeader).toMatch(/;\s*HttpOnly/i);
        expect(cookieHeader).toMatch(/;\s*SameSite=Lax/i);
      }
    });
  });

  // =========================================================================
  // 5. CSRF protection behavior
  // =========================================================================
  describe('CSRF Protection Behavior', () => {
    it('rejects state-changing POST requests when CSRF token is missing or invalid', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'judy',
        isActive: true,
      });

      const session = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      });

      // State-changing request with invalid CSRF token
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie: `session=${session.rawToken}`,
          'x-csrf-token': 'tampered_invalid_csrf_token',
        },
      });

      // CSRF protection must fail closed with HTTP 403 Forbidden
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['CSRF_TOKEN_INVALID', 'FORBIDDEN']).toContain(body.error.code);
    });

    it('does not require CSRF token for safe read-only GET requests', async () => {
      const user = await insertUser(databaseUrl, {
        username: 'kevin',
        isActive: true,
      });

      const session = await insertSession(databaseUrl, {
        userId: user.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      });

      // GET request without CSRF token should NOT be blocked by CSRF
      const response = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: {
          cookie: `session=${session.rawToken}`,
        },
      });

      // Status should be 200 (authenticated), definitely NOT 403 CSRF error
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(user.id);
    });
  });
});
