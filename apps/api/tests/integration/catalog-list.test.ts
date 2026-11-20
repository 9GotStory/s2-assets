import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F008-T4 (#179): the Brand (ยี่ห้อ) and Material Category (หมวดวัสดุ) lists, each added to by a Supply Officer and
// read by every catalog viewer, apart from each other, from the Unit list and from the Reference Lists (#175 MC-12,
// MC-16, MC-26, Q3, Q4, Q20, P5, P7).
describe.each([
  { path: '/brands', table: 'brands', history: 'brand_history', column: 'brand_id', concept: 'Brand' },
  { path: '/material-categories', table: 'material_categories', history: 'material_category_history', column: 'material_category_id', concept: 'Material Category' },
])('$concept list (Seam A - F008-T4)', ({ path, table, history, column, concept }) => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;

  const { addUnit } = materialHelpers(() => ({ api, officer, reader: readonly }));

  const addEntry = (name: string, token: string = crypto.randomUUID(), actor: Actor = officer) => api.post(actor, path, { name }, { 'x-retry-token': token });

  const entryId = async (name: string): Promise<string> => {
    const res = await addEntry(name);
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  const listOf = async (actor: Actor = readonly) => {
    const res = await api.get(actor, path);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const entryNamed = async (name: string) => (await listOf()).items.find((entry: { name: string }) => entry.name === name);
  const entryCount = async () => (await listOf()).items.length;

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_lists', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_lists', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_lists', 'READ_ONLY');
    custodian = await api.actor('custodian_lists', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_lists', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_lists', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('adding', () => {
    it('starts empty, with nothing seeded (Q3)', async () => {
      expect((await listOf()).items).toEqual([]);
    });

    it('adds an entry, active at version 1, and every viewer reads it in the list', async () => {
      const res = await addEntry('  Double A  ');

      expect(res.statusCode).toBe(201);
      const entry = res.json();
      expect(entry).toEqual({ id: expect.stringMatching(UUID), name: 'Double A', is_active: true, version: 1 });
      for (const viewer of [officer, admin, readonly]) {
        expect((await listOf(viewer)).items).toContainEqual(expect.objectContaining(entry));
      }
    });

    it('lists the entries by name, Inactive ones with their status', async () => {
      const prefix = `ลำดับ ${crypto.randomUUID().slice(0, 6)}`;
      const second = await entryId(`${prefix} ข`);
      const first = await entryId(`${prefix} ก`);
      expect((await api.post(officer, `${path}/${second}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);

      const listed = (await listOf()).items.filter((entry: { name: string }) => entry.name.startsWith(prefix));

      expect(listed).toMatchObject([
        { id: first, name: `${prefix} ก`, is_active: true, version: 1 },
        { id: second, name: `${prefix} ข`, is_active: false, version: 2 },
      ]);
    });

    it('records the addition in the entry history, with who added it', async () => {
      const id = await entryId('ตราช้าง');

      // The history is read on the maintenance page from F008-T8; here it is checked where it is stored.
      const res = await api.pool.query(`SELECT version, action, changes, actor_id FROM ${history} WHERE ${column} = $1`, [id]);

      expect(res.rows).toEqual([{ version: 1, action: 'CREATED', changes: { name: { before: null, after: 'ตราช้าง' }, is_active: { before: null, after: true } }, actor_id: officer.id }]);
    });
  });

  describe('one entry per name (Q20)', () => {
    it('refuses a name that matches one in the list ignoring case and repeated spaces, answering with that entry', async () => {
      const id = await entryId('Quick  Dry');
      const before = await entryCount();

      for (const name of ['quick dry', 'QUICK   DRY', ' Quick Dry ']) {
        const res = await addEntry(name);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: expect.stringContaining(concept), entry: { id, name: 'Quick  Dry', is_active: true, version: 1 } });
      }
      expect(await entryCount()).toBe(before);
    });

    it('refuses a name that matches an Inactive entry, saying it is Inactive so that it can be reactivated', async () => {
      const id = await entryId('เลิกผลิต');
      await api.pool.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [id]);

      const res = await addEntry('เลิกผลิต');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id, name: 'เลิกผลิต', is_active: false } });
    });

    it('takes a name that only contains another', async () => {
      await entryId('ม้า');
      expect((await addEntry('ม้าลาย')).statusCode).toBe(201);
    });

    it('keeps its names apart from the other list and from the Unit list', async () => {
      const name = `ร่วมกัน ${crypto.randomUUID().slice(0, 8)}`;
      const other = path === '/brands' ? '/material-categories' : '/brands';
      expect((await api.post(officer, other, { name }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(201);
      expect((await addUnit(name)).statusCode).toBe(201);

      expect((await addEntry(name)).statusCode).toBe(201);
    });
  });

  describe('the name (P7)', () => {
    it('needs a name that is not blank', async () => {
      const before = await entryCount();
      const res = await addEntry('   ');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('name') });
      expect(await entryCount()).toBe(before);
    });

    it('takes 200 characters and refuses 201', async () => {
      expect((await addEntry('ห'.repeat(200))).statusCode).toBe(201);
      const res = await addEntry('ย'.repeat(201));
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('200');
    });

    it('refuses a control character, a line break at its end included', async () => {
      for (const name of ['ตรา\tนก', 'ตรานก\n']) {
        const res = await addEntry(name);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('control characters');
      }
      expect(await entryNamed('ตรานก')).toBeUndefined();
    });

    it('takes no field it does not know', async () => {
      const res = await api.post(officer, path, { name: 'ตราไก่', is_active: false }, { 'x-retry-token': crypto.randomUUID() });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('is_active');
      expect(await entryNamed('ตราไก่')).toBeUndefined();
    });
  });

  describe('permissions', () => {
    it('lets the Supply Officer, the Administrator and the Read-only User read the list, and no one else', async () => {
      await entryId('ตราแมว');
      for (const viewer of [officer, admin, readonly]) {
        expect((await api.get(viewer, path)).statusCode).toBe(200);
      }
      for (const other of [custodian, staff, maintainer]) {
        const res = await api.get(other, path);
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain('ตราแมว');
      }
      expect((await api.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    });

    it('tells the list whether the viewer may add, which follows material:manage alone', async () => {
      expect((await listOf(officer)).can_manage).toBe(true);
      for (const viewer of [admin, readonly]) {
        expect((await listOf(viewer)).can_manage).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, path));
      expect(denied.json().can_manage).toBe(false);
    });

    it('lets only the Supply Officer add an entry', async () => {
      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await addEntry('ตราปลา', crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await entryNamed('ตราปลา')).toBeUndefined();
    });

    it('needs material:manage itself to add, and fails closed when the lookup fails, saving nothing', async () => {
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => addEntry('ตรานกยูง'))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => addEntry('ตรานกยูง'));
      expect(failed.statusCode).toBe(500);
      expect(await entryNamed('ตรานกยูง')).toBeUndefined();
    });

    // The Administrator holds asset:view too, so a gate on another capability would let them through.
    it('needs material:view itself to read the list, and fails closed when the lookup fails', async () => {
      await entryId('ตราเสือ');
      const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(admin, path));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('ตราเสือ');
      const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(admin, path));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('ตราเสือ');
    });

    it('needs a session and the CSRF token to add', async () => {
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: { name: 'ตราวัว' } });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await entryNamed('ตราวัว')).toBeUndefined();
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const res = await api.post(officer, path, { name: 'ตราควาย' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await entryNamed('ตราควาย')).toBeUndefined();
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const token = crypto.randomUUID();
      const first = await addEntry('ตรากระต่าย', token);
      expect(first.statusCode).toBe(201);
      const before = await entryCount();

      const replay = await addEntry('ตรากระต่าย', token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await entryCount()).toBe(before);
    });

    it('refuses the same token with a changed name, and writes nothing', async () => {
      const token = crypto.randomUUID();
      expect((await addEntry('ตราหมี', token)).statusCode).toBe(201);

      const res = await addEntry('ตราหมีขาว', token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await entryNamed('ตราหมีขาว')).toBeUndefined();
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor(`officer_lists_${table}`, 'SUPPLY_OFFICER');
      const token = crypto.randomUUID();

      expect((await addEntry('ตราลิง', token)).statusCode).toBe(201);
      expect((await addEntry('ตราลิงทอง', token, otherOfficer)).statusCode).toBe(201);
    });

    it('scopes a token to its list', async () => {
      const token = crypto.randomUUID();
      expect((await addUnit('ตราห่าน', token)).statusCode).toBe(201);
      const other = path === '/brands' ? '/material-categories' : '/brands';
      expect((await api.post(officer, other, { name: 'ตราห่าน' }, { 'x-retry-token': token })).statusCode).toBe(201);

      const res = await addEntry('ตราห่าน', token);

      expect(res.statusCode).toBe(201);
      expect(res.json().id).not.toBe(undefined);
      expect(await entryNamed('ตราห่าน')).toMatchObject({ id: res.json().id });
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => addEntry('ตรานาฬิกา', token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().id)).size).toBe(1);
    });

    it('stores no receipt for a refused name, so the same token can carry another', async () => {
      await entryId('ตราดาว');
      const token = crypto.randomUUID();
      expect((await addEntry('ตราดาว', token)).statusCode).toBe(409);

      expect((await addEntry('ตราดาวเหนือ', token)).statusCode).toBe(201);
    });
  });
});
