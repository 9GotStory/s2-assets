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
      expect(dupBody.total_count).toBe(1);
      expect(dupBody.has_more).toBe(false);

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

    it('supports bounded duplicate candidate pagination with limit and offset query parameters', async () => {
      // Register multiple distinct assets with the same serial number using explicit continuation
      const sn = 'SN-PAGE-TEST';
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: 'POST',
          url: '/assets',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            name: `Item ${i}`,
            serial_number: sn,
            explicit_continuation: true,
          },
        });
      }

      // Page 1: limit 2, offset 0
      const page1Res = await app.inject({
        method: 'GET',
        url: `/assets/duplicate-candidates?serial_number=${sn}&limit=2&offset=0`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.body);
      expect(page1.candidates).toHaveLength(2);
      expect(page1.total_count).toBe(3);
      expect(page1.has_more).toBe(true);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      // Page 2: limit 2, offset 2
      const page2Res = await app.inject({
        method: 'GET',
        url: `/assets/duplicate-candidates?serial_number=${sn}&limit=2&offset=2`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.body);
      expect(page2.candidates).toHaveLength(1);
      expect(page2.total_count).toBe(3);
      expect(page2.has_more).toBe(false);
      expect(page2.offset).toBe(2);
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

  describe('GET /assets/search Integration & Security Tests (Seam A - T3)', () => {
    let testAssetId: string;

    beforeEach(async () => {
      // Seed test assets for search tests
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Dell UltraSharp Monitor 27"',
          asset_number: 'MON-DELL-001',
          serial_number: 'SN-DELL-998877',
        },
      });
      expect(res.statusCode).toBe(201);
      testAssetId = JSON.parse(res.body).asset.id;

      await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Special %_\\ Inventory Item',
          asset_number: 'SPEC-INV-001',
          serial_number: 'SN-SPEC-001',
        },
      });
    });

    it('allows Asset Custodian, Administrator, and Read-Only users to perform search (200 OK)', async () => {
      for (const user of [custodianUser, adminUser, readonlyUser]) {
        const res = await app.inject({
          method: 'GET',
          url: '/assets/search?field=asset_number&value=MON-DELL-001',
          headers: { cookie: user.cookie },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');

        const body = JSON.parse(res.body);
        expect(body.items).toHaveLength(1);
        expect(body.items[0].id).toBe(testAssetId);
        expect(body.items[0].asset_number).toBe('MON-DELL-001');
        expect(body.items[0].serial_number).toBe('SN-DELL-998877');
        expect(body.items[0].name).toBe('Dell UltraSharp Monitor 27"');
        expect(body.total_count).toBe(1);
        expect(body.has_more).toBe(false);

        // Strict projection: exactly id, name, asset_number, serial_number
        expect(Object.keys(body.items[0]).sort()).toEqual([
          'asset_number',
          'id',
          'name',
          'serial_number',
        ]);
      }
    });

    it('supports search by stable_id UUID, serial_number, and case-insensitive substring name', async () => {
      // By stable_id UUID
      const resId = await app.inject({
        method: 'GET',
        url: `/assets/search?field=stable_id&value=${testAssetId}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resId.statusCode).toBe(200);
      expect(JSON.parse(resId.body).items[0].id).toBe(testAssetId);

      // By serial_number
      const resSerial = await app.inject({
        method: 'GET',
        url: '/assets/search?field=serial_number&value=SN-DELL-998877',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resSerial.statusCode).toBe(200);
      expect(JSON.parse(resSerial.body).items[0].id).toBe(testAssetId);

      // By name substring case-insensitive
      const resName = await app.inject({
        method: 'GET',
        url: '/assets/search?field=name&value=ultrasharp',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resName.statusCode).toBe(200);
      expect(JSON.parse(resName.body).items[0].id).toBe(testAssetId);

      // By literal %_\ characters
      const resLiteral = await app.inject({
        method: 'GET',
        url: '/assets/search?field=name&value=%25_%5C',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resLiteral.statusCode).toBe(200);
      const literalBody = JSON.parse(resLiteral.body);
      expect(literalBody.items).toHaveLength(1);
      expect(literalBody.items[0].asset_number).toBe('SPEC-INV-001');
    });

    it('supports empty browse and pagination', async () => {
      // Empty browse without params
      const resEmpty = await app.inject({
        method: 'GET',
        url: '/assets/search',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resEmpty.statusCode).toBe(200);
      const emptyBody = JSON.parse(resEmpty.body);
      expect(emptyBody.items.length).toBeGreaterThanOrEqual(2);
      expect(emptyBody.limit).toBe(25);
      expect(emptyBody.offset).toBe(0);

      // Paged browse
      const resPaged = await app.inject({
        method: 'GET',
        url: '/assets/search?limit=1&offset=0',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resPaged.statusCode).toBe(200);
      const pagedBody = JSON.parse(resPaged.body);
      expect(pagedBody.items).toHaveLength(1);
      expect(pagedBody.has_more).toBe(true);
    });

    it('rejects unauthenticated and unauthorized requests (401 and 403)', async () => {
      // 401 unauthenticated
      const resUnauth = await app.inject({
        method: 'GET',
        url: '/assets/search',
      });
      expect(resUnauth.statusCode).toBe(401);

      // 401 inactive user
      const resInactive = await app.inject({
        method: 'GET',
        url: '/assets/search',
        headers: { cookie: inactiveUser.cookie },
      });
      expect(resInactive.statusCode).toBe(401);

      // 403 system maintainer (lacks asset:search / asset:view)
      const resMaintainer = await app.inject({
        method: 'GET',
        url: '/assets/search',
        headers: { cookie: maintainerUser.cookie },
      });
      expect(resMaintainer.statusCode).toBe(403);

      // 403 ordinary user without capabilities
      const resOrdinary = await app.inject({
        method: 'GET',
        url: '/assets/search',
        headers: { cookie: ordinaryUser.cookie },
      });
      expect(resOrdinary.statusCode).toBe(403);
    });

    it('rejects invalid query parameters with 400 and standard validation envelope', async () => {
      const invalidUrls = [
        '/assets/search?unknown_param=123',
        '/assets/search?field=name&field=asset_number',
        '/assets/search?field=name',
        '/assets/search?value=some-val',
        '/assets/search?field=unknown_field&value=123',
        '/assets/search?field=stable_id&value=not-a-uuid',
        '/assets/search?field=name&value=%20%20%20',
        '/assets/search?limit=0',
        '/assets/search?limit=101',
        '/assets/search?limit=abc',
        '/assets/search?offset=-1',
        '/assets/search?offset=abc',
        '/assets/search?field=name&value=null%00byte',
        '/assets/search?limit=01',
        '/assets/search?limit=025',
        '/assets/search?offset=00',
        '/assets/search?offset=01',
        '/assets/search?field=stable_id&value=%20f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
        '/assets/search?field=stable_id&value=f81d4fae-7dec-11d0-a765-00a0c91e6bf6%20',
        '/assets/search?field=stable_id&value=%20%20f81d4fae-7dec-11d0-a765-00a0c91e6bf6%20%20',
        '/assets/search?field=stable_id&value=%09f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
        '/assets/search?field=stable_id&value=f81d4fae-7dec-11d0-a765-00a0c91e6bf6%0A',
      ];

      for (const url of invalidUrls) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: {
            cookie: custodianUser.cookie,
            'x-request-id': 'req-test-val-err-1',
          },
        });
        expect(res.statusCode).toBe(400);

        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('error');
        expect(body.error.code).toBe('VALIDATION_FAILED');
        expect(body.error.message).toBe('The provided request data is invalid.');
        expect(body.error.request_id).toBe('req-test-val-err-1');
        expect(body.error).toHaveProperty('details');
        expect(typeof body.error.details).toBe('object');
      }
    });

    it('IR-F1: accepts valid UUID formats and empty-value browse, and returns 400 for padded UUID', async () => {
      // 1. Valid lowercase UUID
      const resLower = await app.inject({
        method: 'GET',
        url: `/assets/search?field=stable_id&value=${testAssetId.toLowerCase()}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resLower.statusCode).toBe(200);

      // 2. Valid uppercase UUID
      const resUpper = await app.inject({
        method: 'GET',
        url: `/assets/search?field=stable_id&value=${testAssetId.toUpperCase()}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resUpper.statusCode).toBe(200);

      // 3. Padded UUID returns 400 with details.value
      const resPadded = await app.inject({
        method: 'GET',
        url: `/assets/search?field=stable_id&value=%20${testAssetId}%20`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resPadded.statusCode).toBe(400);
      const paddedBody = JSON.parse(resPadded.body);
      expect(paddedBody.error.details).toEqual({ value: 'Invalid UUID format for stable_id' });

      // 4. Empty-value stable_id -> browse mode preserved (200 OK)
      const resBrowse = await app.inject({
        method: 'GET',
        url: '/assets/search?field=stable_id&value=',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resBrowse.statusCode).toBe(200);

      // 5. Valid UUID not matching any asset -> 200 OK with empty items
      const resNoMatch = await app.inject({
        method: 'GET',
        url: '/assets/search?field=stable_id&value=00000000-0000-0000-0000-000000000000',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resNoMatch.statusCode).toBe(200);
      const noMatchBody = JSON.parse(resNoMatch.body);
      expect(noMatchBody.items).toHaveLength(0);
      expect(noMatchBody.total_count).toBe(0);
    });

    it('IR-F3: enforces search-specific response policy covering 200, 400, 401, 403, and early/late 500s while preserving T1 routes', async () => {
      // 1. Success 200 OK
      const res200 = await app.inject({
        method: 'GET',
        url: '/assets/search?field=asset_number&value=MON-DELL-001',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(res200.statusCode).toBe(200);
      expect(res200.headers['cache-control']).toBe('no-store');

      // 2. Validation 400 Bad Request
      const res400 = await app.inject({
        method: 'GET',
        url: '/assets/search?limit=0',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(res400.statusCode).toBe(400);
      expect(res400.headers['cache-control']).toBe('no-store');

      // 3. Authentication 401 Unauthorized (early denial in global auth hook before preHandler)
      const res401 = await app.inject({
        method: 'GET',
        url: '/assets/search?field=asset_number&value=MON-DELL-001',
      });
      expect(res401.statusCode).toBe(401);
      expect(res401.headers['cache-control']).toBe('no-store');

      // 4. Authorization 403 Forbidden (denial in requireCapability preHandler)
      const res403 = await app.inject({
        method: 'GET',
        url: '/assets/search?field=asset_number&value=MON-DELL-001',
        headers: { cookie: maintainerUser.cookie },
      });
      expect(res403.statusCode).toBe(403);
      expect(res403.headers['cache-control']).toBe('no-store');

      // 5. Early Pre-handler Failure 500
      // Induce failure in capability check during preHandler phase
      const origHasCap = app.capabilityService!.hasCapability;
      app.capabilityService!.hasCapability = async () => {
        throw new Error('Pre-handler capability evaluation crash');
      };

      try {
        const res500Early = await app.inject({
          method: 'GET',
          url: '/assets/search?field=asset_number&value=MON-DELL-001',
          headers: { cookie: readonlyUser.cookie },
        });
        expect(res500Early.statusCode).toBe(500);
        expect(res500Early.headers['cache-control']).toBe('no-store');
      } finally {
        app.capabilityService!.hasCapability = origHasCap;
      }

      // 6. Handler/Service Failure 500
      const origSearch = (app as any).assetService.searchAssets;
      (app as any).assetService.searchAssets = async () => {
        throw new Error('Service database failure during search');
      };

      try {
        const res500Service = await app.inject({
          method: 'GET',
          url: '/assets/search?field=asset_number&value=MON-DELL-001',
          headers: { cookie: readonlyUser.cookie },
        });
        expect(res500Service.statusCode).toBe(500);
        expect(res500Service.headers['cache-control']).toBe('no-store');
      } finally {
        (app as any).assetService.searchAssets = origSearch;
      }

      // 7. Preservation of unrelated T1 routes (must not be forced to no-store)
      const resT1Get = await app.inject({
        method: 'GET',
        url: `/assets/${testAssetId}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resT1Get.statusCode).toBe(200);
      expect(resT1Get.headers['cache-control']).not.toBe('no-store');
    });

    it('F1: accepts canonical offset=0 and rejects leading-zero pagination', async () => {
      const resZero = await app.inject({
        method: 'GET',
        url: '/assets/search?offset=0&limit=25',
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resZero.statusCode).toBe(200);
    });

    it('F4: does not echo unknown query key or value in validation error details', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/assets/search?untrusted_secret_key=secret_value_123',
        headers: {
          cookie: custodianUser.cookie,
          'x-request-id': 'req-test-no-echo-1',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_FAILED');
      // Crucial: untrusted key must NEVER appear as a property in details
      expect(body.error.details).not.toHaveProperty('untrusted_secret_key');
      expect(body.error.details).toHaveProperty('query');
      expect(JSON.stringify(body)).not.toContain('untrusted_secret_key');
      expect(JSON.stringify(body)).not.toContain('secret_value_123');
    });

    it('F4: does not disclose query-bearing URL or search values in composed operational logs', async () => {
      let logBuffer = '';
      const { Writable } = await import('node:stream');
      const captureStream = new Writable({
        write(chunk, _enc, cb) {
          logBuffer += chunk.toString();
          cb();
        },
      });

      const loggedApp = await buildApp({
        db: pool,
        cookieSecret: 'test-secret-at-least-32-chars-long-12345',
        logger: { stream: captureStream, level: 'info' },
      });

      try {
        // 1. 200 OK request with query values
        const res200 = await loggedApp.inject({
          method: 'GET',
          url: '/assets/search?field=name&value=SECRET_SEARCH_VALUE',
          headers: { cookie: readonlyUser.cookie },
        });
        expect(res200.statusCode).toBe(200);

        // 2. 400 Bad request with unknown query key and value
        const res400 = await loggedApp.inject({
          method: 'GET',
          url: '/assets/search?untrusted_secret_key=untrusted_secret_val',
          headers: { cookie: custodianUser.cookie },
        });
        expect(res400.statusCode).toBe(400);

        // 3. 401 Unauthenticated
        const res401 = await loggedApp.inject({
          method: 'GET',
          url: '/assets/search?field=asset_number&value=SECRET_UNAUTH_VAL',
        });
        expect(res401.statusCode).toBe(401);

        // 4. 403 Forbidden
        const res403 = await loggedApp.inject({
          method: 'GET',
          url: '/assets/search?field=asset_number&value=SECRET_FORBIDDEN_VAL',
          headers: { cookie: maintainerUser.cookie },
        });
        expect(res403.statusCode).toBe(403);

        // 5. 500 Internal Server Error (genuine database/service failure on composed app)
        const originalSearchAssets = (loggedApp as any).assetService.searchAssets;
        (loggedApp as any).assetService.searchAssets = async () => {
          throw new Error('Database query failure during search operation');
        };

        const res500 = await loggedApp.inject({
          method: 'GET',
          url: '/assets/search?field=name&value=SECRET_500_VAL',
          headers: { cookie: readonlyUser.cookie },
        });
        expect(res500.statusCode).toBe(500);
        expect(res500.body).not.toContain('SECRET_500_VAL');

        // Restore normal service behavior and verify normal recovery
        (loggedApp as any).assetService.searchAssets = originalSearchAssets;
        const resRecovery = await loggedApp.inject({
          method: 'GET',
          url: '/assets/search?field=asset_number&value=MON-DELL-001',
          headers: { cookie: readonlyUser.cookie },
        });
        expect(resRecovery.statusCode).toBe(200);

        // Verify that NO query string or query value was leaked to operational logs
        expect(logBuffer).not.toContain('SECRET_SEARCH_VALUE');
        expect(logBuffer).not.toContain('untrusted_secret_key');
        expect(logBuffer).not.toContain('untrusted_secret_val');
        expect(logBuffer).not.toContain('SECRET_UNAUTH_VAL');
        expect(logBuffer).not.toContain('SECRET_FORBIDDEN_VAL');
        expect(logBuffer).not.toContain('SECRET_500_VAL');
        expect(logBuffer).not.toContain('/assets/search?');
      } finally {
        await loggedApp.close();
      }
    });
  });
});
