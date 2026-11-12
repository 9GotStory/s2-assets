import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('Acquisition Routes Integration Tests (Seam A)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sessionService: SessionService;

  let custodianUser: { id: string; cookie: string; csrf: string };
  let adminUser: { id: string; cookie: string; csrf: string };
  let readonlyUser: { id: string; cookie: string; csrf: string };
  let maintainerUser: { id: string; cookie: string; csrf: string };

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
    const databaseUrl = container.getConnectionUri();

    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    pool = new Pool({ connectionString: databaseUrl });
    sessionService = new SessionService({ db: pool });

    app = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-12345',
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

    const cId = await createUserWithRole('custodian_acq', 'ASSET_CUSTODIAN');
    const aId = await createUserWithRole('admin_acq', 'ADMINISTRATOR');
    const rId = await createUserWithRole('readonly_acq', 'READ_ONLY');
    const mId = await createUserWithRole('maintainer_acq', 'SYSTEM_MAINTAINER');

    custodianUser = await createAuthenticatedSession(cId);
    adminUser = await createAuthenticatedSession(aId);
    readonlyUser = await createAuthenticatedSession(rId);
    maintainerUser = await createAuthenticatedSession(mId);
  }, 120_000);

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
  });

  describe('D1 Validation & Fact Rules on POST /acquisitions', () => {
    it('rejects creation when no approved facts are provided (blank reference)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('F5: rejects placeholder-only notes and source_reference with zero writes', async () => {
      const initialAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      const initialTokenCount = Number((await pool.query('SELECT count(*)::text FROM registration_retry_tokens')).rows[0].count);

      const placeholderCases = [
        { notes: '-' },
        { notes: 'n/a' },
        { notes: 'N/A' },
        { notes: '...' },
        { notes: '   ---   ' },
        { source_reference: '-' },
        { source_reference: 'n/a' },
        { source_reference: '...' },
        { source_reference: 'none' },
        { notes: '-', source_reference: '-' },
      ];

      for (const payload of placeholderCases) {
        const res = await app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': `placeholder-token-${Math.random()}`,
          },
          payload,
        });
        expect(res.statusCode, `Expected 400 for placeholder ${JSON.stringify(payload)}`).toBe(400);
      }

      // Independent DB check: zero rows written
      const postAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      const postTokenCount = Number((await pool.query('SELECT count(*)::text FROM registration_retry_tokens')).rows[0].count);
      expect(postAcqCount).toBe(initialAcqCount);
      expect(postTokenCount).toBe(initialTokenCount);
    });

    it('F5 positive controls: accepts meaningful notes-only and reference-only records', async () => {
      // Meaningful notes-only
      const notesRes = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-notes-only-001',
        },
        payload: {
          notes: 'Legitimate procurement note explaining donation from faculty alumni association',
        },
      });
      expect(notesRes.statusCode).toBe(201);
      const notesBody = JSON.parse(notesRes.body);
      expect(notesBody.notes).toBe('Legitimate procurement note explaining donation from faculty alumni association');
      expect(notesBody.acquisition_type).toBeNull();
      expect(notesBody.total_amount).toBeNull();

      // Meaningful reference-only
      const refRes = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-ref-only-001',
        },
        payload: {
          source_reference: 'PR-2026-ALUMNI-GRANT-42',
        },
      });
      expect(refRes.statusCode).toBe(201);
      const refBody = JSON.parse(refRes.body);
      expect(refBody.source_reference).toBe('PR-2026-ALUMNI-GRANT-42');
    });

    it('rejects invented unknown acquisition_type labels', async () => {
      for (const invalidType of ['unknown', 'Unknown', 'UNKNOWN', 'N/A', '-', '  ']) {
        const res = await app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            acquisition_type: invalidType,
          },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects malformed or impossible Gregorian acquisition_date', async () => {
      for (const badDate of ['2026-02-30', '2026-13-01', 'not-a-date', '2026/01/15', '2026-04-31']) {
        const res = await app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            acquisition_type: 'จัดซื้อปกติ',
            acquisition_date: badDate,
          },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('enforces total_amount and currency coupling and strict THB rules', async () => {
      // Amount without currency
      const res1 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          total_amount: '100.00',
        },
      });
      expect(res1.statusCode).toBe(400);

      // Currency without amount
      const res2 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          currency: 'THB',
        },
      });
      expect(res2.statusCode).toBe(400);

      // Non-THB currency
      const res3 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          total_amount: '100.00',
          currency: 'USD',
        },
      });
      expect(res3.statusCode).toBe(400);

      // Extra precision (not exactly 2 decimal places)
      for (const badAmount of ['100', '100.5', '100.555', '-50.00', 'abc']) {
        const resBad = await app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
          },
          payload: {
            total_amount: badAmount,
            currency: 'THB',
          },
        });
        expect(resBad.statusCode).toBe(400);
      }

      // Factual zero is accepted with THB
      const resZero = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-zero-thb-001',
        },
        payload: {
          total_amount: '0.00',
          currency: 'THB',
        },
      });
      expect(resZero.statusCode).toBe(201);
      const zeroBody = JSON.parse(resZero.body);
      expect(zeroBody.total_amount).toBe('0.00');
      expect(zeroBody.currency).toBe('THB');
    });

    it('successfully creates an acquisition reference with truthful approved facts', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-truthful-facts-001',
        },
        payload: {
          acquisition_type: 'จัดซื้อตามสัญญาจ้าง',
          acquisition_date: '2026-03-20',
          total_amount: '450000.00',
          currency: 'THB',
          source_reference: 'PO-2026-0889',
          notes: 'จัดซื้อคอมพิวเตอร์และอุปกรณ์สำนักงาน',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeDefined();
      expect(body.acquisition_type).toBe('จัดซื้อตามสัญญาจ้าง');
      expect(body.acquisition_date).toBe('2026-03-20');
      expect(body.total_amount).toBe('450000.00');
      expect(body.currency).toBe('THB');
      expect(body.source_reference).toBe('PO-2026-0889');
      expect(body.notes).toBe('จัดซื้อคอมพิวเตอร์และอุปกรณ์สำนักงาน');
      expect(body.created_by).toBe(custodianUser.id);
      expect(body.recorded_at).toBeDefined();
    });
  });

  describe('D3 Permission Matrix on POST and GET /acquisitions', () => {
    let testAcqId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-d3-setup-001',
        },
        payload: {
          acquisition_type: 'เงินบริจาคสมาคมศิษย์เก่า',
          source_reference: 'DONATION-2026-01',
        },
      });
      testAcqId = JSON.parse(res.body).id;
    });

    it('denies unauthenticated access with 401/403', async () => {
      const postRes = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        payload: { acquisition_type: 'test' },
      });
      expect([401, 403]).toContain(postRes.statusCode);

      const getRes = await app.inject({
        method: 'GET',
        url: `/acquisitions/${testAcqId}`,
      });
      expect(getRes.statusCode).toBe(401);
    });

    it('denies POST /acquisitions for roles lacking acquisition:create (ADMINISTRATOR, READ_ONLY, SYSTEM_MAINTAINER)', async () => {
      for (const u of [adminUser, readonlyUser, maintainerUser]) {
        const res = await app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: u.cookie,
            'x-csrf-token': u.csrf,
          },
          payload: { acquisition_type: 'test' },
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it('enforces CSRF check on POST /acquisitions for cookie sessions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': 'invalid-csrf-token',
        },
        payload: { acquisition_type: 'test' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows GET /acquisitions/:id for roles with acquisition:view (CUSTODIAN, ADMIN, READ_ONLY)', async () => {
      for (const u of [custodianUser, adminUser, readonlyUser]) {
        const res = await app.inject({
          method: 'GET',
          url: `/acquisitions/${testAcqId}`,
          headers: { cookie: u.cookie },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(testAcqId);
        expect(body.acquisition_type).toBe('เงินบริจาคสมาคมศิษย์เก่า');
      }
    });

    it('denies GET /acquisitions/:id for SYSTEM_MAINTAINER lacking acquisition:view', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/acquisitions/${testAcqId}`,
        headers: { cookie: maintainerUser.cookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it('fails closed when role is revoked in PostgreSQL', async () => {
      // Create temporary user with CUSTODIAN role
      const tempId = await (async () => {
        const passwordHash = await UserService.hashPassword('Password123!');
        const res = await pool.query(
          'INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id',
          ['temp_custodian', passwordHash]
        );
        const uId = res.rows[0].id;
        await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [uId, 'ASSET_CUSTODIAN']);
        return uId;
      })();

      const tempUser = await createAuthenticatedSession(tempId);

      // Verify access before revocation
      const preRes = await app.inject({
        method: 'GET',
        url: `/acquisitions/${testAcqId}`,
        headers: { cookie: tempUser.cookie },
      });
      expect(preRes.statusCode).toBe(200);

      // Revoke role in DB
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [tempId]);

      // Immediate fail-closed 403
      const postRes = await app.inject({
        method: 'GET',
        url: `/acquisitions/${testAcqId}`,
        headers: { cookie: tempUser.cookie },
      });
      expect(postRes.statusCode).toBe(403);
    });
  });

  describe('Retry Token Idempotency & Conflict Contract', () => {
    it('F1: rejects creation when retry token is omitted, blank, or contradictory with zero writes', async () => {
      const initialAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      const initialTokenCount = Number((await pool.query('SELECT count(*)::text FROM registration_retry_tokens')).rows[0].count);

      const validFactPayload = { notes: 'Genuine fact for token requirement test' };

      // 1. Omitted retry token (neither header nor body)
      const resNoToken = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: validFactPayload,
      });
      expect(resNoToken.statusCode, 'Missing retry token must return 400').toBe(400);

      // 2. Blank retry token in header
      const resBlankHeader = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': '   ',
        },
        payload: validFactPayload,
      });
      expect(resBlankHeader.statusCode, 'Blank header retry token must return 400').toBe(400);

      // 3. Blank retry token in body
      const resBlankBody = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: { ...validFactPayload, retry_token: '   ' },
      });
      expect(resBlankBody.statusCode, 'Blank body retry token must return 400').toBe(400);

      // 4. Contradictory header and body tokens
      const resConflict = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-header-xyz',
        },
        payload: { ...validFactPayload, retry_token: 'token-body-different' },
      });
      expect(resConflict.statusCode, 'Contradictory tokens must return 400').toBe(400);

      // Independent DB check: zero rows written
      const postAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      const postTokenCount = Number((await pool.query('SELECT count(*)::text FROM registration_retry_tokens')).rows[0].count);
      expect(postAcqCount).toBe(initialAcqCount);
      expect(postTokenCount).toBe(initialTokenCount);
    });

    it('returns the same acquisition record on identical retry token replay', async () => {
      const retryToken = 'acq-retry-token-001';
      const payload = {
        acquisition_type: 'จัดซื้อเร่งด่วน',
        total_amount: '12000.00',
        currency: 'THB',
        source_reference: 'FAST-PO-01',
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const body1 = JSON.parse(res1.body);

      // Second identical call
      const res2 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const body2 = JSON.parse(res2.body);
      expect(body2.id).toBe(body1.id);
      expect(body2.acquisition_type).toBe(body1.acquisition_type);
    });

    it('rejects with 409 Conflict when retry token is reused with different payload without business writes', async () => {
      const retryToken = 'acq-retry-token-002';
      const payloadOriginal = {
        acquisition_type: 'จัดซื้อทั่วไป',
        source_reference: 'GEN-01',
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload: payloadOriginal,
      });
      expect(res1.statusCode).toBe(201);

      // Reused token with changed payload
      const res2 = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': retryToken,
        },
        payload: {
          acquisition_type: 'จัดซื้อเปลี่ยนแปลง',
          source_reference: 'GEN-02',
        },
      });
      expect(res2.statusCode).toBe(409);
      const body2 = JSON.parse(res2.body);
      expect(body2.code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });

    it('handles simultaneous concurrent acquisition creation requests with the same retry token idempotently', async () => {
      const concurrentToken = `concurrent-token-${Math.random()}`;
      const payload = {
        acquisition_type: 'จัดซื้อพร้อมกัน',
        total_amount: '50000.00',
        currency: 'THB',
        source_reference: 'CONCUR-01',
      };

      const initialAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);

      // Fire 3 simultaneous requests with exact same token
      const [res1, res2, res3] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': concurrentToken,
          },
          payload,
        }),
        app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': concurrentToken,
          },
          payload,
        }),
        app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': concurrentToken,
          },
          payload,
        }),
      ]);

      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);
      expect(res3.statusCode).toBe(201);

      const id1 = JSON.parse(res1.body).id;
      const id2 = JSON.parse(res2.body).id;
      const id3 = JSON.parse(res3.body).id;
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);

      // Independent DB observation: exactly one acquisition created
      const finalAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      expect(finalAcqCount).toBe(initialAcqCount + 1);
    });

    it('handles genuinely concurrent requests with same retry token but conflicting payloads with one winner (201) and one conflict (409) and zero extra writes', async () => {
      const conflictToken = `concurrent-conflict-${crypto.randomUUID()}`;
      const initialAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);

      // Genuinely concurrent requests with same retry token but conflicting payloads
      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': conflictToken,
          },
          payload: {
            acquisition_type: 'ประเภทแรก A',
            source_reference: 'REF-A',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': conflictToken,
          },
          payload: {
            acquisition_type: 'ประเภทขัดแย้ง B',
            source_reference: 'REF-B',
          },
        }),
      ]);

      const statuses = [resA.statusCode, resB.statusCode].sort();
      expect(statuses).toEqual([201, 409]);

      // Exactly 1 acquisition row written in database
      const finalAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      expect(finalAcqCount).toBe(initialAcqCount + 1);

      // Exactly 1 scoped retry result written
      const tokenRows = (
        await pool.query('SELECT * FROM registration_retry_tokens WHERE token = $1', [conflictToken])
      ).rows;
      expect(tokenRows.length).toBe(1);
      expect(tokenRows[0].operation).toBe('acquisition:create');

      // Subsequent sequential conflicting request also receives 409 Conflict with zero extra writes
      const resSubsequentConflict = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': conflictToken,
        },
        payload: {
          acquisition_type: 'ประเภทขัดแย้งถัดไป C',
          source_reference: 'REF-C',
        },
      });
      expect(resSubsequentConflict.statusCode).toBe(409);
      const finalAcqCountAfter = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      expect(finalAcqCountAfter).toBe(finalAcqCount);
    });

    it('late failure on acquisition retry-result persistence rolls back inserted acquisition and retry token; subsequent retry succeeds', async () => {
      const rollbackToken = `fault-rollback-token-${crypto.randomUUID()}`;
      const uniqueRef = `ROLLBACK-LATE-${crypto.randomUUID().slice(0, 8)}`;

      const initialAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
      const initialTokenCount = Number((await pool.query('SELECT count(*)::text FROM registration_retry_tokens')).rows[0].count);

      // Install a temporary fail-closed trigger on registration_retry_tokens specifically for this token,
      // which fires AFTER the acquisition row has already been inserted in the same transaction
      await pool.query(`
        CREATE OR REPLACE FUNCTION fail_retry_token_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = '${rollbackToken}' THEN
            RAISE EXCEPTION 'Simulated retry token persistence failure after acquisition insert';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER trg_fail_retry_token_insert
        BEFORE INSERT ON registration_retry_tokens
        FOR EACH ROW EXECUTE FUNCTION fail_retry_token_insert();
      `);

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/acquisitions',
          headers: {
            cookie: custodianUser.cookie,
            'x-csrf-token': custodianUser.csrf,
            'x-retry-token': rollbackToken,
          },
          payload: {
            acquisition_type: 'ทดสอบโรลแบ็คปลายทาง',
            source_reference: uniqueRef,
          },
        });

        expect(res.statusCode).toBe(500);

        // Independent pool observation: zero acquisition records committed, zero retry tokens committed
        const postAcqCount = Number((await pool.query('SELECT count(*)::text FROM acquisitions')).rows[0].count);
        const postTokenCount = Number((await pool.query('SELECT count(*)::text FROM registration_retry_tokens')).rows[0].count);
        expect(postAcqCount).toBe(initialAcqCount);
        expect(postTokenCount).toBe(initialTokenCount);

        // Specifically assert the acquisition record that was inserted was rolled back completely
        const specificAcqRows = (
          await pool.query('SELECT * FROM acquisitions WHERE source_reference = $1', [uniqueRef])
        ).rows;
        expect(specificAcqRows.length).toBe(0);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS trg_fail_retry_token_insert ON registration_retry_tokens');
        await pool.query('DROP FUNCTION IF EXISTS fail_retry_token_insert');
      }

      // Remove the fault and show the same valid intent/token succeeds
      const resRetry = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': rollbackToken,
        },
        payload: {
          acquisition_type: 'ทดสอบโรลแบ็คปลายทาง',
          source_reference: uniqueRef,
        },
      });

      expect(resRetry.statusCode).toBe(201);
      const resRetryBody = JSON.parse(resRetry.body);
      expect(resRetryBody.source_reference).toBe(uniqueRef);

      // Independent pool observation: now exactly 1 acquisition and 1 retry token row exist
      const retryAcqRows = (
        await pool.query('SELECT * FROM acquisitions WHERE source_reference = $1', [uniqueRef])
      ).rows;
      expect(retryAcqRows.length).toBe(1);

      const retryTokenRows = (
        await pool.query('SELECT * FROM registration_retry_tokens WHERE token = $1', [rollbackToken])
      ).rows;
      expect(retryTokenRows.length).toBe(1);
      expect(retryTokenRows[0].response_status).toBe(201);
    });
  });

  describe('Shared Reference Across Two Assets & Total Separation', () => {
    it('allows registering multiple distinct assets referencing the same acquisition without duplicating total', async () => {
      // 1. Create Acquisition with whole total
      const acqRes = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-shared-ref-001',
        },
        payload: {
          acquisition_type: 'จัดซื้อเซิร์ฟเวอร์สำนักงาน',
          total_amount: '100000.00',
          currency: 'THB',
          source_reference: 'SRV-PO-2026',
        },
      });
      expect(acqRes.statusCode).toBe(201);
      const acq = JSON.parse(acqRes.body);

      // 2. Register Asset 1 referencing acq.id
      const asset1Res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Server Node 1',
          asset_number: 'SRV-001',
          serial_number: 'SN-SRV-001',
          acquisition_id: acq.id,
        },
      });
      expect(asset1Res.statusCode).toBe(201);
      const asset1 = JSON.parse(asset1Res.body).asset;
      expect(asset1.acquisition_id).toBe(acq.id);

      // 3. Register Asset 2 referencing acq.id
      const asset2Res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Server Node 2',
          asset_number: 'SRV-002',
          serial_number: 'SN-SRV-002',
          acquisition_id: acq.id,
        },
      });
      expect(asset2Res.statusCode).toBe(201);
      const asset2 = JSON.parse(asset2Res.body).asset;
      expect(asset2.acquisition_id).toBe(acq.id);

      // 4. Verify GET /acquisitions/:id returns linked assets with count 2
      const getAcqRes = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acq.id}`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(getAcqRes.statusCode).toBe(200);
      const acqData = JSON.parse(getAcqRes.body);
      expect(acqData.total_amount).toBe('100000.00');
      expect(acqData.currency).toBe('THB');
      expect(acqData.total_assets).toBe(2);
      expect(acqData.assets.length).toBe(2);
      const assetIds = acqData.assets.map((a: any) => a.id);
      expect(assetIds).toContain(asset1.id);
      expect(assetIds).toContain(asset2.id);

      // 5. Invariant: Assets do NOT have per-item total copied or divided
      expect((asset1 as any).total_amount).toBeUndefined();
      expect((asset2 as any).total_amount).toBeUndefined();

      // 6. Inspect detail boundary for Read-only user lacking asset:view (or test suppression)
      // Read-only user has both asset:view and acquisition:view, so they see both
      const roRes = await app.inject({
        method: 'GET',
        url: `/assets/${asset1.id}`,
        headers: { cookie: readonlyUser.cookie },
      });
      expect(roRes.statusCode).toBe(200);
      const roAssetData = JSON.parse(roRes.body);
      expect(roAssetData.asset.acquisition_id).toBe(acq.id);
    });

    it('rejects linking asset to non-existent acquisition_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
        },
        payload: {
          name: 'Orphan Asset Attempt',
          acquisition_id: 'a0000000-0000-4000-8000-000000000099',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('Pagination & Bounds on GET /acquisitions/:id', () => {
    it('supports limit and offset pagination for linked assets', async () => {
      // Create acquisition
      const acqRes = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-batch-pagination-001',
        },
        payload: { acquisition_type: 'Batch test' },
      });
      const acqId = JSON.parse(acqRes.body).id;

      // Register 3 assets
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
            asset_number: `BATCH-${acqId.slice(0, 4)}-${i}`,
            acquisition_id: acqId,
          },
        });
      }

      // Query with limit=2, offset=0
      const page1Res = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?limit=2&offset=0`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.body);
      expect(page1.total_assets).toBe(3);
      expect(page1.assets.length).toBe(2);
      expect(page1.has_more).toBe(true);

      // Query with limit=2, offset=2
      const page2Res = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?limit=2&offset=2`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.body);
      expect(page2.total_assets).toBe(3);
      expect(page2.assets.length).toBe(1);
      expect(page2.has_more).toBe(false);

      // Query beyond end
      const beyondRes = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?limit=2&offset=10`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(beyondRes.statusCode).toBe(200);
      const beyond = JSON.parse(beyondRes.body);
      expect(beyond.total_assets).toBe(3);
      expect(beyond.assets.length).toBe(0);
      expect(beyond.has_more).toBe(false);
    });

    it('F4: strictly rejects invalid pagination queries (1garbage, offset=-1, limit=101, limit=0) and padded UUID with 400', async () => {
      // Create valid acquisition for testing GET
      const acqRes = await app.inject({
        method: 'POST',
        url: '/acquisitions',
        headers: {
          cookie: custodianUser.cookie,
          'x-csrf-token': custodianUser.csrf,
          'x-retry-token': 'token-strict-reads-001',
        },
        payload: { notes: 'Valid acquisition for strict read tests' },
      });
      expect(acqRes.statusCode).toBe(201);
      const acqId = JSON.parse(acqRes.body).id;

      // 1. limit=1garbage -> 400
      const resGarbage = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?limit=1garbage`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resGarbage.statusCode, 'limit=1garbage must return 400').toBe(400);

      // 2. offset=-1 -> 400
      const resNegativeOffset = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?offset=-1`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resNegativeOffset.statusCode, 'offset=-1 must return 400').toBe(400);

      // 3. limit=101 -> 400
      const resOverLimit = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?limit=101`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resOverLimit.statusCode, 'limit=101 must return 400').toBe(400);

      // 4. limit=0 -> 400
      const resZeroLimit = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}?limit=0`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resZeroLimit.statusCode, 'limit=0 must return 400').toBe(400);

      // 5. space-padded UUID -> 400
      const resPaddedUuid = await app.inject({
        method: 'GET',
        url: `/acquisitions/%20${acqId}%20`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resPaddedUuid.statusCode, 'space-padded UUID must return 400').toBe(400);

      // 6. Valid boundaries accepted (limit=1, limit=100, offset=0)
      for (const query of ['?limit=1', '?limit=100', '?offset=0', '?limit=50&offset=0']) {
        const resValid = await app.inject({
          method: 'GET',
          url: `/acquisitions/${acqId}${query}`,
          headers: { cookie: custodianUser.cookie },
        });
        expect(resValid.statusCode, `Valid query ${query} must return 200`).toBe(200);
      }

      // 7. Omitted limit parameter defaults strictly to 25 (PO decision 6405116419)
      const resOmitted = await app.inject({
        method: 'GET',
        url: `/acquisitions/${acqId}`,
        headers: { cookie: custodianUser.cookie },
      });
      expect(resOmitted.statusCode).toBe(200);
      const omittedBody = JSON.parse(resOmitted.body);
      expect(omittedBody.limit).toBe(25);
    });
  });
});
