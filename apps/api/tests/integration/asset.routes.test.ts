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
  }, 120_000);

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
    // Assignment facts restrict deleting their Asset (F003-T1), so they go first.
    await pool.query('DELETE FROM assignment_changes');
    await pool.query('DELETE FROM assignment_events');
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

      // 2. Custodian registers a legacy Asset WITH legacy OrganizationUnit text (D7), which becomes
      // its Initial Assignment with an unknown Effective Date (F003-T1)
      const regB = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Accounting Printer',
          is_legacy: true,
          legacy_organization_unit_text: 'Accounting Division',
          effective_date: null,
        },
      });
      expect(regB.statusCode).toBe(201);
      const idB = JSON.parse(regB.body).asset.id;

      // 3. Read-only user can view record A (no org unit)
      const readA = await app.inject({
        method: 'GET',
        url: `/assets/${idA}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(readA.statusCode).toBe(200);
      expect(JSON.parse(readA.body).asset.name).toBe('Office Common Projector');
      expect(JSON.parse(readA.body).current_assignment.organization_unit).toBeNull();
      expect(JSON.parse(readA.body).current_assignment.legacy_organization_unit_text).toBeNull();

      // 4. Administrator can view record B (specific org unit)
      const readB = await app.inject({
        method: 'GET',
        url: `/assets/${idB}`,
        headers: { cookie: adminUser.cookie },
      });
      expect(readB.statusCode).toBe(200);
      expect(JSON.parse(readB.body).current_assignment.legacy_organization_unit_text).toBe('Accounting Division');
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

  describe('T2: Asset Correction HTTP Routes & Security Matrix (P1–P3, Seam A)', () => {
    let testAssetId: string;

    beforeEach(async () => {
      // Create a base asset using custodian
      const regRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Base Test Asset',
          asset_number: 'ROUTE-BASE-01',
          serial_number: 'SN-BASE-01',
        },
      });
      expect(regRes.statusCode).toBe(201);
      testAssetId = JSON.parse(regRes.body).asset.id;
    });

    it('P1 Security Matrix: Administrator and Custodian can correct, others are denied (403/401)', async () => {
      const payload = {
        name: 'Corrected by Admin',
        expected_name: 'Base Test Asset',
        expected_asset_number: 'ROUTE-BASE-01',
        expected_serial_number: 'SN-BASE-01',
        reason: 'Admin correction check',
      };

      // 1. Administrator -> allowed (200)
      const adminRes = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload,
      });
      expect(adminRes.statusCode).toBe(200);
      const adminBody = JSON.parse(adminRes.body);
      expect(adminBody.asset.name).toBe('Corrected by Admin');
      expect(adminBody.history.action).toBe('CORRECTED');

      // 2. Asset Custodian (via PATCH) -> allowed (200)
      const custodianRes = await app.inject({
        method: 'PATCH',
        url: `/assets/${testAssetId}`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload: {
          name: 'Corrected by Custodian',
          expected_name: 'Corrected by Admin',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Custodian correction check',
        },
      });
      expect(custodianRes.statusCode).toBe(200);
      expect(JSON.parse(custodianRes.body).asset.name).toBe('Corrected by Custodian');

      // 3. Read-only user -> 403 Forbidden
      const readOnlyRes = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: readonlyUser.cookie,
          'x-csrf-token': readonlyUser.csrf,
        },
        payload: {
          name: 'Readonly Attempt',
          expected_name: 'Corrected by Custodian',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Unauthorized attempt',
        },
      });
      expect(readOnlyRes.statusCode).toBe(403);

      // 4. System maintainer -> 403 Forbidden
      const maintainerRes = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: maintainerUser.cookie,
          'x-csrf-token': maintainerUser.csrf,
        },
        payload: {
          name: 'Maintainer Attempt',
          expected_name: 'Corrected by Custodian',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Unauthorized attempt',
        },
      });
      expect(maintainerRes.statusCode).toBe(403);

      // 5. Unauthenticated -> 401 Unauthorized or 403 CSRF/Auth rejection
      const unauthRes = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        payload: {
          name: 'Unauth Attempt',
          expected_name: 'Corrected by Custodian',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Unauthorized attempt',
        },
      });
      expect([401, 403]).toContain(unauthRes.statusCode);
    });

    it('requires valid CSRF token on correction mutation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': 'bad-or-missing-csrf-token',
        },
        payload: {
          name: 'CSRF Test',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'CSRF failure test',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('validates strict schema and rejects unexpected fields with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload: {
          name: 'Unexpected Field Test',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Try injecting category and is_legacy',
          category: 'COMPUTERS',
          is_legacy: true,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('VALIDATION_FAILED');
    });

    it('rejects conflicting retry token headers and body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': 'header-token-123',
        },
        payload: {
          name: 'Conflict Token',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Conflicting tokens',
          retry_token: 'body-token-456',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('Conflicting retry token');
    });

    it('protects correction candidate preview GET /assets/:id/duplicate-candidates with asset:correct', async () => {
      // 1. Administrator (has asset:correct) can call
      const adminRes = await app.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/duplicate-candidates?asset_number=ROUTE-BASE-01`,
        headers: {
          cookie: adminUser.cookie,
        },
      });
      expect(adminRes.statusCode).toBe(200);
      const body = JSON.parse(adminRes.body);
      // Because it self-excludes testAssetId, candidates count is 0
      expect(body.candidates).toEqual([]);
      expect(body.total_count).toBe(0);

      // 2. Read-only user cannot call (403)
      const readOnlyRes = await app.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/duplicate-candidates?asset_number=ROUTE-BASE-01`,
        headers: {
          cookie: readonlyUser.cookie,
        },
      });
      expect(readOnlyRes.statusCode).toBe(403);
    });

    it('handles idempotent retries over HTTP with Idempotency-Key header', async () => {
      const retryToken = 'http-correct-token-' + crypto.randomUUID();
      const payload = {
        name: 'HTTP Idempotency Name',
        expected_name: 'Base Test Asset',
        expected_asset_number: 'ROUTE-BASE-01',
        expected_serial_number: 'SN-BASE-01',
        reason: 'HTTP token idempotency test',
      };

      // First call
      const res1 = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'idempotency-key': retryToken,
        },
        payload,
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      const historyId1 = body1.history.id;

      // Replay call with same token
      const res2 = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'idempotency-key': retryToken,
        },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.history.id).toBe(historyId1);
    });

    it('dynamically enforces role revocation on retry attempt (403)', async () => {
      // Dedicated admin for revocation test
      const ephemeralPassword = await UserService.hashPassword('Password123!');
      const ephemeralUserRes = await pool.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('u_revocation_test', '${ephemeralPassword}', true)
        RETURNING id;
      `);
      const ephemeralUserId = ephemeralUserRes.rows[0].id;
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')",
        [ephemeralUserId]
      );
      const ephemeralSession = await createAuthenticatedSession(ephemeralUserId);

      // Perform first correction
      const retryToken = 'revocation-token-' + crypto.randomUUID();
      const res1 = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: ephemeralSession.cookie,
          'x-csrf-token': ephemeralSession.csrf,
          'idempotency-key': retryToken,
        },
        payload: {
          name: 'Before Revocation',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Test revocation',
        },
      });
      expect(res1.statusCode).toBe(200);

      // Revoke ADMINISTRATOR role in PostgreSQL
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [ephemeralUserId]);

      // Attempt retry with same token -> Must be denied with 403 Forbidden!
      const res2 = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: ephemeralSession.cookie,
          'x-csrf-token': ephemeralSession.csrf,
          'idempotency-key': retryToken,
        },
        payload: {
          name: 'Before Revocation',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Test revocation',
        },
      });
      expect(res2.statusCode).toBe(403);
    });

    it('rejects payload with 400 VALIDATION_FAILED when expected-before own properties are omitted', async () => {
      // Omit expected_name
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload: {
          name: 'Some Name',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Missing expected_name',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('allows no-op correction without reason (200 OK, noop: true)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload: {
          name: 'Base Test Asset',
          asset_number: 'ROUTE-BASE-01',
          serial_number: 'SN-BASE-01',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.noop).toBe(true);
      expect(body.history).toBeNull();
    });

    it('preserves verbatim spacing in identifiers through route boundary', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload: {
          name: 'Base Test Asset',
          asset_number: '  SPACED-NUM  ',
          serial_number: '  SPACED-SN  ',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Verbatim spacing route test',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.asset.asset_number).toBe('  SPACED-NUM  ');
      expect(body.asset.serial_number).toBe('  SPACED-SN  ');
    });

    it('rejects correction with 400 VALIDATION_FAILED when retry token is omitted from both header and body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
        },
        payload: {
          name: 'Missing Token Asset',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'No token passed in header or body',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.message).toContain('Correction retry token is required and must be a nonblank string');
    });

    it('rejects correction with 400 VALIDATION_FAILED when retry token is whitespace-only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/assets/${testAssetId}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': '   ',
        },
        payload: {
          name: 'Blank Token Asset',
          expected_name: 'Base Test Asset',
          expected_asset_number: 'ROUTE-BASE-01',
          expected_serial_number: 'SN-BASE-01',
          reason: 'Blank whitespace token passed',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.message).toContain('Correction retry token is required and must be a nonblank string');
    });

    it('handles competing corrections with distinct valid tokens over HTTP: one commits (200), competitor rejected (409 STALE_BEFORE_CONFLICT)', async () => {
      // Create a fresh asset using custodian (who has asset:register permission)
      const createRes = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': crypto.randomUUID(),
        },
        payload: {
          name: 'Route Race Asset',
          asset_number: 'RACE-001',
          serial_number: 'SN-RACE-001',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const raceAssetId = JSON.parse(createRes.body).asset.id;

      const tokenA = 'race-token-' + crypto.randomUUID();
      const tokenB = 'race-token-' + crypto.randomUUID();

      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/assets/${raceAssetId}/correct`,
          headers: {
            cookie: adminUser.cookie,
            'x-csrf-token': adminUser.csrf,
            'x-retry-token': tokenA,
          },
          payload: {
            name: 'Route Winner A',
            expected_name: 'Route Race Asset',
            expected_asset_number: 'RACE-001',
            expected_serial_number: 'SN-RACE-001',
            reason: 'Route race contestant A',
          },
        }),
        app.inject({
          method: 'POST',
          url: `/assets/${raceAssetId}/correct`,
          headers: {
            cookie: adminUser.cookie,
            'x-csrf-token': adminUser.csrf,
            'x-retry-token': tokenB,
          },
          payload: {
            name: 'Route Winner B',
            expected_name: 'Route Race Asset',
            expected_asset_number: 'RACE-001',
            expected_serial_number: 'SN-RACE-001',
            reason: 'Route race contestant B',
          },
        }),
      ]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const winnerRes = resA.statusCode === 200 ? resA : resB;
      const loserRes = resA.statusCode === 409 ? resA : resB;
      const winningToken = resA.statusCode === 200 ? tokenA : tokenB;
      const losingToken = resA.statusCode === 409 ? tokenA : tokenB;

      const winnerBody = JSON.parse(winnerRes.body);
      const loserBody = JSON.parse(loserRes.body);

      expect(loserBody.code).toBe('STALE_BEFORE_CONFLICT');

      // Verify no lost update in database
      const dbAsset = await pool.query('SELECT name FROM assets WHERE id = $1', [raceAssetId]);
      expect(dbAsset.rows[0].name).toBe(winnerBody.asset.name);

      // Exactly one CORRECTED audit record in database
      const histRes = await pool.query(
        "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [raceAssetId]
      );
      expect(histRes.rows[0].count).toBe(1);

      // Exactly one scoped committed token ledger entry
      const tokenWinRes = await pool.query(
        'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
        [winningToken]
      );
      expect(tokenWinRes.rows[0].count).toBe(1);

      const tokenLoseRes = await pool.query(
        'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
        [losingToken]
      );
      expect(tokenLoseRes.rows[0].count).toBe(0);
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

        // Strict projection, the one place that pins a search row's exact fields (#78 retro): id, name,
        // asset_number, serial_number and, since T4, the reference context; since F004-T4 (#78), On Loan
        // and, since F005-T2 (#100), the Start Loan warning that replaced the latest Loan Return's Condition
        expect(Object.keys(body.items[0]).sort()).toEqual([
          'asset_number',
          'id',
          'legacy_location_text',
          'legacy_organization_unit_text',
          'legacy_responsible_person_text',
          'location',
          'name',
          'on_loan',
          'organization_unit',
          'responsible_person',
          'serial_number',
          'start_loan_warning',
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

  describe('GET /assets/:id/qr-label Integration & Security Tests (Seam A - T8)', () => {
    let qrApp: FastifyInstance;
    let testAssetId: string;

    beforeAll(async () => {
      qrApp = await buildApp({
        db: pool,
        cookieSecret: 'test-secret-at-least-32-chars-long-12345',
        publicAppOrigin: 'http://localhost:3000',
        logger: false,
      });
    });

    beforeEach(async () => {
      // Insert an asset for testing in each test (since outer beforeEach clears assets)
      const insertRes = await pool.query(
        `INSERT INTO assets (
          name, asset_number, serial_number, registered_by, category
        ) VALUES (
          'Test QR Asset', 'QR-ASSET-001', 'SN-QR-999', $1, NULL
        ) RETURNING id;`,
        [custodianUser.id]
      );
      testAssetId = insertRes.rows[0].id;
    });

    afterAll(async () => {
      if (qrApp) {
        await qrApp.close();
      }
    });

    it('returns HTTP 503 SERVICE_UNAVAILABLE with Cache-Control: no-store when PUBLIC_APP_ORIGIN is not configured', async () => {
      // Default app does NOT have publicAppOrigin configured
      const res = await app.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: custodianUser.cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(res.body);
      expect(body.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error).toBe('SERVICE_UNAVAILABLE');
      expect(body.message).toBe('Public application origin is not configured');
    });

    it('enforces RBAC matrix under asset:view capability (Admin, Custodian, Read-only allowed; Maintainer, unauthenticated, inactive denied)', async () => {
      // 1. Custodian (has asset:view) -> 200 OK
      const resCustodian = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resCustodian.statusCode).toBe(200);

      // 2. Administrator (has asset:view) -> 200 OK
      const resAdmin = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: adminUser.cookie },
      });
      expect(resAdmin.statusCode).toBe(200);

      // 3. Read-only user (has asset:view) -> 200 OK
      const resReadOnly = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(resReadOnly.statusCode).toBe(200);

      // 4. Maintainer alone (lacks asset:view) -> 403 Forbidden
      const resMaintainer = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: maintainerUser.cookie },
      });
      expect(resMaintainer.statusCode).toBe(403);
      expect(resMaintainer.headers['cache-control']).toBe('no-store');

      // 5. Unauthenticated -> 401 Unauthorized
      const resUnauth = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
      });
      expect(resUnauth.statusCode).toBe(401);
      expect(resUnauth.headers['cache-control']).toBe('no-store');

      // 6. Inactive user -> 403 Forbidden
      const resInactive = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: inactiveUser.cookie },
      });
      expect([401, 403]).toContain(resInactive.statusCode);
      expect(resInactive.headers['cache-control']).toBe('no-store');
    });

    it('returns 200 with strictly shaped payload matching { id, locator, name, asset_number, serial_number }', async () => {
      const res = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: readonlyUser.cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        id: testAssetId,
        locator: `http://localhost:3000/assets/${testAssetId}`,
        name: 'Test QR Asset',
        asset_number: 'QR-ASSET-001',
        serial_number: 'SN-QR-999',
      });
      expect(Object.keys(body).sort()).toEqual([
        'asset_number',
        'id',
        'locator',
        'name',
        'serial_number',
      ]);
    });

    it('rejects invalid UUID formats with 400 INVALID_ID and Cache-Control: no-store', async () => {
      const res = await qrApp.inject({
        method: 'GET',
        url: '/assets/invalid-uuid-string/qr-label',
        headers: { cookie: custodianUser.cookie },
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_ID');
      expect(body.error).toBe('INVALID_ID');
      expect(body.message).toBe('Asset ID must be a valid UUID string');
    });

    it('returns 404 NOT_FOUND and Cache-Control: no-store when asset does not exist', async () => {
      const nonexistentId = '00000000-0000-4000-a000-000000000999';
      const res = await qrApp.inject({
        method: 'GET',
        url: `/assets/${nonexistentId}/qr-label`,
        headers: { cookie: custodianUser.cookie },
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(res.body);
      expect(body.code).toBe('NOT_FOUND');
      expect(body.error).toBe('NOT_FOUND');
      expect(body.message).toBe('Asset not found');
    });

    it('remains strictly immune to hostile Host, Forwarded, and X-Forwarded headers', async () => {
      const res = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: {
          cookie: custodianUser.cookie,
          host: 'evil-attacker.example.com',
          'x-forwarded-host': 'evil-attacker.example.com',
          'x-forwarded-proto': 'https',
          forwarded: 'host=evil-attacker.example.com;proto=https',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.locator).toBe(`http://localhost:3000/assets/${testAssetId}`);
      expect(body.locator).not.toContain('evil-attacker');
    });

    it('enforces Cache-Control: no-store on simulated 500 error', async () => {
      const originalGetAsset = (qrApp as any).assetService.getAssetById;
      try {
        (qrApp as any).assetService.getAssetById = async () => {
          throw new Error('Simulated database breakdown during qr-label');
        };

        const res500 = await qrApp.inject({
          method: 'GET',
          url: `/assets/${testAssetId}/qr-label`,
          headers: { cookie: custodianUser.cookie },
        });

        expect(res500.statusCode).toBe(500);
        expect(res500.headers['cache-control']).toBe('no-store');
      } finally {
        (qrApp as any).assetService.getAssetById = originalGetAsset;
      }
    });

    it('rejects padded or whitespace UUIDs with 400 INVALID_ID while accepting uppercase UUIDs and returning canonical lowercase', async () => {
      // 1. Padded/whitespace UUID with %20 -> 400 INVALID_ID
      const paddedRes = await qrApp.inject({
        method: 'GET',
        url: `/assets/%20${testAssetId}%20/qr-label`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(paddedRes.statusCode).toBe(400);
      expect(paddedRes.headers['cache-control']).toBe('no-store');
      const paddedBody = JSON.parse(paddedRes.body);
      expect(paddedBody.code).toBe('INVALID_ID');

      // 2. Uppercase UUID -> 200 OK with canonical lowercase id in response
      const uppercaseId = testAssetId.toUpperCase();
      const upperRes = await qrApp.inject({
        method: 'GET',
        url: `/assets/${uppercaseId}/qr-label`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(upperRes.statusCode).toBe(200);
      expect(upperRes.headers['cache-control']).toBe('no-store');
      const upperBody = JSON.parse(upperRes.body);
      expect(upperBody.id).toBe(testAssetId.toLowerCase());
      expect(upperBody.locator).toBe(`http://localhost:3000/assets/${testAssetId.toLowerCase()}`);
    });

    it('performs zero mutations in assets, asset_history, and retry tokens (row counts and asset field/timestamp immutability)', async () => {
      const getAssetSnapshot = async () => {
        const res = await pool.query('SELECT * FROM assets WHERE id = $1', [testAssetId]);
        return res.rows[0];
      };

      const countQuery = async () => {
        const assetsCount = await pool.query('SELECT COUNT(*) FROM assets');
        const historyCount = await pool.query('SELECT COUNT(*) FROM asset_history');
        const retryCount = await pool.query('SELECT COUNT(*) FROM registration_retry_tokens');
        return {
          assets: Number(assetsCount.rows[0].count),
          history: Number(historyCount.rows[0].count),
          retry: Number(retryCount.rows[0].count),
        };
      };

      const beforeCounts = await countQuery();
      const beforeSnapshot = await getAssetSnapshot();

      const res = await qrApp.inject({
        method: 'GET',
        url: `/assets/${testAssetId}/qr-label`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(res.statusCode).toBe(200);

      const afterCounts = await countQuery();
      const afterSnapshot = await getAssetSnapshot();

      expect(afterCounts.assets).toBe(beforeCounts.assets);
      expect(afterCounts.history).toBe(beforeCounts.history);
      expect(afterCounts.retry).toBe(beforeCounts.retry);
      expect(afterSnapshot).toEqual(beforeSnapshot);
    });
  });

  describe('T5: Acquisition Linking & Read Suppression on Asset Routes', () => {
    let linkedAcqId: string;

    beforeAll(async () => {
      const acqRes = await pool.query(`
        INSERT INTO acquisitions (acquisition_type, source_reference, created_by)
        VALUES ('จัดซื้อปกติ', 'REF-ROUTE-LINK-01', '${custodianUser.id}')
        RETURNING id;
      `);
      linkedAcqId = acqRes.rows[0].id;
    });

    it('successfully registers an asset with acquisition_id and returns acquisition_id in response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Acquisition Linked Asset',
          asset_number: 'AST-ACQ-LINK-001',
          serial_number: 'SN-ACQ-LINK-001',
          acquisition_id: linkedAcqId,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.asset.acquisition_id).toBe(linkedAcqId);

      // Verify GET /assets/:id by custodian (who has acquisition:view) discloses acquisition_id
      const getRes = await app.inject({
        method: 'GET',
        url: `/assets/${body.asset.id}`,
        headers: {
          cookie: custodianUser.cookie,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body);
      expect(getBody.asset.acquisition_id).toBe(linkedAcqId);
    });

    it('rejects registration with invalid or nonexistent acquisition_id', async () => {
      // Invalid UUID
      const resInvalid = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Invalid UUID Asset',
          asset_number: 'AST-INV-001',
          acquisition_id: 'not-a-uuid',
        },
      });
      expect(resInvalid.statusCode).toBe(400);

      // Nonexistent UUID
      const resNonexistent = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Nonexistent UUID Asset',
          asset_number: 'AST-NON-001',
          acquisition_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      });
      expect(resNonexistent.statusCode).toBe(400);
    });
  });

  describe('POST /assets/bulk-register (Seam A - Routes & D3 Security)', () => {
    const validItemKey1 = '11111111-1111-4111-8111-111111111111';
    const validItemKey2 = '22222222-2222-4222-8222-222222222222';

    it('requires authentication (fails closed with 401 or 403 for unauthenticated requests)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          'x-retry-token': 'auth-test-token',
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item 1' }],
        },
      });
      expect([401, 403]).toContain(res.statusCode);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('enforces D3 capability matrix: ASSET_CUSTODIAN allowed, ADMINISTRATOR, READ_ONLY, and MAINTAINER denied 403', async () => {
      const payload = {
        items: [{ item_key: validItemKey1, name: 'D3 Matrix Test Asset' }],
      };

      // 1. ASSET_CUSTODIAN: succeeds (201)
      const resCustodian = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'd3-custodian-token',
        },
        payload,
      });
      expect(resCustodian.statusCode).toBe(201);
      expect(resCustodian.headers['cache-control']).toBe('no-store');
      const bodyCustodian = JSON.parse(resCustodian.body);
      expect(bodyCustodian.total_registered).toBe(1);

      // 2. ADMINISTRATOR: denied (403)
      const resAdmin = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
          'x-retry-token': 'd3-admin-token',
        },
        payload,
      });
      expect(resAdmin.statusCode).toBe(403);
      expect(resAdmin.headers['cache-control']).toBe('no-store');

      // 3. READ_ONLY: denied (403)
      const resReadOnly = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: readonlyUser.cookie,
          'x-csrf-token': readonlyUser.csrf,
          'x-retry-token': 'd3-readonly-token',
        },
        payload,
      });
      expect(resReadOnly.statusCode).toBe(403);
      expect(resReadOnly.headers['cache-control']).toBe('no-store');

      // 4. SYSTEM_MAINTAINER: denied (403)
      const resMaintainer = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: maintainerUser.cookie,
          'x-csrf-token': maintainerUser.csrf,
          'x-retry-token': 'd3-maintainer-token',
        },
        payload,
      });
      expect(resMaintainer.statusCode).toBe(403);
      expect(resMaintainer.headers['cache-control']).toBe('no-store');
    });

    it('validates x-retry-token header presence, non-emptiness, and max length', async () => {
      // Missing x-retry-token
      const resMissing = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item 1' }],
        },
      });
      expect(resMissing.statusCode).toBe(400);
      expect(resMissing.headers['cache-control']).toBe('no-store');

      // Blank x-retry-token
      const resBlank = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': '   ',
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item 1' }],
        },
      });
      expect(resBlank.statusCode).toBe(400);

      // Over 128 characters
      const resTooLong = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'a'.repeat(129),
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item 1' }],
        },
      });
      expect(resTooLong.statusCode).toBe(400);
    });

    it('rejects batch with 0 items, > 100 items, or duplicate item_keys', async () => {
      // 0 items
      const resZero = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'validation-zero-items',
        },
        payload: {
          items: [],
        },
      });
      expect(resZero.statusCode).toBe(400);

      // > 100 items
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        item_key: `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`,
        name: `Item ${i + 1}`,
      }));
      const resTooMany = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'validation-too-many',
        },
        payload: {
          items: tooMany,
        },
      });
      expect(resTooMany.statusCode).toBe(400);

      // Duplicate item_keys
      const resDupKey = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'validation-dup-keys',
        },
        payload: {
          items: [
            { item_key: validItemKey1, name: 'Item 1' },
            { item_key: validItemKey1, name: 'Item 2' },
          ],
        },
      });
      expect(resDupKey.statusCode).toBe(400);
    });

    it('rejects unexpected fields at top level or item level', async () => {
      // Unexpected top-level field
      const resRootUnknown = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'unknown-field-token-1',
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item 1' }],
          extra_field: 'illegal',
        },
      });
      expect(resRootUnknown.statusCode).toBe(400);

      // Unexpected item-level field
      const resItemUnknown = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'unknown-field-token-2',
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item 1', bad_prop: 123 }],
        },
      });
      expect(resItemUnknown.statusCode).toBe(400);
    });

    it('handles duplicate warnings (409) and allows continuation when explicit_continuation is true', async () => {
      // First, register an asset
      await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'seed-single-for-bulk-dup',
        },
        payload: {
          name: 'Existing Single Asset',
          asset_number: 'AST-ROUTE-DUP-1',
        },
      });

      // Try bulk registering item with the same asset_number without continuation
      const resConflict = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'conflict-bulk-token',
        },
        payload: {
          items: [
            {
              item_key: validItemKey1,
              name: 'Duplicate Candidate Asset',
              asset_number: 'AST-ROUTE-DUP-1',
            },
          ],
          explicit_continuation: false,
        },
      });
      expect(resConflict.statusCode).toBe(409);
      expect(resConflict.headers['cache-control']).toBe('no-store');
      const conflictBody = JSON.parse(resConflict.body);
      expect(conflictBody.code).toBe('DUPLICATE_CANDIDATES_FOUND');
      expect(conflictBody.warnings).toBeDefined();
      expect(conflictBody.warnings[0].field).toBe('asset_number');
      expect(conflictBody.warnings[0].value).toBe('AST-ROUTE-DUP-1');

      // Now register with explicit_continuation = true
      const resContinued = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'continued-bulk-token',
        },
        payload: {
          items: [
            {
              item_key: validItemKey1,
              name: 'Duplicate Candidate Asset',
              asset_number: 'AST-ROUTE-DUP-1',
            },
          ],
          explicit_continuation: true,
        },
      });
      expect(resContinued.statusCode).toBe(201);
      const continuedBody = JSON.parse(resContinued.body);
      expect(continuedBody.total_registered).toBe(1);
    });

    it('enforces retry token idempotency contract across identical retries and conflicting payloads', async () => {
      const token = 'route-bulk-retry-token-100';
      const payload = {
        items: [
          {
            item_key: validItemKey1,
            name: 'Bulk Item A',
            asset_number: 'AST-ROUTE-RETRY-A',
          },
          {
            item_key: validItemKey2,
            name: 'Bulk Item B',
            asset_number: 'AST-ROUTE-RETRY-B',
          },
        ],
      };

      // 1. Initial request succeeds
      const res1 = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': token,
        },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const body1 = JSON.parse(res1.body);

      // 2. Identical retry returns 201 with identical body
      const res2 = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': token,
        },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const body2 = JSON.parse(res2.body);
      expect(body2).toEqual(body1);

      // 3. Changed payload with same token returns 409 RETRY_TOKEN_PAYLOAD_MISMATCH
      const resConflict = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': token,
        },
        payload: {
          items: [
            {
              item_key: validItemKey1,
              name: 'Different Name Here',
              asset_number: 'AST-ROUTE-RETRY-A',
            },
          ],
        },
      });
      expect(resConflict.statusCode).toBe(409);
      expect(resConflict.headers['cache-control']).toBe('no-store');
      const conflictBody = JSON.parse(resConflict.body);
      expect(conflictBody.code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });

    it('links optional acquisition when provided and applies to all items in batch', async () => {
      const acqRes = await pool.query(`
        INSERT INTO acquisitions (acquisition_type, source_reference, created_by)
        VALUES ('BulkAcquisition', 'REF-BULK-LINK-01', '${custodianUser.id}')
        RETURNING id;
      `);
      const acqId = acqRes.rows[0].id;

      const res = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'bulk-with-acq-token',
        },
        payload: {
          acquisition_id: acqId,
          items: [
            { item_key: validItemKey1, name: 'Item Linked 1' },
            { item_key: validItemKey2, name: 'Item Linked 2' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.shared_acquisition_id).toBe(acqId);
      expect(body.results).toHaveLength(2);
    });

    it('rejects payload exceeding 1 MiB body limit with 413 and Cache-Control: no-store', async () => {
      const hugeString = 'x'.repeat(1024 * 1024 + 100);
      const res = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'huge-payload-token',
        },
        payload: {
          items: [
            {
              item_key: validItemKey1,
              name: 'Huge Payload Item',
              source_notes: hugeString,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(413);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('rejects contradictory body retry_token (including empty string) with 400', async () => {
      const token = 'header-token-contract-01';

      // 1. Contradictory token with empty string
      const resEmpty = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': token,
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item Token Test 1' }],
          retry_token: '',
        },
      });
      expect(resEmpty.statusCode).toBe(400);
      const bodyEmpty = JSON.parse(resEmpty.body);
      expect(bodyEmpty.message).toContain(
        'x-retry-token header and body retry_token must match'
      );

      // 2. Contradictory token with mismatched value
      const resMismatch = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': token,
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item Token Test 2' }],
          retry_token: 'mismatched-body-token',
        },
      });
      expect(resMismatch.statusCode).toBe(400);
      const bodyMismatch = JSON.parse(resMismatch.body);
      expect(bodyMismatch.message).toContain(
        'x-retry-token header and body retry_token must match'
      );

      // 3. Matching token succeeds
      const resMatch = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': token,
        },
        payload: {
          items: [{ item_key: validItemKey1, name: 'Item Token Test 3' }],
          retry_token: token,
        },
      });
      expect(resMatch.statusCode).toBe(201);
    });

    it('rejects replay after capability revocation with 403', async () => {
      const replayToken = 'revoked-replay-token-01';
      const payload = {
        items: [{ item_key: validItemKey2, name: 'Revocation Test Item' }],
      };

      // 1. Initial execution succeeds as custodian
      const res1 = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': replayToken,
        },
        payload,
      });
      expect(res1.statusCode).toBe(201);

      // 2. Revoke ASSET_CUSTODIAN role from custodianUser
      await pool.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ASSET_CUSTODIAN'`,
        [custodianUser.id]
      );

      try {
        // 3. Replay with same retry token is rejected with 403 Forbidden
        const resReplay = await app.inject({
          method: 'POST',
          url: '/assets/bulk-register',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': replayToken,
          },
          payload,
        });
        expect(resReplay.statusCode).toBe(403);
      } finally {
        // Restore role
        await pool.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
          [custodianUser.id]
        );
      }
    });

    it('enforces CSRF protection: rejects bulk registration requests with missing or invalid x-csrf-token with 403 Forbidden', async () => {
      // 1. Missing CSRF token
      const resMissing = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-retry-token': 'csrf-bulk-test-token-1',
        },
        payload: {
          items: [{ item_key: crypto.randomUUID(), name: 'CSRF Missing Asset' }],
        },
      });
      expect(resMissing.statusCode).toBe(403);
      expect(resMissing.headers['cache-control']).toBe('no-store');

      // 2. Invalid CSRF token
      const resInvalid = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': 'invalid-csrf-token-bytes',
          'x-retry-token': 'csrf-bulk-test-token-2',
        },
        payload: {
          items: [{ item_key: crypto.randomUUID(), name: 'CSRF Invalid Asset' }],
        },
      });
      expect(resInvalid.statusCode).toBe(403);
      expect(resInvalid.headers['cache-control']).toBe('no-store');
    });

    it('enforces actor and operation retry token isolation', async () => {
      // Create a second custodian user
      const otherPass = await UserService.hashPassword('Pass123!');
      const userRes = await pool.query(
        `INSERT INTO users (username, password_hash, is_active) VALUES ('other_custodian_iso', $1, true) RETURNING id`,
        [otherPass]
      );
      const otherCustodianId = userRes.rows[0].id;
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
        [otherCustodianId]
      );
      const otherCustodianUser = await createAuthenticatedSession(otherCustodianId);

      const sharedToken = `iso-token-${crypto.randomUUID()}`;
      const payload1 = {
        items: [{ item_key: crypto.randomUUID(), name: 'Custodian 1 Isolated Asset' }],
      };

      // 1. Custodian 1 registers successfully with sharedToken
      const res1 = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': sharedToken,
        },
        payload: payload1,
      });
      expect(res1.statusCode).toBe(201);
      const res1Body = JSON.parse(res1.body);
      const asset1Id = res1Body.results[0].asset_id;

      // 2. Custodian 2 uses the same retry token string:
      // Actor isolation ensures Custodian 2 does NOT hijack Custodian 1's replay or response,
      // but executes independently under their own actor-scoped token partition.
      const resOtherActor = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: otherCustodianUser.cookie,
          'x-csrf-token': otherCustodianUser.csrf,
          'x-retry-token': sharedToken,
        },
        payload: {
          items: [{ item_key: crypto.randomUUID(), name: 'Custodian 2 Isolated Asset' }],
        },
      });
      expect(resOtherActor.statusCode).toBe(201);
      const resOtherBody = JSON.parse(resOtherActor.body);
      const assetOtherId = resOtherBody.results[0].asset_id;
      expect(assetOtherId).not.toBe(asset1Id);

      // Verify both tokens exist in DB isolated by actor_id
      const tokensInDb = await pool.query(
        `SELECT actor_id, operation, token FROM registration_retry_tokens WHERE token = $1`,
        [sharedToken]
      );
      expect(tokensInDb.rows).toHaveLength(2);
      expect(tokensInDb.rows.map((r: any) => r.actor_id)).toContain(custodianUser.id);
      expect(tokensInDb.rows.map((r: any) => r.actor_id)).toContain(otherCustodianId);

      // 3. Operation isolation: retry token registered for single-asset register (operation: 'asset:register')
      // is isolated from bulk-register (operation: 'asset:bulk-register').
      const singleOpToken = `single-op-token-${crypto.randomUUID()}`;
      const resSingle = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': singleOpToken,
        },
        payload: {
          name: 'Single Asset Token Op',
        },
      });
      expect(resSingle.statusCode).toBe(201);

      const resBulkWithSingleToken = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': singleOpToken,
        },
        payload: {
          items: [{ item_key: crypto.randomUUID(), name: 'Bulk Cross Op Reuse' }],
        },
      });
      expect(resBulkWithSingleToken.statusCode).toBe(201);

      // 4. Within the same actor and operation, conflicting payload produces 409
      const resConflict = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': sharedToken,
        },
        payload: {
          items: [{ item_key: crypto.randomUUID(), name: 'Different Payload Conflict' }],
        },
      });
      expect(resConflict.statusCode).toBe(409);
    });

    it('supports acquisition-free truthful legacy bulk registration with null shared_acquisition_id and proper history entry', async () => {
      const itemKey = crypto.randomUUID();
      const legacyPayload = {
        acquisition_id: null,
        items: [
          {
            item_key: itemKey,
            name: 'Acquisition Free Legacy Asset',
            asset_number: `AST-ACQFREE-LEG-${Date.now()}`,
            is_legacy: true,
            source_reference: 'Pre-system inventory sheet #4',
            source_notes: 'Found in storage archive B',
          },
        ],
      };

      const res = await app.inject({
        method: 'POST',
        url: '/assets/bulk-register',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': `acqfree-legacy-${crypto.randomUUID()}`,
        },
        payload: legacyPayload,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.total_registered).toBe(1);
      expect(body.shared_acquisition_id).toBeNull();
      expect(body.results).toHaveLength(1);
      const createdAssetId = body.results[0].asset_id;

      // Verify in DB that asset has acquisition_id null
      const assetRow = await pool.query(
        `SELECT id, name, asset_number, serial_number, acquisition_id FROM assets WHERE id = $1`,
        [createdAssetId]
      );
      expect(assetRow.rows[0].acquisition_id).toBeNull();

      // Verify history row records REGISTERED action and is_legacy: true in payload
      const histRow = await pool.query(
        `SELECT action, actor_id, payload FROM asset_history WHERE asset_id = $1`,
        [createdAssetId]
      );
      expect(histRow.rows).toHaveLength(1);
      expect(histRow.rows[0].action).toBe('REGISTERED');
      expect(histRow.rows[0].payload.is_legacy).toBe(true);
      expect(histRow.rows[0].payload.acquisition_id).toBeUndefined();
    });
  });
});
