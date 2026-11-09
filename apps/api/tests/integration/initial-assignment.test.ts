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
import { withCapabilityAnswer } from './support/capability-helpers.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

type Actor = { id: string; cookie: string; csrf: string };

const NO_VALUE = { entry: null, legacy_text: null };

// F003-T1 (#51, ADR 0001): the values given at registration become the Asset's Initial Assignment,
// and the Asset reads its Location, OrganizationUnit and Responsible Person from assignment facts.
describe('Initial Assignment (Seam A - F003-T1)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sessionService: SessionService;
  // The API's clock: 12:00 on 5 November 2026 in Bangkok unless a test moves it.
  let now = new Date('2026-11-05T05:00:00Z');

  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let maintainer: Actor;

  const createAuthenticatedSession = async (userId: string): Promise<Actor> => {
    const session = await sessionService.createSession(userId);
    const sessionCookie = `session=${session.token}`;
    const res = await app.inject({ method: 'GET', url: '/auth/session-check', headers: { cookie: sessionCookie } });
    const body = JSON.parse(res.body);
    const setCookie = res.headers['set-cookie'];
    const csrfCookie = setCookie
      ? Array.isArray(setCookie)
        ? setCookie.map((c: string) => c.split(';')[0]).join('; ')
        : setCookie.split(';')[0]
      : '';
    return { id: userId, cookie: csrfCookie ? `${sessionCookie}; ${csrfCookie}` : sessionCookie, csrf: body.csrfToken || '' };
  };

  const post = (actor: Actor, url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: actor.cookie, 'x-csrf-token': actor.csrf, 'content-type': 'application/json', ...headers },
      payload: payload as any,
    });

  const get = (actor: Actor, url: string) => app.inject({ method: 'GET', url, headers: { cookie: actor.cookie } });

  const entry = async (kind: string, name: string) => (await post(admin, `/references/${kind}`, { name })).json();

  const timelineOf = async (assetId: string, viewer: Actor = readonly) => {
    const res = await get(viewer, `/assets/${assetId}/assignments`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
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
    await runMigrator({ command: 'latest', databaseUrl, migrationFolder });

    pool = new Pool({ connectionString: databaseUrl });
    sessionService = new SessionService({ db: pool });
    app = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-assignment',
      logger: false,
      clock: () => now,
    });

    const passwordHash = await UserService.hashPassword('Password123!');
    const createUserWithRole = async (username: string, role: string) => {
      const res = await pool.query(
        'INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash]
      );
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [res.rows[0].id, role]);
      return res.rows[0].id as string;
    };

    admin = await createAuthenticatedSession(await createUserWithRole('admin_ia', 'ADMINISTRATOR'));
    custodian = await createAuthenticatedSession(await createUserWithRole('custodian_ia', 'ASSET_CUSTODIAN'));
    readonly = await createAuthenticatedSession(await createUserWithRole('readonly_ia', 'READ_ONLY'));
    maintainer = await createAuthenticatedSession(await createUserWithRole('maintainer_ia', 'SYSTEM_MAINTAINER'));
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  describe('Registration (AR-06, AR-07, Q17)', () => {
    it("records the values given at registration as the Asset's Initial Assignment, a fact apart from the registration", async () => {
      const room = await entry('locations', 'ห้องพัสดุ ชั้น 1');
      const unit = await entry('organization-units', 'กลุ่มงานพัสดุ');

      const res = await post(custodian, '/assets', {
        name: 'เครื่องพิมพ์เลเซอร์',
        location_id: room.id,
        organization_unit_id: unit.id,
        legacy_responsible_person_text: '  คุณสมศรี (ทะเบียนเดิม) ',
        effective_date: '2026-11-01',
      });
      expect(res.statusCode).toBe(201);
      const assetId = res.json().asset.id;

      const detail = (await get(readonly, `/assets/${assetId}`)).json();
      expect(detail.current_assignment).toEqual({
        location: { id: room.id, name: 'ห้องพัสดุ ชั้น 1', is_active: true },
        organization_unit: { id: unit.id, name: 'กลุ่มงานพัสดุ', is_active: true },
        responsible_person: null,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: 'คุณสมศรี (ทะเบียนเดิม)',
      });
      expect(detail.assignment_version).toBe(1);

      // The registration fact no longer carries dimension values; the Initial Assignment does.
      const registered = detail.history.find((h: any) => h.action === 'REGISTERED');
      expect(registered.payload).toEqual({
        is_legacy: false,
        name: 'เครื่องพิมพ์เลเซอร์',
        asset_number: null,
        serial_number: null,
        source_reference: null,
        source_notes: null,
      });

      const timeline = await timelineOf(assetId);
      expect(timeline).toEqual([
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          kind: 'INITIAL',
          effective_date: '2026-11-01',
          recorded_at: detail.asset.recorded_at,
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_ia',
          provenance: 'RECORDED',
          document_reference: null,
          remark: null,
          is_voided: false,
          bulk_reference: null,
          corrections: [],
          changes: [
            {
              dimension: 'location',
              prior: NO_VALUE,
              new: { entry: { id: room.id, name: 'ห้องพัสดุ ชั้น 1', is_active: true }, legacy_text: null },
              conflict: null,
            },
            {
              dimension: 'organization_unit',
              prior: NO_VALUE,
              new: { entry: { id: unit.id, name: 'กลุ่มงานพัสดุ', is_active: true }, legacy_text: null },
              conflict: null,
            },
            {
              dimension: 'responsible_person',
              prior: NO_VALUE,
              new: { entry: null, legacy_text: 'คุณสมศรี (ทะเบียนเดิม)' },
              conflict: null,
            },
          ],
        },
      ]);
      expect(res.json().initial_assignment).toEqual(timeline[0]);
    });

    it('replays a retried registration with its Initial Assignment, and refuses other assignment facts under the same token', async () => {
      const room = await entry('locations', 'ห้องลงทะเบียนซ้ำ');
      const payload = {
        name: 'ลงทะเบียนซ้ำพร้อมกำหนดครั้งแรก',
        location_id: room.id,
        effective_date: '2026-11-02',
        retry_token: 'ia-register-replay',
      };
      const first = await post(custodian, '/assets', payload);
      expect(first.statusCode).toBe(201);
      const replay = await post(custodian, '/assets', payload);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await timelineOf(first.json().asset.id)).toHaveLength(1);

      for (const changed of [{ effective_date: '2026-11-03' }, { effective_date: null }, { remark: 'อื่น' }]) {
        const res = await post(custodian, '/assets', { ...payload, ...changed });
        expect(res.statusCode, JSON.stringify(changed)).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
    });

    it('records no Initial Assignment for a registration without dimension values, and still registers (AR-06, AS-02)', async () => {
      for (const payload of [{ name: 'โต๊ะประชุมส่วนกลาง' }, { name: 'เก้าอี้ส่วนกลาง', legacy_location_text: '   ' }]) {
        const res = await post(custodian, '/assets', payload);
        expect(res.statusCode).toBe(201);
        expect(res.json().initial_assignment).toBeNull();
        const assetId = res.json().asset.id;

        expect(await timelineOf(assetId)).toEqual([]);
        const detail = (await get(readonly, `/assets/${assetId}`)).json();
        expect(detail.current_assignment).toEqual({
          location: null,
          organization_unit: null,
          responsible_person: null,
          legacy_location_text: null,
          legacy_organization_unit_text: null,
          legacy_responsible_person_text: null,
        });
        expect(detail.assignment_version).toBe(0);
      }
    });

    it('refuses an Effective Date, document reference or remark that comes without a dimension value', async () => {
      for (const extra of [
        { effective_date: '2026-11-01' },
        { effective_date: null },
        { document_reference: 'บันทึกข้อความ ที่ 12/2569' },
        { remark: 'ย้ายมาจากคลัง' },
      ]) {
        const res = await post(custodian, '/assets', { name: 'ไม่มีมิติแต่มีวันที่', ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('ไม่มีมิติแต่มีวันที่')}`);
      expect(found.json().total_count).toBe(0);
    });
  });

  describe('Effective Date (AS-06, Q2, Q11)', () => {
    it('needs an Effective Date with any dimension value: a calendar date with no lower bound, or null for unknown', async () => {
      const room = await entry('locations', 'ห้องตรวจวันที่');
      const register = (name: string, effective: Record<string, unknown>) =>
        post(custodian, '/assets', { name, location_id: room.id, ...effective });

      for (const effective of [
        {},
        { effective_date: '' },
        { effective_date: '5/11/2026' },
        { effective_date: '2026-11-5' },
        { effective_date: '2026-02-29' },
        { effective_date: '2026-13-01' },
        { effective_date: '0000-12-31' },
        { effective_date: '2026-11-01T00:00:00Z' },
        { effective_date: 20261101 },
      ]) {
        const res = await register('วันที่มีผลไม่ถูกต้อง', effective);
        expect(res.statusCode, JSON.stringify(effective)).toBe(400);
      }
      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('วันที่มีผลไม่ถูกต้อง')}`);
      expect(found.json().total_count).toBe(0);

      const unknown = await register('ไม่ทราบวันที่มีผล', { effective_date: null });
      expect(unknown.statusCode).toBe(201);
      expect(unknown.json().initial_assignment.effective_date).toBeNull();

      for (const date of ['1985-01-31', '2024-02-29', '0001-01-01']) {
        const res = await register(`ทะเบียนเก่า ${date}`, { effective_date: date });
        expect(res.statusCode, date).toBe(201);
        expect(res.json().initial_assignment.effective_date).toBe(date);
      }
    });

    it("refuses a date after today's Asia/Bangkok date, which turns at 17:00 UTC", async () => {
      const room = await entry('locations', 'ห้องเที่ยงคืน');
      const register = (date: string) =>
        post(custodian, '/assets', { name: `ข้ามวัน ${date}`, location_id: room.id, effective_date: date });
      try {
        now = new Date('2026-11-05T16:59:59.999Z'); // 23:59:59.999 on 5 November in Bangkok
        expect((await register('2026-11-06')).statusCode).toBe(400);
        expect((await register('2026-11-05')).statusCode).toBe(201);

        now = new Date('2026-11-05T17:00:00.000Z'); // 00:00 on 6 November in Bangkok
        expect((await register('2026-11-06')).statusCode).toBe(201);
        expect((await register('2026-11-07')).statusCode).toBe(400);
      } finally {
        now = new Date('2026-11-05T05:00:00Z');
      }
    });
  });

  describe('Document reference and remark (AS-07, Q5)', () => {
    it('keeps an optional document reference and remark on the Initial Assignment, trimmed, blank as none', async () => {
      const room = await entry('locations', 'ห้องเก็บเอกสาร');
      const res = await post(custodian, '/assets', {
        name: 'ตู้เอกสารเหล็ก',
        location_id: room.id,
        effective_date: '2026-10-01',
        document_reference: '  บันทึกข้อความ ที่ 15/2569 ',
        remark: 'รับจากคลังกลาง\nตามใบส่งของเลขที่ 88',
      });
      expect(res.statusCode).toBe(201);
      const [initial] = await timelineOf(res.json().asset.id);
      expect(initial).toMatchObject({
        document_reference: 'บันทึกข้อความ ที่ 15/2569',
        remark: 'รับจากคลังกลาง\nตามใบส่งของเลขที่ 88',
      });

      const blank = await post(custodian, '/assets', {
        name: 'ตู้เอกสารไม้',
        location_id: room.id,
        effective_date: null,
        document_reference: '   ',
        remark: '',
      });
      expect(blank.statusCode).toBe(201);
      expect(blank.json().initial_assignment).toMatchObject({ document_reference: null, remark: null });
    });

    it('refuses an overlong or control-character document reference or remark without writing', async () => {
      const room = await entry('locations', 'ห้องเอกสารผิดรูป');
      for (const extra of [
        { document_reference: 'x'.repeat(501) },
        { document_reference: 'bad\u0007ref' },
        { document_reference: 12 },
        { remark: 'y'.repeat(2001) },
        { remark: 'bad\u0000remark' },
      ]) {
        const res = await post(custodian, '/assets', {
          name: 'เอกสารอ้างอิงผิดรูป',
          location_id: room.id,
          effective_date: null,
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra).slice(0, 60)).toBe(400);
      }
      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('เอกสารอ้างอิงผิดรูป')}`);
      expect(found.json().total_count).toBe(0);
    });
  });

  describe('Entries (D7, Q16)', () => {
    it("takes each entry from its own dimension's list", async () => {
      const room = await entry('locations', 'ห้องที่ไม่ใช่หน่วยงาน');
      const person = await entry('persons', 'นายที่ไม่ใช่สถานที่');
      for (const values of [
        { organization_unit_id: room.id },
        { responsible_person_id: room.id },
        { location_id: person.id },
        { location_id: '00000000-0000-4000-8000-000000000000' },
      ]) {
        const res = await post(custodian, '/assets', { name: 'รายการผิดมิติ', effective_date: null, ...values });
        expect(res.statusCode, JSON.stringify(values)).toBe(400);
      }
      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('รายการผิดมิติ')}`);
      expect(found.json().total_count).toBe(0);
    });

    it('accepts a deactivated entry only for an Effective Date before today or unknown, and shows it as such', async () => {
      const closed = await entry('locations', 'ห้องที่ปิดไปแล้ว');
      await post(admin, `/references/locations/${closed.id}`, { expected_version: 1, is_active: false });
      const register = (effective_date: string | null) =>
        post(custodian, '/assets', { name: `ห้องปิด ${effective_date}`, location_id: closed.id, effective_date });

      expect((await register('2026-11-05')).statusCode).toBe(400);
      const past = await register('2026-11-04');
      expect(past.statusCode).toBe(201);
      expect((await register(null)).statusCode).toBe(201);

      const closedEntry = { id: closed.id, name: 'ห้องที่ปิดไปแล้ว', is_active: false };
      expect(past.json().initial_assignment.changes).toEqual([
        { dimension: 'location', prior: NO_VALUE, new: { entry: closedEntry, legacy_text: null }, conflict: null },
      ]);
      const detail = (await get(readonly, `/assets/${past.json().asset.id}`)).json();
      expect(detail.current_assignment.location).toEqual(closedEntry);
    });
  });

  describe('Bulk registration (#25 decision 1, Q17)', () => {
    const bulk = (actor: Actor, body: unknown, token: string) =>
      post(actor, '/assets/bulk-register', body, { 'x-retry-token': token });

    it('gives every Asset of a batch its own Initial Assignment with the shared values and Effective Date', async () => {
      const room = await entry('locations', 'ห้องเรียนรวม 3');
      const unit = await entry('organization-units', 'กลุ่มงานวิชาการ');
      const payload = {
        location_id: room.id,
        organization_unit_id: unit.id,
        effective_date: '2026-10-15',
        document_reference: 'ใบส่งของ 77/2569',
        remark: 'ซื้อพร้อมกันทั้งชุด',
        items: [
          { item_key: '6f1c5a52-5d0f-4b2a-9c1e-000000000001', name: 'โต๊ะนักเรียน 1' },
          { item_key: '6f1c5a52-5d0f-4b2a-9c1e-000000000002', name: 'โต๊ะนักเรียน 2' },
        ],
      };

      const first = await bulk(custodian, payload, 'ia-bulk-1');
      expect(first.statusCode).toBe(201);
      const results = first.json().results;
      expect(results).toHaveLength(2);
      for (const result of results) {
        const timeline = await timelineOf(result.asset_id);
        expect(timeline).toHaveLength(1);
        expect(timeline[0]).toMatchObject({
          id: result.initial_assignment_id,
          kind: 'INITIAL',
          effective_date: '2026-10-15',
          recorded_by: custodian.id,
          provenance: 'RECORDED',
          document_reference: 'ใบส่งของ 77/2569',
          remark: 'ซื้อพร้อมกันทั้งชุด',
        });
        expect(timeline[0].changes.map((change: any) => [change.dimension, change.new.entry.id])).toEqual([
          ['location', room.id],
          ['organization_unit', unit.id],
        ]);
      }
      // Each Asset gets a fact of its own.
      expect(results[0].initial_assignment_id).not.toBe(results[1].initial_assignment_id);

      // The same token and payload replay the committed result; another Effective Date under it conflicts.
      const replay = await bulk(custodian, payload, 'ia-bulk-1');
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      const changed = await bulk(custodian, { ...payload, effective_date: '2026-10-16' }, 'ia-bulk-1');
      expect(changed.statusCode).toBe(409);
    });

    it('registers no Asset of the batch when its shared Initial Assignment is refused', async () => {
      const closed = await entry('locations', 'ห้องปิดก่อนรับของ');
      await post(admin, `/references/locations/${closed.id}`, { expected_version: 1, is_active: false });
      const items = [
        { item_key: '6f1c5a52-5d0f-4b2a-9c1e-000000000003', name: 'ชุดที่ไม่ควรลงทะเบียน 1' },
        { item_key: '6f1c5a52-5d0f-4b2a-9c1e-000000000004', name: 'ชุดที่ไม่ควรลงทะเบียน 2' },
      ];
      for (const [token, shared] of [
        ['ia-bulk-2', { location_id: closed.id, effective_date: '2026-11-05' }],
        ['ia-bulk-3', { location_id: closed.id }],
        ['ia-bulk-4', { legacy_location_text: 'ห้องเก่า', effective_date: '2026-11-06' }],
      ] as const) {
        const res = await bulk(custodian, { ...shared, items }, token);
        expect(res.statusCode, token).toBe(400);
      }
      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('ชุดที่ไม่ควรลงทะเบียน')}`);
      expect(found.json().total_count).toBe(0);
    });
  });

  describe('Access (Q3)', () => {
    it('lets only an Asset Custodian register with dimension values, under CSRF, and records nothing otherwise', async () => {
      const room = await entry('locations', 'ห้องตรวจสิทธิ์');
      const shared = { location_id: room.id, effective_date: null };
      for (const actor of [readonly, admin, maintainer]) {
        expect((await post(actor, '/assets', { name: 'ลงทะเบียนโดยไม่มีสิทธิ์', ...shared })).statusCode).toBe(403);
        const batch = await post(
          actor,
          '/assets/bulk-register',
          { ...shared, items: [{ item_key: '6f1c5a52-5d0f-4b2a-9c1e-000000000010', name: 'ลงทะเบียนโดยไม่มีสิทธิ์' }] },
          { 'x-retry-token': `ia-denied-${actor.id}` }
        );
        expect(batch.statusCode).toBe(403);
      }
      const withoutCsrf = await app.inject({
        method: 'POST',
        url: '/assets',
        headers: { cookie: custodian.cookie, 'content-type': 'application/json' },
        payload: { name: 'ลงทะเบียนโดยไม่มีสิทธิ์', ...shared },
      });
      expect(withoutCsrf.statusCode).toBe(403);

      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('ลงทะเบียนโดยไม่มีสิทธิ์')}`);
      expect(found.json().total_count).toBe(0);
    });

    it('refuses dimension values to an actor who may register but not record an assignment, and still registers without them', async () => {
      const room = await entry('locations', 'ห้องไม่มีสิทธิ์กำหนด');
      // Only an Asset Custodian holds both capabilities today, so the second check is isolated here.
      await withCapabilityAnswer(app, 'assignment:reassign', async () => false, async () => {
        const single = await post(custodian, '/assets', {
          name: 'ลงทะเบียนโดยไม่มีสิทธิ์กำหนด',
          location_id: room.id,
          effective_date: null,
        });
        expect(single.statusCode).toBe(403);
        expect(single.json()).toMatchObject({ code: 'FORBIDDEN' });
        expect(single.json().message).toContain('assignment:reassign');
        const batch = await post(
          custodian,
          '/assets/bulk-register',
          {
            location_id: room.id,
            effective_date: null,
            items: [{ item_key: '6f1c5a52-5d0f-4b2a-9c1e-000000000011', name: 'ลงทะเบียนโดยไม่มีสิทธิ์กำหนด' }],
          },
          { 'x-retry-token': 'ia-no-assign' }
        );
        expect(batch.statusCode).toBe(403);

        const plain = await post(custodian, '/assets', { name: 'ลงทะเบียนได้โดยไม่กำหนด' });
        expect(plain.statusCode).toBe(201);
      });
      const found = await get(readonly, `/assets/search?field=name&value=${encodeURIComponent('ลงทะเบียนโดยไม่มีสิทธิ์กำหนด')}`);
      expect(found.json().total_count).toBe(0);
    });

    it('shows the assignment timeline to every role with asset:view and to no one else', async () => {
      const room = await entry('locations', 'ห้องดูประวัติ');
      const assetId = (await post(custodian, '/assets', { name: 'มีประวัติให้ดู', location_id: room.id, effective_date: null })).json()
        .asset.id;
      for (const viewer of [readonly, admin, custodian]) {
        expect((await get(viewer, `/assets/${assetId}/assignments`)).statusCode).toBe(200);
      }
      expect((await get(maintainer, `/assets/${assetId}/assignments`)).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/assets/${assetId}/assignments` })).statusCode).toBe(401);
      expect((await get(readonly, '/assets/not-a-uuid/assignments')).statusCode).toBe(400);
      expect((await get(readonly, '/assets/00000000-0000-4000-8000-000000000000/assignments')).statusCode).toBe(404);
    });
  });

  describe('Registry correction (#25 D3 as amended by Q1, ADR 0001)', () => {
    it('refuses any dimension value or its expected-before value, leaving the Initial Assignment as recorded', async () => {
      const roomA = await entry('locations', 'ห้องแก้ทะเบียน ก');
      const roomB = await entry('locations', 'ห้องแก้ทะเบียน ข');
      const asset = (
        await post(custodian, '/assets', { name: 'แก้ทะเบียนไม่ย้าย', location_id: roomA.id, effective_date: null })
      ).json().asset;
      const identity = { expected_name: asset.name, expected_asset_number: null, expected_serial_number: null };

      let token = 0;
      const refusals: [Actor, Record<string, unknown>][] = [
        [custodian, { location_id: roomB.id, expected_location_id: roomA.id }],
        [custodian, { location_id: null, expected_location_id: roomA.id }],
        [admin, { expected_location_id: roomA.id }],
        [admin, { responsible_person_id: null }],
        [custodian, { legacy_organization_unit_text: 'กองเดิม', expected_legacy_organization_unit_text: null }],
      ];
      for (const [actor, fields] of refusals) {
        const res = await post(actor, `/assets/${asset.id}/correct`, {
          ...identity,
          name: 'ชื่อที่ไม่ควรถูกแก้',
          reason: 'ย้ายห้อง',
          retry_token: `ia-correct-${++token}`,
          ...fields,
        });
        expect(res.statusCode, JSON.stringify(fields)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      const patched = await app.inject({
        method: 'PATCH',
        url: `/assets/${asset.id}`,
        headers: { cookie: custodian.cookie, 'x-csrf-token': custodian.csrf, 'content-type': 'application/json' },
        payload: { ...identity, reason: 'ย้ายห้อง', retry_token: 'ia-correct-patch', location_id: roomB.id, expected_location_id: roomA.id },
      });
      expect(patched.statusCode).toBe(400);

      const detail = (await get(readonly, `/assets/${asset.id}`)).json();
      expect(detail.asset.name).toBe('แก้ทะเบียนไม่ย้าย');
      expect(detail.current_assignment.location).toMatchObject({ id: roomA.id });
      expect(detail.history.map((h: any) => h.action)).toEqual(['REGISTERED']);
      expect(await timelineOf(asset.id)).toHaveLength(1);

      // Name, Asset Number and Serial Number are corrected as before and change no assignment fact.
      const renamed = await post(admin, `/assets/${asset.id}/correct`, {
        ...identity,
        name: 'แก้ชื่อทะเบียนแล้ว',
        asset_number: 'A-T1-77',
        reason: 'ชื่อและเลขตามป้ายจริง',
        retry_token: 'ia-correct-identity',
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().history.payload).toEqual({
        reason: 'ชื่อและเลขตามป้ายจริง',
        changes: {
          name: { before: 'แก้ทะเบียนไม่ย้าย', after: 'แก้ชื่อทะเบียนแล้ว' },
          asset_number: { before: null, after: 'A-T1-77' },
        },
      });
      const after = (await get(readonly, `/assets/${asset.id}`)).json();
      expect(after.current_assignment.location).toMatchObject({ id: roomA.id });
      expect(after.assignment_version).toBe(1);
      expect(await timelineOf(asset.id)).toEqual(await timelineOf(asset.id, custodian));
    });
  });

  describe('Search (AR-06, AR-10, Q14)', () => {
    const register = async (name: string, values: Record<string, unknown>) =>
      (
        await post(custodian, '/assets', {
          name,
          ...values,
          ...(Object.keys(values).length > 0 ? { effective_date: null } : {}),
        })
      ).json().asset.id as string;
    const search = (query: string) => get(readonly, `/assets/search?${query}`);
    const ids = async (query: string) => {
      const res = await search(query);
      expect(res.statusCode, query).toBe(200);
      return res.json().items.map((item: any) => item.id);
    };

    it('filters by the Current Assignment of each dimension, combined with AND, newest first and in pages', async () => {
      const room = await entry('locations', 'ห้องค้นหาปัจจุบัน');
      const unit = await entry('organization-units', 'หน่วยค้นหาปัจจุบัน');
      const person = await entry('persons', 'บุคคลค้นหาปัจจุบัน');
      const a1 = await register('ค้นหามิติ 1', { location_id: room.id, organization_unit_id: unit.id });
      const a2 = await register('ค้นหามิติ 2', { location_id: room.id, responsible_person_id: person.id });
      const a3 = await register('ค้นหามิติ 3', { organization_unit_id: unit.id });
      await register('ค้นหามิติ 4', {});

      expect(await ids(`location_id=${room.id}`)).toEqual([a2, a1]);
      expect(await ids(`organization_unit_id=${unit.id}`)).toEqual([a3, a1]);
      expect(await ids(`responsible_person_id=${person.id}`)).toEqual([a2]);
      expect(await ids(`location_id=${room.id}&organization_unit_id=${unit.id}`)).toEqual([a1]);
      expect(await ids(`location_id=${room.id}&field=name&value=${encodeURIComponent('ค้นหามิติ 1')}`)).toEqual([a1]);

      const first = (await search(`location_id=${room.id}&limit=1&offset=0`)).json();
      expect(first).toMatchObject({ total_count: 2, has_more: true, limit: 1, offset: 0 });
      expect(first.items.map((item: any) => item.id)).toEqual([a2]);
      const second = (await search(`location_id=${room.id}&limit=1&offset=1`)).json();
      expect(second).toMatchObject({ total_count: 2, has_more: false });
      expect(second.items.map((item: any) => item.id)).toEqual([a1]);

      // Each result carries its Current Assignment for display.
      expect(first.items[0]).toEqual({
        id: a2,
        name: 'ค้นหามิติ 2',
        asset_number: null,
        serial_number: null,
        location: { id: room.id, name: 'ห้องค้นหาปัจจุบัน', is_active: true },
        organization_unit: null,
        responsible_person: { id: person.id, name: 'บุคคลค้นหาปัจจุบัน', is_active: true },
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
    });

    it('finds an Asset by the Legacy text of its Initial Assignment, each dimension on its own', async () => {
      const id = await register('ค้นหาข้อความเดิม', {
        legacy_location_text: 'Old Store Room 9',
        legacy_responsible_person_text: 'ครูสมพร (ทะเบียนเดิม)',
      });
      const byText = (field: string, value: string) => ids(`field=${field}&value=${encodeURIComponent(value)}`);
      expect(await byText('legacy_location_text', 'store room 9')).toEqual([id]);
      expect(await byText('legacy_responsible_person_text', 'สมพร')).toEqual([id]);
      expect(await byText('legacy_organization_unit_text', 'store room 9')).toEqual([]);
      expect(await byText('legacy_responsible_person_text', 'store room 9')).toEqual([]);
    });
  });

  describe('Current Assignment over several facts (MR-03, AS-06)', () => {
    it('derives each dimension from its latest effective fact and lists the facts by Effective Date, unknown first', async () => {
      const roomA = await entry('locations', 'ห้องลำดับ ก');
      const roomB = await entry('locations', 'ห้องลำดับ ข');
      const roomC = await entry('locations', 'ห้องลำดับ ค');
      const person = await entry('persons', 'นางสาวลำดับ ง');
      const registered = (
        await post(custodian, '/assets', {
          name: 'ลำดับเหตุการณ์',
          location_id: roomA.id,
          legacy_responsible_person_text: 'ครูเดิม',
          effective_date: null,
        })
      ).json();
      const assetId = registered.asset.id;

      // Reassignments are recorded through the API from F003-T2; here they are seeded as facts,
      // recorded out of Effective Date order.
      const reassignment = async (effectiveDate: string, recordedAt: string, dimension: string, values: Record<string, string>) => {
        const eventId = (
          await pool.query(
            `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_at, recorded_by, provenance)
             VALUES ($1, 'REASSIGNMENT', $2, $3, $4, 'RECORDED') RETURNING id`,
            [assetId, effectiveDate, recordedAt, custodian.id]
          )
        ).rows[0].id;
        const columns = Object.keys(values);
        await pool.query(
          `INSERT INTO assignment_changes (event_id, event_kind, dimension, ${columns.join(', ')})
           VALUES ($1, 'REASSIGNMENT', $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')})`,
          [eventId, dimension, ...Object.values(values)]
        );
        return eventId as string;
      };
      const toB = await reassignment('2026-10-01', '2026-11-05T01:00:00Z', 'LOCATION', {
        prior_location_id: roomA.id,
        new_location_id: roomB.id,
      });
      const toC = await reassignment('2026-09-01', '2026-11-05T02:00:00Z', 'LOCATION', {
        prior_location_id: roomA.id,
        new_location_id: roomC.id,
      });
      const toPerson = await reassignment('2026-10-01', '2026-11-05T03:00:00Z', 'RESPONSIBLE_PERSON', {
        prior_legacy_text: 'ครูเดิม',
        new_person_id: person.id,
      });

      const timeline = await timelineOf(assetId);
      expect(timeline.map((event: any) => [event.id, event.kind, event.effective_date])).toEqual([
        [registered.initial_assignment.id, 'INITIAL', null],
        [toC, 'REASSIGNMENT', '2026-09-01'],
        [toB, 'REASSIGNMENT', '2026-10-01'],
        [toPerson, 'REASSIGNMENT', '2026-10-01'],
      ]);
      expect(timeline[2].changes).toEqual([
        {
          dimension: 'location',
          prior: { entry: { id: roomA.id, name: 'ห้องลำดับ ก', is_active: true }, legacy_text: null },
          new: { entry: { id: roomB.id, name: 'ห้องลำดับ ข', is_active: true }, legacy_text: null },
          // Seeded out of order, this fact's prior value is not the one just before it.
          conflict: { value_just_before: { entry: { id: roomC.id, name: 'ห้องลำดับ ค', is_active: true }, legacy_text: null } },
        },
      ]);

      // The latest effective fact of each dimension holds, whenever it was recorded.
      const detail = (await get(readonly, `/assets/${assetId}`)).json();
      expect(detail.current_assignment).toEqual({
        location: { id: roomB.id, name: 'ห้องลำดับ ข', is_active: true },
        organization_unit: null,
        responsible_person: { id: person.id, name: 'นางสาวลำดับ ง', is_active: true },
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
      const ids = async (query: string) => (await get(readonly, `/assets/search?${query}`)).json().items.map((i: any) => i.id);
      expect(await ids(`location_id=${roomB.id}`)).toEqual([assetId]);
      expect(await ids(`location_id=${roomA.id}`)).toEqual([]);
      expect(await ids(`location_id=${roomC.id}`)).toEqual([]);
      expect(await ids(`responsible_person_id=${person.id}`)).toEqual([assetId]);
      // The old-register wording stays findable after its dimension moved on (#50 search decision).
      expect(await ids(`field=legacy_responsible_person_text&value=${encodeURIComponent('ครูเดิม')}`)).toEqual([assetId]);
    });
  });

  describe('One transaction (US 8, US 49)', () => {
    // A test-only trigger holds or fails the registration's transaction after its Asset is inserted,
    // when the Initial Assignment writes the marker Legacy text.
    const withMarkerTrigger = async (run: () => Promise<void>) => {
      await pool.query(`
        CREATE FUNCTION test_initial_assignment_marker() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.new_legacy_text = 'HOLD' THEN PERFORM pg_advisory_xact_lock(51001); END IF;
          IF NEW.new_legacy_text = 'FAIL' THEN RAISE EXCEPTION 'injected failure after the Asset insert'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_initial_assignment_marker BEFORE INSERT ON assignment_changes
          FOR EACH ROW EXECUTE FUNCTION test_initial_assignment_marker();`);
      try {
        await run();
      } finally {
        await pool.query(`DROP TRIGGER test_initial_assignment_marker ON assignment_changes;
          DROP FUNCTION test_initial_assignment_marker();`);
      }
    };
    const countNamed = async (name: string) =>
      (await get(readonly, `/assets/search?field=name&value=${encodeURIComponent(name)}`)).json().total_count;

    it('commits the registration and its Initial Assignment together, as an independent connection sees', async () => {
      const room = await entry('locations', 'ห้องดูการบันทึกพร้อมกัน');
      await withMarkerTrigger(async () => {
        const holder = await pool.connect();
        try {
          await holder.query('SELECT pg_advisory_lock(51001)');
          const registration = post(custodian, '/assets', {
            name: 'ลงทะเบียนพร้อมกำหนดครั้งแรก',
            location_id: room.id,
            legacy_responsible_person_text: 'HOLD',
            effective_date: null,
          });

          // The registration waits on the held lock after inserting its Asset, still uncommitted.
          let waiting = 0;
          for (let attempt = 0; attempt < 100 && waiting === 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            waiting = (
              await pool.query(
                `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`
              )
            ).rows[0].n;
          }
          expect(waiting).toBe(1);
          expect(await countNamed('ลงทะเบียนพร้อมกำหนดครั้งแรก')).toBe(0);

          await holder.query('SELECT pg_advisory_unlock(51001)');
          const res = await registration;
          expect(res.statusCode).toBe(201);
          expect(await countNamed('ลงทะเบียนพร้อมกำหนดครั้งแรก')).toBe(1);
          expect(await timelineOf(res.json().asset.id)).toHaveLength(1);
        } finally {
          holder.release();
        }
      });
    });

    it('records neither the registration nor its Initial Assignment when the Initial Assignment fails, and discloses no detail', async () => {
      const room = await entry('locations', 'ห้องที่บันทึกไม่สำเร็จ');
      await withMarkerTrigger(async () => {
        const res = await post(custodian, '/assets', {
          name: 'ลงทะเบียนที่ต้องย้อนกลับ',
          location_id: room.id,
          legacy_responsible_person_text: 'FAIL',
          effective_date: null,
        });
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('injected');
        expect(res.body).not.toContain('assignment_changes');
      });
      expect(await countNamed('ลงทะเบียนที่ต้องย้อนกลับ')).toBe(0);
    });
  });
});
