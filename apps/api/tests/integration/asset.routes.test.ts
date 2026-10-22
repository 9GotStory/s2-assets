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
    const cookie = `session=${session.token}`;

    // Get CSRF token via session-check
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session-check',
      headers: { cookie },
    });
    const body = JSON.parse(res.body);
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
    await pool.query(`
      INSERT INTO user_roles (user_id, role_id) VALUES
        ('${userMap.get('u_custodian')}', 'ASSET_CUSTODIAN'),
        ('${userMap.get('u_admin')}', 'ADMINISTRATOR'),
        ('${userMap.get('u_readonly')}', 'READ_ONLY'),
        ('${userMap.get('u_maintainer')}', 'SYSTEM_MAINTAINER'),
        ('${userMap.get('u_combined')}', 'ADMINISTRATOR'),
        ('${userMap.get('u_combined')}', 'ASSET_CUSTODIAN'),
        ('${userMap.get('u_inactive')}', 'ASSET_CUSTODIAN');
    `);

    const loginAndGetSession = async (username: string, userId: string) => {
      const cookieMap = new Map<string, string>();
      const addCookies = (res: any) => {
        const raw = res.headers['set-cookie'];
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const c of list) {
          const part = c.split(';')[0];
          const name = part.split('=')[0];
          cookieMap.set(name, part);
        }
      };

      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username, password: 'Password123!' },
      });
      addCookies(loginRes);

      const checkRes = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
        headers: { cookie: Array.from(cookieMap.values()).join('; ') },
      });
      addCookies(checkRes);

      const checkBody = JSON.parse(checkRes.body);
      return {
        id: userId,
        cookie: Array.from(cookieMap.values()).join('; '),
        csrf: checkBody.csrfToken || '',
      };
    };

    custodianUser = await loginAndGetSession('u_custodian', userMap.get('u_custodian')!);
    adminUser = await loginAndGetSession('u_admin', userMap.get('u_admin')!);
    readonlyUser = await loginAndGetSession('u_readonly', userMap.get('u_readonly')!);
    maintainerUser = await loginAndGetSession('u_maintainer', userMap.get('u_maintainer')!);
    combinedUser = await loginAndGetSession('u_combined', userMap.get('u_combined')!);
    ordinaryUser = await loginAndGetSession('u_ordinary', userMap.get('u_ordinary')!);

    // Inactive user: cannot login via normal endpoint (USER_DISABLED)
    // create session directly and test access
    const inactSess = await sessionService.createSession(userMap.get('u_inactive')!);
    // Using signed cookie helper from fastify
    const signedCookie = (app as any).signCookie
      ? `session=${(app as any).signCookie(inactSess.token)}`
      : `session=${inactSess.token}`;
    inactiveUser = {
      id: userMap.get('u_inactive')!,
      cookie: signedCookie,
      csrf: 'any-csrf',
    };
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await pool.end();
    if (container) {
      await container.stop();
    }
  }, 30_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM registration_retry_tokens');
    await pool.query('DELETE FROM asset_history');
    await pool.query('DELETE FROM assets');
  });

  describe('R3: Role/Action Matrix Enforcement', () => {
    it('Asset Custodian: permits duplicate lookup, registration, and detail reading', async () => {
      // 1. Duplicate candidates lookup -> 200
      const dupRes = await app.inject({
        method: 'GET',
        url: '/assets/duplicate-candidates?asset_number=TEST-100',
        headers: { cookie: custodianUser.cookie },
      });
      expect(dupRes.statusCode).toBe(200);

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

    it('Current role revocation: revoking role immediately denies access on next request', async () => {
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

      // Restore role for subsequent tests
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
        custodianUser.id,
        'ASSET_CUSTODIAN',
      ]);
    });

    it('CSRF protection: rejects state-changing POST /assets when CSRF token is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          // Omitting x-csrf-token header
        },
        payload: { name: 'CSRF Missing Asset' },
      });
      expect(res.statusCode).toBe(403);
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
          organization_unit: null,
        },
      });
      const idA = JSON.parse(regA.body).asset.id;

      // 2. Custodian registers Asset WITH OrganizationUnit
      const regB = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Accounting Printer',
          organization_unit: 'Accounting Division',
        },
      });
      const idB = JSON.parse(regB.body).asset.id;

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

  describe('D2/D4: Duplicate Warning and Retry Token HTTP Contract', () => {
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
  });
});
