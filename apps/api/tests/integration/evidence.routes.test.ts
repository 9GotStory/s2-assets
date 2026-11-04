import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { buildApp } from '../../src/app.ts';
import { SessionService } from '../../src/services/session.service.ts';
import { UserService } from '../../src/services/user.service.ts';

const { Pool, Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

describe('Evidence Routes Integration Tests (Seam A - T7)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sessionService: SessionService;
  let databaseUrl: string;

  let custodianUser: { id: string; cookie: string; csrf: string };
  let adminUser: { id: string; cookie: string; csrf: string };
  let readonlyUser: { id: string; cookie: string; csrf: string };
  let maintainerUser: { id: string; cookie: string; csrf: string };

  let testAcquisitionId: string;
  let testAcquisition2Id: string;
  let testAsset1Id: string;
  let testAsset2Id: string;
  let testAsset3OtherAcqId: string;
  let testLegacyAssetId: string;

  const createAuthenticatedSession = async (userId: string) => {
    const session = await sessionService.createSession(userId);
    const sessionCookie = `session=${session.token}`;

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
    databaseUrl = container.getConnectionUri();

    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    pool = new Pool({ connectionString: databaseUrl });
    sessionService = new SessionService({ db: pool });

    app = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-evidence',
      logger: false,
    });

    const passwordHash = await UserService.hashPassword('Password123!');

    const createUserWithRole = async (username: string, role: string) => {
      const res = await pool.query(
        'INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash]
      );
      const userId = res.rows[0].id;
      await pool.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [userId, role]
      );
      return userId;
    };

    const cId = await createUserWithRole('custodian_ev', 'ASSET_CUSTODIAN');
    const aId = await createUserWithRole('admin_ev', 'ADMINISTRATOR');
    const rId = await createUserWithRole('readonly_ev', 'READ_ONLY');
    const mId = await createUserWithRole('maintainer_ev', 'SYSTEM_MAINTAINER');

    custodianUser = await createAuthenticatedSession(cId);
    adminUser = await createAuthenticatedSession(aId);
    readonlyUser = await createAuthenticatedSession(rId);
    maintainerUser = await createAuthenticatedSession(mId);

    // Seed test acquisitions and assets
    const acq1Res = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-01', 'PO-EV-001', 'Main Acquisition 1', $1)
      RETURNING id
    `, [cId]);
    testAcquisitionId = acq1Res.rows[0].id;

    const acq2Res = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Direct Contract', '2026-03-02', 'PO-EV-002', 'Alternative Acquisition 2', $1)
      RETURNING id
    `, [cId]);
    testAcquisition2Id = acq2Res.rows[0].id;

    const ast1Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Server Node 1', 'AST-EV-001', 'SN-EV-001', $1, $2)
      RETURNING id
    `, [cId, testAcquisitionId]);
    testAsset1Id = ast1Res.rows[0].id;

    const ast2Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Server Node 2', 'AST-EV-002', 'SN-EV-002', $1, $2)
      RETURNING id
    `, [cId, testAcquisitionId]);
    testAsset2Id = ast2Res.rows[0].id;

    const ast3Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Storage Array', 'AST-EV-003', 'SN-EV-003', $1, $2)
      RETURNING id
    `, [cId, testAcquisition2Id]);
    testAsset3OtherAcqId = ast3Res.rows[0].id;

    const ast4Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Legacy Switch', 'AST-EV-004', 'SN-EV-004', $1, NULL)
      RETURNING id
    `, [cId]);
    testLegacyAssetId = ast4Res.rows[0].id;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  }, 30_000);

  // 1. Auth, CSRF, and Cache-Control
  describe('Authentication, CSRF, and Cache-Control', () => {
    it('rejects unauthenticated requests with 401 and Cache-Control: no-store', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('rejects mutating requests without valid CSRF with 403 and Cache-Control: no-store', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          // Missing x-csrf-token
        },
        payload: {
          reference_text: 'CSRF missing attempt',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-csrf-1',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('enforces Cache-Control: no-store on successful responses and 404s', async () => {
      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/evidence/00000000-0000-0000-0000-000000000000',
        headers: {
          cookie: custodianUser.cookie,
        },
      });
      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.headers['cache-control']).toBe('no-store');

      const successRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: custodianUser.cookie,
        },
      });
      expect(successRes.statusCode).toBe(200);
      expect(successRes.headers['cache-control']).toBe('no-store');
    });
  });

  // 2. D3 Role Permission Matrix
  describe('D3 Role Permission Matrix', () => {
    it('allows ASSET_CUSTODIAN to view and create evidence', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_type: 'Invoice',
          reference_text: 'INV-2026-001',
          description: 'Initial custodian purchase invoice',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: 'tok-d3-custodian-1',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      expect(created.id).toBeDefined();
      expect(created.version).toBe(1);

      const listRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: custodianUser.cookie,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const listData = JSON.parse(listRes.body);
      expect(listData.can_create).toBe(true);
      expect(listData.can_correct).toBe(true);
      expect(listData.items.some((i: any) => i.id === created.id)).toBe(true);
    });

    it('denies ADMINISTRATOR from POST /evidence (creation)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
        },
        payload: {
          reference_text: 'Admin create attempt',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-admin-create-fail',
        },
      });
      expect(createRes.statusCode).toBe(403);
    });

    it('allows ADMINISTRATOR to view evidence and correct evidence with reason', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: adminUser.cookie,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const listData = JSON.parse(listRes.body);
      expect(listData.can_create).toBe(false);
      expect(listData.can_correct).toBe(true);

      const targetEv = listData.items[0];
      expect(targetEv).toBeDefined();

      const correctRes = await app.inject({
        method: 'POST',
        url: `/evidence/${targetEv.id}/correct`,
        headers: {
          cookie: adminUser.cookie,
          'x-csrf-token': adminUser.csrf,
        },
        payload: {
          expected_version: targetEv.version,
          reason: 'Administrator updated the invoice reference number',
          reference_text: 'INV-2026-001-ADMIN-CORRECTED',
          retry_token: 'tok-admin-correct-1',
        },
      });
      expect(correctRes.statusCode).toBe(200);
      const corrected = JSON.parse(correctRes.body);
      expect(corrected.version).toBe(targetEv.version + 1);

      // Verify fact via GET
      const getRes = await app.inject({
        method: 'GET',
        url: `/evidence/${targetEv.id}`,
        headers: { cookie: adminUser.cookie },
      });
      expect(JSON.parse(getRes.body).reference_text).toBe('INV-2026-001-ADMIN-CORRECTED');
    });

    it('allows READ_ONLY user to view evidence but denies mutations', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: readonlyUser.cookie,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const listData = JSON.parse(listRes.body);
      expect(listData.can_create).toBe(false);
      expect(listData.can_correct).toBe(false);

      const createRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: readonlyUser.cookie,
          'x-csrf-token': readonlyUser.csrf,
        },
        payload: {
          reference_text: 'Readonly create attempt',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-ro-fail',
        },
      });
      expect(createRes.statusCode).toBe(403);
    });

    it('denies SYSTEM_MAINTAINER alone from all evidence routes (view, create, correct)', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: maintainerUser.cookie,
        },
      });
      expect(listRes.statusCode).toBe(403);

      const createRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: maintainerUser.cookie,
          'x-csrf-token': maintainerUser.csrf,
        },
        payload: {
          reference_text: 'Maintainer create attempt',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-maint-fail',
        },
      });
      expect(createRes.statusCode).toBe(403);
    });

    it('fails closed immediately when role grant is dynamically revoked in PostgreSQL', async () => {
      const dynamicUserId = await pool
        .query(
          "INSERT INTO users (username, password_hash, is_active) VALUES ('dyn_custodian', 'hash123', true) RETURNING id"
        )
        .then((r) => r.rows[0].id);

      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')",
        [dynamicUserId]
      );

      const dynamicSession = await createAuthenticatedSession(dynamicUserId);

      // Verify initial access succeeds
      const checkRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: dynamicSession.cookie,
        },
      });
      expect(checkRes.statusCode).toBe(200);

      // Revoke role directly in PostgreSQL
      await pool.query(
        "DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ASSET_CUSTODIAN'",
        [dynamicUserId]
      );

      // Immediate fail-closed verification
      const revokedRes = await app.inject({
        method: 'GET',
        url: `/evidence?acquisition_id=${testAcquisitionId}`,
        headers: {
          cookie: dynamicSession.cookie,
        },
      });
      expect(revokedRes.statusCode).toBe(403);
    });
  });

  // 3. F1 & F2: Retry Token Enforcement, Advisory Locks, and Replay Renewal
  describe('Retry Token Enforcement and Replay Boundary (F1, F2)', () => {
    it('rejects POST /evidence with missing or blank retry_token with 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Missing token attempt',
          acquisition_id: testAcquisitionId,
          // No retry_token
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('retry_token is required');
    });

    it('rejects POST /evidence/:id/correct with missing or blank retry_token with 400 VALIDATION_FAILED', async () => {
      // Create valid item first
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Item for correct token check',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-chk-token-req-1',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const res = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Attempt without token',
          reference_text: 'New text',
          // No retry_token
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('retry_token is required');
    });

    it('replaying retry token after dynamic role revocation returns 403 FORBIDDEN (F2 Lead Probe)', async () => {
      const probeUserId = await pool
        .query(
          "INSERT INTO users (username, password_hash, is_active) VALUES ('probe_rev_user', 'hash123', true) RETURNING id"
        )
        .then((r) => r.rows[0].id);

      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')",
        [probeUserId]
      );
      const probeSession = await createAuthenticatedSession(probeUserId);

      const probeToken = 'probe-token-lock-revocation';
      const lockKey = `evidence:create:${probeUserId}:${probeToken}`;

      // Open an independent PostgreSQL client to hold the advisory lock
      const lockClient = new Client({ connectionString: databaseUrl });
      await lockClient.connect();

      try {
        await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);

        // Launch request in background (it will wait on the advisory lock)
        const pendingRequest = app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: probeSession.cookie,
            'x-csrf-token': probeSession.csrf,
          },
          payload: {
            reference_text: 'Advisory probe evidence',
            acquisition_id: testAcquisitionId,
            retry_token: probeToken,
          },
        });

        // Give it a moment to begin waiting
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Revoke the user's role while request is waiting
        await pool.query(
          "DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ASSET_CUSTODIAN'",
          [probeUserId]
        );

        // Release the lock
        await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);

        // The request must fail closed with 403
        const result = await pendingRequest;
        expect(result.statusCode).toBe(403);
      } finally {
        await lockClient.end();
      }
    });

    it('replaying retry token after subsequent correction returns original compact receipt while GET returns latest facts (F1)', async () => {
      const initialToken = 'tok-replay-fresh-check';

      // 1. Create evidence with Initial Description
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Freshness Test',
          description: 'Initial Description Fact',
          acquisition_id: testAcquisitionId,
          retry_token: initialToken,
        },
      });
      expect(cr.statusCode).toBe(201);
      const created = JSON.parse(cr.body);
      expect(created.id).toBeDefined();
      expect(created.version).toBe(1);

      // 2. Correct evidence to Updated Description
      const corRes = await app.inject({
        method: 'POST',
        url: `/evidence/${created.id}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Update description for freshness check',
          description: 'Updated Description Fact',
          retry_token: 'tok-replay-fresh-cor',
        },
      });
      expect(corRes.statusCode).toBe(200);

      // 3. Replay original creation request
      const replayRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Freshness Test',
          description: 'Initial Description Fact',
          acquisition_id: testAcquisitionId,
          retry_token: initialToken,
        },
      });
      expect(replayRes.statusCode).toBe(201);
      const replayed = JSON.parse(replayRes.body);
      expect(replayed.id).toBe(created.id);
      expect(replayed.version).toBe(1);
      // Compact receipt does not contain stale description
      expect((replayed as any).evidence).toBeUndefined();

      // 4. Authoritative GET returns current facts
      const getRes = await app.inject({
        method: 'GET',
        url: `/evidence/${created.id}`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(getRes.statusCode).toBe(200);
      const currentFacts = JSON.parse(getRes.body);
      expect(currentFacts.description).toBe('Updated Description Fact');
      expect(currentFacts.version).toBe(2);
    });
  });

  // 4. B1 Multi-Parent Semantics and Constraints
  describe('B1 Multi-Parent Semantics and Constraints', () => {
    it('supports one Evidence linked to an Acquisition and multiple Assets of that Acquisition', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Delivery Note DN-101',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id, testAsset2Id],
          retry_token: 'tok-b1-multi-1',
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);

      const getRes = await app.inject({
        method: 'GET',
        url: `/evidence/${created.id}`,
        headers: { cookie: custodianUser.cookie },
      });
      const record = JSON.parse(getRes.body);
      expect(record.acquisition_id).toBe(testAcquisitionId);
      expect(record.asset_ids).toContain(testAsset1Id);
      expect(record.asset_ids).toContain(testAsset2Id);
    });

    it('rejects linking an asset that belongs to a different acquisition with 409 RELATIONSHIP_CONFLICT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Conflicting cross-acquisition link attempt',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset3OtherAcqId], // Belongs to testAcquisition2Id
          retry_token: 'tok-b1-conflict-1',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('RELATIONSHIP_CONFLICT');
    });

    it('supports Asset-only evidence for an Asset that already belongs to an Acquisition (PO clarification)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Component replacement receipt for Asset 1',
          acquisition_id: null,
          asset_ids: [testAsset1Id],
          retry_token: 'tok-b1-asset-only-acq',
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);

      const getRes = await app.inject({
        method: 'GET',
        url: `/evidence/${created.id}`,
        headers: { cookie: custodianUser.cookie },
      });
      const record = JSON.parse(getRes.body);
      expect(record.acquisition_id).toBeNull();
      expect(record.asset_ids).toEqual([testAsset1Id]);
    });

    it('supports Asset-only evidence for an acquisition-free legacy Asset', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Legacy device manual and warranty card',
          acquisition_id: null,
          asset_ids: [testLegacyAssetId],
          retry_token: 'tok-b1-legacy-1',
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);

      const getRes = await app.inject({
        method: 'GET',
        url: `/evidence/${created.id}`,
        headers: { cookie: custodianUser.cookie },
      });
      const record = JSON.parse(getRes.body);
      expect(record.acquisition_id).toBeNull();
      expect(record.asset_ids).toEqual([testLegacyAssetId]);
    });

    it('rejects creating evidence without any parent with 400 Bad Request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Orphan evidence attempt',
          acquisition_id: null,
          asset_ids: [],
          retry_token: 'tok-b1-orphan-1',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('VALIDATION_FAILED');
    });

    it('rejects removing the final parent without replacement during correction with 409 RELATIONSHIP_CONFLICT', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Single parent evidence',
          acquisition_id: null,
          asset_ids: [testAsset1Id],
          retry_token: 'tok-b1-single-par',
        },
      });
      const evId = JSON.parse(createRes.body).id;

      const removeLastRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Remove the only parent',
          remove_asset_ids: [testAsset1Id],
          retry_token: 'tok-b1-remove-last',
        },
      });
      expect(removeLastRes.statusCode).toBe(409);
      expect(JSON.parse(removeLastRes.body).code).toBe('RELATIONSHIP_CONFLICT');
    });
  });

  // 5. B2 Metadata Truthfulness and Strict Validation (F4)
  describe('B2 Metadata Truthfulness and Strict Validation (F4)', () => {
    it('rejects when both reference_text and description are missing or placeholder', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_type: 'Invoice',
          reference_text: '   -   ',
          description: 'N/A',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-b2-placeholder',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('VALIDATION_FAILED');
    });

    it('normalizes blank or placeholder reference_type to NULL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_type: '   -   ',
          reference_text: 'Meaningful Reference Text',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-b2-norm-type',
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);

      const getRes = await app.inject({
        method: 'GET',
        url: `/evidence/${created.id}`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(JSON.parse(getRes.body).reference_type).toBeNull();
    });

    it('rejects control characters in create and correction payloads', async () => {
      // In create
      const createRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Valid Text\x00ControlChar',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-b2-ctrl-create',
        },
      });
      expect(createRes.statusCode).toBe(400);

      // In correction (F4)
      const validCr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Valid before correction',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-b2-ctrl-valid',
        },
      });
      const evId = JSON.parse(validCr.body).id;

      // Correction with reference_type > 100 characters and control char U+0001
      const badType = 'X'.repeat(101) + '\x01';
      const corBadType = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Testing strict type length and control char rejection',
          reference_type: badType,
          retry_token: 'tok-b2-ctrl-cor',
        },
      });
      expect(corBadType.statusCode).toBe(400);
      expect(JSON.parse(corBadType.body).code).toBe('VALIDATION_FAILED');
    });

    it('rejects empty string acquisition_id in correction (explicit NULL required for unlinking)', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Linked to acq',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: 'tok-empty-acq-test',
        },
      });
      const evId = JSON.parse(cr.body).id;

      const corRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Attempt empty string unlink',
          acquisition_id: '',
          retry_token: 'tok-empty-acq-fail',
        },
      });
      expect(corRes.statusCode).toBe(400);
      expect(JSON.parse(corRes.body).code).toBe('VALIDATION_FAILED');
    });
  });

  // 6. F2: All-Parent Disclosure Checks
  describe('All-Parent Disclosure Checks (F2)', () => {
    it('denies direct lookup and history when caller lacks required parent view grants', async () => {
      // Create user with READ_ONLY role (which has evidence:view and asset:view)
      const noAcqUserId = await pool
        .query(
          "INSERT INTO users (username, password_hash, is_active) VALUES ('no_acq_user', 'hash123', true) RETURNING id"
        )
        .then((r) => r.rows[0].id);

      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')",
        [noAcqUserId]
      );

      const noAcqSession = await createAuthenticatedSession(noAcqUserId);

      // Mock hasCapability for noAcqUserId to lack acquisition:view while retaining evidence:view and asset:view
      const origHasCap = (app as any).capabilityService.hasCapability.bind((app as any).capabilityService);
      const capSpy = vi.spyOn((app as any).capabilityService, 'hasCapability').mockImplementation(async (...args: any[]) => {
        const [uid, cap] = args;
        if (uid === noAcqUserId) {
          if (cap === 'acquisition:view') return false;
          if (cap === 'evidence:view' || cap === 'asset:view') return true;
        }
        return origHasCap(uid, cap);
      });

      try {
        // Evidence linked to an acquisition
        const evWithAcq = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            reference_text: 'Acquisition disclosure test',
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: 'tok-disclosure-ev-1',
          },
        });
        const evId = JSON.parse(evWithAcq.body).id;

        // GET /evidence/:id discloses acquisition -> must return 403
        const getRes = await app.inject({
          method: 'GET',
          url: `/evidence/${evId}`,
          headers: { cookie: noAcqSession.cookie },
        });
        expect(getRes.statusCode).toBe(403);

        // GET /evidence/:id/history discloses acquisition -> must return 403
        const histRes = await app.inject({
          method: 'GET',
          url: `/evidence/${evId}/history`,
          headers: { cookie: noAcqSession.cookie },
        });
        expect(histRes.statusCode).toBe(403);
      } finally {
        capSpy.mockRestore();
      }
    });
  });

  // 7. F6: Linked Asset Pagination and >100 Links Across Mutations
  describe('Linked Asset Pagination and Unbounded Relationship Pages (F6)', () => {
    it('supports paginating linked assets on GET /evidence/:id and accumulates >100 links across multiple mutations', async () => {
      // Create evidence with initial 1 asset
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          reference_text: 'Bulk asset links accumulator',
          acquisition_id: null,
          asset_ids: [testLegacyAssetId],
          retry_token: 'tok-f6-accum-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      // Seed 110 additional distinct assets directly in DB
      const additionalAssetIds: string[] = [];
      for (let i = 1; i <= 110; i++) {
        const aRes = await pool.query(
          "INSERT INTO assets (name, asset_number, registered_by) VALUES ($1, $2, $3) RETURNING id",
          [`Bulk Asset ${i}`, `AST-BULK-${i}`, custodianUser.id]
        );
        additionalAssetIds.push(aRes.rows[0].id);
      }

      // Add batch 1: 60 assets
      const batch1 = additionalAssetIds.slice(0, 60);
      const cor1 = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Add batch 1 of 60 assets',
          add_asset_ids: batch1,
          retry_token: 'tok-f6-batch-1',
        },
      });
      expect(cor1.statusCode).toBe(200);

      // Add batch 2: 50 assets
      const batch2 = additionalAssetIds.slice(60, 110);
      const cor2 = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 2,
          reason: 'Add batch 2 of 50 assets',
          add_asset_ids: batch2,
          retry_token: 'tok-f6-batch-2',
        },
      });
      expect(cor2.statusCode).toBe(200);

      // Total linked assets = 1 (initial) + 60 + 50 = 111 assets (> 100 links)
      // Test page 1: asset_limit=25, asset_offset=0
      const page1Res = await app.inject({
        method: 'GET',
        url: `/evidence/${evId}?asset_limit=25&asset_offset=0`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1Data = JSON.parse(page1Res.body);
      expect(page1Data.asset_ids_total).toBe(111);
      expect(page1Data.asset_ids.length).toBe(25);
      expect(page1Data.has_more_assets).toBe(true);

      // Test page 5: asset_limit=25, asset_offset=100
      const page5Res = await app.inject({
        method: 'GET',
        url: `/evidence/${evId}?asset_limit=25&asset_offset=100`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(page5Res.statusCode).toBe(200);
      const page5Data = JSON.parse(page5Res.body);
      expect(page5Data.asset_ids_total).toBe(111);
      expect(page5Data.asset_ids.length).toBe(11);
      expect(page5Data.has_more_assets).toBe(false);
    });
  });

  describe('Hardening, Boundary & State Races (F1, F2, F4, F7)', () => {
    it('rejects version conflicts with 409 CONFLICT', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Initial for version conflict test',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-ver-conflict-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const corRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 999,
          reason: 'Attempted correction with wrong version',
          description: 'Updated text',
          retry_token: 'tok-ver-conflict-mismatch',
        },
      });
      expect(corRes.statusCode).toBe(409);
      const err = JSON.parse(corRes.body);
      expect(err.code).toBe('CONCURRENCY_CONFLICT');
      expect(err.message).toMatch(/Concurrency conflict/i);
    });

    it('handles no-op corrections gracefully by preserving version and returning history_id: null', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Initial for no-op test',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-noop-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const noopRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Valid correction reason',
          retry_token: 'tok-noop-attempt',
        },
      });
      expect(noopRes.statusCode).toBe(200);
      const data = JSON.parse(noopRes.body);
      expect(data.version).toBe(1);
      expect(data.history_id).toBeNull();
    });

    it('rejects contradictory payload replaying the same retry_token with 409 RETRY_TOKEN_PAYLOAD_MISMATCH', async () => {
      const token = 'tok-changed-intent-conflict';
      const cr1 = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Initial intent payload',
          acquisition_id: testAcquisitionId,
          retry_token: token,
        },
      });
      expect(cr1.statusCode).toBe(201);

      const cr2 = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Contradictory intent payload',
          acquisition_id: testAcquisitionId,
          retry_token: token,
        },
      });
      expect(cr2.statusCode).toBe(409);
      const err = JSON.parse(cr2.body);
      expect(err.code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });

    it('rejects placeholder correction reasons (N/A, test, asdf, etc.) with 400 VALIDATION_FAILED', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Initial for placeholder reason test',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-placeholder-reason-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      for (const placeholder of ['N/A', 'n/a', 'test', 'asdf', '-', 'none']) {
        const res = await app.inject({
          method: 'POST',
          url: `/evidence/${evId}/correct`,
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            expected_version: 1,
            reason: placeholder,
            description: 'Updated with placeholder reason',
            retry_token: `tok-placeholder-${placeholder}`,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toMatch(/meaningful explanation/i);
      }
    });

    it('rejects retry tokens containing strict control characters (newline, tab) with 400 VALIDATION_FAILED', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Testing newline in token',
          acquisition_id: testAcquisitionId,
          retry_token: 'bad\ntoken',
        },
      });
      expect(res1.statusCode).toBe(400);
      expect(JSON.parse(res1.body).message).toMatch(/control characters/i);

      const res2 = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'bad\ttoken',
        },
        payload: {
          description: 'Testing tab in header token',
          acquisition_id: testAcquisitionId,
        },
      });
      expect(res2.statusCode).toBe(400);
      expect(JSON.parse(res2.body).message).toMatch(/control characters/i);
    });

    it('returns 404 NOT_FOUND for nonexistent evidence history without leaking information', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/evidence/00000000-0000-0000-0000-000000000099/history',
        headers: { cookie: custodianUser.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe('NOT_FOUND');
    });

    it('denies history disclosure with 403 on all pages (including offset=1000) when caller lacks view permission on parent', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Parent disclosure check evidence',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-parent-disc-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const capService = app.capabilityService!;
      const originalHas = capService.hasCapability.bind(capService);
      try {
        capService.hasCapability = async (uid, cap) =>
          uid === custodianUser.id && cap === 'acquisition:view' ? false : originalHas(uid, cap);

        const page0 = await app.inject({
          method: 'GET',
          url: `/evidence/${evId}/history`,
          headers: { cookie: custodianUser.cookie },
        });
        expect(page0.statusCode).toBe(403);

        const page1000 = await app.inject({
          method: 'GET',
          url: `/evidence/${evId}/history?offset=1000`,
          headers: { cookie: custodianUser.cookie },
        });
        expect(page1000.statusCode).toBe(403);
      } finally {
        capService.hasCapability = originalHas;
      }
    });

    async function waitForPgStatLockWaiter(timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const res = await pool.query(
          `SELECT pid, wait_event_type, wait_event, state
           FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()`
        );
        if (res.rows.length > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('Timed out waiting for lock waiter in pg_stat_activity');
    }

    it('rejects row-wait correction with 403 when user role is downgraded during lock wait', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Initial row-wait evidence',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-row-wait-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const lockClient = await pool.connect();
      try {
        await lockClient.query('BEGIN');
        await lockClient.query('SELECT id FROM evidence_records WHERE id = $1 FOR UPDATE', [evId]);

        const pending = app.inject({
          method: 'POST',
          url: `/evidence/${evId}/correct`,
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            expected_version: 1,
            reason: 'Correction during row lock wait',
            description: 'Unauthorized update after downgrade',
            retry_token: 'tok-row-wait-corr',
          },
        });

        await waitForPgStatLockWaiter();

        await pool.query('DELETE FROM user_roles WHERE user_id = $1', [custodianUser.id]);
        await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')", [custodianUser.id]);

        await lockClient.query('COMMIT');
        lockClient.release();

        const res = await pending;
        expect(res.statusCode).toBe(403);

        const check = await pool.query('SELECT description FROM evidence_records WHERE id = $1', [evId]);
        expect(check.rows[0].description).toBe('Initial row-wait evidence');
      } finally {
        await pool.query('DELETE FROM user_roles WHERE user_id = $1', [custodianUser.id]);
        await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')", [custodianUser.id]);
      }
    });

    it('rejects receipt replay with 401 when DB session is deleted during wait', async () => {
      const token = 'tok-session-del-replay';
      const initialPayload = {
        description: 'Session deletion evidence',
        acquisition_id: testAcquisitionId,
        retry_token: token,
      };

      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: initialPayload,
      });
      expect(cr.statusCode).toBe(201);

      const lockClient = await pool.connect();
      try {
        await lockClient.query('BEGIN');
        await lockClient.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`evidence:create:${custodianUser.id}:${token}`]
        );

        const pendingReplay = app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: initialPayload,
        });

        await waitForPgStatLockWaiter();

        await pool.query('DELETE FROM sessions WHERE user_id = $1', [custodianUser.id]);

        await lockClient.query('COMMIT');
        lockClient.release();

        const replayRes = await pendingReplay;
        expect(replayRes.statusCode).toBe(401);
      } finally {
        const newSession = await createAuthenticatedSession(custodianUser.id);
        custodianUser.cookie = newSession.cookie;
        custodianUser.csrf = newSession.csrf;
      }
    });

    it('rejects receipt replay with 401 when DB session expires by wall clock during advisory lock wait', async () => {
      const token = 'tok-session-wallclock-expired';
      const initialPayload = {
        description: 'Session wall clock expiration evidence',
        acquisition_id: testAcquisitionId,
        retry_token: token,
      };

      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: initialPayload,
      });
      expect(cr.statusCode).toBe(201);

      const lockClient = await pool.connect();
      try {
        await lockClient.query('BEGIN');
        await lockClient.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`evidence:create:${custodianUser.id}:${token}`]
        );

        const pendingReplay = app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: initialPayload,
        });

        await waitForPgStatLockWaiter();

        // Expire the session in DB by setting expires_at to 1 second in the past
        await pool.query(
          "UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1",
          [custodianUser.id]
        );

        await lockClient.query('COMMIT');
        lockClient.release();

        const replayRes = await pendingReplay;
        expect(replayRes.statusCode).toBe(401);
      } finally {
        const newSession = await createAuthenticatedSession(custodianUser.id);
        custodianUser.cookie = newSession.cookie;
        custodianUser.csrf = newSession.csrf;
      }
    });

    it('rejects cached correction receipt replay with 403 when caller lacks view capability on removed parent acquisition', async () => {
      const initToken = 'tok-rem-parent-init';
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Evidence with parent to be removed',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: initToken,
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      // Correct: unlink acquisition_id
      const corrToken = 'tok-rem-parent-corr';
      const corrPayload = {
        expected_version: 1,
        reason: 'Unlinking acquisition parent',
        acquisition_id: null,
        retry_token: corrToken,
      };

      const corrRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: corrPayload,
      });
      expect(corrRes.statusCode).toBe(200);

      // Now revoke acquisition:view capability
      const capService = app.capabilityService!;
      const originalHas = capService.hasCapability.bind(capService);
      try {
        capService.hasCapability = async (uid, cap) =>
          uid === custodianUser.id && cap === 'acquisition:view' ? false : originalHas(uid, cap);

        // Replay cached correction receipt with same token
        const replayRes = await app.inject({
          method: 'POST',
          url: `/evidence/${evId}/correct`,
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: corrPayload,
        });
        expect(replayRes.statusCode).toBe(403);
      } finally {
        capService.hasCapability = originalHas;
      }
    });

    it('enforces exact per-receipt parent authorization: denies replay of acquisition-linked no-op when unlinked and view revoked, but permits fresh Asset-only no-op and identical immediate replay', async () => {
      const initToken = 'tok-noop-rem-parent-init';
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Evidence for exact per-receipt parent authorization check',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: initToken,
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      // 1. Issue original NO-OP correction while linked to acquisition (Control 1)
      const origNoOpToken = 'tok-noop-acq-linked';
      const origNoOpPayload = {
        expected_version: 1,
        reason: 'Original acquisition-linked no-op',
        retry_token: origNoOpToken,
      };
      const origNoOpRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: origNoOpPayload,
      });
      expect(origNoOpRes.statusCode).toBe(200);
      expect(JSON.parse(origNoOpRes.body).version).toBe(1);
      expect(JSON.parse(origNoOpRes.body).history_id).toBeNull();

      // 2. Unlink acquisition (version becomes 2)
      const corrToken = 'tok-noop-rem-parent-unlink';
      const corrRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Unlinking acquisition parent',
          acquisition_id: null,
          retry_token: corrToken,
        },
      });
      expect(corrRes.statusCode).toBe(200);

      // 3. Deny acquisition:view capability
      const capService = app.capabilityService!;
      const originalHas = capService.hasCapability.bind(capService);
      try {
        capService.hasCapability = async (uid, cap) =>
          uid === custodianUser.id && cap === 'acquisition:view' ? false : originalHas(uid, cap);

        // Control 1: Replay of the original acquisition-linked no-op MUST fail closed with 403
        const replayOrigRes = await app.inject({
          method: 'POST',
          url: `/evidence/${evId}/correct`,
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: origNoOpPayload,
        });
        expect(replayOrigRes.statusCode).toBe(403);

        // Control 2: Submit a NEW Asset-only no-op on version 2 under unchanged restricted grants -> succeeds 200
        const assetOnlyNoOpToken = 'tok-noop-asset-only-stable';
        const assetOnlyNoOpPayload = {
          expected_version: 2,
          reason: 'Confirm current Asset-only association without changing facts',
          retry_token: assetOnlyNoOpToken,
        };
        const freshAssetOnlyRes = await app.inject({
          method: 'POST',
          url: `/evidence/${evId}/correct`,
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: assetOnlyNoOpPayload,
        });
        expect(freshAssetOnlyRes.statusCode).toBe(200);
        const freshData = JSON.parse(freshAssetOnlyRes.body);
        expect(freshData.id).toBe(evId);
        expect(freshData.version).toBe(2);
        expect(freshData.history_id).toBeNull();

        // Control 2 (continued): Immediate replay of the exact same Asset-only no-op MUST also succeed with 200 and identical receipt
        const replayAssetOnlyRes = await app.inject({
          method: 'POST',
          url: `/evidence/${evId}/correct`,
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: assetOnlyNoOpPayload,
        });
        expect(replayAssetOnlyRes.statusCode).toBe(200);
        const replayData = JSON.parse(replayAssetOnlyRes.body);
        expect(replayData).toEqual(freshData);
        expect(replayData._auth_context).toBeUndefined();
      } finally {
        capService.hasCapability = originalHas;
      }

      // Replay of original no-op when capability is restored returns 200 with compact receipt
      const restoreRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: origNoOpPayload,
      });
      expect(restoreRes.statusCode).toBe(200);
      const restoreData = JSON.parse(restoreRes.body);
      expect(restoreData.id).toBe(evId);
      expect(restoreData.version).toBe(1);
      expect(restoreData.history_id).toBeNull();
      expect(restoreData._auth_context).toBeUndefined();
    });

    it('serializes genuine simultaneous concurrent creations via separate DB connections with zero data corruption', async () => {
      const p1 = app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Concurrent Creation A',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-concurrent-create-a',
        },
      });

      const p2 = app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Concurrent Creation B',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-concurrent-create-b',
        },
      });

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);
      const id1 = JSON.parse(res1.body).id;
      const id2 = JSON.parse(res2.body).id;
      expect(id1).not.toBe(id2);

      const verifyClient = await pool.connect();
      try {
        const rows = await verifyClient.query(
          'SELECT id, description FROM evidence_records WHERE id IN ($1, $2)',
          [id1, id2]
        );
        expect(rows.rows.length).toBe(2);
      } finally {
        verifyClient.release();
      }
    });

    it('handles simultaneous concurrent corrections on the same evidence record with optimistic concurrency 409', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Concurrent correction target',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-concurrent-target-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const p1 = app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Correction racer 1',
          description: 'Updated by racer 1',
          retry_token: 'tok-race-1',
        },
      });

      const p2 = app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Correction racer 2',
          description: 'Updated by racer 2',
          retry_token: 'tok-race-2',
        },
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      const statusCodes = [r1.statusCode, r2.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const verifyClient = await pool.connect();
      try {
        const check = await verifyClient.query(
          'SELECT version FROM evidence_records WHERE id = $1',
          [evId]
        );
        expect(check.rows[0].version).toBe(2);
      } finally {
        verifyClient.release();
      }
    });

    it('guarantees pre-write validation rejection on nonexistent asset without partial writes', async () => {
      const failToken = 'tok-late-fail-rollback';
      // Attempting to add a nonexistent asset causes pre-write validation failure
      const res = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Pre-write rejection payload',
          acquisition_id: testAcquisitionId,
          asset_ids: ['00000000-0000-0000-0000-000000000000'],
          retry_token: failToken,
        },
      });
      expect(res.statusCode).toBe(400);

      // Verify ZERO partial writes via independent connection
      const independentClient = await pool.connect();
      try {
        const evRows = await independentClient.query(
          "SELECT id FROM evidence_records WHERE description = 'Pre-write rejection payload'"
        );
        expect(evRows.rows.length).toBe(0);

        const tokRows = await independentClient.query(
          'SELECT token FROM registration_retry_tokens WHERE token = $1',
          [failToken]
        );
        expect(tokRows.rows.length).toBe(0);
      } finally {
        independentClient.release();
      }

      // Successful retry with valid payload succeeds cleanly
      const retryRes = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Pre-write rejection payload',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: failToken,
        },
      });
      expect(retryRes.statusCode).toBe(201);
    });

    it('guarantees zero partial writes on late link insertion trigger failure and allows clean retry via independent DB connection', async () => {
      const triggerClient = await pool.connect();
      const failToken = 'tok-late-link-fail';
      const desc = 'Late link insertion failure test payload';
      try {
        await triggerClient.query(`
          CREATE OR REPLACE FUNCTION fail_specific_link() RETURNS trigger AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM evidence_records WHERE description = '${desc}' AND id = NEW.evidence_id) THEN
              RAISE EXCEPTION 'Simulated late link insertion failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          DROP TRIGGER IF EXISTS trg_fail_link ON evidence_asset_links;
          CREATE TRIGGER trg_fail_link BEFORE INSERT ON evidence_asset_links
            FOR EACH ROW EXECUTE FUNCTION fail_specific_link();
        `);

        const res = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            description: desc,
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: failToken,
          },
        });
        expect(res.statusCode).toBe(500);

        // Verify zero partial rows across all 4 tables via independent client
        const verifyClient = await pool.connect();
        try {
          const evRows = await verifyClient.query(
            'SELECT id FROM evidence_records WHERE description = $1',
            [desc]
          );
          expect(evRows.rows.length).toBe(0);

          const histRows = await verifyClient.query(
            "SELECT id FROM evidence_history WHERE after_state->>'description' = $1",
            [desc]
          );
          expect(histRows.rows.length).toBe(0);

          const linkRows = await verifyClient.query(
            'SELECT evidence_id FROM evidence_asset_links WHERE asset_id = $1 AND evidence_id IN (SELECT id FROM evidence_records WHERE description = $2)',
            [testAsset1Id, desc]
          );
          expect(linkRows.rows.length).toBe(0);

          const tokRows = await verifyClient.query(
            'SELECT token FROM registration_retry_tokens WHERE token = $1',
            [failToken]
          );
          expect(tokRows.rows.length).toBe(0);
        } finally {
          verifyClient.release();
        }

        // Drop trigger
        await triggerClient.query(
          'DROP TRIGGER IF EXISTS trg_fail_link ON evidence_asset_links; DROP FUNCTION IF EXISTS fail_specific_link();'
        );

        // Clean retry with exact same token and payload succeeds
        const retryRes = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            description: desc,
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: failToken,
          },
        });
        expect(retryRes.statusCode).toBe(201);
        const retryData = JSON.parse(retryRes.body);
        expect(retryData.id).toBeDefined();

        // Verify precisely one coherent record in each table
        const postClient = await pool.connect();
        try {
          const evPost = await postClient.query(
            'SELECT id FROM evidence_records WHERE id = $1',
            [retryData.id]
          );
          expect(evPost.rows.length).toBe(1);

          const histPost = await postClient.query(
            'SELECT id FROM evidence_history WHERE evidence_id = $1',
            [retryData.id]
          );
          expect(histPost.rows.length).toBe(1);

          const linkPost = await postClient.query(
            'SELECT evidence_id FROM evidence_asset_links WHERE evidence_id = $1 AND asset_id = $2',
            [retryData.id, testAsset1Id]
          );
          expect(linkPost.rows.length).toBe(1);

          const tokPost = await postClient.query(
            'SELECT token FROM registration_retry_tokens WHERE token = $1',
            [failToken]
          );
          expect(tokPost.rows.length).toBe(1);
        } finally {
          postClient.release();
        }
      } finally {
        await triggerClient
          .query(
            'DROP TRIGGER IF EXISTS trg_fail_link ON evidence_asset_links; DROP FUNCTION IF EXISTS fail_specific_link();'
          )
          .catch(() => {});
        triggerClient.release();
      }
    });

    it('guarantees zero partial writes on late history insertion trigger failure and allows clean retry via independent DB connection', async () => {
      const triggerClient = await pool.connect();
      const failToken = 'tok-late-history-fail';
      const desc = 'Late history insertion failure test payload';
      try {
        await triggerClient.query(`
          CREATE OR REPLACE FUNCTION fail_specific_history() RETURNS trigger AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM evidence_records WHERE description = '${desc}' AND id = NEW.evidence_id) THEN
              RAISE EXCEPTION 'Simulated late history insertion failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          DROP TRIGGER IF EXISTS trg_fail_hist ON evidence_history;
          CREATE TRIGGER trg_fail_hist BEFORE INSERT ON evidence_history
            FOR EACH ROW EXECUTE FUNCTION fail_specific_history();
        `);

        const res = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            description: desc,
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: failToken,
          },
        });
        expect(res.statusCode).toBe(500);

        // Verify zero partial rows across all 4 tables via independent client
        const verifyClient = await pool.connect();
        try {
          const evRows = await verifyClient.query(
            'SELECT id FROM evidence_records WHERE description = $1',
            [desc]
          );
          expect(evRows.rows.length).toBe(0);

          const histRows = await verifyClient.query(
            "SELECT id FROM evidence_history WHERE after_state->>'description' = $1",
            [desc]
          );
          expect(histRows.rows.length).toBe(0);

          const linkRows = await verifyClient.query(
            'SELECT evidence_id FROM evidence_asset_links WHERE asset_id = $1 AND evidence_id IN (SELECT id FROM evidence_records WHERE description = $2)',
            [testAsset1Id, desc]
          );
          expect(linkRows.rows.length).toBe(0);

          const tokRows = await verifyClient.query(
            'SELECT token FROM registration_retry_tokens WHERE token = $1',
            [failToken]
          );
          expect(tokRows.rows.length).toBe(0);
        } finally {
          verifyClient.release();
        }

        // Drop trigger
        await triggerClient.query(
          'DROP TRIGGER IF EXISTS trg_fail_hist ON evidence_history; DROP FUNCTION IF EXISTS fail_specific_history();'
        );

        // Clean retry with exact same token and payload succeeds
        const retryRes = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            description: desc,
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: failToken,
          },
        });
        expect(retryRes.statusCode).toBe(201);
        const retryData = JSON.parse(retryRes.body);

        // Verify precisely one coherent record in each table
        const postClient = await pool.connect();
        try {
          const evPost = await postClient.query(
            'SELECT id FROM evidence_records WHERE id = $1',
            [retryData.id]
          );
          expect(evPost.rows.length).toBe(1);

          const histPost = await postClient.query(
            'SELECT id FROM evidence_history WHERE evidence_id = $1',
            [retryData.id]
          );
          expect(histPost.rows.length).toBe(1);

          const linkPost = await postClient.query(
            'SELECT evidence_id FROM evidence_asset_links WHERE evidence_id = $1 AND asset_id = $2',
            [retryData.id, testAsset1Id]
          );
          expect(linkPost.rows.length).toBe(1);

          const tokPost = await postClient.query(
            'SELECT token FROM registration_retry_tokens WHERE token = $1',
            [failToken]
          );
          expect(tokPost.rows.length).toBe(1);
        } finally {
          postClient.release();
        }
      } finally {
        await triggerClient
          .query(
            'DROP TRIGGER IF EXISTS trg_fail_hist ON evidence_history; DROP FUNCTION IF EXISTS fail_specific_history();'
          )
          .catch(() => {});
        triggerClient.release();
      }
    });

    it('guarantees zero partial writes on late trigger transaction failure and allows clean retry via independent DB connection', async () => {
      const triggerClient = await pool.connect();
      const failToken = 'tok-late-trigger-fail';
      const desc = 'Late trigger failure test payload';
      try {
        await triggerClient.query(`
          CREATE OR REPLACE FUNCTION fail_specific_token() RETURNS trigger AS $$
          BEGIN
            IF NEW.token = '${failToken}' THEN
              RAISE EXCEPTION 'Simulated late trigger failure on token insert';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          DROP TRIGGER IF EXISTS trg_fail_token ON registration_retry_tokens;
          CREATE TRIGGER trg_fail_token BEFORE INSERT ON registration_retry_tokens
            FOR EACH ROW EXECUTE FUNCTION fail_specific_token();
        `);

        const res = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            description: desc,
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: failToken,
          },
        });
        expect(res.statusCode).toBe(500);

        // Verify zero partial rows across all 4 tables via independent client
        const verifyClient = await pool.connect();
        try {
          const evRows = await verifyClient.query(
            'SELECT id FROM evidence_records WHERE description = $1',
            [desc]
          );
          expect(evRows.rows.length).toBe(0);

          const histRows = await verifyClient.query(
            "SELECT id FROM evidence_history WHERE after_state->>'description' = $1",
            [desc]
          );
          expect(histRows.rows.length).toBe(0);

          const linkRows = await verifyClient.query(
            'SELECT evidence_id FROM evidence_asset_links WHERE asset_id = $1 AND evidence_id IN (SELECT id FROM evidence_records WHERE description = $2)',
            [testAsset1Id, desc]
          );
          expect(linkRows.rows.length).toBe(0);

          const tokRows = await verifyClient.query(
            'SELECT token FROM registration_retry_tokens WHERE token = $1',
            [failToken]
          );
          expect(tokRows.rows.length).toBe(0);
        } finally {
          verifyClient.release();
        }

        // Drop trigger
        await triggerClient.query(
          'DROP TRIGGER IF EXISTS trg_fail_token ON registration_retry_tokens; DROP FUNCTION IF EXISTS fail_specific_token();'
        );

        // Clean retry with exact same token succeeds
        const retryRes = await app.inject({
          method: 'POST',
          url: '/evidence',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            description: desc,
            acquisition_id: testAcquisitionId,
            asset_ids: [testAsset1Id],
            retry_token: failToken,
          },
        });
        expect(retryRes.statusCode).toBe(201);
        const retryData = JSON.parse(retryRes.body);

        // Verify precisely one coherent record in each table
        const postClient = await pool.connect();
        try {
          const evPost = await postClient.query(
            'SELECT id FROM evidence_records WHERE id = $1',
            [retryData.id]
          );
          expect(evPost.rows.length).toBe(1);

          const histPost = await postClient.query(
            'SELECT id FROM evidence_history WHERE evidence_id = $1',
            [retryData.id]
          );
          expect(histPost.rows.length).toBe(1);

          const linkPost = await postClient.query(
            'SELECT evidence_id FROM evidence_asset_links WHERE evidence_id = $1 AND asset_id = $2',
            [retryData.id, testAsset1Id]
          );
          expect(linkPost.rows.length).toBe(1);

          const tokPost = await postClient.query(
            'SELECT token FROM registration_retry_tokens WHERE token = $1',
            [failToken]
          );
          expect(tokPost.rows.length).toBe(1);
        } finally {
          postClient.release();
        }
      } finally {
        await triggerClient
          .query(
            'DROP TRIGGER IF EXISTS trg_fail_token ON registration_retry_tokens; DROP FUNCTION IF EXISTS fail_specific_token();'
          )
          .catch(() => {});
        triggerClient.release();
      }
    });

    it('serializes parallel identical-token creates returning identical 201 receipts with exactly one DB row', async () => {
      const parallelToken = 'tok-parallel-identical-create';
      const payload = {
        description: 'Parallel identical create payload',
        acquisition_id: testAcquisitionId,
        asset_ids: [testAsset1Id],
        retry_token: parallelToken,
      };

      const p1 = app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload,
      });

      const p2 = app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload,
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);

      const d1 = JSON.parse(r1.body);
      const d2 = JSON.parse(r2.body);
      // Assert COMPLETE receipt equality
      expect(d1).toEqual(d2);
      expect(d1.id).toBeDefined();
      expect(d1.version).toBe(1);
      expect(d1.history_id).toBeDefined();

      const verifyClient = await pool.connect();
      try {
        const evCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM evidence_records WHERE id = $1',
          [d1.id]
        );
        expect(evCount.rows[0].count).toBe(1);

        const histCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM evidence_history WHERE evidence_id = $1',
          [d1.id]
        );
        expect(histCount.rows[0].count).toBe(1);

        const linkCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM evidence_asset_links WHERE evidence_id = $1 AND asset_id = $2',
          [d1.id, testAsset1Id]
        );
        expect(linkCount.rows[0].count).toBe(1);

        const tokCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
          [parallelToken]
        );
        expect(tokCount.rows[0].count).toBe(1);
      } finally {
        verifyClient.release();
      }
    });

    it('handles parallel conflicting-token creates with exactly one 201 and one 409 RETRY_TOKEN_PAYLOAD_MISMATCH', async () => {
      const conflictToken = 'tok-parallel-conflict-create';
      const p1 = app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Conflict payload Alpha',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: conflictToken,
        },
      });

      const p2 = app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Conflict payload Beta',
          acquisition_id: testAcquisitionId,
          asset_ids: [testAsset1Id],
          retry_token: conflictToken,
        },
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      const statusCodes = [r1.statusCode, r2.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const errRes = r1.statusCode === 409 ? r1 : r2;
      expect(JSON.parse(errRes.body).code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');

      const okRes = r1.statusCode === 201 ? r1 : r2;
      const okId = JSON.parse(okRes.body).id;

      const verifyClient = await pool.connect();
      try {
        const evCount = await verifyClient.query(
          "SELECT count(*)::int as count FROM evidence_records WHERE description LIKE 'Conflict payload %'"
        );
        expect(evCount.rows[0].count).toBe(1);

        const histCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM evidence_history WHERE evidence_id = $1',
          [okId]
        );
        expect(histCount.rows[0].count).toBe(1);

        const linkCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM evidence_asset_links WHERE evidence_id = $1',
          [okId]
        );
        expect(linkCount.rows[0].count).toBe(1);

        const tokCount = await verifyClient.query(
          'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
          [conflictToken]
        );
        expect(tokCount.rows[0].count).toBe(1);
      } finally {
        verifyClient.release();
      }
    });

    it('preserves immutable created_at, created_by, and original recorded_at across corrections', async () => {
      const cr = await app.inject({
        method: 'POST',
        url: '/evidence',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          description: 'Original immutable timestamps evidence',
          acquisition_id: testAcquisitionId,
          retry_token: 'tok-ts-preserve-init',
        },
      });
      expect(cr.statusCode).toBe(201);
      const evId = JSON.parse(cr.body).id;

      const initialRow = (await pool.query(
        'SELECT created_at, created_by, recorded_at, updated_at FROM evidence_records WHERE id = $1',
        [evId]
      )).rows[0];

      await new Promise((r) => setTimeout(r, 50));

      const corRes = await app.inject({
        method: 'POST',
        url: `/evidence/${evId}/correct`,
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          expected_version: 1,
          reason: 'Valid correction preserving timestamps',
          description: 'Updated description',
          retry_token: 'tok-ts-preserve-corr',
        },
      });
      expect(corRes.statusCode).toBe(200);

      const afterRow = (await pool.query(
        'SELECT created_at, created_by, recorded_at, updated_at FROM evidence_records WHERE id = $1',
        [evId]
      )).rows[0];

      expect(new Date(afterRow.created_at).getTime()).toBe(new Date(initialRow.created_at).getTime());
      expect(afterRow.created_by).toBe(initialRow.created_by);
      expect(new Date(afterRow.recorded_at).getTime()).toBe(new Date(initialRow.recorded_at).getTime());
      expect(new Date(afterRow.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(initialRow.updated_at).getTime());
    });
  });
});
