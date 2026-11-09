import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
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

// F003-T2 (#52): an Asset Custodian changes where an Asset belongs, from the Asset page.
describe('Reassign one Asset (Seam A - F003-T2)', () => {
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

  const detailOf = async (assetId: string) => (await get(readonly, `/assets/${assetId}`)).json();

  const timelineOf = async (assetId: string) => {
    const res = await get(readonly, `/assets/${assetId}/assignments`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  // Registers an Asset, with an Initial Assignment when the payload names dimension values.
  const registered = async (payload: Record<string, unknown>): Promise<string> => {
    const res = await post(custodian, '/assets', payload);
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // Records an assignment fact. The retry token is fresh unless a test names one.
  const record = (assetId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    post(actor, `/assets/${assetId}/assignments`, payload, { 'x-retry-token': token });

  const reassign = (assetId: string, payload: Record<string, unknown>, token?: string) =>
    record(assetId, { kind: 'REASSIGNMENT', ...payload }, token);

  const withReassignCapability = <T>(answer: () => Promise<boolean>, work: () => Promise<T>): Promise<T> =>
    withCapabilityAnswer(app, 'assignment:reassign', answer, work);

  // What an observer reads of an Asset's assignment, to show that a refused write changed nothing.
  const assignmentOf = async (assetId: string) => {
    const detail = await detailOf(assetId);
    return {
      current: detail.current_assignment,
      version: detail.assignment_version,
      timeline: await timelineOf(assetId),
    };
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
      cookieSecret: 'test-secret-at-least-32-chars-long-reassignment',
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

    admin = await createAuthenticatedSession(await createUserWithRole('admin_ra', 'ADMINISTRATOR'));
    custodian = await createAuthenticatedSession(await createUserWithRole('custodian_ra', 'ASSET_CUSTODIAN'));
    readonly = await createAuthenticatedSession(await createUserWithRole('readonly_ra', 'READ_ONLY'));
    maintainer = await createAuthenticatedSession(await createUserWithRole('maintainer_ra', 'SYSTEM_MAINTAINER'));
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  describe('Recording (MR-01, MR-02, AR-02)', () => {
    it('records a Reassignment as one event of the changed dimension, moves the Current Assignment and keeps the Stable ID', async () => {
      const from = await entry('locations', 'ห้องพัสดุเดิม');
      const to = await entry('locations', 'ห้องพัสดุใหม่');
      const unit = await entry('organization-units', 'กลุ่มงานคงเดิม');
      const assetId = await registered({
        name: 'เครื่องถ่ายเอกสาร',
        location_id: from.id,
        organization_unit_id: unit.id,
        effective_date: '2026-10-01',
      });
      const before = await detailOf(assetId);
      expect(before.assignment_version).toBe(1);

      const res = await reassign(assetId, {
        expected_assignment_version: 1,
        effective_date: '2026-11-03',
        location_id: to.id,
        document_reference: ' บันทึกข้อความ ที่ 45/2569 ',
        remark: 'ย้ายตามการปรับห้องทำงาน',
      });
      expect(res.statusCode).toBe(201);

      const after = await detailOf(assetId);
      expect(after.asset.id).toBe(assetId);
      expect(after.asset.recorded_at).toBe(before.asset.recorded_at);
      expect(after.history).toEqual(before.history);
      expect(after.assignment_version).toBe(2);
      expect(after.current_assignment).toEqual({
        location: { id: to.id, name: 'ห้องพัสดุใหม่', is_active: true },
        organization_unit: { id: unit.id, name: 'กลุ่มงานคงเดิม', is_active: true },
        responsible_person: null,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });

      const timeline = await timelineOf(assetId);
      expect(timeline.map((event: any) => event.kind)).toEqual(['INITIAL', 'REASSIGNMENT']);
      expect(timeline[1]).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'REASSIGNMENT',
        effective_date: '2026-11-03',
        recorded_at: expect.any(String),
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_ra',
        provenance: 'RECORDED',
        document_reference: 'บันทึกข้อความ ที่ 45/2569',
        remark: 'ย้ายตามการปรับห้องทำงาน',
        is_voided: false,
        bulk_reference: null,
        changes: [
          {
            dimension: 'location',
            prior: { entry: { id: from.id, name: 'ห้องพัสดุเดิม', is_active: true }, legacy_text: null },
            new: { entry: { id: to.id, name: 'ห้องพัสดุใหม่', is_active: true }, legacy_text: null },
            conflict: null,
          },
        ],
        corrections: [],
      });
      expect(res.json()).toEqual({
        event: timeline[1],
        current_assignment: after.current_assignment,
        assignment_version: 2,
      });
    });

    it('records one event for several dimensions, each with its own prior and new value', async () => {
      const room = await entry('locations', 'ห้องหลายมิติ เดิม');
      const newRoom = await entry('locations', 'ห้องหลายมิติ ใหม่');
      const person = await entry('persons', 'คุณหลายมิติ');
      const assetId = await registered({ name: 'ตู้เอกสาร', location_id: room.id, effective_date: '2026-10-01' });

      const res = await reassign(assetId, {
        expected_assignment_version: 1,
        effective_date: '2026-11-05',
        location_id: newRoom.id,
        responsible_person_id: person.id,
      });
      expect(res.statusCode).toBe(201);

      const timeline = await timelineOf(assetId);
      expect(timeline).toHaveLength(2);
      expect(timeline[1].changes).toEqual([
        {
          dimension: 'location',
          prior: { entry: { id: room.id, name: 'ห้องหลายมิติ เดิม', is_active: true }, legacy_text: null },
          new: { entry: { id: newRoom.id, name: 'ห้องหลายมิติ ใหม่', is_active: true }, legacy_text: null },
          conflict: null,
        },
        {
          dimension: 'responsible_person',
          prior: NO_VALUE,
          new: { entry: { id: person.id, name: 'คุณหลายมิติ', is_active: true }, legacy_text: null },
          conflict: null,
        },
      ]);
    });

    it('records an Initial Assignment for an Asset that has none, with Legacy text and an unknown Effective Date', async () => {
      const room = await entry('locations', 'ห้องกำหนดภายหลัง');
      const assetId = await registered({ name: 'โต๊ะที่ยังไม่ได้กำหนด' });

      const res = await record(assetId, {
        kind: 'INITIAL',
        expected_assignment_version: 0,
        effective_date: null,
        location_id: room.id,
        legacy_responsible_person_text: ' คุณสมชาย (ทะเบียนเก่า) ',
        document_reference: 'สมุดทะเบียน เล่ม 2',
      });
      expect(res.statusCode).toBe(201);

      const timeline = await timelineOf(assetId);
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({
        kind: 'INITIAL',
        effective_date: null,
        provenance: 'RECORDED',
        recorded_by: custodian.id,
        document_reference: 'สมุดทะเบียน เล่ม 2',
      });
      expect(timeline[0].changes).toEqual([
        { dimension: 'location', prior: NO_VALUE, new: { entry: { id: room.id, name: 'ห้องกำหนดภายหลัง', is_active: true }, legacy_text: null }, conflict: null },
        { dimension: 'responsible_person', prior: NO_VALUE, new: { entry: null, legacy_text: 'คุณสมชาย (ทะเบียนเก่า)' }, conflict: null },
      ]);
      const detail = await detailOf(assetId);
      expect(detail.assignment_version).toBe(1);
      expect(detail.current_assignment.legacy_responsible_person_text).toBe('คุณสมชาย (ทะเบียนเก่า)');
      expect(res.json().event).toEqual(timeline[0]);
    });

    it('refuses a second Initial Assignment, and a Reassignment of an Asset that has none, without writing', async () => {
      const room = await entry('locations', 'ห้องกฎครั้งแรก');
      const other = await entry('locations', 'ห้องกฎครั้งแรก 2');
      const placed = await registered({ name: 'มีครั้งแรกแล้ว', location_id: room.id, effective_date: '2026-10-01' });
      const unplaced = await registered({ name: 'ยังไม่มีครั้งแรก' });

      const before = await assignmentOf(placed);
      const second = await record(placed, {
        kind: 'INITIAL',
        expected_assignment_version: 1,
        effective_date: '2026-10-02',
        location_id: other.id,
      });
      expect(second.statusCode).toBe(400);
      expect(second.json().code).toBe('VALIDATION_FAILED');
      expect(await assignmentOf(placed)).toEqual(before);

      const beforeUnplaced = await assignmentOf(unplaced);
      const early = await reassign(unplaced, {
        expected_assignment_version: 0,
        effective_date: '2026-11-01',
        location_id: other.id,
      });
      expect(early.statusCode).toBe(400);
      expect(early.json().code).toBe('VALIDATION_FAILED');
      expect(await assignmentOf(unplaced)).toEqual(beforeUnplaced);
    });

    it('refuses an Initial Assignment that names no dimension value, and answers for an unknown Asset or a malformed id', async () => {
      const assetId = await registered({ name: 'ไม่มีค่าใดเลย' });
      for (const empty of [{ expected_assignment_version: 0 }, { expected_assignment_version: 0, effective_date: null }]) {
        const res = await record(assetId, { kind: 'INITIAL', ...empty });
        expect(res.statusCode, JSON.stringify(empty)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await timelineOf(assetId)).toEqual([]);

      const room = await entry('locations', 'ห้องไม่มี Asset');
      const missing = await reassign('11111111-1111-4111-8111-111111111111', {
        expected_assignment_version: 0,
        effective_date: '2026-11-01',
        location_id: room.id,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');

      const malformed = await reassign('not-a-uuid', { expected_assignment_version: 0, effective_date: '2026-11-01', location_id: room.id });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('INVALID_ID');
    });

    it('refuses a body that is not the contract, such as client-set prior values, with the deterministic error shape', async () => {
      const room = await entry('locations', 'ห้องสัญญา');
      const assetId = await registered({ name: 'ตรวจรูปแบบคำขอ', location_id: room.id, effective_date: '2026-10-01' });
      const other = await entry('locations', 'ห้องสัญญา 2');
      const before = await assignmentOf(assetId);
      const base = { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2026-11-01', location_id: other.id };

      for (const body of [
        { ...base, prior_location_id: room.id },
        { ...base, kind: 'MOVE' },
        { ...base, expected_assignment_version: '1' },
        { ...base, expected_assignment_version: -1 },
        { kind: 'REASSIGNMENT', effective_date: '2026-11-01', location_id: other.id },
      ]) {
        const res = await record(assetId, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
        expect(res.json().statusCode).toBe(400);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });
  });

  describe('Effective Date (AS-06, MR-04, MR-05, Q2, Q11)', () => {
    // An Asset at Location `from` since an unknown date, ready to be reassigned.
    const placedAsset = async (name: string) => {
      const from = await entry('locations', `${name} เดิม`);
      const to = await entry('locations', `${name} ใหม่`);
      const assetId = await registered({ name, location_id: from.id, effective_date: null });
      return { assetId, from, to };
    };

    it("is no later than today's Asia/Bangkok date, which turns at 17:00 UTC", async () => {
      const { assetId, to } = await placedAsset('ตรวจขอบเขตวัน');
      const unit = await entry('organization-units', 'หน่วยขอบเขตวัน');
      const before = now;
      try {
        now = new Date('2026-11-05T16:59:59Z');
        const tooLate = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-06', location_id: to.id });
        expect(tooLate.statusCode).toBe(400);
        expect(tooLate.json().code).toBe('VALIDATION_FAILED');
        expect(await timelineOf(assetId)).toHaveLength(1);

        const today = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-05', location_id: to.id });
        expect(today.statusCode).toBe(201);

        now = new Date('2026-11-05T17:00:00Z');
        const afterMidnight = await reassign(assetId, {
          expected_assignment_version: 2,
          effective_date: '2026-11-06',
          organization_unit_id: unit.id,
        });
        expect(afterMidnight.statusCode).toBe(201);
      } finally {
        now = before;
      }
    });

    it('has no lower bound', async () => {
      const { assetId, to } = await placedAsset('ตรวจย้อนหลัง');
      const res = await reassign(assetId, { expected_assignment_version: 1, effective_date: '0001-01-01', location_id: to.id });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.effective_date).toBe('0001-01-01');
    });

    it('is required on a Reassignment, as a real calendar date: unknown is refused there', async () => {
      const { assetId, to } = await placedAsset('ตรวจรูปแบบวันที่');
      const before = await assignmentOf(assetId);
      for (const effective of [
        {},
        { effective_date: null },
        { effective_date: '' },
        { effective_date: '2026-02-29' },
        { effective_date: '2026-11-5' },
        { effective_date: '2026-13-01' },
      ]) {
        const res = await reassign(assetId, { expected_assignment_version: 1, location_id: to.id, ...effective });
        expect(res.statusCode, JSON.stringify(effective)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it("applies the same bound to an Initial Assignment recorded later, and refuses a malformed date there", async () => {
      const room = await entry('locations', 'ห้องวันที่ครั้งแรก');
      const assetId = await registered({ name: 'ตรวจวันครั้งแรก' });
      for (const effective of [{ effective_date: '2026-11-06' }, { effective_date: 'วันนี้' }, {}]) {
        const res = await record(assetId, { kind: 'INITIAL', expected_assignment_version: 0, location_id: room.id, ...effective });
        expect(res.statusCode, JSON.stringify(effective)).toBe(400);
      }
      expect(await timelineOf(assetId)).toEqual([]);
    });
  });

  describe('Prior values (derived by the server, MR-01)', () => {
    const rooms = async (prefix: string, count: number) =>
      Promise.all(Array.from({ length: count }, (_, i) => entry('locations', `${prefix} ${i + 1}`)));

    const at = (room: { id: string; name: string }) => ({ entry: { id: room.id, name: room.name, is_active: true }, legacy_text: null });

    it('derives each prior value at the Effective Date, not from the Current Assignment', async () => {
      const [a, b, c, d] = await rooms('ห้องลำดับ', 4);
      const assetId = await registered({ name: 'ตรวจค่าก่อนหน้า', location_id: a.id, effective_date: null });
      expect((await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-06-01', location_id: b.id })).statusCode).toBe(201);
      expect((await reassign(assetId, { expected_assignment_version: 2, effective_date: '2026-09-01', location_id: c.id })).statusCode).toBe(201);

      const backdated = await reassign(assetId, { expected_assignment_version: 3, effective_date: '2026-07-15', location_id: d.id, explicit_continuation: true });
      expect(backdated.statusCode).toBe(201);
      expect(backdated.json().event.changes).toEqual([{ dimension: 'location', prior: at(b), new: at(d), conflict: null }]);

      // The facts read in Effective Date order, and the Current Assignment follows the latest date.
      const timeline = await timelineOf(assetId);
      expect(timeline.map((event: any) => event.effective_date)).toEqual([null, '2026-06-01', '2026-07-15', '2026-09-01']);
      expect((await detailOf(assetId)).current_assignment.location.id).toBe(c.id);
    });

    it('treats a fact of unknown date as before every dated fact, and a date before all facts as having no prior value', async () => {
      const [a, b, c] = await rooms('ห้องไม่ทราบวัน', 3);
      const assetId = await registered({ name: 'ตรวจวันไม่ทราบ', location_id: a.id, effective_date: null });
      const early = await reassign(assetId, { expected_assignment_version: 1, effective_date: '1999-01-01', location_id: b.id });
      expect(early.statusCode).toBe(201);
      expect(early.json().event.changes[0].prior).toEqual(at(a));

      const dated = await registered({ name: 'ตรวจก่อนทุกข้อเท็จจริง', location_id: a.id, effective_date: '2026-10-01' });
      const before = await reassign(dated, { expected_assignment_version: 1, effective_date: '2026-09-01', location_id: c.id, explicit_continuation: true });
      expect(before.statusCode).toBe(201);
      expect(before.json().event.changes[0].prior).toEqual(NO_VALUE);
    });

    it('places a fact after those already recorded on its own date, ordered by Recorded At', async () => {
      const [a, b, c] = await rooms('ห้องวันเดียวกัน', 3);
      const assetId = await registered({ name: 'ตรวจวันเดียวกัน', location_id: a.id, effective_date: '2026-10-01' });
      expect((await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: b.id })).statusCode).toBe(201);

      const sameDate = await reassign(assetId, { expected_assignment_version: 2, effective_date: '2026-11-01', location_id: c.id });
      expect(sameDate.statusCode).toBe(201);
      expect(sameDate.json().event.changes).toEqual([{ dimension: 'location', prior: at(b), new: at(c), conflict: null }]);
      expect((await detailOf(assetId)).current_assignment.location.id).toBe(c.id);
      const timeline = await timelineOf(assetId);
      expect(timeline[1].changes[0].new.entry.id).toBe(b.id);
      expect(timeline[2].changes[0].new.entry.id).toBe(c.id);
    });

    it('drops a dimension whose new value equals its prior value, and records the rest', async () => {
      const [a, b] = await rooms('ห้องไม่เปลี่ยน', 2);
      const unit = await entry('organization-units', 'หน่วยไม่เปลี่ยน');
      const assetId = await registered({ name: 'ตรวจตัดมิติ', location_id: a.id, organization_unit_id: unit.id, effective_date: '2026-10-01' });

      const res = await reassign(assetId, {
        expected_assignment_version: 1,
        effective_date: '2026-11-01',
        location_id: b.id,
        organization_unit_id: unit.id,
        responsible_person_id: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.changes).toEqual([{ dimension: 'location', prior: at(a), new: at(b), conflict: null }]);
    });

    it('refuses a request left with no change, at the Effective Date, without writing', async () => {
      const [a, b] = await rooms('ห้องไม่มีการเปลี่ยน', 2);
      const assetId = await registered({ name: 'ตรวจไม่มีการเปลี่ยน', location_id: a.id, effective_date: '2026-06-01' });
      expect((await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-09-01', location_id: b.id })).statusCode).toBe(201);
      const before = await assignmentOf(assetId);

      for (const payload of [
        { effective_date: '2026-10-01', location_id: b.id },
        { effective_date: '2026-07-01', location_id: a.id },
        { effective_date: '2026-10-01', organization_unit_id: null },
        { effective_date: '2026-10-01' },
      ]) {
        const res = await reassign(assetId, { expected_assignment_version: 2, ...payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });
  });

  describe('New values (AS-02, AS-04, Q14, Q15, Q16)', () => {
    it('clears the OrganizationUnit or the Responsible Person', async () => {
      const room = await entry('locations', 'ห้องล้างค่า');
      const unit = await entry('organization-units', 'หน่วยล้างค่า');
      const person = await entry('persons', 'คุณล้างค่า');
      const assetId = await registered({
        name: 'ตรวจการล้างค่า',
        location_id: room.id,
        organization_unit_id: unit.id,
        responsible_person_id: person.id,
        effective_date: '2026-10-01',
      });

      const res = await reassign(assetId, {
        expected_assignment_version: 1,
        effective_date: '2026-11-01',
        organization_unit_id: null,
        responsible_person_id: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.changes).toEqual([
        { dimension: 'organization_unit', prior: { entry: { id: unit.id, name: 'หน่วยล้างค่า', is_active: true }, legacy_text: null }, new: NO_VALUE, conflict: null },
        { dimension: 'responsible_person', prior: { entry: { id: person.id, name: 'คุณล้างค่า', is_active: true }, legacy_text: null }, new: NO_VALUE, conflict: null },
      ]);
      const { current_assignment: current } = await detailOf(assetId);
      expect(current.location.id).toBe(room.id);
      expect(current.organization_unit).toBeNull();
      expect(current.responsible_person).toBeNull();
    });

    it('refuses clearing the Location, and any Legacy text, on a Reassignment', async () => {
      const room = await entry('locations', 'ห้องห้ามล้าง');
      const assetId = await registered({ name: 'ตรวจห้ามล้าง', location_id: room.id, effective_date: '2026-10-01' });
      const before = await assignmentOf(assetId);

      for (const payload of [
        { location_id: null },
        { legacy_location_text: 'ห้องเก่า' },
        { legacy_organization_unit_text: 'หน่วยเก่า' },
        { legacy_responsible_person_text: 'คุณเก่า' },
        { legacy_responsible_person_text: null },
      ]) {
        const res = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', ...payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it("takes every entry from its own dimension's list", async () => {
      const room = await entry('locations', 'ห้องตรวจรายการ');
      const unit = await entry('organization-units', 'หน่วยตรวจรายการ');
      const assetId = await registered({ name: 'ตรวจรายการ', location_id: room.id, effective_date: '2026-10-01' });
      const before = await assignmentOf(assetId);

      for (const payload of [
        { location_id: unit.id },
        { organization_unit_id: room.id },
        { responsible_person_id: room.id },
        { location_id: '11111111-1111-4111-8111-111111111111' },
        { location_id: 'not-a-uuid' },
      ]) {
        const res = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', ...payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('accepts a deactivated entry only with an Effective Date before today', async () => {
      const room = await entry('locations', 'ห้องเปิดอยู่');
      const closed = await entry('locations', 'ห้องที่ปิดแล้ว');
      await post(admin, `/references/locations/${closed.id}`, { expected_version: closed.version, is_active: false });
      const assetId = await registered({ name: 'ตรวจรายการปิด', location_id: room.id, effective_date: '2026-10-01' });
      const before = await assignmentOf(assetId);

      const today = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-05', location_id: closed.id });
      expect(today.statusCode).toBe(400);
      expect(today.json().code).toBe('VALIDATION_FAILED');
      expect(await assignmentOf(assetId)).toEqual(before);

      const yesterday = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-04', location_id: closed.id });
      expect(yesterday.statusCode).toBe(201);
      expect(yesterday.json().event.changes[0].new.entry).toEqual({ id: closed.id, name: 'ห้องที่ปิดแล้ว', is_active: false });
    });

    it('accepts a deactivated entry on an Initial Assignment only before today or unknown', async () => {
      const closed = await entry('locations', 'ห้องปิด ครั้งแรก');
      await post(admin, `/references/locations/${closed.id}`, { expected_version: closed.version, is_active: false });
      const assetId = await registered({ name: 'ตรวจครั้งแรกกับรายการปิด' });

      const today = await record(assetId, { kind: 'INITIAL', expected_assignment_version: 0, effective_date: '2026-11-05', location_id: closed.id });
      expect(today.statusCode).toBe(400);
      expect(await timelineOf(assetId)).toEqual([]);

      const unknown = await record(assetId, { kind: 'INITIAL', expected_assignment_version: 0, effective_date: null, location_id: closed.id });
      expect(unknown.statusCode).toBe(201);
    });

    it('keeps a deactivated entry out of the check when it is not a change: the dimension is dropped', async () => {
      const closing = await entry('locations', 'ห้องกำลังปิด');
      const unit = await entry('organization-units', 'หน่วยคู่กับห้องปิด');
      const assetId = await registered({ name: 'ตรวจรายการปิดที่ไม่เปลี่ยน', location_id: closing.id, effective_date: '2026-10-01' });
      await post(admin, `/references/locations/${closing.id}`, { expected_version: closing.version, is_active: false });

      const res = await reassign(assetId, {
        expected_assignment_version: 1,
        effective_date: '2026-11-05',
        location_id: closing.id,
        organization_unit_id: unit.id,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.changes.map((change: any) => change.dimension)).toEqual(['organization_unit']);
    });
  });

  describe('Document reference and remark (AS-07, MR-08, Q5)', () => {
    it('keeps them optional, trimmed, blank as none', async () => {
      const room = await entry('locations', 'ห้องเอกสาร');
      const other = await entry('locations', 'ห้องเอกสาร 2');
      const assetId = await registered({ name: 'ตรวจเอกสาร', location_id: room.id, effective_date: '2026-10-01' });

      const res = await reassign(assetId, {
        expected_assignment_version: 1,
        effective_date: '2026-11-01',
        location_id: other.id,
        document_reference: '   ',
        remark: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.document_reference).toBeNull();
      expect(res.json().event.remark).toBeNull();
    });

    it('refuses overlong text and control characters, on either kind, without writing', async () => {
      const room = await entry('locations', 'ห้องข้อความ');
      const other = await entry('locations', 'ห้องข้อความ 2');
      const assetId = await registered({ name: 'ตรวจข้อความ', location_id: room.id, effective_date: '2026-10-01' });
      const unplaced = await registered({ name: 'ตรวจข้อความครั้งแรก' });
      const before = await assignmentOf(assetId);

      for (const text of [
        { document_reference: 'ก'.repeat(501) },
        { document_reference: 'เลขที่\u0007' },
        { remark: 'ก'.repeat(2001) },
        { remark: 'หมายเหตุ\u0000' },
        { document_reference: 12 },
      ]) {
        const reassigned = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: other.id, ...text });
        expect(reassigned.statusCode, JSON.stringify(text)).toBe(400);
        expect(reassigned.json().code).toBe('VALIDATION_FAILED');

        const initial = await record(unplaced, { kind: 'INITIAL', expected_assignment_version: 0, effective_date: '2026-11-01', location_id: other.id, ...text });
        expect(initial.statusCode, JSON.stringify(text)).toBe(400);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
      expect(await timelineOf(unplaced)).toEqual([]);
    });
  });

  describe('Current Assignment and timeline (MR-03, Q14, Q20)', () => {
    it('removes Legacy text from the Current Assignment once its dimension is reassigned, keeps it as the prior value, and still finds the Asset by it', async () => {
      const room = await entry('locations', 'ห้องแทนข้อความเดิม');
      const person = await entry('persons', 'คุณแทนข้อความเดิม');
      const assetId = await registered({
        name: 'ตรวจข้อความเดิม',
        legacy_location_text: 'ตึกเก่า ชั้นสอง',
        legacy_responsible_person_text: 'คุณเก่า ทะเบียนเดิม',
        effective_date: null,
      });

      const res = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: room.id });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.changes).toEqual([
        {
          dimension: 'location',
          prior: { entry: null, legacy_text: 'ตึกเก่า ชั้นสอง' },
          new: { entry: { id: room.id, name: 'ห้องแทนข้อความเดิม', is_active: true }, legacy_text: null },
          conflict: null,
        },
      ]);
      const detail = await detailOf(assetId);
      expect(detail.current_assignment.location.id).toBe(room.id);
      expect(detail.current_assignment.legacy_location_text).toBeNull();
      // The dimension not reassigned keeps its Legacy text.
      expect(detail.current_assignment.legacy_responsible_person_text).toBe('คุณเก่า ทะเบียนเดิม');

      const found = await get(readonly, `/assets/search?field=legacy_location_text&value=${encodeURIComponent('ตึกเก่า')}`);
      expect(found.json().items.map((item: any) => item.id)).toContain(assetId);

      // A second dimension's Legacy text stays as the prior value of its own Reassignment.
      const replaced = await reassign(assetId, { expected_assignment_version: 2, effective_date: '2026-11-02', responsible_person_id: person.id });
      expect(replaced.json().event.changes[0].prior).toEqual({ entry: null, legacy_text: 'คุณเก่า ทะเบียนเดิม' });
    });

    it('clears a dimension that holds only Legacy text, keeping the wording as the prior value', async () => {
      const assetId = await registered({ name: 'ตรวจล้างข้อความเดิม', legacy_organization_unit_text: 'กองเก่า (ทะเบียนเดิม)', effective_date: null });

      const res = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', organization_unit_id: null });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.changes).toEqual([
        { dimension: 'organization_unit', prior: { entry: null, legacy_text: 'กองเก่า (ทะเบียนเดิม)' }, new: NO_VALUE, conflict: null },
      ]);
      const { current_assignment: current } = await detailOf(assetId);
      expect(current.organization_unit).toBeNull();
      expect(current.legacy_organization_unit_text).toBeNull();
    });

    it('counts picking the entry already named as a change when it replaces Legacy text beside that entry', async () => {
      const room = await entry('locations', 'ห้องคู่ข้อความเดิม');
      const assetId = await registered({ name: 'ตรวจคู่ข้อความ', location_id: room.id, legacy_location_text: 'ห้องเดิมในทะเบียน', effective_date: null });

      const res = await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: room.id });
      expect(res.statusCode).toBe(201);
      expect((await detailOf(assetId)).current_assignment.legacy_location_text).toBeNull();
    });

    it('shows entries in the timeline by their current name, and deactivated ones as such', async () => {
      const room = await entry('locations', 'ห้องชื่อเก่า');
      const other = await entry('locations', 'ห้องปลายทางที่จะปิด');
      const assetId = await registered({ name: 'ตรวจชื่อปัจจุบัน', location_id: room.id, effective_date: '2026-10-01' });
      expect((await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: other.id })).statusCode).toBe(201);

      const renamed = await post(admin, `/references/locations/${room.id}`, { expected_version: room.version, name: 'ห้องชื่อใหม่' });
      expect(renamed.statusCode).toBe(200);
      const closed = await post(admin, `/references/locations/${other.id}`, { expected_version: other.version, is_active: false });
      expect(closed.statusCode).toBe(200);

      const [initial, reassignment] = await timelineOf(assetId);
      expect(initial.changes[0].new.entry.name).toBe('ห้องชื่อใหม่');
      expect(reassignment.changes[0].prior.entry).toEqual({ id: room.id, name: 'ห้องชื่อใหม่', is_active: true });
      expect(reassignment.changes[0].new.entry).toEqual({ id: other.id, name: 'ห้องปลายทางที่จะปิด', is_active: false });
    });
  });

  describe('Expected assignment version (US 27)', () => {
    it('refuses a stale version with the stale-before conflict, without writing, and increments on every write', async () => {
      const [a, b, c] = await Promise.all(['ก', 'ข', 'ค'].map((suffix) => entry('locations', `ห้องรุ่น ${suffix}`)));
      const assetId = await registered({ name: 'ตรวจรุ่น', location_id: a.id, effective_date: '2026-10-01' });
      expect((await reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: b.id })).json().assignment_version).toBe(2);
      const before = await assignmentOf(assetId);

      for (const stale of [1, 3, 0]) {
        const res = await reassign(assetId, { expected_assignment_version: stale, effective_date: '2026-11-02', location_id: c.id });
        expect(res.statusCode, String(stale)).toBe(409);
        expect(res.json()).toMatchObject({
          statusCode: 409,
          code: 'STALE_BEFORE_CONFLICT',
          error: 'STALE_BEFORE_CONFLICT',
          current_values: { assignment_version: 2 },
          expected_values: { assignment_version: stale },
        });
      }
      expect(await assignmentOf(assetId)).toEqual(before);

      expect((await reassign(assetId, { expected_assignment_version: 2, effective_date: '2026-11-02', location_id: c.id })).json().assignment_version).toBe(3);
    });

    it('checks the version of an Initial Assignment recorded later', async () => {
      const room = await entry('locations', 'ห้องรุ่นครั้งแรก');
      const assetId = await registered({ name: 'ตรวจรุ่นครั้งแรก' });
      const stale = await record(assetId, { kind: 'INITIAL', expected_assignment_version: 1, effective_date: null, location_id: room.id });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect(await timelineOf(assetId)).toEqual([]);
    });

    it('serializes concurrent writes on one Asset behind its row lock: one commits, the other sees the new version', async () => {
      const [a, b, c] = await Promise.all(['ก', 'ข', 'ค'].map((suffix) => entry('locations', `ห้องพร้อมกัน ${suffix}`)));
      const assetId = await registered({ name: 'ตรวจพร้อมกัน', location_id: a.id, effective_date: '2026-10-01' });
      const events = async (observer: pg.Pool | pg.PoolClient) =>
        (await observer.query('SELECT count(*)::int AS count FROM assignment_events WHERE asset_id = $1', [assetId])).rows[0].count;

      // An independent connection holds the Asset's row lock.
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE', [assetId]);

      let settled = false;
      const writes = Promise.all(
        [b, c].map((room) =>
          reassign(assetId, { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: room.id }).then((res) => {
            settled = true;
            return res;
          })
        )
      );

      // While the lock is held neither write finishes, and an independent reader sees no new fact.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await events(pool)).toBe(1);

      await holder.query('COMMIT');
      holder.release();

      const statuses = (await writes).map((res) => res.statusCode).sort();
      expect(statuses).toEqual([201, 409]);

      expect(await events(pool)).toBe(2);
      const { rows } = await pool.query('SELECT assignment_version FROM assets WHERE id = $1', [assetId]);
      expect(rows[0].assignment_version).toBe(2);
    });
  });

  describe('Retry token (US 28)', () => {
    const placed = async (name: string) => {
      const a = await entry('locations', `${name} ก`);
      const b = await entry('locations', `${name} ข`);
      const c = await entry('locations', `${name} ค`);
      const assetId = await registered({ name, location_id: a.id, effective_date: '2026-10-01' });
      return { assetId, a, b, c, payload: { expected_assignment_version: 1, effective_date: '2026-11-01', location_id: b.id } };
    };

    it('replays the committed result for an identical retry, with one event, even after the version has moved on', async () => {
      const { assetId, c, payload } = await placed('ห้องส่งซ้ำ');
      const first = await reassign(assetId, payload, 'reassign-replay');
      expect(first.statusCode).toBe(201);

      const replay = await reassign(assetId, payload, 'reassign-replay');
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await timelineOf(assetId)).toHaveLength(2);

      // A later write moves the version; the retry still answers with what it committed.
      expect((await reassign(assetId, { expected_assignment_version: 2, effective_date: '2026-11-02', location_id: c.id })).statusCode).toBe(201);
      const late = await reassign(assetId, payload, 'reassign-replay');
      expect(late.statusCode).toBe(201);
      expect(late.json()).toEqual(first.json());
      expect(await timelineOf(assetId)).toHaveLength(3);
    });

    it('treats text that normalizes the same as the same payload', async () => {
      const { assetId, payload } = await placed('ห้องส่งซ้ำช่องว่าง');
      const first = await reassign(assetId, { ...payload, remark: 'ย้ายแล้ว' }, 'reassign-normalized');
      expect(first.statusCode).toBe(201);
      const replay = await reassign(assetId, { ...payload, remark: '  ย้ายแล้ว  ' }, 'reassign-normalized');
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
    });

    it('refuses a changed payload under the same token without writing', async () => {
      const { assetId, c, payload } = await placed('ห้องเปลี่ยนคำขอ');
      expect((await reassign(assetId, payload, 'reassign-mismatch')).statusCode).toBe(201);
      const before = await assignmentOf(assetId);

      for (const changed of [
        { location_id: c.id },
        { effective_date: '2026-11-02' },
        { remark: 'อื่น' },
        { document_reference: 'อื่น' },
        { expected_assignment_version: 2 },
        { organization_unit_id: null },
      ]) {
        const res = await reassign(assetId, { ...payload, ...changed }, 'reassign-mismatch');
        expect(res.statusCode, JSON.stringify(changed)).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { assetId, payload } = await placed('ห้องส่งพร้อมกัน');
      const responses = await Promise.all(Array.from({ length: 8 }, () => reassign(assetId, payload, 'reassign-concurrent')));
      for (const res of responses) {
        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual(responses[0].json());
      }
      expect(await timelineOf(assetId)).toHaveLength(2);
      expect((await detailOf(assetId)).assignment_version).toBe(2);
    });

    it('scopes a token to its actor and its Asset, and stores nothing for a refused write', async () => {
      const first = await placed('ห้องขอบเขตโทเค็น');
      const second = await placed('ห้องขอบเขตโทเค็น 2');
      expect((await reassign(first.assetId, first.payload, 'reassign-scope')).statusCode).toBe(201);
      // The same token on another Asset is another operation.
      expect((await reassign(second.assetId, second.payload, 'reassign-scope')).statusCode).toBe(201);

      // A refused write leaves its token free, so the corrected request goes through under it.
      const third = await placed('ห้องขอบเขตโทเค็น 3');
      const refused = await reassign(third.assetId, { ...third.payload, effective_date: '2026-11-06' }, 'reassign-retry-after-refusal');
      expect(refused.statusCode).toBe(400);
      const corrected = await reassign(third.assetId, third.payload, 'reassign-retry-after-refusal');
      expect(corrected.statusCode).toBe(201);
    });

    it('keeps the same contract on an Initial Assignment: replay, changed payload, and concurrent submissions', async () => {
      const room = await entry('locations', 'ห้องส่งซ้ำครั้งแรก');
      const other = await entry('locations', 'ห้องส่งซ้ำครั้งแรก 2');
      const payload = { kind: 'INITIAL', expected_assignment_version: 0, effective_date: null, location_id: room.id, legacy_responsible_person_text: 'คุณเก่า' };

      const assetId = await registered({ name: 'ตรวจส่งซ้ำครั้งแรก' });
      const first = await record(assetId, payload, 'initial-replay');
      expect(first.statusCode).toBe(201);
      const replay = await record(assetId, payload, 'initial-replay');
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await timelineOf(assetId)).toHaveLength(1);

      const before = await assignmentOf(assetId);
      for (const changed of [
        { location_id: other.id },
        { effective_date: '2026-11-01' },
        { legacy_responsible_person_text: 'คุณอื่น' },
        { remark: 'อื่น' },
      ]) {
        const res = await record(assetId, { ...payload, ...changed }, 'initial-replay');
        expect(res.statusCode, JSON.stringify(changed)).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await assignmentOf(assetId)).toEqual(before);

      const concurrent = await registered({ name: 'ตรวจส่งพร้อมกันครั้งแรก' });
      const responses = await Promise.all(Array.from({ length: 8 }, () => record(concurrent, payload, 'initial-concurrent')));
      for (const res of responses) {
        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual(responses[0].json());
      }
      expect(await timelineOf(concurrent)).toHaveLength(1);
      expect((await detailOf(concurrent)).assignment_version).toBe(1);
    });

    it('requires one nonblank token of at most 128 characters, from the header or the body', async () => {
      const { assetId, payload } = await placed('ห้องตรวจโทเค็น');
      const body = { kind: 'REASSIGNMENT', ...payload };
      const url = `/assets/${assetId}/assignments`;

      for (const [extraBody, headers] of [
        [{}, {}],
        [{ retry_token: '   ' }, {}],
        [{}, { 'x-retry-token': 'ก'.repeat(129) }],
        [{ retry_token: 'body-token' }, { 'x-retry-token': 'header-token' }],
      ] as [Record<string, unknown>, Record<string, string>][]) {
        const res = await post(custodian, url, { ...body, ...extraBody }, headers);
        expect(res.statusCode, JSON.stringify({ extraBody, headers })).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await timelineOf(assetId)).toHaveLength(1);

      const fromBody = await post(custodian, url, { ...body, retry_token: 'token-in-body' });
      expect(fromBody.statusCode).toBe(201);
    });

    it('commits the event, the version and the token together, or none of them', async () => {
      const { assetId, payload } = await placed('ห้องล้มกลางทาง');
      const before = await assignmentOf(assetId);
      await pool.query(`
        CREATE FUNCTION fail_reassignment_token() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'reassign-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_reassignment_token BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_reassignment_token();
      `);
      try {
        const res = await reassign(assetId, payload, 'reassign-fail-token');
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('injected failure');
        expect(await assignmentOf(assetId)).toEqual(before);
      } finally {
        await pool.query('DROP TRIGGER fail_reassignment_token ON registration_retry_tokens; DROP FUNCTION fail_reassignment_token();');
      }
      const again = await reassign(assetId, payload, 'reassign-fail-token');
      expect(again.statusCode).toBe(201);
    });
  });

  describe('Authorization (Q3, US 7, US 47)', () => {
    // An Asset ready to be reassigned, and what each attempt below sends.
    const target = async (name: string) => {
      const from = await entry('locations', `${name} เดิม`);
      const to = await entry('locations', `${name} ใหม่`);
      const assetId = await registered({ name, location_id: from.id, effective_date: '2026-10-01' });
      return { assetId, payload: { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2026-11-01', location_id: to.id } };
    };

    it('lets only an Asset Custodian record: every other role is forbidden and nothing is written', async () => {
      const { assetId, payload } = await target('ตรวจสิทธิ์บันทึก');
      const before = await assignmentOf(assetId);

      for (const actor of [readonly, admin, maintainer]) {
        const res = await record(assetId, payload, `denied-${actor.id}`, actor);
        expect(res.statusCode).toBe(403);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('needs a session and the CSRF token', async () => {
      const { assetId, payload } = await target('ตรวจเซสชัน');
      const before = await assignmentOf(assetId);
      const url = `/assets/${assetId}/assignments`;

      const anonymous = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', 'x-retry-token': 'anonymous' },
        payload,
      });
      // The CSRF check answers first for a request with no session at all.
      expect([401, 403]).toContain(anonymous.statusCode);

      const withoutCsrf = await app.inject({
        method: 'POST',
        url,
        headers: { cookie: custodian.cookie, 'content-type': 'application/json', 'x-retry-token': 'no-csrf' },
        payload,
      });
      expect(withoutCsrf.statusCode).toBe(403);

      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it("refuses a Custodian whose 'assignment:reassign' alone is denied, and writes nothing", async () => {
      const { assetId, payload } = await target('ตรวจถอนสิทธิ์');
      const before = await assignmentOf(assetId);
      const res = await withReassignCapability(async () => false, () => record(assetId, payload, 'capability-denied'));
      expect(res.statusCode).toBe(403);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('fails closed when the capability lookup fails, and writes nothing', async () => {
      const { assetId, payload } = await target('ตรวจค้นสิทธิ์ล้ม');
      const before = await assignmentOf(assetId);
      const res = await withReassignCapability(
        async () => {
          throw new Error('lookup failed');
        },
        () => record(assetId, payload, 'capability-lookup-failed')
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('lookup failed');
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('takes a revoked grant away at once', async () => {
      const { assetId, payload } = await target('ตรวจถอนบทบาท');
      const before = await assignmentOf(assetId);
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ASSET_CUSTODIAN'`, [custodian.id]);
      try {
        const res = await record(assetId, payload, 'role-revoked');
        expect(res.statusCode).toBe(403);
      } finally {
        await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`, [custodian.id]);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('tells the Asset page whether the viewer may record', async () => {
      const { assetId } = await target('ตรวจธงสิทธิ์');
      for (const [actor, expected] of [
        [custodian, true],
        [readonly, false],
        [admin, false],
      ] as [Actor, boolean][]) {
        expect((await get(actor, `/assets/${assetId}`)).json().can_reassign).toBe(expected);
      }
      // A System Maintainer has no asset:view, so never reads the page.
      expect((await get(maintainer, `/assets/${assetId}`)).statusCode).toBe(403);

      const denied = await withReassignCapability(async () => false, () => get(custodian, `/assets/${assetId}`));
      expect(denied.json().can_reassign).toBe(false);
    });
  });
});
