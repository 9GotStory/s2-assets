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

type Actor = { id: string; cookie: string; csrf: string };

// T4 (#25): D7-A reference lists and Asset reference context (Seam A).
describe('Reference Context Integration Tests (Seam A - T4)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sessionService: SessionService;

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

  const post = (actor: Actor, url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: actor.cookie, 'x-csrf-token': actor.csrf, 'content-type': 'application/json' },
      payload: payload as any,
    });

  const get = (actor: Actor, url: string) => app.inject({ method: 'GET', url, headers: { cookie: actor.cookie } });

  const entry = async (kind: string, name: string) => (await post(admin, `/references/${kind}`, { name })).json();

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
    app = await buildApp({ db: pool, cookieSecret: 'test-secret-at-least-32-chars-long-reference', logger: false });

    const passwordHash = await UserService.hashPassword('Password123!');
    const createUserWithRole = async (username: string, role: string) => {
      const res = await pool.query(
        'INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash]
      );
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [res.rows[0].id, role]);
      return res.rows[0].id as string;
    };

    admin = await createAuthenticatedSession(await createUserWithRole('admin_ref', 'ADMINISTRATOR'));
    custodian = await createAuthenticatedSession(await createUserWithRole('custodian_ref', 'ASSET_CUSTODIAN'));
    readonly = await createAuthenticatedSession(await createUserWithRole('readonly_ref', 'READ_ONLY'));
    maintainer = await createAuthenticatedSession(await createUserWithRole('maintainer_ref', 'SYSTEM_MAINTAINER'));
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  describe('Reference list maintenance (D7-A, D3 reference:maintain)', () => {
    it('reads lists only in canonical integer pages', async () => {
      for (const query of ['limit=1e2', 'limit=0x10', 'limit=0', 'limit=501', 'offset=', 'offset=-1', 'offset=01']) {
        expect((await get(readonly, `/references/locations?${query}`)).statusCode, query).toBe(400);
      }
      expect((await get(readonly, '/references/locations?limit=1&offset=0')).statusCode).toBe(200);
    });

    it('records every add, rename, deactivation and reactivation with who, when and before → after (#25 PO decision 3)', async () => {
      const room = await entry('locations', 'ห้องมีประวัติ');
      const change = (body: Record<string, unknown>) => post(admin, `/references/locations/${room.id}`, body);
      expect((await change({ expected_version: 1, name: 'ห้องมีประวัติ ชั้น 2' })).statusCode).toBe(200);
      expect((await change({ expected_version: 2, is_active: false })).statusCode).toBe(200);
      expect((await change({ expected_version: 3, is_active: true })).statusCode).toBe(200);
      // A no-op and a refused change record nothing.
      expect((await change({ expected_version: 4, is_active: true })).json().version).toBe(4);
      expect((await change({ expected_version: 1, name: 'ค่าเก่า' })).statusCode).toBe(409);

      for (const viewer of [readonly, custodian, admin]) {
        const res = await get(viewer, `/references/locations/${room.id}/history`);
        expect(res.statusCode).toBe(200);
        const items = res.json().items;
        expect(items.map((item: any) => [item.version, item.action, item.changes])).toEqual([
          [1, 'CREATED', { name: { before: null, after: 'ห้องมีประวัติ' }, is_active: { before: null, after: true } }],
          [2, 'CHANGED', { name: { before: 'ห้องมีประวัติ', after: 'ห้องมีประวัติ ชั้น 2' } }],
          [3, 'CHANGED', { is_active: { before: true, after: false } }],
          [4, 'CHANGED', { is_active: { before: false, after: true } }],
        ]);
        for (const item of items) {
          expect(item).toMatchObject({ actor_id: admin.id, actor_username: 'admin_ref' });
          expect(Number.isNaN(Date.parse(item.recorded_at))).toBe(false);
        }
      }
      expect((await get(maintainer, `/references/locations/${room.id}/history`)).statusCode).toBe(403);
      // History is per list: this id names no person.
      expect((await get(readonly, `/references/persons/${room.id}/history`)).statusCode).toBe(404);
      expect((await get(readonly, '/references/locations/not-a-uuid/history')).statusCode).toBe(400);
    });

    it('lets only one of two concurrent changes made from the same version succeed', async () => {
      const room = await entry('locations', 'ห้องแข่งกันแก้');
      const results = await Promise.all([
        post(admin, `/references/locations/${room.id}`, { expected_version: 1, name: 'ห้องแข่ง ก' }),
        post(admin, `/references/locations/${room.id}`, { expected_version: 1, name: 'ห้องแข่ง ข' }),
      ]);
      expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const stored = (await pool.query('SELECT name, version FROM locations WHERE id = $1', [room.id])).rows[0];
      expect(stored.version).toBe(2);
      expect(results.find((res) => res.statusCode === 200)!.json().name).toBe(stored.name);
    });

    it('lets an Administrator add a location that every registry viewer then sees', async () => {
      const created = await post(admin, '/references/locations', { name: 'ห้องพัสดุ ชั้น 1' });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ name: 'ห้องพัสดุ ชั้น 1', is_active: true, version: 1 });

      for (const viewer of [readonly, custodian, admin]) {
        const list = await get(viewer, '/references/locations');
        expect(list.statusCode).toBe(200);
        expect(list.json().items.map((item: any) => item.name)).toContain('ห้องพัสดุ ชั้น 1');
        // The page offers maintenance only to reference:maintain holders.
        expect(list.json().can_maintain).toBe(viewer === admin);
      }
    });

    it('lets only reference:maintain holders change lists, and only registry viewers read them', async () => {
      for (const actor of [custodian, readonly, maintainer]) {
        const denied = await post(actor, '/references/locations', { name: `ไม่ควรถูกเพิ่ม ${actor.id}` });
        expect(denied.statusCode).toBe(403);
      }
      expect((await get(maintainer, '/references/locations')).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/references/locations' })).statusCode).toBe(401);

      const withoutCsrf = await app.inject({
        method: 'POST',
        url: '/references/locations',
        headers: { cookie: admin.cookie, 'content-type': 'application/json' },
        payload: { name: 'ไม่มี CSRF' },
      });
      expect(withoutCsrf.statusCode).toBe(403);

      const listed = await get(readonly, '/references/locations');
      expect(listed.headers['cache-control']).toBe('no-store');
      const names = listed.json().items.map((item: any) => item.name);
      expect(names).not.toContain('ไม่มี CSRF');
      expect(names.some((name: string) => name.startsWith('ไม่ควรถูกเพิ่ม'))).toBe(false);
      expect((await get(readonly, '/references/rooms')).statusCode).toBe(404);
    });

    it('keeps the three lists separate', async () => {
      const unit = await post(admin, '/references/organization-units', { name: 'กลุ่มงานบริหารทั่วไป' });
      const person = await post(admin, '/references/persons', { name: 'นางสาวสมใจ ใจดี' });
      expect(unit.statusCode).toBe(201);
      expect(person.statusCode).toBe(201);

      const units = (await get(readonly, '/references/organization-units')).json().items.map((i: any) => i.name);
      const persons = (await get(readonly, '/references/persons')).json().items.map((i: any) => i.name);
      const locations = (await get(readonly, '/references/locations')).json().items.map((i: any) => i.name);
      expect(units).toEqual(['กลุ่มงานบริหารทั่วไป']);
      expect(persons).toEqual(['นางสาวสมใจ ใจดี']);
      expect(locations).not.toContain('กลุ่มงานบริหารทั่วไป');
      expect(locations).not.toContain('นางสาวสมใจ ใจดี');
    });

    it('renames, deactivates and reactivates an entry under its version, and never deletes it', async () => {
      const created = (await post(admin, '/references/locations', { name: 'ห้องประชุมเล็ก' })).json();

      const renamed = await post(admin, `/references/locations/${created.id}`, {
        expected_version: 1,
        name: '  ห้องประชุม 2  ',
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toEqual({ id: created.id, name: 'ห้องประชุม 2', is_active: true, version: 2 });

      const stale = await post(admin, `/references/locations/${created.id}`, { expected_version: 1, is_active: false });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('VERSION_CONFLICT');

      const deactivated = await post(admin, `/references/locations/${created.id}`, { expected_version: 2, is_active: false });
      expect(deactivated.json()).toMatchObject({ is_active: false, version: 3 });

      // Inactive entries leave the default list but stay listable for maintenance and history.
      const active = (await get(readonly, '/references/locations')).json().items.map((i: any) => i.id);
      const all = (await get(readonly, '/references/locations?include_inactive=true')).json().items;
      expect(active).not.toContain(created.id);
      expect(all.find((i: any) => i.id === created.id)).toMatchObject({ name: 'ห้องประชุม 2', is_active: false });

      const noOp = await post(admin, `/references/locations/${created.id}`, { expected_version: 3, is_active: false });
      expect(noOp.json()).toMatchObject({ is_active: false, version: 3 });

      const reactivated = await post(admin, `/references/locations/${created.id}`, { expected_version: 3, is_active: true });
      expect(reactivated.json()).toMatchObject({ is_active: true, version: 4 });

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/references/locations/${created.id}`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      });
      expect(deleted.statusCode).toBe(404);
      const row = await pool.query('SELECT count(*)::int AS n FROM locations WHERE id = $1', [created.id]);
      expect(row.rows[0].n).toBe(1);
    });

    it('refuses duplicate, blank, overlong and control-character names and unexpected fields', async () => {
      await post(admin, '/references/locations', { name: 'คลังวัสดุ' });
      const duplicate = await post(admin, '/references/locations', { name: '  คลังวัสดุ ' });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().code).toBe('DUPLICATE_NAME');

      const other = (await post(admin, '/references/locations', { name: 'Store B' })).json();
      const caseOnly = await post(admin, '/references/locations', { name: 'store b' });
      expect(caseOnly.statusCode).toBe(409);
      const renameIntoDuplicate = await post(admin, `/references/locations/${other.id}`, {
        expected_version: 1,
        name: 'คลังวัสดุ',
      });
      expect(renameIntoDuplicate.statusCode).toBe(409);

      for (const payload of [{ name: '   ' }, { name: 'x'.repeat(201) }, { name: 'bad\u0007name' }, { name: 'ok', extra: 1 }, {}]) {
        const res = await post(admin, '/references/locations', payload);
        expect(res.statusCode).toBe(400);
      }
      const missing = await post(admin, '/references/locations/00000000-0000-4000-8000-000000000000', {
        expected_version: 1,
        name: 'ไม่มีอยู่จริง',
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('Asset reference context (AC-13, AC-14, AC-15, AR-06, AR-10)', () => {

    it('registers an Asset with chosen references and legacy text, and shows both on its detail', async () => {
      const location = await entry('locations', 'อาคาร 1 ห้อง 101');
      const unit = await entry('organization-units', 'กลุ่มงานพัสดุ');
      const person = await entry('persons', 'นายสมชาย รักงาน');

      const registered = await post(custodian, '/assets', {
        name: 'เครื่องพิมพ์เลเซอร์',
        location_id: location.id,
        organization_unit_id: unit.id,
        responsible_person_id: person.id,
        legacy_location_text: '  ห้องเก่า 3 (ทะเบียนเดิม) ',
      });
      expect(registered.statusCode).toBe(201);
      const assetId = registered.json().asset.id;

      const detail = await get(readonly, `/assets/${assetId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().reference_context).toEqual({
        location: { id: location.id, name: 'อาคาร 1 ห้อง 101', is_active: true },
        organization_unit: { id: unit.id, name: 'กลุ่มงานพัสดุ', is_active: true },
        responsible_person: { id: person.id, name: 'นายสมชาย รักงาน', is_active: true },
        legacy_location_text: 'ห้องเก่า 3 (ทะเบียนเดิม)',
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
    });

    it('registers without any reference context and invents none (AC-13, AC-15)', async () => {
      const registered = await post(custodian, '/assets', { name: 'โต๊ะประชุมส่วนกลาง' });
      expect(registered.statusCode).toBe(201);
      const detail = (await get(readonly, `/assets/${registered.json().asset.id}`)).json();
      expect(detail.reference_context).toEqual({
        location: null,
        organization_unit: null,
        responsible_person: null,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
      const assignments = await pool.query(
        `SELECT count(*)::int AS n FROM asset_history WHERE asset_id = $1 AND action <> 'REGISTERED'`,
        [registered.json().asset.id]
      );
      expect(assignments.rows[0].n).toBe(0);
    });

    it('makes a registration wait for a concurrent deactivation of its entry, then refuses the entry', async () => {
      const room = await entry('locations', 'ห้องกำลังปิด');
      const before = (await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n;
      const deactivation = await pool.connect();
      try {
        await deactivation.query('BEGIN');
        await deactivation.query('UPDATE locations SET is_active = false, version = version + 1 WHERE id = $1', [room.id]);
        const registration = post(custodian, '/assets', { name: 'ลงทะเบียนระหว่างปิด', location_id: room.id });

        // The registration's FOR SHARE lock must wait behind the uncommitted deactivation.
        let waiting = 0;
        for (let attempt = 0; attempt < 100 && waiting === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          waiting = (
            await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`)
          ).rows[0].n;
        }
        expect(waiting).toBe(1);

        await deactivation.query('COMMIT');
        expect((await registration).statusCode).toBe(400);
      } finally {
        deactivation.release();
      }
      expect((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(before);
    });

    it('refuses an unknown, malformed or inactive reference and invalid legacy text without writing', async () => {
      const inactive = await entry('locations', 'ห้องที่เลิกใช้');
      await post(admin, `/references/locations/${inactive.id}`, { expected_version: 1, is_active: false });
      const before = (await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n;

      const cases: Array<Record<string, unknown>> = [
        { location_id: inactive.id },
        { location_id: '00000000-0000-4000-8000-000000000000' },
        { organization_unit_id: 'not-a-uuid' },
        { responsible_person_id: inactive.id },
        { legacy_location_text: 'bad\u0000text' },
        { legacy_responsible_person_text: 'x'.repeat(501) },
        { legacy_organization_unit_text: 7 },
        { organization_unit: 'กลุ่มงานพัสดุ' },
      ];
      for (const extra of cases) {
        const res = await post(custodian, '/assets', { name: 'ไม่ควรถูกบันทึก', ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(before);
    });

    it('applies one shared reference context to every Asset of a bulk registration, atomically', async () => {
      const location = await entry('locations', 'ห้องเรียนรวม 2');
      const unit = await entry('organization-units', 'กลุ่มงานส่งเสริม');
      const payload = {
        location_id: location.id,
        organization_unit_id: unit.id,
        legacy_responsible_person_text: 'ครูเวรประจำห้อง (ทะเบียนเดิม)',
        items: [
          { item_key: '7e1c5a52-5d0f-4b2a-9c1e-000000000001', name: 'เก้าอี้นักเรียน 1' },
          { item_key: '7e1c5a52-5d0f-4b2a-9c1e-000000000002', name: 'เก้าอี้นักเรียน 2' },
        ],
      };
      const bulk = (actor: Actor, body: unknown, token: string) =>
        app.inject({
          method: 'POST',
          url: '/assets/bulk-register',
          headers: {
            cookie: actor.cookie,
            'x-csrf-token': actor.csrf,
            'x-retry-token': token,
            'content-type': 'application/json',
          },
          payload: body as any,
        });

      const first = await bulk(custodian, payload, 'bulk-ref-1');
      expect(first.statusCode).toBe(201);
      const ids = first.json().results.map((r: any) => r.asset_id);
      expect(ids).toHaveLength(2);
      for (const id of ids) {
        const context = (await get(readonly, `/assets/${id}`)).json().reference_context;
        expect(context.location).toMatchObject({ id: location.id, name: 'ห้องเรียนรวม 2' });
        expect(context.organization_unit).toMatchObject({ id: unit.id, name: 'กลุ่มงานส่งเสริม' });
        expect(context.responsible_person).toBeNull();
        expect(context.legacy_responsible_person_text).toBe('ครูเวรประจำห้อง (ทะเบียนเดิม)');
      }

      // The same token and payload replay the committed result; another context under it conflicts.
      const replay = await bulk(custodian, payload, 'bulk-ref-1');
      expect(replay.statusCode).toBe(201);
      expect(replay.json().results.map((r: any) => r.asset_id)).toEqual(ids);
      const changed = await bulk(custodian, { ...payload, legacy_responsible_person_text: 'อื่น' }, 'bulk-ref-1');
      expect(changed.statusCode).toBe(409);

      await post(admin, `/references/organization-units/${unit.id}`, { expected_version: 1, is_active: false });
      const before = (await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n;
      const refused = await bulk(
        custodian,
        {
          ...payload,
          items: [{ item_key: '7e1c5a52-5d0f-4b2a-9c1e-000000000003', name: 'เก้าอี้นักเรียน 3' }],
        },
        'bulk-ref-2'
      );
      expect(refused.statusCode).toBe(400);
      expect((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(before);
    });
  });

  describe('Search by reference context (AC-14, AC-23, AC-24)', () => {
    const register = async (name: string, context: Record<string, unknown>) =>
      (await post(custodian, '/assets', { name, ...context })).json().asset.id as string;
    const search = async (actor: Actor, query: string) => get(actor, `/assets/search?${query}`);

    it('filters each dimension on its own and combines them with AND, for every registry viewer', async () => {
      const roomA = await entry('locations', 'ห้องค้นหา A');
      const roomB = await entry('locations', 'ห้องค้นหา B');
      const unitX = await entry('organization-units', 'หน่วยค้นหา X');
      const personP = await entry('persons', 'บุคคลค้นหา P');

      const a1 = await register('ค้นหา 1', { location_id: roomA.id, organization_unit_id: unitX.id });
      const a2 = await register('ค้นหา 2', { location_id: roomA.id, responsible_person_id: personP.id });
      const b1 = await register('ค้นหา 3', { location_id: roomB.id, organization_unit_id: unitX.id });
      await register('ค้นหา 4', {});

      const ids = async (actor: Actor, query: string) => {
        const res = await search(actor, query);
        expect(res.statusCode, query).toBe(200);
        return res.json().items.map((item: any) => item.id).sort();
      };

      expect(await ids(readonly, `location_id=${roomA.id}`)).toEqual([a1, a2].sort());
      expect(await ids(readonly, `organization_unit_id=${unitX.id}`)).toEqual([a1, b1].sort());
      expect(await ids(admin, `responsible_person_id=${personP.id}`)).toEqual([a2]);
      expect(await ids(custodian, `location_id=${roomA.id}&organization_unit_id=${unitX.id}`)).toEqual([a1]);
      expect(await ids(readonly, `location_id=${roomB.id}&responsible_person_id=${personP.id}`)).toEqual([]);
      expect(await ids(readonly, `location_id=${roomA.id}&field=name&value=${encodeURIComponent('ค้นหา 2')}`)).toEqual([a2]);

      // Results carry the entry names for display.
      const item = (await search(readonly, `responsible_person_id=${personP.id}`)).json().items[0];
      expect(item.location).toEqual({ id: roomA.id, name: 'ห้องค้นหา A', is_active: true });
      expect(item.responsible_person).toEqual({ id: personP.id, name: 'บุคคลค้นหา P', is_active: true });
      expect(item.organization_unit).toBeNull();
    });

    it('finds each legacy text on its own, case-insensitively, and rejects malformed filters', async () => {
      const legacy = await register('ค้นหาข้อความเดิม', { legacy_location_text: 'Old Store Room 7' });
      const found = await search(readonly, `field=legacy_location_text&value=${encodeURIComponent('store room')}`);
      expect(found.statusCode).toBe(200);
      expect(found.json().items.map((i: any) => i.id)).toEqual([legacy]);
      expect(found.json().items[0].legacy_location_text).toBe('Old Store Room 7');

      // The dimensions stay distinct: an old location text is no old unit or person text.
      for (const field of ['legacy_organization_unit_text', 'legacy_responsible_person_text']) {
        const other = await search(readonly, `field=${field}&value=${encodeURIComponent('store room')}`);
        expect(other.json().items, field).toEqual([]);
      }

      for (const query of [
        'location_id=not-a-uuid',
        `organization_unit_id=${'0'.repeat(36)}`,
        'responsible_person_id=',
        'field=legacy_location_text&value=%20%20',
        'field=legacy_text&value=store',
        'location_id=00000000-0000-4000-8000-000000000000&location_id=00000000-0000-4000-8000-000000000001',
      ]) {
        expect((await search(readonly, query)).statusCode, query).toBe(400);
      }
      expect((await search(maintainer, 'location_id=00000000-0000-4000-8000-000000000000')).statusCode).toBe(403);
    });
  });

  describe('Correcting reference context (D3 asset:correct, with reason and history)', () => {
    const identity = (asset: any) => ({
      expected_name: asset.name,
      expected_asset_number: asset.asset_number,
      expected_serial_number: asset.serial_number,
    });
    let token = 0;
    const correct = (actor: Actor, asset: any, body: Record<string, unknown>) =>
      post(actor, `/assets/${asset.id}/correct`, { ...identity(asset), retry_token: `ref-correct-${++token}`, ...body });

    it('lets a Custodian or Administrator change, set and clear context with a reason, recorded as history', async () => {
      const roomA = await entry('locations', 'ห้องแก้ไข A');
      const roomB = await entry('locations', 'ห้องแก้ไข B');
      const unit = await entry('organization-units', 'หน่วยแก้ไข');
      const asset = (
        await post(custodian, '/assets', { name: 'แก้ไขบริบท', location_id: roomA.id, legacy_responsible_person_text: 'คุณเดิม' })
      ).json().asset;

      const res = await correct(custodian, asset, {
        location_id: roomB.id,
        expected_location_id: roomA.id,
        organization_unit_id: unit.id,
        expected_organization_unit_id: null,
        legacy_responsible_person_text: null,
        expected_legacy_responsible_person_text: 'คุณเดิม',
        reason: 'ย้ายบันทึกให้ตรงห้องจริง',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().history.payload).toEqual({
        reason: 'ย้ายบันทึกให้ตรงห้องจริง',
        changes: {
          location_id: { before: roomA.id, after: roomB.id },
          organization_unit_id: { before: null, after: unit.id },
          legacy_responsible_person_text: { before: 'คุณเดิม', after: null },
        },
      });

      const detail = (await get(readonly, `/assets/${asset.id}`)).json();
      expect(detail.reference_context).toMatchObject({
        location: { id: roomB.id, name: 'ห้องแก้ไข B' },
        organization_unit: { id: unit.id },
        responsible_person: null,
        legacy_responsible_person_text: null,
      });
      expect(detail.history.map((h: any) => h.action)).toEqual(['REGISTERED', 'CORRECTED']);

      // An Administrator corrects too; an unchanged value is a no-op without history.
      const again = await correct(admin, asset, { location_id: roomB.id, expected_location_id: roomB.id, reason: 'ตรวจซ้ำ' });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ noop: true, history: null });
    });

    it('refuses corrections without expected-before, with stale or inactive values, without a reason, or by a viewer', async () => {
      const room = await entry('locations', 'ห้องแก้ไขปฏิเสธ');
      const closed = await entry('locations', 'ห้องปิดแล้ว');
      await post(admin, `/references/locations/${closed.id}`, { expected_version: 1, is_active: false });
      const asset = (await post(custodian, '/assets', { name: 'แก้ไขไม่ได้', location_id: room.id })).json().asset;

      const refusals: [Actor, Record<string, unknown>, number][] = [
        [custodian, { location_id: null, reason: 'ไม่มีค่าก่อนแก้' }, 400],
        [custodian, { location_id: null, expected_location_id: '00000000-0000-4000-8000-000000000000', reason: 'ค่าก่อนแก้ไม่ตรง' }, 409],
        [custodian, { location_id: closed.id, expected_location_id: room.id, reason: 'รายการปิดแล้ว' }, 400],
        [custodian, { location_id: 'not-a-uuid', expected_location_id: room.id, reason: 'รูปแบบผิด' }, 400],
        [custodian, { legacy_location_text: 'x'.repeat(501), expected_legacy_location_text: null, reason: 'ยาวเกิน' }, 400],
        [custodian, { location_id: null, expected_location_id: room.id }, 400],
        [readonly, { location_id: null, expected_location_id: room.id, reason: 'ไม่มีสิทธิ์' }, 403],
      ];
      for (const [actor, body, status] of refusals) {
        expect((await correct(actor, asset, body)).statusCode, JSON.stringify(body)).toBe(status);
      }
      const detail = (await get(readonly, `/assets/${asset.id}`)).json();
      expect(detail.reference_context.location).toMatchObject({ id: room.id });
      expect(detail.history.map((h: any) => h.action)).toEqual(['REGISTERED']);

      // A stale conflict names the current value so the client can show it.
      const stale = await correct(custodian, asset, { location_id: null, expected_location_id: closed.id, reason: 'ค่าเก่า' });
      expect(stale.json().current_values).toMatchObject({ location_id: room.id });

      // An entry deactivated after assignment stays on the Asset while other facts are corrected.
      await post(admin, `/references/locations/${room.id}`, { expected_version: 1, is_active: false });
      const rename = await correct(custodian, asset, { name: 'แก้ชื่อได้', reason: 'ชื่อจริง' });
      expect(rename.statusCode).toBe(200);
      expect(rename.json().asset.location_id).toBe(room.id);
    });

    it('replays a retried correction and rejects a reused token with a different context', async () => {
      const room = await entry('locations', 'ห้องแก้ไขซ้ำ');
      const asset = (await post(custodian, '/assets', { name: 'แก้ซ้ำ' })).json().asset;
      const body = {
        ...identity(asset),
        retry_token: 'ref-correct-replay',
        location_id: room.id,
        expected_location_id: null,
        reason: 'ระบุห้อง',
      };
      const first = await post(custodian, `/assets/${asset.id}/correct`, body);
      const replay = await post(custodian, `/assets/${asset.id}/correct`, body);
      expect(first.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect((await post(custodian, `/assets/${asset.id}/correct`, { ...body, location_id: null })).statusCode).toBe(409);
    });
  });
});
