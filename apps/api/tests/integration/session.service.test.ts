import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import {
  SessionService,
  hashToken,
  SESSION_TTL_MS,
  generateSessionToken,
} from '../../src/services/session.service.ts';

const { Client, Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

describe('SessionService Real PostgreSQL Integration Tests (T019)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: pg.Pool;
  let testUserId: string;

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

    // Run migrations to establish users, sessions, roles, user_roles
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
  }, 30_000);

  beforeEach(async () => {
    // Clean tables and create fresh test user
    await pool.query('TRUNCATE TABLE sessions, user_roles, users, roles CASCADE;');

    testUserId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [testUserId, 'testuser_' + Date.now(), '$argon2id$v=19$m=65536,t=3,p=4$dummyhash$dummysalt', true]
    );
  });

  describe('Database Persistence & Digest Invariant', () => {
    it('persists only the SHA-256 digest in PostgreSQL sessions.id and never the raw token', async () => {
      const service = new SessionService({ db: pool });
      const created = await service.createSession(testUserId);

      expect(created.token).toBeDefined();
      expect(created.token).toHaveLength(43);
      expect(created.session.user_id).toBe(testUserId);

      const expectedDigest = hashToken(created.token);
      expect(created.session.id).toBe(expectedDigest);

      // Query real PostgreSQL database using the digest
      const dbRowByDigest = await pool.query('SELECT * FROM sessions WHERE id = $1', [expectedDigest]);
      expect(dbRowByDigest.rows).toHaveLength(1);
      expect(dbRowByDigest.rows[0].id).toBe(expectedDigest);
      expect(dbRowByDigest.rows[0].user_id).toBe(testUserId);

      // Query real PostgreSQL using the raw token directly - MUST find 0 rows
      const dbRowByRaw = await pool.query('SELECT * FROM sessions WHERE id = $1', [created.token]);
      expect(dbRowByRaw.rows).toHaveLength(0);

      // Scan all records in sessions table to ensure raw token is nowhere in the database
      const allRows = await pool.query('SELECT * FROM sessions');
      expect(allRows.rows).toHaveLength(1);
      const serialized = JSON.stringify(allRows.rows[0]);
      expect(serialized).not.toContain(created.token);
    });

    it('works with a dedicated pg Client as the injected client', async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const service = new SessionService({ db: client });
        const created = await service.createSession(testUserId);

        expect(created.token).toBeDefined();
        const expectedDigest = hashToken(created.token);

        const lookup = await service.lookupSession(created.token);
        expect(lookup).not.toBeNull();
        expect(lookup?.id).toBe(expectedDigest);
        expect(lookup?.user_id).toBe(testUserId);
      } finally {
        await client.end();
      }
    });
  });

  describe('8-Hour Server-Enforced Expiration & Verification', () => {
    it('stores expiration timestamp approximately 8 hours in the future in PostgreSQL', async () => {
      const service = new SessionService({ db: pool });
      const beforeTime = Date.now();
      const created = await service.createSession(testUserId);
      const afterTime = Date.now();

      const dbRes = await pool.query('SELECT expires_at FROM sessions WHERE id = $1', [created.session.id]);
      const dbExpiresAt = new Date(dbRes.rows[0].expires_at).getTime();

      const minExpected = beforeTime + SESSION_TTL_MS - 2000;
      const maxExpected = afterTime + SESSION_TTL_MS + 2000;

      expect(dbExpiresAt).toBeGreaterThanOrEqual(minExpected);
      expect(dbExpiresAt).toBeLessThanOrEqual(maxExpected);
    });

    it('successfully looks up active unexpired session in PostgreSQL', async () => {
      const service = new SessionService({ db: pool });
      const created = await service.createSession(testUserId);

      const session = await service.lookupSession(created.token);
      expect(session).not.toBeNull();
      expect(session?.user_id).toBe(testUserId);
      expect(session?.id).toBe(created.session.id);
    });

    it('strictly rejects expired sessions directly from PostgreSQL', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);

      // Manually insert an expired session into PostgreSQL (expired 5 minutes ago)
      await pool.query(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         VALUES ($1, $2, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '8 hours 5 minutes')`,
        [digest, testUserId]
      );

      const service = new SessionService({ db: pool });

      // lookupSession must reject expired session
      const lookupResult = await service.lookupSession(rawToken);
      expect(lookupResult).toBeNull();

      // validateSession must reject expired session
      const validateResult = await service.validateSession(rawToken);
      expect(validateResult).toBeNull();

      // verifySession must report EXPIRED
      const verifyResult = await service.verifySession(rawToken);
      expect(verifyResult.valid).toBe(false);
      expect(verifyResult.reason).toBe('EXPIRED');
    });
  });

  describe('Rolling Expiration & Strict Non-Revival Invariants', () => {
    it('extends active session expires_at in PostgreSQL during rolling validation', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);

      // Seed session that expires in 10 minutes
      await pool.query(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes', NOW() - INTERVAL '1 hour')`,
        [digest, testUserId]
      );

      const initialRes = await pool.query('SELECT expires_at FROM sessions WHERE id = $1', [digest]);
      const initialExpiresAt = new Date(initialRes.rows[0].expires_at).getTime();

      const service = new SessionService({ db: pool });
      const validated = await service.validateSession(rawToken, { rolling: true });

      expect(validated).not.toBeNull();
      const newExpiresAt = new Date(validated!.expires_at).getTime();

      // Expiration must have rolled forward to ~8 hours from now
      expect(newExpiresAt).toBeGreaterThan(initialExpiresAt + 7 * 60 * 60 * 1000);

      // Verify the update persisted in PostgreSQL
      const updatedRes = await pool.query('SELECT expires_at FROM sessions WHERE id = $1', [digest]);
      const dbUpdatedExpiresAt = new Date(updatedRes.rows[0].expires_at).getTime();
      expect(dbUpdatedExpiresAt).toBe(newExpiresAt);
    });

    it('strictly forbids reviving an already-expired session in PostgreSQL', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);

      // Seed expired session
      await pool.query(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         VALUES ($1, $2, NOW() - INTERVAL '10 seconds', NOW() - INTERVAL '8 hours')`,
        [digest, testUserId]
      );

      const service = new SessionService({ db: pool });

      // Attempting to refresh / roll an expired session must return null
      const refreshResult = await service.refreshSession(rawToken);
      expect(refreshResult).toBeNull();

      const touchResult = await service.touchSession(rawToken);
      expect(touchResult).toBeNull();

      // Check PostgreSQL: expires_at must still be in the past
      const checkRes = await pool.query('SELECT expires_at FROM sessions WHERE id = $1', [digest]);
      expect(checkRes.rows).toHaveLength(1);
      const expiry = new Date(checkRes.rows[0].expires_at).getTime();
      expect(expiry).toBeLessThan(Date.now());
    });
  });

  describe('Immediate Revocation and Cascading Deletion', () => {
    it('hard deletes the session digest from PostgreSQL on revocation', async () => {
      const service = new SessionService({ db: pool });
      const created = await service.createSession(testUserId);

      // Verify it exists in DB
      const beforeRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [created.session.id]);
      expect(beforeRes.rows).toHaveLength(1);

      // Revoke session
      const revoked = await service.revokeSession(created.token);
      expect(revoked).toBe(true);

      // Verify hard delete in PostgreSQL
      const afterRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [created.session.id]);
      expect(afterRes.rows).toHaveLength(0);

      // Subsequent lookup must fail
      const lookup = await service.lookupSession(created.token);
      expect(lookup).toBeNull();
    });

    it('cascades deletion of sessions when user is deleted', async () => {
      const service = new SessionService({ db: pool });
      const session1 = await service.createSession(testUserId);
      const session2 = await service.createSession(testUserId);

      const beforeRes = await pool.query('SELECT * FROM sessions WHERE user_id = $1', [testUserId]);
      expect(beforeRes.rows).toHaveLength(2);

      // Delete the user from users table
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);

      // Foreign key ON DELETE CASCADE should delete both sessions
      const afterRes = await pool.query('SELECT * FROM sessions WHERE user_id = $1', [testUserId]);
      expect(afterRes.rows).toHaveLength(0);

      expect(await service.lookupSession(session1.token)).toBeNull();
      expect(await service.lookupSession(session2.token)).toBeNull();
    });
  });

  describe('Connection Lifecycle and Injected Client Preservation', () => {
    it('does not close or destroy injected PostgreSQL client', async () => {
      const independentClient = new Client({ connectionString: databaseUrl });
      await independentClient.connect();

      try {
        const service = new SessionService({ db: independentClient });
        const created = await service.createSession(testUserId);
        expect(created.token).toBeDefined();

        await service.close();

        // Independent client must still be fully functional and open
        const queryResult = await independentClient.query('SELECT 1 as num');
        expect(queryResult.rows[0].num).toBe(1);
      } finally {
        await independentClient.end();
      }
    });
  });

  describe('Real PostgreSQL Policy Enforcement & Error Sanitization (REWORK 1)', () => {
    it('prevents arbitrary lifetime extensions exceeding 8 hours without touching PostgreSQL', async () => {
      const service = new SessionService({ db: pool });
      const twentyFourHours = 24 * 60 * 60 * 1000;

      await expect(service.createSession(testUserId, { ttlMs: twentyFourHours })).rejects.toThrow(
        'Session TTL cannot exceed 8 hours'
      );

      // Verify no session was created in PostgreSQL
      const dbRes = await pool.query('SELECT * FROM sessions WHERE user_id = $1', [testUserId]);
      expect(dbRes.rows).toHaveLength(0);
    });

    it('sanitizes real PostgreSQL constraint or syntax errors without disclosing database internals', async () => {
      const service = new SessionService({ db: pool });
      // Non-existent foreign key user_id triggers a real foreign key violation in PostgreSQL
      const nonexistentUserId = crypto.randomUUID();

      await expect(service.createSession(nonexistentUserId)).rejects.toThrow('Failed to create session');

      try {
        await service.createSession(nonexistentUserId);
      } catch (err: any) {
        expect(err.message).toBe('Failed to create session');
        expect(err.message).not.toContain('foreign key');
        expect(err.message).not.toContain('sessions_user_id_fkey');
        expect(err.message).not.toContain('violates');
      }
    });
  });
});
