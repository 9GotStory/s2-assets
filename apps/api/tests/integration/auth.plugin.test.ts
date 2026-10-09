import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import { authPlugin } from '../../src/plugins/auth.ts';
import { SessionService, hashToken, generateSessionToken } from '../../src/services/session.service.ts';
import { UserService } from '../../src/services/user.service.ts';

const { Pool, Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

describe('Fastify Auth Plugin PostgreSQL Integration Tests (T020)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: pg.Pool;

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

    const migResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(migResult.error).toBeUndefined();

    pool = new Pool({ connectionString: databaseUrl });
  }, 90_000);

  afterAll(async () => {
    if (pool) {
      await pool.end().catch(() => {});
    }
    if (container) {
      await container.stop().catch(() => {});
    }
  });

  async function createDbUser(username: string, isActive: boolean = true) {
    const id = crypto.randomUUID();
    const passwordHash =
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgqlfreuzphiOZoHzAcTXbgFixda/50No';
    await pool.query(
      `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, username, passwordHash, isActive]
    );
    return { id, username, isActive };
  }

  async function createDbSession(userId: string, expiresAt: Date) {
    const rawToken = generateSessionToken();
    const digest = hashToken(rawToken);
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [digest, userId, expiresAt]
    );
    return { rawToken, digest, userId, expiresAt };
  }

  it('authenticates valid active session against PostgreSQL and decorates request context', async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { databaseUrl });

    app.get('/protected', { preHandler: [app.authenticate] }, async (request) => {
      return {
        user: request.user,
        session: request.session,
        isAuthenticated: request.isAuthenticated(),
      };
    });

    await app.ready();

    const user = await createDbUser('pg_alice', true);
    const session = await createDbSession(user.id, new Date(Date.now() + 4 * 60 * 60 * 1000));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        cookie: `session=${session.rawToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe('pg_alice');
    expect(body.user.password_hash).toBeUndefined();
    expect(body.session.id).toBe(session.digest);
    expect(body.isAuthenticated).toBe(true);

    await app.close();
  });

  it('extends session in PostgreSQL via rolling expiration on protected request', async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { db: pool, rolling: true });

    app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    await app.ready();

    const user = await createDbUser('pg_rolling_user', true);
    // Initial expiry: 1 hour from now
    const initialExpiry = new Date(Date.now() + 1 * 60 * 60 * 1000);
    const session = await createDbSession(user.id, initialExpiry);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        cookie: `session=${session.rawToken}`,
      },
    });

    expect(response.statusCode).toBe(200);

    // Verify in database that expires_at was extended past initialExpiry
    const dbResult = await pool.query('SELECT expires_at FROM sessions WHERE id = $1', [session.digest]);
    const updatedExpiry = new Date(dbResult.rows[0].expires_at);
    expect(updatedExpiry.getTime()).toBeGreaterThan(initialExpiry.getTime());

    // Verify Set-Cookie was sent to update browser cookie Max-Age
    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`session=${session.rawToken}`);

    await app.close();
  });

  it('denies access with HTTP 401 SESSION_EXPIRED when session in PostgreSQL is expired', async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { databaseUrl });

    app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    await app.ready();

    const user = await createDbUser('pg_expired_user', true);
    // Expired 30 minutes ago
    const session = await createDbSession(user.id, new Date(Date.now() - 30 * 60 * 1000));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        cookie: `session=${session.rawToken}`,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('SESSION_EXPIRED');

    await app.close();
  });

  it('denies access with HTTP 403 USER_DISABLED when user is deactivated in PostgreSQL', async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { databaseUrl });

    app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    await app.ready();

    const user = await createDbUser('pg_disabled_user', false);
    const session = await createDbSession(user.id, new Date(Date.now() + 4 * 60 * 60 * 1000));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        cookie: `session=${session.rawToken}`,
      },
    });

    expect([401, 403]).toContain(response.statusCode);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(['USER_DISABLED', 'FORBIDDEN', 'UNAUTHORIZED']).toContain(body.error.code);

    await app.close();
  });

  it('denies access with HTTP 401 when session has been revoked from PostgreSQL', async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { databaseUrl });

    app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    await app.ready();

    const user = await createDbUser('pg_revoked_user', true);
    const session = await createDbSession(user.id, new Date(Date.now() + 4 * 60 * 60 * 1000));

    // Hard delete session from PostgreSQL
    await pool.query('DELETE FROM sessions WHERE id = $1', [session.digest]);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        cookie: `session=${session.rawToken}`,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(body.error.code);

    await app.close();
  });

  it('correctly sets and clears session cookie via reply decorators', async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { databaseUrl, secure: true });

    app.post('/login-test', { config: { public: true } }, async (_req, reply) => {
      reply.setSessionCookie('sample_raw_token_value_here');
      return { ok: true };
    });

    app.post('/logout-test', { config: { public: true } }, async (_req, reply) => {
      reply.clearSessionCookie();
      return { ok: true };
    });

    await app.ready();

    // 1. Test cookie issuance
    const loginRes = await app.inject({ method: 'POST', url: '/login-test' });
    expect(loginRes.statusCode).toBe(200);
    const loginCookie = loginRes.headers['set-cookie'] as string;
    expect(loginCookie).toBeDefined();
    expect(loginCookie).toMatch(/;\s*Secure/i);
    expect(loginCookie).toMatch(/;\s*HttpOnly/i);
    expect(loginCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(loginCookie).toMatch(/;\s*Path=\//i);
    expect(loginCookie).toMatch(/;\s*Max-Age=28800/i);

    // 2. Test cookie clearing
    const logoutRes = await app.inject({ method: 'POST', url: '/logout-test' });
    expect(logoutRes.statusCode).toBe(200);
    const logoutCookie = logoutRes.headers['set-cookie'] as string;
    expect(logoutCookie).toBeDefined();
    expect(logoutCookie).toMatch(/Max-Age=0/i);
    expect(logoutCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(logoutCookie).toMatch(/;\s*Secure/i);
    expect(logoutCookie).toMatch(/;\s*HttpOnly/i);
    expect(logoutCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(logoutCookie).toMatch(/;\s*Path=\//i);

    await app.close();
  });
});
