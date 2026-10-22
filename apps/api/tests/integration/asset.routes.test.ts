import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { buildApp } from '../../src/app.ts';
import { SessionService } from '../../src/services/session.service.ts';
import { UserService } from '../../src/services/user.service.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

describe('Asset Routes & Security Matrix Integration Tests (Seam A)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sessionService: SessionService;

  // Test users by role
  let custodianUser: { id: string; cookie: string; csrf: string };
  let adminUser: { id: string; cookie: string; csrf: string };
  let readonlyUser: { id: string; cookie: string; csrf: string };
  let maintainerUser: { id: string; cookie: string; csrf: string };
  let combinedUser: { id: string; cookie: string; csrf: string };
  let ordinaryUser: { id: string; cookie: string; csrf: string };
  let inactiveUser: { id: string; cookie: string; csrf: string };

  const createAuthenticatedSession = async (userId: string) => {
    const session = await sessionService.createSession(userId);
    const sessionCookie = `session=${session.token}`;

    // Get CSRF token and CSRF cookie via session-check
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session-check',
      headers: { cookie: sessionCookie },
    });
    const body = JSON.parse(res.body);

    const setCookie = res.headers['set-cookie'];
    const csrfCookie = setCookie
      ? Array.isArray(setCookie)
        ? setCookie.map((c: string) => c.split(';')[0]).join('; ')
        : setCookie.split(';')[0]
      : '';

    const cookie = csrfCookie ? `${sessionCookie}; ${csrfCookie}` : sessionCookie;
    return { id: userId, cookie, csrf: body.csrfToken || '' };
  };

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
    const databaseUrl = container.getConnectionUri();

    // Run migrations to latest
    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    pool = new Pool({ connectionString: databaseUrl });
    sessionService = new SessionService({ db: pool });

    // Build Fastify application
    app = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-12345',
      logger: false,
    });

    const passwordHash = await UserService.hashPassword('Password123!');

    // Seed test users
    const userRows = await pool.query(`
      INSERT INTO users (username, password_hash, is_active) VALUES
        ('u_custodian', '${passwordHash}', true),
        ('u_admin', '${passwordHash}', true),
        ('u_readonly', '${passwordHash}', true),
        ('u_maintainer', '${passwordHash}', true),
        ('u_combined', '${passwordHash}', true),
        ('u_ordinary', '${passwordHash}', true),
        ('u_inactive', '${passwordHash}', false)
      RETURNING id, username;
    `);

    const userMap = new Map<string, string>();
    for (const r of userRows.rows) {
      userMap.set(r.username, r.id);
    }

    // Assign roles per R3 matrix
    // 1. ASSET_CUSTODIAN: asset:register, asset:duplicate-check, asset:view
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
      [userMap.get('u_custodian')]
    );

    // 2. ADMINISTRATOR: asset:view only for asset registry; system:maintain
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')`,
      [userMap.get('u_admin')]
    );

    // 3. READ_ONLY: asset:view only
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')`,
      [userMap.get('u_readonly')]
    );

    // 4. SYSTEM_MAINTAINER: system:maintain only; NO registry capabilities
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SYSTEM_MAINTAINER')`,
      [userMap.get('u_maintainer')]
    );

    // 5. COMBINED: ADMINISTRATOR + ASSET_CUSTODIAN
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR'), ($1, 'ASSET_CUSTODIAN')`,
      [userMap.get('u_combined')]
    );

    // 6. ORDINARY: No roles

    // 7. INACTIVE: ASSET_CUSTODIAN role, but is_active = false
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
      [userMap.get('u_inactive')]
    );

    // Initialize sessions
    custodianUser = await createAuthenticatedSession(userMap.get('u_custodian')!);
    adminUser = await createAuthenticatedSession(userMap.get('u_admin')!);
    readonlyUser = await createAuthenticatedSession(userMap.get('u_readonly')!);
    maintainerUser = await createAuthenticatedSession(userMap.get('u_maintainer')!);
    combinedUser = await createAuthenticatedSession(userMap.get('u_combined')!);
    ordinaryUser = await createAuthenticatedSession(userMap.get('u_ordinary')!);
    inactiveUser = {
      id: userMap.get('u_inactive')!,
      cookie: `session=fake-session-token-for-inactive`,
      csrf: 'any',
    };
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    if (container) {
      await container.stop();
    }
  }, 30_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM registration_retry_tokens');
    await pool.query('DELETE FROM asset_history');
    await pool.query('DELETE FROM assets');
    if (custodianUser?.id) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN') ON CONFLICT DO NOTHING`,
        [custodianUser.id]
      );
    }
  });

  describe('R3: Role and Capability Matrix Enforcement', () => {
    it('Asset Custodian: permits duplicate lookup, registration, and detail/starting history view', async () => {
      // 1. Duplicate check -> 200
      const dupRes = await app.inject({
        method: 'GET',
        url: '/assets/duplicate-candidates?asset_number=NONEXISTENT',
        headers: { cookie: custodianUser.cookie },
      });
      expect(dupRes.statusCode).toBe(200);
      expect(JSON.parse(dupRes.body).candidates).toEqual([]);

      // 2. Register asset -> 201
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Custodian Laptop',
          asset_number: 'AST-CUST-1',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const regBody = JSON.parse(regRes.body);
      const assetId = regBody.asset.id;

      // 3. View asset detail -> 200
      const viewRes = await app.inject({
        method: 'GET',
        url: `/assets/${assetId}`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(viewRes.statusCode).toBe(200);
      const viewBody = JSON.parse(viewRes.body);
      expect(viewBody.asset.id).toBe(assetId);
      expect(viewBody.history).toHaveLength(1);
    });

    it('Administrator: allows viewing detail; denies duplicate lookup and registration', async () => {
      // Register an asset as Custodian first
      const seedRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: { name: 'Admin View Test Asset' },
      });
      const assetId = JSON.parse(seedRes.body).asset.id;

      // 1. View detail -> 200 ALLOWED
      const viewRes = await app.inject({
        method: 'GET',
        url: `/assets/${assetId}`,
        headers: { cookie: adminUser.cookie },
      });
      expect(viewRes.statusCode).toBe(200);

      // 2. Duplicate lookup -> 403 DENIED
      const dupRes = await app.inject({
        method: 'GET',
        url: '/assets/duplicate-candidates?asset_number=AST-1',
        headers: { cookie: adminUser.cookie },
      });
      expect(dupRes.statusCode).toBe(403);

      // 3. Register asset -> 403 DENIED
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
        },
        payload: { name: 'Admin Registration Should Fail' },
      });
      expect(regRes.statusCode).toBe(403);
    });

    it('Read-only User: allows viewing detail; denies duplicate lookup and registration', async () => {
      // Seed asset
      const seedRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: { name: 'Read Only Test Asset' },
      });
      const assetId = JSON.parse(seedRes.body).asset.id;

      // 1. View detail -> 200 ALLOWED
      const viewRes = await app.inject({
        method: 'GET',
        url: `/assets/${assetId}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(viewRes.statusCode).toBe(200);

      // 2. Duplicate lookup -> 403 DENIED
      const dupRes = await app.inject({
        method: 'GET',
        url: '/assets/duplicate-candidates?asset_number=AST-1',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(dupRes.statusCode).toBe(403);

      // 3. Register asset -> 403 DENIED
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: readonlyUser.cookie,
          'x-csrf-token': readonlyUser.csrf,
        },
        payload: { name: 'Read Only Registration Should Fail' },
      });
      expect(regRes.statusCode).toBe(403);
    });

    it('System Maintainer: denies all registry endpoints; retains system maintenance', async () => {
      // Seed asset
      const seedRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: { name: 'Maintainer Test Asset' },
      });
      const assetId = JSON.parse(seedRes.body).asset.id;

      // 1. View detail -> 403 DENIED
      const viewRes = await app.inject({
        method: 'GET',
        url: `/assets/${assetId}`,
        headers: { cookie: maintainerUser.cookie },
      });
      expect(viewRes.statusCode).toBe(403);

      // 2. Duplicate lookup -> 403 DENIED
      const dupRes = await app.inject({
        method: 'GET',
        url: '/assets/duplicate-candidates?asset_number=AST-1',
        headers: { cookie: maintainerUser.cookie },
      });
      expect(dupRes.statusCode).toBe(403);

      // 3. Register asset -> 403 DENIED
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: maintainerUser.cookie,
          'x-csrf-token': maintainerUser.csrf,
        },
        payload: { name: 'Maintainer Registration Should Fail' },
      });
      expect(regRes.statusCode).toBe(403);

      // 4. Retains system:maintain capability
      const sysRes = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: { cookie: maintainerUser.cookie },
      });
      expect(sysRes.statusCode).toBe(200);
    });

    it('Combined Administrator + Asset Custodian: receives applicable union grants', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: combinedUser.cookie,
          'x-csrf-token': combinedUser.csrf,
        },
        payload: { name: 'Combined Role Asset' },
      });
      expect(regRes.statusCode).toBe(201);
      const assetId = JSON.parse(regRes.body).asset.id;

      const viewRes = await app.inject({
        method: 'GET',
        url: `/assets/${assetId}`,
        headers: { cookie: combinedUser.cookie },
      });
      expect(viewRes.statusCode).toBe(200);
    });

    it('Ordinary user without registry roles: denied all access (403)', async () => {
      const viewRes = await app.inject({
        method: 'GET',
        url: '/assets/00000000-0000-0000-0000-000000000001',
        headers: { cookie: ordinaryUser.cookie },
      });
      expect(viewRes.statusCode).toBe(403);
    });

    it('Inactive account: denied all access (401 or 403)', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: inactiveUser.cookie,
          'x-csrf-token': inactiveUser.csrf,
        },
        payload: { name: 'Inactive User Asset' },
      });
      expect([401, 403]).toContain(regRes.statusCode);
    });

    it('Unauthenticated request: denied with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/assets/00000000-0000-0000-0000-000000000001',
      });
      expect(res.statusCode).toBe(401);
    });

    it('Current role revocation: immediately denies access on next request', async () => {
      try {
        // 1. User can register initially
        const okRes = await app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: { name: 'Pre-revocation Asset' },
        });
        expect(okRes.statusCode).toBe(201);

        // 2. Revoke role from user_roles in database
        await pool.query('DELETE FROM user_roles WHERE user_id = $1', [custodianUser.id]);

        // 3. Immediately next request must fail closed with 403 without requiring re-login
        const revokedRes = await app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: { name: 'Post-revocation Asset' },
        });
        expect(revokedRes.statusCode).toBe(403);
      } finally {
        // Restore role for subsequent tests
        await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          custodianUser.id,
          'ASSET_CUSTODIAN',
        ]);
      }
    });

    it('Replay after role revocation fails closed (403)', async () => {
      const retryToken = 'role-revocation-replay-token';
      const payload = {
        name: 'Asset Before Revocation',
        asset_number: 'AST-REVOKE-01',
      };

      try {
        // 1. Initial registration succeeds
        const initRes = await app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': retryToken,
          },
          payload,
        });
        expect(initRes.statusCode).toBe(201);

        // 2. Revoke role
        await pool.query('DELETE FROM user_roles WHERE user_id = $1', [custodianUser.id]);

        // 3. Replay with the same token must fail closed on current grants check
        const replayRes = await app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': retryToken,
          },
          payload,
        });
        expect(replayRes.statusCode).toBe(403);
      } finally {
        // Restore role
        await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          custodianUser.id,
          'ASSET_CUSTODIAN',
        ]);
      }
    });

    it('CSRF protection: rejects state-changing POST /assets when CSRF token is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
        },
        payload: { name: 'CSRF Missing Asset' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Boundary Validation (Standards Finding 1, Spec Findings 6, 7 & 8)', () => {
    it('rejects string booleans "false" on is_legacy with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'String Boolean Item',
          is_legacy: 'false',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects string booleans "false" on explicit_continuation with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'String Continuation Item',
          explicit_continuation: 'false',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects unapproved category with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Category Test Item',
          category: 'Unapproved taxonomy',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects unapproved organization_unit with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Org Unit Test Item',
          organization_unit: 'Engineering Division',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects non-string name with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 12345,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('preserves untrimmed identifiers verbatim without modification', async () => {
      const untrimmedAsset = '  A-01  ';
      const untrimmedSerial = '  S-01  ';

      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Untrimmed Identifiers Asset',
          asset_number: untrimmedAsset,
          serial_number: untrimmedSerial,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.asset.asset_number).toBe(untrimmedAsset);
      expect(body.asset.serial_number).toBe(untrimmedSerial);
    });
  });

  describe('R4: Office-wide Visibility', () => {
    it('authorized registry roles can view assets registered by others, with or without OrganizationUnit', async () => {
      // 1. Custodian registers Asset WITHOUT OrganizationUnit
      const regA = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Office Common Projector',
        },
      });
      const idA = JSON.parse(regA.body).asset.id;

      // 2. Direct seed of legacy Asset WITH OrganizationUnit
      const seedB = await pool.query(
        `INSERT INTO assets (id, name, organization_unit, registered_by)
         VALUES (gen_random_uuid(), 'Accounting Printer', 'Accounting Division', $1)
         RETURNING id;`,
        [custodianUser.id]
      );
      const idB = seedB.rows[0].id;
      await pool.query(
        `INSERT INTO asset_history (id, asset_id, action, actor_id, payload)
         VALUES (gen_random_uuid(), $1, 'REGISTERED', $2, '{"name": "Accounting Printer"}'::jsonb)`,
        [idB, custodianUser.id]
      );

      // 3. Read-only user can view record A (no org unit)
      const readA = await app.inject({
        method: 'GET',
        url: `/assets/${idA}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(readA.statusCode).toBe(200);
      expect(JSON.parse(readA.body).asset.name).toBe('Office Common Projector');
      expect(JSON.parse(readA.body).asset.organization_unit).toBeNull();

      // 4. Administrator can view record B (specific org unit)
      const readB = await app.inject({
        method: 'GET',
        url: `/assets/${idB}`,
        headers: { cookie: adminUser.cookie },
      });
      expect(readB.statusCode).toBe(200);
      expect(JSON.parse(readB.body).asset.organization_unit).toBe('Accounting Division');
    });
  });

  describe('D2/D4: Duplicate Warning and Retry Token HTTP Contract (Findings Standards 2 & Spec 4)', () => {
    it('returns 409 DUPLICATE_CANDIDATES_FOUND on duplicate match; allows explicit continuation', async () => {
      // 1. Register initial asset
      await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Desk Chair 01',
          asset_number: 'CHR-99',
        },
      });

      // 2. Duplicate registration attempt without explicit continuation -> 409
      const dupRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Desk Chair 02',
          asset_number: 'CHR-99',
        },
      });
      expect(dupRes.statusCode).toBe(409);
      const dupBody = JSON.parse(dupRes.body);
      expect(dupBody.code).toBe('DUPLICATE_CANDIDATES_FOUND');
      expect(dupBody.candidates).toHaveLength(1);

      // 3. Explicit continuation -> 201
      const contRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Desk Chair 02 (Explicit Distinct)',
          asset_number: 'CHR-99',
          explicit_continuation: true,
        },
      });
      expect(contRes.statusCode).toBe(201);
    });

    it('replays committed response on identical retry token; rejects mismatch', async () => {
      const retryToken = 'http-retry-token-123';
      const payload = {
        name: 'Conference Phone',
        asset_number: 'CONF-TEL-1',
      };

      // First call
      const first = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload,
      });
      expect(first.statusCode).toBe(201);
      const firstId = JSON.parse(first.body).asset.id;

      // Replay with same token and payload
      const replay = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect(JSON.parse(replay.body).asset.id).toBe(firstId);

      // Attempt reuse with different payload -> 409
      const mismatch = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload: {
          name: 'Conference Phone (Tampered)',
          asset_number: 'CONF-TEL-2',
        },
      });
      expect(mismatch.statusCode).toBe(409);
    });

    it('handles 8 concurrent identical requests via public HTTP route without 500 or duplicate records', async () => {
      const retryToken = 'concurrent-http-retry-token';
      const payload = {
        name: 'Concurrent Router 01',
        asset_number: 'ROUTER-CONC-01',
      };

      const promises = Array.from({ length: 8 }, () =>
        app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': retryToken,
          },
          payload,
        })
      );

      const responses = await Promise.all(promises);

      // Every response must return 201
      for (const res of responses) {
        expect(res.statusCode).toBe(201);
      }

      // Every response must contain the identical asset ID
      const firstId = JSON.parse(responses[0].body).asset.id;
      for (const res of responses) {
        expect(JSON.parse(res.body).asset.id).toBe(firstId);
      }

      // Database must contain exactly 1 asset
      const countRes = await pool.query(
        'SELECT count(*)::int as count FROM assets WHERE asset_number = $1',
        ['ROUTER-CONC-01']
      );
      expect(countRes.rows[0].count).toBe(1);
    });

    it('handles concurrent conflicting payloads on same retry token: one 201, other 409', async () => {
      const retryToken = 'concurrent-conflict-http-token';
      const payloadA = { name: 'Item Alpha', asset_number: 'ALPHA-01' };
      const payloadB = { name: 'Item Beta', asset_number: 'BETA-01' };

      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': retryToken,
          },
          payload: payloadA,
        }),
        app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': retryToken,
          },
          payload: payloadB,
        }),
      ]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);
    });
  });
});
