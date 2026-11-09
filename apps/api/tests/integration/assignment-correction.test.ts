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

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

type Actor = { id: string; cookie: string; csrf: string };

// F003-T3 (#53): an Asset Custodian or an Administrator fixes an assignment fact that was recorded wrong.
describe('Correct or void an assignment fact (Seam A - F003-T3)', () => {
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

  const registered = async (payload: Record<string, unknown>): Promise<string> => {
    const res = await post(custodian, '/assets', payload);
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  const record = (assetId: string, payload: Record<string, unknown>) =>
    post(custodian, `/assets/${assetId}/assignments`, payload, { 'x-retry-token': crypto.randomUUID() });

  // Sends one correction of one fact. The retry token is fresh unless a test names one.
  const correct = (
    assetId: string,
    eventId: string,
    payload: Record<string, unknown>,
    { token = crypto.randomUUID(), actor = custodian }: { token?: string; actor?: Actor } = {}
  ) => post(actor, `/assets/${assetId}/assignments/${eventId}/corrections`, payload, { 'x-retry-token': token });

  const amend = (
    assetId: string,
    eventId: string,
    version: number,
    fields: Record<string, unknown>,
    options?: { token?: string; actor?: Actor }
  ) => correct(assetId, eventId, { action: 'AMEND', expected_assignment_version: version, reason: 'บันทึกผิด', ...fields }, options);

  const voidFact = (assetId: string, eventId: string, version: number, options?: { token?: string; actor?: Actor }) =>
    correct(assetId, eventId, { action: 'VOID', expected_assignment_version: version, reason: 'บันทึกผิด' }, options);

  // What an observer reads of an Asset's assignment, to show that a refused write changed nothing.
  const assignmentOf = async (assetId: string) => {
    const detail = await detailOf(assetId);
    return {
      current: detail.current_assignment,
      version: detail.assignment_version,
      timeline: await timelineOf(assetId),
    };
  };

  // An Asset whose Location went from Room A (Initial Assignment) to Room B (Reassignment).
  const reassigned = async (name: string) => {
    const roomA = await entry('locations', `${name} ก`);
    const roomB = await entry('locations', `${name} ข`);
    const assetId = await registered({ name, location_id: roomA.id, effective_date: '2026-01-01' });
    const res = await record(assetId, {
      kind: 'REASSIGNMENT',
      expected_assignment_version: 1,
      effective_date: '2026-06-01',
      location_id: roomB.id,
    });
    expect(res.statusCode).toBe(201);
    const [initial, reassignment] = await timelineOf(assetId);
    return { assetId, roomA, roomB, initial, reassignment };
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
      cookieSecret: 'test-secret-at-least-32-chars-long-assignment-correction',
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

    admin = await createAuthenticatedSession(await createUserWithRole('admin_ac', 'ADMINISTRATOR'));
    custodian = await createAuthenticatedSession(await createUserWithRole('custodian_ac', 'ASSET_CUSTODIAN'));
    readonly = await createAuthenticatedSession(await createUserWithRole('readonly_ac', 'READ_ONLY'));
    maintainer = await createAuthenticatedSession(await createUserWithRole('maintainer_ac', 'SYSTEM_MAINTAINER'));
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  // Entry and Legacy text of a value in an amendment.
  const valueOf = (entryRow: { id: string } | null, legacy_text: string | null = null) => ({ entry_id: entryRow?.id ?? null, legacy_text });

  const summary = (row: { id: string; name: string }, is_active = true) => ({ id: row.id, name: row.name, is_active });

  const NO_VALUE = { entry: null, legacy_text: null };

  describe('Amend (MR-06, Q13)', () => {
    it('amends the Effective Date, document reference and remark: the event holds the corrected values and the record keeps the originals', async () => {
      const room = await entry('locations', 'ห้องแก้ช่อง');
      const assetId = await registered({
        name: 'ตู้แก้ไขช่องข้อมูล',
        location_id: room.id,
        effective_date: '2026-01-01',
        document_reference: 'เอกสารเดิม',
        remark: 'หมายเหตุเดิม',
      });
      const [initial] = await timelineOf(assetId);

      const res = await amend(assetId, initial.id, 1, {
        reason: ' วันที่ในบันทึกผิด ',
        effective_date: '2025-12-15',
        document_reference: ' เอกสารใหม่ ',
        remark: null,
      });
      expect(res.statusCode).toBe(201);

      const [event] = await timelineOf(assetId);
      expect(event).toMatchObject({
        id: initial.id,
        kind: 'INITIAL',
        effective_date: '2025-12-15',
        recorded_at: initial.recorded_at,
        recorded_by: initial.recorded_by,
        document_reference: 'เอกสารใหม่',
        remark: null,
        is_voided: false,
        changes: initial.changes,
      });
      expect(event.corrections).toEqual([
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          action: 'AMENDED',
          reason: 'วันที่ในบันทึกผิด',
          recorded_at: expect.any(String),
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_ac',
          changes: [
            { field: 'effective_date', before: '2026-01-01', after: '2025-12-15' },
            { field: 'document_reference', before: 'เอกสารเดิม', after: 'เอกสารใหม่' },
            { field: 'remark', before: 'หมายเหตุเดิม', after: null },
          ],
        },
      ]);
      expect((await detailOf(assetId)).assignment_version).toBe(2);
      expect(res.json().event).toEqual(event);
    });

    it('leaves a field the request does not name as it stands', async () => {
      const { assetId, reassignment } = await reassigned('ห้องไม่แตะช่อง');
      expect((await amend(assetId, reassignment.id, 2, { remark: 'เติมหมายเหตุ' })).statusCode).toBe(201);
      const [, event] = await timelineOf(assetId);
      expect(event.effective_date).toBe('2026-06-01');
      expect(event.changes).toEqual(reassignment.changes);
      expect(event.corrections[0].changes).toEqual([{ field: 'remark', before: null, after: 'เติมหมายเหตุ' }]);
    });

    it('keeps each correction, in the order made', async () => {
      const { assetId, reassignment } = await reassigned('ห้องแก้หลายครั้ง');
      expect((await amend(assetId, reassignment.id, 2, { remark: 'ครั้งแรก', reason: 'เหตุผลแรก' })).statusCode).toBe(201);
      expect((await amend(assetId, reassignment.id, 3, { remark: 'ครั้งที่สอง', reason: 'เหตุผลสอง' })).statusCode).toBe(201);
      const [, event] = await timelineOf(assetId);
      expect(event.corrections.map((correction: any) => correction.reason)).toEqual(['เหตุผลแรก', 'เหตุผลสอง']);
      expect(event.corrections[1].changes).toEqual([{ field: 'remark', before: 'ครั้งแรก', after: 'ครั้งที่สอง' }]);
    });

    describe('Effective Date', () => {
      it('may be unknown on an Initial Assignment, and only there', async () => {
        const { assetId, initial, reassignment } = await reassigned('ห้องวันไม่ทราบ');
        expect((await amend(assetId, initial.id, 2, { effective_date: null })).statusCode).toBe(201);
        const [event] = await timelineOf(assetId);
        expect(event.effective_date).toBeNull();
        expect(event.corrections[0].changes).toEqual([{ field: 'effective_date', before: '2026-01-01', after: null }]);

        const before = await assignmentOf(assetId);
        const refused = await amend(assetId, reassignment.id, 3, { effective_date: null });
        expect(refused.statusCode).toBe(400);
        expect(await assignmentOf(assetId)).toEqual(before);
      });

      it('is never after today, at the Bangkok date boundary', async () => {
        const { assetId, reassignment } = await reassigned('ห้องขอบวัน');
        const saved = now;
        try {
          // 23:59 on 5 November in Bangkok.
          now = new Date('2026-11-05T16:59:00Z');
          expect((await amend(assetId, reassignment.id, 2, { effective_date: '2026-11-06' })).statusCode).toBe(400);
          expect((await amend(assetId, reassignment.id, 2, { effective_date: '2026-11-05' })).statusCode).toBe(201);
          // 00:00 on 6 November in Bangkok.
          now = new Date('2026-11-05T17:00:00Z');
          expect((await amend(assetId, reassignment.id, 3, { effective_date: '2026-11-06' })).statusCode).toBe(201);
        } finally {
          now = saved;
        }
      });

      it('must be a real date', async () => {
        const { assetId, reassignment } = await reassigned('ห้องวันผิดรูป');
        for (const effective_date of ['2026-02-30', 'วันนี้', 20260101]) {
          const res = await amend(assetId, reassignment.id, 2, { effective_date });
          expect(res.statusCode, String(effective_date)).toBe(400);
        }
      });
    });

    describe('New values of an Initial Assignment', () => {
      it('names an entry or Legacy text', async () => {
        const room = await entry('locations', 'ห้องตั้งต้น');
        const other = await entry('locations', 'ห้องที่ถูกต้อง');
        const assetId = await registered({ name: 'โต๊ะแก้ค่าแรก', location_id: room.id, effective_date: '2026-01-01' });
        const [initial] = await timelineOf(assetId);

        expect((await amend(assetId, initial.id, 1, { changes: { location: { new: valueOf(other) } } })).statusCode).toBe(201);
        expect((await detailOf(assetId)).current_assignment.location.id).toBe(other.id);

        const res = await amend(assetId, initial.id, 2, { changes: { location: { new: valueOf(null, ' ห้องตามทะเบียนเก่า ') } } });
        expect(res.statusCode).toBe(201);
        const detail = await detailOf(assetId);
        expect(detail.current_assignment.location).toBeNull();
        expect(detail.current_assignment.legacy_location_text).toBe('ห้องตามทะเบียนเก่า');

        const [event] = await timelineOf(assetId);
        expect(event.changes).toEqual([
          { dimension: 'location', prior: NO_VALUE, new: { entry: null, legacy_text: 'ห้องตามทะเบียนเก่า' } },
        ]);
        expect(event.corrections.at(-1).changes).toEqual([
          {
            field: 'location',
            before: { prior: NO_VALUE, new: { entry: summary(other), legacy_text: null } },
            after: { prior: NO_VALUE, new: { entry: null, legacy_text: 'ห้องตามทะเบียนเก่า' } },
          },
        ]);
      });

      it('adds a dimension it missed, and it takes effect as an Initial Assignment value', async () => {
        const room = await entry('locations', 'ห้องเติมมิติ');
        const unit = await entry('organization-units', 'กลุ่มงานเติมมิติ');
        const assetId = await registered({ name: 'โต๊ะเติมมิติ', location_id: room.id, effective_date: '2026-01-01' });
        const [initial] = await timelineOf(assetId);

        const res = await amend(assetId, initial.id, 1, { changes: { organization_unit: { new: valueOf(unit) } } });
        expect(res.statusCode).toBe(201);
        expect((await detailOf(assetId)).current_assignment.organization_unit.id).toBe(unit.id);
        const [event] = await timelineOf(assetId);
        expect(event.changes.map((change: any) => change.dimension)).toEqual(['location', 'organization_unit']);
        expect(event.corrections[0].changes).toEqual([
          { field: 'organization_unit', before: null, after: { prior: NO_VALUE, new: { entry: summary(unit), legacy_text: null } } },
        ]);
      });

      it('removes a dimension while another remains, and refuses to remove the last one: voiding is for that', async () => {
        const room = await entry('locations', 'ห้องเอาออก');
        const unit = await entry('organization-units', 'กลุ่มงานเอาออก');
        const assetId = await registered({
          name: 'โต๊ะเอาออก',
          location_id: room.id,
          organization_unit_id: unit.id,
          effective_date: '2026-01-01',
        });
        const [initial] = await timelineOf(assetId);

        expect((await amend(assetId, initial.id, 1, { changes: { organization_unit: null } })).statusCode).toBe(201);
        expect((await detailOf(assetId)).current_assignment.organization_unit).toBeNull();
        const [event] = await timelineOf(assetId);
        expect(event.changes.map((change: any) => change.dimension)).toEqual(['location']);
        expect(event.corrections[0].changes).toEqual([
          { field: 'organization_unit', before: { prior: NO_VALUE, new: { entry: summary(unit), legacy_text: null } }, after: null },
        ]);

        const before = await assignmentOf(assetId);
        const last = await amend(assetId, initial.id, 2, { changes: { location: null } });
        expect(last.statusCode).toBe(400);
        expect(await assignmentOf(assetId)).toEqual(before);
      });

      it('refuses prior values, an empty new value and removing a dimension it does not have', async () => {
        const room = await entry('locations', 'ห้องกติกาแรก');
        const unit = await entry('organization-units', 'กลุ่มงานกติกาแรก');
        const assetId = await registered({ name: 'โต๊ะกติกาแรก', location_id: room.id, effective_date: '2026-01-01' });
        const [initial] = await timelineOf(assetId);
        const before = await assignmentOf(assetId);

        for (const changes of [
          { location: { prior: valueOf(room) } },
          { location: { new: valueOf(null) } },
          { organization_unit: { prior: valueOf(unit), new: valueOf(unit) } },
          { organization_unit: { new: {} } },
          { organization_unit: null },
        ]) {
          const res = await amend(assetId, initial.id, 1, { changes });
          expect(res.statusCode, JSON.stringify(changes)).toBe(400);
        }
        expect(await assignmentOf(assetId)).toEqual(before);
      });
    });

    describe('Values of a Reassignment', () => {
      // An Asset whose Reassignment moved its Location, OrganizationUnit and Responsible Person.
      const reassignedInThreeDimensions = async (name: string) => {
        const [roomA, roomB] = await Promise.all(['ก', 'ข'].map((suffix) => entry('locations', `${name} ${suffix}`)));
        const [unitA, unitB] = await Promise.all(['ก', 'ข'].map((suffix) => entry('organization-units', `กลุ่มงาน${name} ${suffix}`)));
        const [personA, personB] = await Promise.all(['ก', 'ข'].map((suffix) => entry('persons', `คุณ${name} ${suffix}`)));
        const assetId = await registered({
          name,
          location_id: roomA.id,
          organization_unit_id: unitA.id,
          responsible_person_id: personA.id,
          effective_date: '2026-01-01',
        });
        const res = await record(assetId, {
          kind: 'REASSIGNMENT',
          expected_assignment_version: 1,
          effective_date: '2026-06-01',
          location_id: roomB.id,
          organization_unit_id: unitB.id,
          responsible_person_id: personB.id,
        });
        expect(res.statusCode).toBe(201);
        return { assetId, roomA, roomB, unitA, unitB, personA, personB, event: res.json().event };
      };

      it('amends new values to entries, and empties the OrganizationUnit or the Responsible Person', async () => {
        const { assetId, roomA, roomB, unitA, unitB, personA, personB, event } = await reassignedInThreeDimensions('แก้ค่าใหม่');
        const roomC = await entry('locations', 'แก้ค่าใหม่ ค');

        const res = await amend(assetId, event.id, 2, {
          changes: {
            location: { new: valueOf(roomC) },
            organization_unit: { new: valueOf(null) },
            responsible_person: { new: {} },
          },
        });
        expect(res.statusCode).toBe(201);

        const detail = await detailOf(assetId);
        expect(detail.current_assignment.location.id).toBe(roomC.id);
        expect(detail.current_assignment.organization_unit).toBeNull();
        expect(detail.current_assignment.responsible_person).toBeNull();

        const of = (row: { id: string; name: string }) => ({ entry: summary(row), legacy_text: null });
        const [, stored] = await timelineOf(assetId);
        expect(stored.changes).toEqual([
          { dimension: 'location', prior: of(roomA), new: of(roomC) },
          { dimension: 'organization_unit', prior: of(unitA), new: NO_VALUE },
          { dimension: 'responsible_person', prior: of(personA), new: NO_VALUE },
        ]);
        expect(stored.corrections[0].changes).toEqual([
          { field: 'location', before: { prior: of(roomA), new: of(roomB) }, after: { prior: of(roomA), new: of(roomC) } },
          { field: 'organization_unit', before: { prior: of(unitA), new: of(unitB) }, after: { prior: of(unitA), new: NO_VALUE } },
          { field: 'responsible_person', before: { prior: of(personA), new: of(personB) }, after: { prior: of(personA), new: NO_VALUE } },
        ]);
      });

      it('amends prior values to an entry, Legacy text, or empty', async () => {
        const { assetId, event } = await reassignedInThreeDimensions('แก้ค่าก่อนหน้า');
        const roomC = await entry('locations', 'แก้ค่าก่อนหน้า ค');
        const unitBefore = await entry('organization-units', 'กลุ่มงานก่อนแก้ค่าก่อนหน้า');

        const res = await amend(assetId, event.id, 2, {
          changes: {
            location: { prior: valueOf(roomC) },
            organization_unit: { prior: valueOf(unitBefore, 'กองเก่า') },
            responsible_person: { prior: valueOf(null, ' คุณเก่า ') },
          },
        });
        expect(res.statusCode).toBe(201);
        const [, stored] = await timelineOf(assetId);
        expect(stored.changes.map((change: any) => change.prior)).toEqual([
          { entry: summary(roomC), legacy_text: null },
          { entry: summary(unitBefore), legacy_text: 'กองเก่า' },
          { entry: null, legacy_text: 'คุณเก่า' },
        ]);

        // Emptying a prior value is a value like any other, and the Current Assignment follows new values only.
        expect((await amend(assetId, event.id, 3, { changes: { location: { prior: valueOf(null) } } })).statusCode).toBe(201);
        const [, emptied] = await timelineOf(assetId);
        expect(emptied.changes[0].prior).toEqual(NO_VALUE);
      });

      it('removes a dimension while at least one remains, and refuses to remove the last one', async () => {
        const { assetId, roomB, unitA, event } = await reassignedInThreeDimensions('เอาออกจากการย้าย');
        const res = await amend(assetId, event.id, 2, { changes: { organization_unit: null, responsible_person: null } });
        expect(res.statusCode).toBe(201);

        const detail = await detailOf(assetId);
        expect(detail.current_assignment.location.id).toBe(roomB.id);
        expect(detail.current_assignment.organization_unit.id).toBe(unitA.id);
        const [, stored] = await timelineOf(assetId);
        expect(stored.changes.map((change: any) => change.dimension)).toEqual(['location']);
        expect(stored.corrections[0].changes.map((change: any) => [change.field, change.after])).toEqual([
          ['organization_unit', null],
          ['responsible_person', null],
        ]);

        const before = await assignmentOf(assetId);
        expect((await amend(assetId, event.id, 3, { changes: { location: null } })).statusCode).toBe(400);
        expect(await assignmentOf(assetId)).toEqual(before);
      });

      it('may remove the Location while another dimension remains, which leaves the earlier Location current', async () => {
        const { assetId, roomA, event } = await reassignedInThreeDimensions('เอาสถานที่ออก');
        expect((await amend(assetId, event.id, 2, { changes: { location: null } })).statusCode).toBe(201);
        expect((await detailOf(assetId)).current_assignment.location.id).toBe(roomA.id);
      });

      it('never empties the Location, never takes Legacy text as a new value, and never adds a dimension', async () => {
        const { assetId, roomB } = await reassignedInThreeDimensions('กติกาการย้าย');
        const unit = await entry('organization-units', 'กลุ่มงานเติมไม่ได้');
        const single = await record(assetId, { kind: 'REASSIGNMENT', expected_assignment_version: 2, effective_date: '2026-07-01', location_id: roomB.id, responsible_person_id: null });
        expect(single.statusCode).toBe(201);
        const event = single.json().event;
        expect(event.changes.map((change: any) => change.dimension)).toEqual(['responsible_person']);
        const before = await assignmentOf(assetId);

        const other = await reassignedInThreeDimensions('กติกาการย้าย 2');
        const otherBefore = await assignmentOf(other.assetId);
        for (const [target, version, changes] of [
          [other, 2, { location: { new: valueOf(null) } }],
          [other, 2, { location: { new: {} } }],
          [other, 2, { organization_unit: { new: valueOf(null, 'ข้อความเดิม') } }],
          [other, 2, { organization_unit: { new: valueOf(unit, 'ข้อความเดิม') } }],
          [{ assetId, event }, 3, { organization_unit: { new: valueOf(unit) } }],
          [{ assetId, event }, 3, { organization_unit: null }],
        ] as [{ assetId: string; event: { id: string } }, number, unknown][]) {
          const res = await amend(target.assetId, target.event.id, version, { changes });
          expect(res.statusCode, JSON.stringify(changes)).toBe(400);
        }
        expect(await assignmentOf(assetId)).toEqual(before);
        expect(await assignmentOf(other.assetId)).toEqual(otherBefore);
      });

      it('refuses a change whose new value would equal its prior value: that fact changes nothing (MR-01)', async () => {
        const { assetId, roomA, event } = await reassignedInThreeDimensions('ค่าเท่ากัน');
        const before = await assignmentOf(assetId);
        for (const changes of [{ location: { new: valueOf(roomA) } }, { organization_unit: { new: valueOf(null), prior: valueOf(null) } }]) {
          const res = await amend(assetId, event.id, 2, { changes });
          expect(res.statusCode, JSON.stringify(changes)).toBe(400);
        }
        expect(await assignmentOf(assetId)).toEqual(before);
      });
    });

    describe('Entries', () => {
      it('allows deactivated entries, on any date, labelled by their current state', async () => {
        const { assetId, reassignment } = await reassigned('ห้องปิดแล้วแก้ได้');
        const closed = await entry('locations', 'ห้องปิดแล้ว ก');
        const closing = await post(admin, `/references/locations/${closed.id}`, { expected_version: closed.version, is_active: false });
        expect(closing.statusCode).toBe(200);

        const res = await amend(assetId, reassignment.id, 2, { effective_date: '2026-11-05', changes: { location: { new: valueOf(closed) } } });
        expect(res.statusCode).toBe(201);
        expect((await detailOf(assetId)).current_assignment.location).toEqual({ id: closed.id, name: 'ห้องปิดแล้ว ก', is_active: false });
      });

      it('refuses an entry of another list, an unknown entry and a malformed id', async () => {
        const { assetId, reassignment } = await reassigned('ห้องรายการผิด');
        const unit = await entry('organization-units', 'กลุ่มงานคนละรายการ');
        const before = await assignmentOf(assetId);

        for (const value of [valueOf(unit), { entry_id: '00000000-0000-4000-8000-000000000000' }, { entry_id: 'not-a-uuid' }]) {
          for (const side of ['new', 'prior']) {
            const res = await amend(assetId, reassignment.id, 2, { changes: { location: { [side]: value } } });
            expect(res.statusCode, JSON.stringify({ side, value })).toBe(400);
          }
        }
        expect(await assignmentOf(assetId)).toEqual(before);
      });
    });

    describe('Rules of every amendment', () => {
      it('refuses an amendment that changes nothing, and writes nothing', async () => {
        const { assetId, roomA, roomB, reassignment } = await reassigned('ห้องไม่เปลี่ยน');
        const before = await assignmentOf(assetId);

        for (const fields of [
          {},
          { effective_date: '2026-06-01' },
          { remark: null, document_reference: '   ' },
          { changes: {} },
          { changes: { location: {} } },
          { changes: { location: { prior: valueOf(roomA), new: valueOf(roomB) } } },
        ]) {
          const res = await amend(assetId, reassignment.id, 2, fields);
          expect(res.statusCode, JSON.stringify(fields)).toBe(400);
          expect(res.json().code).toBe('VALIDATION_FAILED');
        }
        expect(await assignmentOf(assetId)).toEqual(before);
      });

      it('requires a reason: nonblank, bounded, with control characters refused', async () => {
        const { assetId, reassignment } = await reassigned('ห้องเหตุผล');
        const before = await assignmentOf(assetId);

        for (const reason of [undefined, null, '', '   ', 'ก'.repeat(2001), 'มี\u0007อักขระควบคุม']) {
          const payload = { action: 'AMEND', expected_assignment_version: 2, remark: 'เปลี่ยน', ...(reason === undefined ? {} : { reason }) };
          const amended = await correct(assetId, reassignment.id, payload);
          expect(amended.statusCode, `amend ${reason}`).toBe(400);
          const voided = await correct(assetId, reassignment.id, { action: 'VOID', expected_assignment_version: 2, ...(reason === undefined ? {} : { reason }) });
          expect(voided.statusCode, `void ${reason}`).toBe(400);
        }
        expect(await assignmentOf(assetId)).toEqual(before);

        const longest = await amend(assetId, reassignment.id, 2, { remark: 'เปลี่ยน', reason: 'ก'.repeat(2000) });
        expect(longest.statusCode).toBe(201);
      });

      it('bounds the document reference and remark, with control characters refused', async () => {
        const { assetId, reassignment } = await reassigned('ห้องข้อความ');
        const before = await assignmentOf(assetId);
        for (const fields of [
          { document_reference: 'ก'.repeat(501) },
          { remark: 'ก'.repeat(2001) },
          { document_reference: 'มี\u0000ศูนย์' },
          { remark: 'มี\u007fลบ' },
          { changes: { location: { prior: valueOf(null, 'ก'.repeat(501)) } } },
        ]) {
          const res = await amend(assetId, reassignment.id, 2, fields);
          expect(res.statusCode, Object.keys(fields).join()).toBe(400);
        }
        expect(await assignmentOf(assetId)).toEqual(before);
      });

      it('refuses to amend a voided fact, and writes nothing', async () => {
        const { assetId, reassignment } = await reassigned('ห้องแก้ที่ยกเลิก');
        expect((await voidFact(assetId, reassignment.id, 2)).statusCode).toBe(201);
        const before = await assignmentOf(assetId);
        const res = await amend(assetId, reassignment.id, 3, { remark: 'ขอแก้' });
        expect(res.statusCode).toBe(400);
        expect(await assignmentOf(assetId)).toEqual(before);
      });
    });
  });

  describe('Void (MR-07)', () => {
    it('voids a Reassignment: it stays in the timeline with its reason, and the Current Assignment recomputes', async () => {
      const { assetId, roomA, reassignment } = await reassigned('ห้องยกเลิก');

      const res = await correct(assetId, reassignment.id, {
        action: 'VOID',
        expected_assignment_version: 2,
        reason: 'บันทึกผิดครุภัณฑ์',
      });
      expect(res.statusCode).toBe(201);

      const detail = await detailOf(assetId);
      expect(detail.assignment_version).toBe(3);
      expect(detail.current_assignment.location).toEqual({ id: roomA.id, name: 'ห้องยกเลิก ก', is_active: true });

      const timeline = await timelineOf(assetId);
      expect(timeline).toHaveLength(2);
      expect(timeline[0].is_voided).toBe(false);
      expect(timeline[0].corrections).toEqual([]);
      expect(timeline[1].id).toBe(reassignment.id);
      expect(timeline[1].is_voided).toBe(true);
      expect(timeline[1].changes).toEqual(reassignment.changes);
      expect(timeline[1].corrections).toEqual([
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          action: 'VOIDED',
          reason: 'บันทึกผิดครุภัณฑ์',
          recorded_at: expect.any(String),
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_ac',
          changes: [],
        },
      ]);
      expect(res.json()).toEqual({
        event: timeline[1],
        current_assignment: detail.current_assignment,
        assignment_version: 3,
      });
    });

    it('takes a voided fact out of the prior values a later fact derives', async () => {
      const { assetId, roomA, reassignment } = await reassigned('ห้องค่าก่อนหน้า');
      const roomC = await entry('locations', 'ห้องค่าก่อนหน้า ค');
      expect((await voidFact(assetId, reassignment.id, 2)).statusCode).toBe(201);

      const res = await record(assetId, {
        kind: 'REASSIGNMENT',
        expected_assignment_version: 3,
        effective_date: '2026-07-01',
        location_id: roomC.id,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().event.changes[0].prior.entry.id).toBe(roomA.id);
    });

    it('takes a voided fact out of the asset search: the entry filter and the legacy-text search', async () => {
      const { assetId, roomA, roomB, reassignment } = await reassigned('ห้องค้นหา');
      const search = async (query: string) =>
        (await get(readonly, `/assets/search?${query}`)).json().items.map((item: any) => item.id);

      expect(await search(`location_id=${roomB.id}`)).toContain(assetId);
      expect((await voidFact(assetId, reassignment.id, 2)).statusCode).toBe(201);
      expect(await search(`location_id=${roomB.id}`)).not.toContain(assetId);
      expect(await search(`location_id=${roomA.id}`)).toContain(assetId);

      const legacyAsset = await registered({
        name: 'โต๊ะข้อความเดิมค้นหา',
        legacy_location_text: 'ข้อความเดิมค้นหายกเลิก',
        effective_date: null,
      });
      const [initial] = await timelineOf(legacyAsset);
      expect(await search(`field=legacy_location_text&value=${encodeURIComponent('ข้อความเดิมค้นหายกเลิก')}`)).toContain(legacyAsset);
      expect((await voidFact(legacyAsset, initial.id, 1)).statusCode).toBe(201);
      expect(await search(`field=legacy_location_text&value=${encodeURIComponent('ข้อความเดิมค้นหายกเลิก')}`)).not.toContain(legacyAsset);
    });

    it('refuses to void a voided fact, and writes nothing', async () => {
      const { assetId, reassignment } = await reassigned('ห้องยกเลิกซ้ำ');
      expect((await voidFact(assetId, reassignment.id, 2)).statusCode).toBe(201);
      const before = await assignmentOf(assetId);

      const res = await voidFact(assetId, reassignment.id, 3);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('lets a new Initial Assignment be recorded after the Initial Assignment is voided, and refuses a Reassignment until then', async () => {
      const { assetId, roomB, initial } = await reassigned('ห้องกำหนดใหม่');
      const roomC = await entry('locations', 'ห้องกำหนดใหม่ ค');

      // While one stands, a second is refused.
      const second = { kind: 'INITIAL', effective_date: '2026-01-02', location_id: roomC.id };
      expect((await record(assetId, { ...second, expected_assignment_version: 2 })).statusCode).toBe(400);

      expect((await voidFact(assetId, initial.id, 2)).statusCode).toBe(201);
      expect((await detailOf(assetId)).current_assignment.location.id).toBe(roomB.id);

      // A Reassignment needs a standing Initial Assignment.
      const refused = await record(assetId, { kind: 'REASSIGNMENT', expected_assignment_version: 3, effective_date: '2026-07-01', location_id: roomC.id });
      expect(refused.statusCode).toBe(400);

      expect((await record(assetId, { ...second, expected_assignment_version: 3 })).statusCode).toBe(201);
      const timeline = await timelineOf(assetId);
      expect(timeline.map((event: any) => [event.kind, event.is_voided])).toEqual([
        ['INITIAL', true],
        ['INITIAL', false],
        ['REASSIGNMENT', false],
      ]);
    });

    it('holds one non-voided Initial Assignment per Asset, and one void per event, in the database', async () => {
      const { assetId, reassignment, initial } = await reassigned('ห้องข้อจำกัด');
      const insertInitial = () =>
        pool.query(
          `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
           VALUES ($1, 'INITIAL', NULL, $2, 'RECORDED') RETURNING id`,
          [assetId, custodian.id]
        );
      await expect(insertInitial()).rejects.toThrow(/assignment_events_one_initial/);

      expect((await voidFact(assetId, initial.id, 2)).statusCode).toBe(201);
      const again = await insertInitial();
      expect(again.rows).toHaveLength(1);

      expect((await voidFact(assetId, reassignment.id, 3)).statusCode).toBe(201);
      await expect(
        pool.query(
          `INSERT INTO assignment_corrections (event_id, action, reason, changes, recorded_by)
           VALUES ($1, 'VOIDED', 'ซ้ำ', '[]'::jsonb, $2)`,
          [reassignment.id, custodian.id]
        )
      ).rejects.toThrow(/assignment_corrections_one_void/);
    });
  });

  describe('Integrity', () => {
    it('never changes an event\'s kind or Asset: a request naming them is refused', async () => {
      const { assetId, reassignment } = await reassigned('ห้องชนิดรายการ');
      const other = await reassigned('ห้องชนิดรายการ อื่น');
      const before = await assignmentOf(assetId);

      for (const extra of [{ kind: 'INITIAL' }, { asset_id: other.assetId }, { recorded_by: admin.id }, { is_voided: true }]) {
        const res = await amend(assetId, reassignment.id, 2, { remark: 'แก้', ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await assignmentOf(assetId)).toEqual(before);
      expect((await timelineOf(assetId))[1].kind).toBe('REASSIGNMENT');
    });

    it('takes no amendment fields on a void, and no unknown dimension on an amendment', async () => {
      const { assetId, roomA, reassignment } = await reassigned('ห้องคำขอแปลก');
      const before = await assignmentOf(assetId);
      const voided = await correct(assetId, reassignment.id, { action: 'VOID', expected_assignment_version: 2, reason: 'ผิด', remark: 'แก้' });
      expect(voided.statusCode).toBe(400);
      const unknown = await amend(assetId, reassignment.id, 2, { changes: { building: { new: valueOf(roomA) } } });
      expect(unknown.statusCode).toBe(400);
      const action = await correct(assetId, reassignment.id, { action: 'DELETE', expected_assignment_version: 2, reason: 'ผิด' });
      expect(action.statusCode).toBe(400);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('finds a fact only under its own Asset', async () => {
      const { assetId, reassignment } = await reassigned('ห้องของตัวเอง');
      const other = await reassigned('ห้องของคนอื่น');
      const before = await assignmentOf(assetId);
      const otherBefore = await assignmentOf(other.assetId);

      const res = await voidFact(other.assetId, reassignment.id, 2);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
      expect(await assignmentOf(assetId)).toEqual(before);
      expect(await assignmentOf(other.assetId)).toEqual(otherBefore);

      expect((await voidFact(assetId, '00000000-0000-4000-8000-000000000000', 2)).statusCode).toBe(404);
      expect((await voidFact('00000000-0000-4000-8000-000000000000', reassignment.id, 2)).statusCode).toBe(404);
      expect((await voidFact('not-a-uuid', reassignment.id, 2)).statusCode).toBe(400);
      expect((await voidFact(assetId, 'not-a-uuid', 2)).statusCode).toBe(400);
    });

    it('corrects a fact carried over from Feature 002 and keeps its provenance', async () => {
      const room = await entry('locations', 'ห้องยกมา');
      const other = await entry('locations', 'ห้องยกมา แก้แล้ว');
      const assetId = await registered({ name: 'ตู้ยกมา' });
      const created = await pool.query(
        `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
         VALUES ($1, 'INITIAL', NULL, $2, 'CARRIED_OVER_F002') RETURNING id`,
        [assetId, custodian.id]
      );
      const eventId = created.rows[0].id;
      await pool.query(
        `INSERT INTO assignment_changes (event_id, event_kind, dimension, new_location_id) VALUES ($1, 'INITIAL', 'LOCATION', $2)`,
        [eventId, room.id]
      );
      await pool.query('UPDATE assets SET assignment_version = 1 WHERE id = $1', [assetId]);

      expect((await amend(assetId, eventId, 1, { changes: { location: { new: valueOf(other) } } })).statusCode).toBe(201);
      const [event] = await timelineOf(assetId);
      expect(event.provenance).toBe('CARRIED_OVER_F002');
      expect(event.changes[0].new.entry.id).toBe(other.id);
    });

    it('reads every entry of a correction by its current name and active flag (#50 Q20)', async () => {
      const { assetId, roomB, reassignment } = await reassigned('ห้องเปลี่ยนชื่อ');
      const roomC = await entry('locations', 'ห้องเปลี่ยนชื่อ ค');
      expect((await amend(assetId, reassignment.id, 2, { changes: { location: { new: valueOf(roomC) } } })).statusCode).toBe(201);

      const renamed = await post(admin, `/references/locations/${roomB.id}`, { expected_version: roomB.version, name: 'ห้องชื่อใหม่' });
      expect(renamed.statusCode).toBe(200);
      const closed = await post(admin, `/references/locations/${roomC.id}`, { expected_version: roomC.version, is_active: false });
      expect(closed.statusCode).toBe(200);

      const [, event] = await timelineOf(assetId);
      const [field] = event.corrections[0].changes;
      expect(field.before.new.entry).toEqual({ id: roomB.id, name: 'ห้องชื่อใหม่', is_active: true });
      expect(field.after.new.entry).toEqual({ id: roomC.id, name: 'ห้องเปลี่ยนชื่อ ค', is_active: false });
    });
  });

  describe('Expected assignment version', () => {
    it('refuses a stale amendment or void with the stale-before conflict, and writes nothing', async () => {
      const { assetId, reassignment } = await reassigned('ห้องรุ่นเก่า');
      const before = await assignmentOf(assetId);
      for (const res of [await amend(assetId, reassignment.id, 1, { remark: 'แก้' }), await voidFact(assetId, reassignment.id, 1)]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          code: 'STALE_BEFORE_CONFLICT',
          current_values: { assignment_version: 2 },
          expected_values: { assignment_version: 1 },
        });
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('serializes concurrent corrections of one Asset behind its row lock: one commits, the other sees the new version', async () => {
      const { assetId, initial, reassignment } = await reassigned('ห้องแก้พร้อมกัน');
      const corrections = async () =>
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM assignment_corrections r
             JOIN assignment_events e ON e.id = r.event_id WHERE e.asset_id = $1`,
            [assetId]
          )
        ).rows[0].count;

      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE', [assetId]);

      let settled = false;
      const writes = Promise.all(
        [amend(assetId, reassignment.id, 2, { remark: 'แก้พร้อมกัน' }), voidFact(assetId, initial.id, 2)].map((write) =>
          write.then((res) => {
            settled = true;
            return res;
          })
        )
      );

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await corrections()).toBe(0);

      await holder.query('COMMIT');
      holder.release();

      expect((await writes).map((res) => res.statusCode).sort()).toEqual([201, 409]);
      expect(await corrections()).toBe(1);
      expect((await pool.query('SELECT assignment_version FROM assets WHERE id = $1', [assetId])).rows[0].assignment_version).toBe(3);
    });
  });

  describe('Retry token (US 28)', () => {
    it('replays the committed result for an identical retry, with one correction, even after the version has moved on', async () => {
      const { assetId, reassignment } = await reassigned('ห้องส่งซ้ำแก้');
      const first = await amend(assetId, reassignment.id, 2, { remark: 'ส่งซ้ำ' }, { token: 'amend-replay' });
      expect(first.statusCode).toBe(201);

      const replay = await amend(assetId, reassignment.id, 2, { remark: 'ส่งซ้ำ' }, { token: 'amend-replay' });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect((await timelineOf(assetId))[1].corrections).toHaveLength(1);

      expect((await amend(assetId, reassignment.id, 3, { remark: 'ครั้งใหม่' })).statusCode).toBe(201);
      const late = await amend(assetId, reassignment.id, 2, { remark: 'ส่งซ้ำ' }, { token: 'amend-replay' });
      expect(late.statusCode).toBe(201);
      expect(late.json()).toEqual(first.json());
      expect((await timelineOf(assetId))[1].corrections).toHaveLength(2);
    });

    it('treats text that normalizes the same as the same payload', async () => {
      const { assetId, reassignment } = await reassigned('ห้องส่งซ้ำช่องว่างแก้');
      const first = await amend(assetId, reassignment.id, 2, { remark: 'แก้', reason: 'เหตุผล' }, { token: 'amend-normalized' });
      expect(first.statusCode).toBe(201);
      const replay = await amend(assetId, reassignment.id, 2, { remark: ' แก้ ', reason: ' เหตุผล ' }, { token: 'amend-normalized' });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
    });

    it('refuses a changed payload under the same token without writing', async () => {
      const { assetId, roomA, reassignment } = await reassigned('ห้องเปลี่ยนคำขอแก้');
      const payload = { remark: 'แก้', reason: 'เหตุผล' };
      expect((await amend(assetId, reassignment.id, 2, payload, { token: 'amend-mismatch' })).statusCode).toBe(201);
      const before = await assignmentOf(assetId);

      for (const changed of [
        { remark: 'อื่น' },
        { reason: 'อื่น' },
        { document_reference: 'อื่น' },
        { effective_date: '2026-06-02' },
        { changes: { location: { prior: valueOf(null) } } },
        { changes: { location: { prior: valueOf(roomA, 'ข้อความ') } } },
      ]) {
        const res = await amend(assetId, reassignment.id, 2, { ...payload, ...changed }, { token: 'amend-mismatch' });
        expect(res.statusCode, JSON.stringify(changed)).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect((await amend(assetId, reassignment.id, 3, payload, { token: 'amend-mismatch' })).statusCode).toBe(409);
      expect((await correct(assetId, reassignment.id, { action: 'VOID', expected_assignment_version: 2, reason: 'เหตุผล' }, { token: 'amend-mismatch' })).statusCode).toBe(409);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { assetId, reassignment } = await reassigned('ห้องส่งพร้อมกันแก้');
      const responses = await Promise.all(Array.from({ length: 8 }, () => voidFact(assetId, reassignment.id, 2, { token: 'void-concurrent' })));
      for (const res of responses) {
        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual(responses[0].json());
      }
      expect((await timelineOf(assetId))[1].corrections).toHaveLength(1);
      expect((await detailOf(assetId)).assignment_version).toBe(3);
    });

    it('scopes a token to its fact, and stores nothing for a refused write', async () => {
      const { assetId, initial, reassignment } = await reassigned('ห้องขอบเขตโทเค็นแก้');
      expect((await amend(assetId, reassignment.id, 2, { remark: 'แก้' }, { token: 'correction-scope' })).statusCode).toBe(201);
      expect((await amend(assetId, initial.id, 3, { remark: 'แก้' }, { token: 'correction-scope' })).statusCode).toBe(201);

      const refused = await amend(assetId, reassignment.id, 4, { effective_date: '2026-11-06' }, { token: 'correction-after-refusal' });
      expect(refused.statusCode).toBe(400);
      expect((await amend(assetId, reassignment.id, 4, { effective_date: '2026-11-05' }, { token: 'correction-after-refusal' })).statusCode).toBe(201);
    });

    it('requires one nonblank token of at most 128 characters, from the header or the body', async () => {
      const { assetId, reassignment } = await reassigned('ห้องตรวจโทเค็นแก้');
      const url = `/assets/${assetId}/assignments/${reassignment.id}/corrections`;
      const body = { action: 'VOID', expected_assignment_version: 2, reason: 'ผิด' };
      const before = await assignmentOf(assetId);

      for (const [extraBody, headers] of [
        [{}, {}],
        [{ retry_token: '   ' }, {}],
        [{}, { 'x-retry-token': 'ก'.repeat(129) }],
        [{ retry_token: 'body-token' }, { 'x-retry-token': 'header-token' }],
      ] as [Record<string, unknown>, Record<string, string>][]) {
        const res = await post(custodian, url, { ...body, ...extraBody }, headers);
        expect(res.statusCode, JSON.stringify({ extraBody, headers })).toBe(400);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
      expect((await post(custodian, url, { ...body, retry_token: 'correction-token-in-body' })).statusCode).toBe(201);
    });

    it('commits the correction, the event, the version and the token together, or none of them', async () => {
      const { assetId, reassignment } = await reassigned('ห้องล้มกลางทางแก้');
      const before = await assignmentOf(assetId);
      await pool.query(`
        CREATE FUNCTION fail_correction_token() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'correction-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_correction_token BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_correction_token();
      `);
      try {
        for (const res of [
          await amend(assetId, reassignment.id, 2, { remark: 'แก้' }, { token: 'correction-fail-token' }),
          await voidFact(assetId, reassignment.id, 2, { token: 'correction-fail-token' }),
        ]) {
          expect(res.statusCode).toBe(500);
          expect(res.body).not.toContain('injected failure');
        }
        expect(await assignmentOf(assetId)).toEqual(before);
      } finally {
        await pool.query('DROP TRIGGER fail_correction_token ON registration_retry_tokens; DROP FUNCTION fail_correction_token();');
      }
      expect((await amend(assetId, reassignment.id, 2, { remark: 'แก้' }, { token: 'correction-fail-token' })).statusCode).toBe(201);
    });
  });

  describe('Authorization (Q3, US 47)', () => {
    // Runs `work` with 'assignment:correct' answered by `answer` instead of the role map.
    const withCorrectCapability = async <T>(answer: () => Promise<boolean>, work: () => Promise<T>): Promise<T> => {
      const capabilities = app.capabilityService!;
      const original = capabilities.hasCapability;
      capabilities.hasCapability = async (userId: string, capability: string) =>
        capability === 'assignment:correct' ? answer() : original.call(capabilities, userId, capability);
      try {
        return await work();
      } finally {
        capabilities.hasCapability = original;
      }
    };

    it('lets an Asset Custodian and an Administrator correct, recording who did', async () => {
      const { assetId, initial, reassignment } = await reassigned('ห้องสิทธิ์แก้');
      expect((await amend(assetId, initial.id, 2, { remark: 'โดยผู้ดูแล' }, { actor: custodian })).statusCode).toBe(201);
      expect((await voidFact(assetId, reassignment.id, 3, { actor: admin })).statusCode).toBe(201);
      const timeline = await timelineOf(assetId);
      expect(timeline[0].corrections[0].recorded_by).toBe(custodian.id);
      expect(timeline[1].corrections[0].recorded_by).toBe(admin.id);
      expect(timeline[1].corrections[0].recorded_by_username).toBe('admin_ac');
    });

    it('forbids a Read-only User and a System Maintainer, and writes nothing', async () => {
      const { assetId, reassignment } = await reassigned('ห้องสิทธิ์ห้าม');
      const before = await assignmentOf(assetId);
      for (const actor of [readonly, maintainer]) {
        expect((await amend(assetId, reassignment.id, 2, { remark: 'แก้' }, { actor })).statusCode).toBe(403);
        expect((await voidFact(assetId, reassignment.id, 2, { actor })).statusCode).toBe(403);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('needs a session and the CSRF token', async () => {
      const { assetId, reassignment } = await reassigned('ห้องเซสชันแก้');
      const before = await assignmentOf(assetId);
      const url = `/assets/${assetId}/assignments/${reassignment.id}/corrections`;
      const payload = { action: 'VOID', expected_assignment_version: 2, reason: 'ผิด' };

      const anonymous = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-retry-token': 'anonymous' }, payload });
      expect([401, 403]).toContain(anonymous.statusCode);
      const withoutCsrf = await app.inject({ method: 'POST', url, headers: { cookie: custodian.cookie, 'content-type': 'application/json', 'x-retry-token': 'no-csrf' }, payload });
      expect(withoutCsrf.statusCode).toBe(403);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it("refuses a Custodian whose 'assignment:correct' alone is denied, and writes nothing", async () => {
      const { assetId, reassignment } = await reassigned('ห้องถอนสิทธิ์แก้');
      const before = await assignmentOf(assetId);
      const res = await withCorrectCapability(async () => false, () => amend(assetId, reassignment.id, 2, { remark: 'แก้' }));
      expect(res.statusCode).toBe(403);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('fails closed when the capability lookup fails, and writes nothing', async () => {
      const { assetId, reassignment } = await reassigned('ห้องค้นสิทธิ์ล้มแก้');
      const before = await assignmentOf(assetId);
      const res = await withCorrectCapability(
        async () => {
          throw new Error('lookup failed');
        },
        () => voidFact(assetId, reassignment.id, 2)
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('lookup failed');
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('takes a revoked grant away at once', async () => {
      const { assetId, reassignment } = await reassigned('ห้องถอนบทบาทแก้');
      const before = await assignmentOf(assetId);
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ADMINISTRATOR'`, [admin.id]);
      try {
        expect((await voidFact(assetId, reassignment.id, 2, { actor: admin })).statusCode).toBe(403);
      } finally {
        await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')`, [admin.id]);
      }
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('tells the Asset page whether the viewer may correct', async () => {
      const { assetId } = await reassigned('ห้องธงสิทธิ์แก้');
      for (const [actor, expected] of [
        [custodian, true],
        [admin, true],
        [readonly, false],
      ] as [Actor, boolean][]) {
        expect((await get(actor, `/assets/${assetId}`)).json().can_correct_assignment).toBe(expected);
      }
      const denied = await withCorrectCapability(async () => false, () => get(custodian, `/assets/${assetId}`));
      expect(denied.json().can_correct_assignment).toBe(false);
    });
  });
});
