import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F008-T1 (#176): the shared Unit list (หน่วยนับ), added to by a Supply Officer and read by every catalog viewer
// (#175 Q5, Q20, P5, P7).
describe('Unit list (Seam A - F008-T1)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;

  const { addUnit, unitNamed, unitsOf } = materialHelpers(() => ({ api, officer, reader: readonly }));

  const entryNamed = async (name: string) => (await unitsOf()).items.find((entry: { name: string }) => entry.name === name);
  const unitCount = async () => (await unitsOf()).items.length;

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_units', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_units', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_units', 'READ_ONLY');
    custodian = await api.actor('custodian_units', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_units', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_units', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('adding', () => {
    it('adds a Unit, active at version 1, and every viewer reads it in the list by name', async () => {
      const res = await addUnit('  รีม  ');

      expect(res.statusCode).toBe(201);
      const entry = res.json();
      expect(entry).toEqual({ id: expect.stringMatching(UUID), name: 'รีม', is_active: true, version: 1 });
      for (const viewer of [officer, admin, readonly]) {
        expect((await unitsOf(viewer)).items).toContainEqual(entry);
      }
    });

    it('lists the Units by name, Inactive ones with their status', async () => {
      const prefix = `ลำดับ ${crypto.randomUUID().slice(0, 6)}`;
      const second = await unitNamed(`${prefix} ข`);
      const first = await unitNamed(`${prefix} ก`);
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [second]);

      const listed = (await unitsOf()).items.filter((entry: { name: string }) => entry.name.startsWith(prefix));

      expect(listed).toEqual([
        { id: first, name: `${prefix} ก`, is_active: true, version: 1 },
        { id: second, name: `${prefix} ข`, is_active: false, version: 1 },
      ]);
    });

    it('records the addition in the entry history, with who added it', async () => {
      const id = await unitNamed('กระป๋อง');

      // The history is read on the maintenance page from F008-T8; here it is checked where it is stored.
      const res = await api.pool.query('SELECT version, action, changes, actor_id FROM unit_history WHERE unit_id = $1', [id]);

      expect(res.rows).toEqual([{ version: 1, action: 'CREATED', changes: { name: { before: null, after: 'กระป๋อง' }, is_active: { before: null, after: true } }, actor_id: officer.id }]);
    });
  });

  describe('one entry per name', () => {
    it('refuses a name that matches one in the list ignoring case and repeated spaces, answering with that entry', async () => {
      const id = await unitNamed('Box  Pack');
      const before = await unitCount();

      for (const name of ['box pack', 'BOX   PACK', ' Box Pack ']) {
        const res = await addUnit(name);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id, name: 'Box  Pack', is_active: true, version: 1 } });
      }
      expect(await unitCount()).toBe(before);
    });

    it('refuses a name that matches an Inactive entry, saying it is Inactive so that it can be reactivated', async () => {
      const id = await unitNamed('ถัง');
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [id]);

      const res = await addUnit('ถัง');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id, name: 'ถัง', is_active: false } });
    });

    it('takes a name that only contains another', async () => {
      await unitNamed('ชุด');
      expect((await addUnit('ชุดใหญ่')).statusCode).toBe(201);
    });
  });

  describe('the name (P7)', () => {
    it('needs a name that is not blank', async () => {
      const before = await unitCount();
      const res = await addUnit('   ');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('name') });
      expect(await unitCount()).toBe(before);
    });

    it('takes 200 characters and refuses 201', async () => {
      expect((await addUnit('ห'.repeat(200))).statusCode).toBe(201);
      const res = await addUnit('ย'.repeat(201));
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('200');
    });

    it('refuses a control character, a line break at its end included', async () => {
      for (const name of ['ม้วน\tใหญ่', 'ม้วน\n']) {
        const res = await addUnit(name);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('control characters');
      }
      expect(await entryNamed('ม้วน')).toBeUndefined();
    });
  });

  describe('permissions', () => {
    it('lets the Supply Officer, the Administrator and the Read-only User read the list, and no one else', async () => {
      await unitNamed('แท่ง');
      for (const viewer of [officer, admin, readonly]) {
        expect((await api.get(viewer, '/units')).statusCode).toBe(200);
      }
      for (const other of [custodian, staff, maintainer]) {
        const res = await api.get(other, '/units');
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain('แท่ง');
      }
      expect((await api.app.inject({ method: 'GET', url: '/units' })).statusCode).toBe(401);
    });

    it('tells the list whether the viewer may add, which follows material:manage alone', async () => {
      expect((await unitsOf(officer)).can_manage).toBe(true);
      for (const viewer of [admin, readonly]) {
        expect((await unitsOf(viewer)).can_manage).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, '/units'));
      expect(denied.json().can_manage).toBe(false);
    });

    it('lets only the Supply Officer add a Unit', async () => {
      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await addUnit('ห่อ', crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await entryNamed('ห่อ')).toBeUndefined();
    });

    it('needs material:manage itself to add, and fails closed when the lookup fails, saving nothing', async () => {
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => addUnit('ซอง'))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => addUnit('ซอง'));
      expect(failed.statusCode).toBe(500);
      expect(await entryNamed('ซอง')).toBeUndefined();
    });

    // The Administrator holds asset:view too, so a gate on another capability would let them through.
    it('needs material:view itself to read the list, and fails closed when the lookup fails', async () => {
      await unitNamed('ขวด');
      const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(admin, '/units'));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('ขวด');
      const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(admin, '/units'));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('ขวด');
    });

    it('needs a session and the CSRF token to add', async () => {
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: '/units', headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: { name: 'โหล' } });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await entryNamed('โหล')).toBeUndefined();
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const res = await api.post(officer, '/units', { name: 'คู่' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await entryNamed('คู่')).toBeUndefined();
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const token = crypto.randomUUID();
      const first = await addUnit('ตลับ', token);
      expect(first.statusCode).toBe(201);
      const before = await unitCount();

      const replay = await addUnit('ตลับ', token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await unitCount()).toBe(before);
    });

    it('refuses the same token with a changed name, and writes nothing', async () => {
      const token = crypto.randomUUID();
      expect((await addUnit('แพ็ค', token)).statusCode).toBe(201);

      const res = await addUnit('แพ็คใหญ่', token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await entryNamed('แพ็คใหญ่')).toBeUndefined();
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_units_two', 'SUPPLY_OFFICER');
      const token = crypto.randomUUID();

      expect((await addUnit('ก้อน', token)).statusCode).toBe(201);
      expect((await addUnit('ลูก', token, otherOfficer)).statusCode).toBe(201);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => addUnit('หลอด', token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().id)).size).toBe(1);
    });

    it('stores no receipt for a refused name, so the same token can carry another', async () => {
      await unitNamed('เล่ม');
      const token = crypto.randomUUID();
      expect((await addUnit('เล่ม', token)).statusCode).toBe(409);

      // A refusal stored nothing, so the token is not bound to the refused name.
      expect((await addUnit('เล่มเล็ก', token)).statusCode).toBe(201);
    });
  });
});
