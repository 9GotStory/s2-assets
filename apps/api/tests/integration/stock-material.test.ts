import * as crypto from 'node:crypto';
  // It confirms any Duplicate Candidate (F008-T5): the Stock Materials here share names.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Text of `length` characters.
const text = (length: number) => 'ก'.repeat(length);

// F008-T1 (#176): creating a Stock Material with its Base Unit, and finding it again in the list and on its page
// (#175 MC-01, MC-02, MC-04, MC-10, Q1, Q2, Q5, Q6, Q18, P6, P7, P9).
describe('Stock Material (Seam A - F008-T1)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // A Unit most Stock Materials here count in.
  let sheet: string;

  const { unitNamed, createMaterial, created, materialOf, materialCount } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A valid request: a name and the Base Unit แผ่น, unless `overrides` says otherwise.
  const base = (overrides: Record<string, unknown> = {}) => ({ name: 'กระดาษ A4', base_unit: { unit_id: sheet }, explicit_continuation: true, ...overrides });

  // The list rows a reader gets for `query`.
  const listed = async (query: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/stock-materials?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // A refused request: its status and code, its message naming `field`, and nothing saved.
  const expectRefused = async (payload: Record<string, unknown>, field: string) => {
    const before = await materialCount();
    const res = await createMaterial(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialCount()).toBe(before);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_material', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_material', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_material', 'READ_ONLY');
    custodian = await api.actor('custodian_material', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_material', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_material', 'SYSTEM_MAINTAINER');
    sheet = await unitNamed('แผ่น');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('creating', () => {
    it('creates a Stock Material with its own Stable ID, and its page shows every field, its Base Unit and its history', async () => {
      const before = Date.now();

      const res = await createMaterial(
        base({ name: 'กระดาษถ่ายเอกสาร A4', model: 'Double A Premium', specification: '80 แกรม\nสีขาว', note: 'ใช้ในงานธุรการ', base_unit: { unit_id: sheet, whole_number_only: true } })
      );

      expect(res.statusCode).toBe(201);
      const { stock_material_id: id, version } = res.json();
      expect(id).toMatch(UUID);
      expect(version).toBe(1);
      const page = await materialOf(id);
      expect(page).toMatchObject({
        id,
        name: 'กระดาษถ่ายเอกสาร A4',
        model: 'Double A Premium',
        specification: '80 แกรม\nสีขาว',
        note: 'ใช้ในงานธุรการ',
        is_active: true,
        version: 1,
        created_by: officer.id,
        created_by_username: 'officer_material',
        units: [{ unit_id: sheet, name: 'แผ่น', unit_is_active: true, is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true }],
      });
      expect(page.history).toEqual([
        {
          version: 1,
          kind: 'CREATED',
          changes: [
            { field: 'name', before: null, after: 'กระดาษถ่ายเอกสาร A4' },
            { field: 'model', before: null, after: 'Double A Premium' },
            { field: 'specification', before: null, after: '80 แกรม\nสีขาว' },
            { field: 'note', before: null, after: 'ใช้ในงานธุรการ' },
            { field: 'units', before: null, after: [{ unit_id: sheet, name: 'แผ่น', is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true }] },
          ],
          reason: null,
          note: null,
          recorded_by: officer.id,
          recorded_by_username: 'officer_material',
          recorded_at: expect.any(String),
        },
      ]);
      expect(page.recorded_at).toBe(page.history[0].recorded_at);
      expect(Date.parse(page.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(page.recorded_at)).toBeLessThanOrEqual(Date.now());
    });

    it('needs only a name and a Base Unit: Model, Specification and note left out or blank are none, and the history lists none', async () => {
      const id = (await createMaterial(base({ model: '  ', specification: '', note: null }))).json().stock_material_id;

      const page = await materialOf(id);

      expect(page).toMatchObject({ model: null, specification: null, note: null });
      expect(page.history[0].changes.map(({ field }: { field: string }) => field)).toEqual(['name', 'units']);
    });

    it('makes the Base Unit whole-number-only unless told fractions are allowed', async () => {
      const whole = await created({ base_unit: { unit_id: sheet } });
      const fractional = await created({ base_unit: { unit_id: sheet, whole_number_only: false } });

      expect((await materialOf(whole)).units[0].whole_number_only).toBe(true);
      expect((await materialOf(fractional)).units[0]).toMatchObject({ is_base: true, conversion_factor: '1', whole_number_only: false });
    });

    it('lets two Stock Materials share a name: each is its own record', async () => {
      const first = await created({ name: 'แฟ้มเอกสาร' });
      const second = await created({ name: 'แฟ้มเอกสาร' });
      expect(first).not.toBe(second);
    });

    it('needs a name that is not blank', async () => {
      const { name: _name, ...noName } = base();
      await expectRefused(noName, 'name');
      await expectRefused(base({ name: '   ' }), 'name');
    });

    it('needs a Base Unit', async () => {
      const { base_unit: _baseUnit, ...noBaseUnit } = base();
      await expectRefused(noBaseUnit, 'base_unit');
      await expectRefused(base({ base_unit: { whole_number_only: true } }), 'base_unit');
      await expectRefused(base({ base_unit: { unit_id: 'not-a-unit' } }), 'base_unit.unit_id');
    });

    it('needs a Base Unit that is on the Unit list and active', async () => {
      await expectRefused(base({ base_unit: { unit_id: crypto.randomUUID() } }), 'base_unit.unit_id');
      const retired = await unitNamed('ลัง (เลิกใช้)');
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [retired]);
      await expectRefused(base({ base_unit: { unit_id: retired } }), 'base_unit.unit_id');
    });

    it('takes no field it does not know', async () => {
      await expectRefused(base({ code: 'M-001' }), 'code');
      await expectRefused(base({ base_unit: { unit_id: sheet, is_active: false } }), 'base_unit');
    });
  });

  describe('text (P7)', () => {
    it('takes a name and a Model of 200 characters, a Specification of 500 and a note of 2000, and refuses one more', async () => {
      expect((await createMaterial(base({ name: text(200), model: text(200), specification: text(500), note: text(2000) }))).statusCode).toBe(201);
      await expectRefused(base({ name: text(201) }), 'name');
      await expectRefused(base({ model: text(201) }), 'model');
      await expectRefused(base({ specification: text(501) }), 'specification');
      await expectRefused(base({ note: text(2001) }), 'note');
    });

    it('refuses any control character in the name or the Model, a line break at its end included', async () => {
      await expectRefused(base({ name: 'กระดาษ\tA4' }), 'name');
      await expectRefused(base({ name: 'กระดาษ A4\n' }), 'name');
      await expectRefused(base({ model: 'รุ่น\n2' }), 'model');
    });

    it('keeps tab and line breaks inside the Specification and the note, and refuses any other control character', async () => {
      const id = await created({ specification: 'ขนาด A4\tสีขาว\r\nกล่องละ 5 รีม', note: 'สั่งทุกเดือน\nช่วงต้นเดือน' });
      expect(await materialOf(id)).toMatchObject({ specification: 'ขนาด A4\tสีขาว\r\nกล่องละ 5 รีม', note: 'สั่งทุกเดือน\nช่วงต้นเดือน' });

      await expectRefused(base({ specification: 'สีขาว\u0007' }), 'specification');
      await expectRefused(base({ note: 'หมายเหตุ\u0000' }), 'note');
    });
  });

  describe('history (Q18, P6)', () => {
    it('keeps the Base Unit name as it was when recorded, while the page shows its name now', async () => {
      const box = await unitNamed('กลอ่ง');
      const id = await created({ base_unit: { unit_id: box } });
      // The rename of F008-T8, written where it is stored.
      await api.pool.query(`UPDATE units SET name = 'กล่อง', version = version + 1 WHERE id = $1`, [box]);

      const page = await materialOf(id);

      expect(page.units[0].name).toBe('กล่อง');
      expect(page.history[0].changes.find(({ field }: { field: string }) => field === 'units').after[0].name).toBe('กลอ่ง');
    });
  });

  describe('concurrency', () => {
    it('waits for a Unit being made Inactive and then refuses it as the Base Unit', async () => {
      const unit = await unitNamed('ม้วน');
      const before = await materialCount();

      const [res] = await whileWriting(
        // What making a Unit Inactive writes (F008-T8), held uncommitted.
        { sql: 'UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', params: [unit] },
        () => [createMaterial(base({ base_unit: { unit_id: unit } }))],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('base_unit.unit_id');
      expect(await materialCount()).toBe(before);
    });
  });

  describe('the list', () => {
    it('lists each Stock Material with its identity fields, its Base Unit and its status', async () => {
      const box = await unitNamed('กล่องรายการ');
      const id = await created({ name: 'หมึกพิมพ์ รายการ', model: 'HP 682', specification: 'สีดำ', base_unit: { unit_id: box } });

      const { items } = await listed(`search=${encodeURIComponent('หมึกพิมพ์ รายการ')}`);

      // F008-T4 (#179) adds the Brand and the Material Category, none here.
      expect(items).toEqual([
        { id, name: 'หมึกพิมพ์ รายการ', model: 'HP 682', specification: 'สีดำ', base_unit: { unit_id: box, name: 'กล่องรายการ' }, brand: null, material_category: null, minimum_stock: null, is_active: true },
      ]);
    });

    it('searches the name, the Model and the Specification, ignoring case', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const byName = await created({ name: `Stapler ${tag}` });
      const byModel = await created({ name: 'ที่เย็บกระดาษ', model: `MAX-${tag}` });
      const bySpecification = await created({ name: 'ลวดเย็บ', specification: `เบอร์ 10 (${tag})` });
      await created({ name: 'ไม่เกี่ยว', note: tag });

      const found = await listed(`search=${tag.toUpperCase()}&limit=100`);

      expect(found.items.map(({ id }: { id: string }) => id).sort()).toEqual([byName, byModel, bySpecification].sort());
      expect(found.total_count).toBe(3);
    });

    it('treats % and _ in a search as text', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const percent = await created({ name: `น้ำยา 100% ${tag}` });
      await created({ name: `น้ำยา 1000 ${tag}` });

      expect((await listed(`search=${encodeURIComponent(`100% ${tag}`)}`)).items.map(({ id }: { id: string }) => id)).toEqual([percent]);
      expect((await listed(`search=${encodeURIComponent(`_ ${tag}`)}`)).items).toEqual([]);
    });

    it('pages the list by name, breaking a tie by Stable ID across a page break', async () => {
      const tag = `เรียง ${crypto.randomUUID().slice(0, 8)}`;
      const last = await created({ name: `${tag} ข` });
      const tied = [await created({ name: `${tag} ก` }), await created({ name: `${tag} ก` })].sort();

      const first = await listed(`search=${encodeURIComponent(tag)}&limit=1&offset=0`);
      const second = await listed(`search=${encodeURIComponent(tag)}&limit=1&offset=1`);
      const third = await listed(`search=${encodeURIComponent(tag)}&limit=1&offset=2`);

      expect([first, second, third].map(({ items }) => items[0].id)).toEqual([...tied, last]);
      expect(first).toMatchObject({ limit: 1, offset: 0, total_count: 3, has_more: true });
      expect(third).toMatchObject({ offset: 2, total_count: 3, has_more: false });
      expect(await listed(`search=${encodeURIComponent(tag)}&offset=5`)).toMatchObject({ items: [], total_count: 3, has_more: false });
    });

    it('refuses a query it does not take: a page past 100, a blank search, or a control character other than tab and line breaks', async () => {
      for (const [query, field] of [['limit=101', 'limit'], ['search=%20%20', 'search'], ['search=a%07b', 'search'], ['status=INACTIVE', 'status']]) {
        const res = await api.get(readonly, `/stock-materials?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
      }
    });

    it('tells the list whether the viewer may add a Stock Material, which follows material:manage alone', async () => {
      expect((await listed('limit=1', officer)).can_manage).toBe(true);
      for (const viewer of [admin, readonly]) {
        expect((await listed('limit=1', viewer)).can_manage).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, '/stock-materials?limit=1'));
      expect(denied.json().can_manage).toBe(false);
    });
  });

  describe('the page', () => {
    it('answers 404 for a Stock Material that does not exist, and 400 for an id that is not one', async () => {
      expect((await api.get(readonly, `/stock-materials/${crypto.randomUUID()}`)).statusCode).toBe(404);
      const res = await api.get(readonly, '/stock-materials/not-an-id');
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_ID');
    });

    it('tells the page whether the viewer may change the Stock Material, which follows material:manage alone', async () => {
      const id = await created();

      expect((await materialOf(id, officer)).can_manage).toBe(true);
      for (const viewer of [admin, readonly]) {
        expect((await materialOf(id, viewer)).can_manage).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, `/stock-materials/${id}`));
      expect(denied.json().can_manage).toBe(false);
    });
  });

  describe('permissions', () => {
    it('lets the Supply Officer, the Administrator and the Read-only User read the list and the page, and no one else', async () => {
      const id = await created({ name: 'ผงซักฟอกที่ทุกคนไม่ควรเห็น' });

      for (const viewer of [officer, admin, readonly]) {
        expect((await api.get(viewer, '/stock-materials')).statusCode).toBe(200);
        expect((await api.get(viewer, `/stock-materials/${id}`)).statusCode).toBe(200);
      }
      for (const other of [custodian, staff, maintainer]) {
        for (const url of ['/stock-materials', `/stock-materials/${id}`]) {
          const res = await api.get(other, url);
          expect(res.statusCode).toBe(403);
          expect(res.body).not.toContain('ผงซักฟอก');
        }
      }
      for (const url of ['/stock-materials', `/stock-materials/${id}`]) {
        const anonymous = await api.app.inject({ method: 'GET', url });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.body).not.toContain(id);
      }
    });

    // The Administrator holds asset:view too, so a gate on another capability would let them through.
    it('needs material:view itself to read, and fails closed when the lookup fails', async () => {
      const id = await created({ name: 'น้ำยาล้างจานที่ไม่ควรเห็น' });

      for (const url of ['/stock-materials', `/stock-materials/${id}`]) {
        const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(admin, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('น้ำยาล้างจาน');
        const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(admin, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('น้ำยาล้างจาน');
      }
    });

    it('lets only the Supply Officer create a Stock Material', async () => {
      const before = await materialCount();
      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await createMaterial(base(), crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await materialCount()).toBe(before);
    });

    it('needs material:manage itself to create, and fails closed when the lookup fails, saving nothing', async () => {
      const before = await materialCount();
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => createMaterial(base()))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => createMaterial(base()));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await materialCount()).toBe(before);
    });

    it('needs a session and the CSRF token to create, and an inactive user is refused', async () => {
      const before = await materialCount();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: '/stock-materials', headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: base() });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('officer_inactive_material', 'SUPPLY_OFFICER');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await createMaterial(base(), crypto.randomUUID(), leaving)).statusCode);
      expect(await materialCount()).toBe(before);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const before = await materialCount();
      const res = await api.post(officer, '/stock-materials', base());
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await materialCount()).toBe(before);
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const token = crypto.randomUUID();
      const first = await createMaterial(base(), token);
      expect(first.statusCode).toBe(201);
      const before = await materialCount();

      const replay = await createMaterial(base(), token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await materialCount()).toBe(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const token = crypto.randomUUID();
      expect((await createMaterial(base(), token)).statusCode).toBe(201);
      const before = await materialCount();

      for (const changed of [base({ name: 'กระดาษ A3' }), base({ model: 'IK' }), base({ base_unit: { unit_id: sheet, whole_number_only: false } })]) {
        const res = await createMaterial(changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await materialCount()).toBe(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_material_two', 'SUPPLY_OFFICER');
      const token = crypto.randomUUID();
      const mine = await createMaterial(base(), token);
      const theirs = await createMaterial(base(), token, otherOfficer);

      expect(theirs.statusCode).toBe(201);
      expect(theirs.json().stock_material_id).not.toBe(mine.json().stock_material_id);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const token = crypto.randomUUID();
      const before = await materialCount();

      const responses = await Promise.all(Array.from({ length: 8 }, () => createMaterial(base(), token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().stock_material_id)).size).toBe(1);
      expect(await materialCount()).toBe(before + 1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const unit = await unitNamed('โหลพัก');
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [unit]);
      const token = crypto.randomUUID();
      expect((await createMaterial(base({ base_unit: { unit_id: unit } }), token)).statusCode).toBe(400);
      await api.pool.query('UPDATE units SET is_active = true WHERE id = $1', [unit]);

      expect((await createMaterial(base({ base_unit: { unit_id: unit } }), token)).statusCode).toBe(201);
    });
  });
});
