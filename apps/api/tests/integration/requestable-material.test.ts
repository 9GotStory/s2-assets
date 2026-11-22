import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Text of `length` characters.
const text = (length: number) => 'ก'.repeat(length);

// F009-T1 (#203): creating a Requestable Material (วัสดุสำหรับขอเบิก) with its Request Unit (หน่วยที่ขอ), and finding it
// again in the list and on its page (#202 MRQ-01, MRQ-02, MRQ-28, Q5, Q6, Q17, Q18, P7, P9).
describe('Requestable Material (Seam A - F009-T1)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit most Requestable Materials here are asked for in.
  let ream: string;

  const { unitNamed } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  const createRequestable = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, '/requestable-materials', payload, { 'x-retry-token': token });

  // A valid request: a unique name and the Request Unit รีม, unless `overrides` says otherwise.
  const base = (overrides: Record<string, unknown> = {}) => ({ name: `วัสดุขอเบิก ${crypto.randomUUID().slice(0, 8)}`, request_unit_id: ream, ...overrides });

  // A Requestable Material created with `overrides`, and its id.
  const created = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await createRequestable(base(overrides));
    expect(res.statusCode).toBe(201);
    return res.json().requestable_material_id;
  };

  // The Requestable Material page as `actor` reads it.
  const requestableOf = async (id: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/requestable-materials/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The list rows `actor` gets for `query`.
  const listed = async (query: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/requestable-materials?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // How many Requestable Materials exist, to show that a refused write saved nothing.
  const requestableCount = async (): Promise<number> => (await listed('limit=1')).total_count;

  // A refused request: its status and code, its message naming `field`, and nothing saved.
  const expectRefused = async (payload: Record<string, unknown>, field: string) => {
    const before = await requestableCount();
    const res = await createRequestable(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await requestableCount()).toBe(before);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_requestable', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_requestable', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_requestable', 'READ_ONLY');
    custodian = await api.actor('custodian_requestable', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_requestable', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_requestable', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('creating', () => {
    it('creates a Requestable Material with its own Stable ID, and its page shows every field and its history', async () => {
      const before = Date.now();

      const res = await createRequestable({ name: 'กระดาษ A4', request_unit_id: ream, whole_number_only: true, description: 'กระดาษถ่ายเอกสาร\nขนาด A4' });

      expect(res.statusCode).toBe(201);
      const { requestable_material_id: id, version } = res.json();
      expect(id).toMatch(UUID);
      expect(version).toBe(1);
      const page = await requestableOf(id);
      expect(page).toMatchObject({
        id,
        name: 'กระดาษ A4',
        request_unit: { unit_id: ream, name: 'รีม', unit_is_active: true },
        whole_number_only: true,
        description: 'กระดาษถ่ายเอกสาร\nขนาด A4',
        is_active: true,
        version: 1,
        created_by: officer.id,
        created_by_username: 'officer_requestable',
      });
      expect(page.history).toEqual([
        {
          version: 1,
          kind: 'CREATED',
          changes: [
            { field: 'name', before: null, after: 'กระดาษ A4' },
            { field: 'request_unit', before: null, after: { id: ream, name: 'รีม' } },
            { field: 'whole_number_only', before: null, after: true },
            { field: 'description', before: null, after: 'กระดาษถ่ายเอกสาร\nขนาด A4' },
          ],
          recorded_by: officer.id,
          recorded_by_username: 'officer_requestable',
          recorded_at: expect.any(String),
        },
      ]);
      expect(page.recorded_at).toBe(page.history[0].recorded_at);
      expect(Date.parse(page.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(page.recorded_at)).toBeLessThanOrEqual(Date.now());
    });

    it('makes a Requestable Material whole-number-only unless told otherwise (Q5)', async () => {
      const whole = await created();
      const fractional = await created({ whole_number_only: false });

      expect((await requestableOf(whole)).whole_number_only).toBe(true);
      expect((await requestableOf(fractional)).whole_number_only).toBe(false);
      expect((await requestableOf(fractional)).history[0].changes).toContainEqual({ field: 'whole_number_only', before: null, after: false });
    });

    it('needs no description: one left out or blank is none, and the history lists none', async () => {
      const left = await created();
      const blank = await created({ description: '  ' });

      for (const id of [left, blank]) {
        const page = await requestableOf(id);
        expect(page.description).toBeNull();
        expect(page.history[0].changes.map(({ field }: { field: string }) => field)).toEqual(['name', 'request_unit', 'whole_number_only']);
      }
    });

    it('needs a name that is not blank', async () => {
      const { name: _name, ...noName } = base();
      await expectRefused(noName, 'name');
      await expectRefused(base({ name: '   ' }), 'name must not be blank');
    });

    it('needs a Request Unit', async () => {
      const { request_unit_id: _unit, ...noUnit } = base();
      await expectRefused(noUnit, 'request_unit_id');
      await expectRefused(base({ request_unit_id: 'not-a-unit' }), 'request_unit_id must be a valid UUID');
    });

    it('needs a Request Unit that is on the Unit list and active (Q15)', async () => {
      await expectRefused(base({ request_unit_id: crypto.randomUUID() }), 'request_unit_id must name an active Unit');
      const retired = await unitNamed('ลัง (เลิกใช้แล้ว)');
      // Making a Unit Inactive (F008-T8), written where it is stored.
      await api.pool.query('UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', [retired]);
      await expectRefused(base({ request_unit_id: retired }), 'request_unit_id must name an active Unit');
    });

    it('takes no field it does not know, and a whole-number setting only as true or false', async () => {
      await expectRefused(base({ category: 'เครื่องเขียน' }), 'category');
      await expectRefused(base({ whole_number_only: 'yes' }), 'whole_number_only');
    });
  });

  describe('text (P7)', () => {
    it('takes a name of 200 characters and a description of 2000, and refuses one more', async () => {
      expect((await createRequestable(base({ name: `${text(191)}${crypto.randomUUID().slice(0, 9)}`, description: text(2000) }))).statusCode).toBe(201);
      await expectRefused(base({ name: text(201) }), 'name must be at most 200');
      await expectRefused(base({ description: text(2001) }), 'description must be at most 2000');
    });

    it('refuses any control character in the name, a line break at its end included', async () => {
      await expectRefused(base({ name: 'กระดาษ\tA4' }), 'name must not contain control characters');
      await expectRefused(base({ name: 'กระดาษ A4\n' }), 'name must not contain control characters');
    });

    it('keeps tab and line breaks inside the description, and refuses any other control character', async () => {
      const id = await created({ description: 'ขนาด A4\tสีขาว\r\nสำหรับถ่ายเอกสาร' });
      expect((await requestableOf(id)).description).toBe('ขนาด A4\tสีขาว\r\nสำหรับถ่ายเอกสาร');

      await expectRefused(base({ description: 'สีขาว\u0007' }), 'description must not contain control characters');
    });
  });

  describe('a name already used (Q6)', () => {
    it('refuses a name equal to another after ignoring case and repeated spaces, naming that Requestable Material, and saves nothing', async () => {
      const existing = await created({ name: 'Paper  Clip ใหญ่' });
      const before = await requestableCount();

      for (const name of ['Paper  Clip ใหญ่', 'paper clip ใหญ่', '  PAPER   CLIP  ใหญ่ ']) {
        const res = await createRequestable(base({ name }));
        expect(res.statusCode, name).toBe(409);
        expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id: existing, name: 'Paper  Clip ใหญ่', is_active: true, version: 1 } });
      }
      expect(await requestableCount()).toBe(before);
      // A name that differs otherwise is another Requestable Material.
      expect((await createRequestable(base({ name: 'PaperClip ใหญ่' }))).statusCode).toBe(201);
    });

    it('refuses the name of an Inactive Requestable Material too, saying it is Inactive so it can be reactivated', async () => {
      const retired = await created({ name: 'ซองจดหมายเลิกใช้' });
      // Making it Inactive (F009-T7), written where it is stored.
      await api.pool.query('UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', [retired]);

      const res = await createRequestable(base({ name: 'ซองจดหมายเลิกใช้' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id: retired, is_active: false, version: 2 } });
    });

    it('of two concurrent creates of one name, saves one and refuses the other naming it', async () => {
      const name = `ลวดเย็บ ${crypto.randomUUID().slice(0, 8)}`;

      const responses = await Promise.all([createRequestable(base({ name })), createRequestable(base({ name: name.toUpperCase() }))]);

      expect(responses.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      const saved = responses.find((res) => res.statusCode === 201)!.json().requestable_material_id;
      expect(responses.find((res) => res.statusCode === 409)!.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id: saved } });
    });
  });

  describe('history (Q17, #175 P6)', () => {
    it('keeps the Request Unit name as it was when recorded, while the page shows its name now', async () => {
      const box = await unitNamed('กลอ่งขอเบิก');
      const id = await created({ request_unit_id: box });
      // The rename of F008-T8, written where it is stored.
      await api.pool.query(`UPDATE units SET name = 'กล่องขอเบิก', version = version + 1 WHERE id = $1`, [box]);

      const page = await requestableOf(id);

      expect(page.request_unit).toEqual({ unit_id: box, name: 'กล่องขอเบิก', unit_is_active: true });
      expect(page.history[0].changes.find(({ field }: { field: string }) => field === 'request_unit').after).toEqual({ id: box, name: 'กลอ่งขอเบิก' });
    });

    it('keeps a Requestable Material whose Request Unit was later made Inactive in the list, showing that it is (Q15)', async () => {
      const bottle = await unitNamed('ขวดขอเบิก');
      const id = await created({ request_unit_id: bottle });
      await api.pool.query('UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', [bottle]);

      expect((await requestableOf(id)).request_unit).toEqual({ unit_id: bottle, name: 'ขวดขอเบิก', unit_is_active: false });
      expect((await listed(`search=${encodeURIComponent((await requestableOf(id)).name)}`)).items[0].request_unit.unit_is_active).toBe(false);
    });
  });

  // #203 decision comment 7041198954: the create reads its Request Unit FOR SHARE for the active-Unit rule and for the
  // name its history records, against the Unit's Inactive, reactivation and Rename (F008-T8).
  describe('concurrency', () => {
    it('waits for its Request Unit being made Inactive and then refuses it', async () => {
      const unit = await unitNamed('ม้วนขอเบิก');
      const before = await requestableCount();

      const [res] = await whileWriting(
        // What making a Unit Inactive writes (F008-T8), held uncommitted.
        { sql: 'UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', params: [unit] },
        () => [createRequestable(base({ request_unit_id: unit }))],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('request_unit_id must name an active Unit');
      expect(await requestableCount()).toBe(before);
    });

    it('waits for its Request Unit being reactivated and then takes it', async () => {
      const unit = await unitNamed('แพ็คขอเบิก');
      await api.pool.query('UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', [unit]);

      const [res] = await whileWriting(
        // What reactivating a Unit writes (F008-T8), held uncommitted.
        { sql: 'UPDATE units SET is_active = true, version = version + 1 WHERE id = $1', params: [unit] },
        () => [createRequestable(base({ request_unit_id: unit }))],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(201);
      expect((await requestableOf(res.json().requestable_material_id)).request_unit.unit_id).toBe(unit);
    });

    it('waits for its Request Unit being renamed and records the new name in the history', async () => {
      const unit = await unitNamed('ห่อขอเบิกเดิม');

      const [res] = await whileWriting(
        // What renaming a Unit writes (F008-T8), held uncommitted.
        { sql: `UPDATE units SET name = 'ห่อขอเบิกใหม่', version = version + 1 WHERE id = $1`, params: [unit] },
        () => [createRequestable(base({ request_unit_id: unit }))],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(201);
      const page = await requestableOf(res.json().requestable_material_id);
      expect(page.history[0].changes.find(({ field }: { field: string }) => field === 'request_unit').after).toEqual({ id: unit, name: 'ห่อขอเบิกใหม่' });
    });
  });

  describe('the list', () => {
    it('lists each Requestable Material with its Request Unit, whole-number setting and status', async () => {
      const box = await unitNamed('กล่องรายการขอเบิก');
      const id = await created({ name: 'หมึกพิมพ์ขอเบิก รายการ', request_unit_id: box, whole_number_only: false, description: 'สีดำ' });

      const { items } = await listed(`search=${encodeURIComponent('หมึกพิมพ์ขอเบิก รายการ')}`);

      expect(items).toEqual([{ id, name: 'หมึกพิมพ์ขอเบิก รายการ', request_unit: { unit_id: box, name: 'กล่องรายการขอเบิก', unit_is_active: true }, whole_number_only: false, is_active: true }]);
    });

    it('searches the name ignoring case and repeated spaces, and not the description', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const spaced = await created({ name: `Blue  Pen ${tag}` });
      const plain = await created({ name: `blue pen ${tag} แท่ง` });
      await created({ name: `ปากกาแดง ${tag}x`, description: `blue pen ${tag}` });

      const found = await listed(`search=${encodeURIComponent(`BLUE   PEN ${tag}`)}&limit=100`);

      expect(found.items.map(({ id }: { id: string }) => id).sort()).toEqual([spaced, plain].sort());
      expect(found.total_count).toBe(2);
    });

    it('treats % and _ in a search as text', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const percent = await created({ name: `น้ำยา 100% ${tag}` });
      await created({ name: `น้ำยา 1000 ${tag}` });

      expect((await listed(`search=${encodeURIComponent(`100% ${tag}`)}`)).items.map(({ id }: { id: string }) => id)).toEqual([percent]);
      expect((await listed(`search=${encodeURIComponent(`_ ${tag}`)}`)).items).toEqual([]);
    });

    // requestable_materials_name_unique refuses two names equal ignoring case (Q6), so the order by name has no tie
    // and the list keeps no tiebreak (CODING_STANDARDS.md).
    it('pages the list by name ignoring case', async () => {
      const tag = `order ${crypto.randomUUID().slice(0, 8)}`;
      const lowerB = await created({ name: `${tag} b` });
      const upperC = await created({ name: `${tag} C` });
      const upperA = await created({ name: `${tag} A` });

      const pages = await Promise.all([0, 1, 2].map((offset) => listed(`search=${encodeURIComponent(tag)}&limit=1&offset=${offset}`)));

      expect(pages.map(({ items }) => items[0].id)).toEqual([upperA, lowerB, upperC]);
      expect(pages[0]).toMatchObject({ limit: 1, offset: 0, total_count: 3, has_more: true });
      expect(pages[2]).toMatchObject({ offset: 2, total_count: 3, has_more: false });
      expect(await listed(`search=${encodeURIComponent(tag)}&offset=5`)).toMatchObject({ items: [], total_count: 3, has_more: false });
    });

    it('answers 25 rows from the first by default', async () => {
      expect(await listed('')).toMatchObject({ limit: 25, offset: 0 });
    });

    it('refuses a query it does not take: a page past 100, a blank or overlong search, a control character, or a field it does not know', async () => {
      for (const [query, message] of [
        ['limit=101', 'limit: must be between 1 and 100'],
        ['search=%20%20', 'search: must not be blank'],
        [`search=${text(201)}`, 'search: must be at most 200'],
        ['search=a%09b', 'search: must not contain control characters'],
        ['category=x', 'category'],
      ]) {
        const res = await api.get(readonly, `/requestable-materials?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(message) });
      }
    });

    it('tells the list whether the viewer may add a Requestable Material, which follows material:manage alone', async () => {
      expect((await listed('limit=1', officer)).can_manage).toBe(true);
      for (const viewer of [admin, readonly]) {
        expect((await listed('limit=1', viewer)).can_manage).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, '/requestable-materials?limit=1'));
      expect(denied.json().can_manage).toBe(false);
    });
  });

  describe('the page', () => {
    it('answers 404 for a Requestable Material that does not exist, and 400 for an id that is not one', async () => {
      const missing = await api.get(readonly, `/requestable-materials/${crypto.randomUUID()}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');
      const res = await api.get(readonly, '/requestable-materials/not-an-id');
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_ID');
    });

    it('tells the page whether the viewer may change the Requestable Material, which follows material:manage alone', async () => {
      const id = await created();

      expect((await requestableOf(id, officer)).can_manage).toBe(true);
      for (const viewer of [admin, readonly]) {
        expect((await requestableOf(id, viewer)).can_manage).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, `/requestable-materials/${id}`));
      expect(denied.json().can_manage).toBe(false);
    });
  });

  describe('permissions (Q18, P9)', () => {
    it('lets the Supply Officer, the Administrator and the Read-only User read the list and the page, and no one else', async () => {
      const id = await created({ name: 'ผงซักฟอกขอเบิกที่ทุกคนไม่ควรเห็น' });
      const urls = [`/requestable-materials?search=${encodeURIComponent('ผงซักฟอกขอเบิก')}`, `/requestable-materials/${id}`];

      for (const viewer of [officer, admin, readonly]) {
        for (const url of urls) {
          const res = await api.get(viewer, url);
          expect(res.statusCode).toBe(200);
          expect(res.body).toContain('ผงซักฟอกขอเบิก');
        }
      }
      for (const other of [custodian, staff, maintainer]) {
        for (const url of urls) {
          const res = await api.get(other, url);
          expect(res.statusCode).toBe(403);
          expect(res.body).not.toContain('ผงซักฟอกขอเบิก');
        }
      }
      for (const url of urls) {
        const anonymous = await api.app.inject({ method: 'GET', url });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.body).not.toContain(id);
      }
    });

    // The Administrator holds asset:view too, so a gate on another capability would let them through.
    it('needs material:view itself to read, and fails closed when the lookup fails', async () => {
      const id = await created({ name: 'น้ำยาล้างจานขอเบิกที่ไม่ควรเห็น' });

      for (const url of [`/requestable-materials?search=${encodeURIComponent('น้ำยาล้างจานขอเบิก')}`, `/requestable-materials/${id}`]) {
        expect((await api.get(admin, url)).body).toContain('น้ำยาล้างจานขอเบิก');
        const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(admin, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('น้ำยาล้างจานขอเบิก');
        const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(admin, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('น้ำยาล้างจานขอเบิก');
      }
    });

    it('lets only the Supply Officer create a Requestable Material', async () => {
      const before = await requestableCount();
      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await createRequestable(base(), crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await requestableCount()).toBe(before);
    });

    it('needs material:manage itself to create, and fails closed when the lookup fails, saving nothing', async () => {
      const before = await requestableCount();
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => createRequestable(base()))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => createRequestable(base()));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await requestableCount()).toBe(before);
    });

    it('needs a session and the CSRF token to create, and an inactive user is refused', async () => {
      const before = await requestableCount();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: '/requestable-materials', headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: base() });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('officer_inactive_requestable', 'SUPPLY_OFFICER');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await createRequestable(base(), crypto.randomUUID(), leaving)).statusCode);
      expect(await requestableCount()).toBe(before);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const before = await requestableCount();
      const res = await api.post(officer, '/requestable-materials', base());
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      expect(await requestableCount()).toBe(before);
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const token = crypto.randomUUID();
      const payload = base();
      const first = await createRequestable(payload, token);
      expect(first.statusCode).toBe(201);
      const before = await requestableCount();

      const replay = await createRequestable(payload, token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await requestableCount()).toBe(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const token = crypto.randomUUID();
      const payload = base({ description: 'เดิม' });
      expect((await createRequestable(payload, token)).statusCode).toBe(201);
      const before = await requestableCount();
      const other = await unitNamed();

      for (const changed of [{ name: `${payload.name} ใหม่` }, { request_unit_id: other }, { whole_number_only: false }, { description: 'ใหม่' }]) {
        const res = await createRequestable({ ...payload, ...changed }, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await requestableCount()).toBe(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_requestable_two', 'SUPPLY_OFFICER');
      const token = crypto.randomUUID();
      const mine = await createRequestable(base(), token);
      const theirs = await createRequestable(base(), token, otherOfficer);

      expect(theirs.statusCode).toBe(201);
      expect(theirs.json().requestable_material_id).not.toBe(mine.json().requestable_material_id);
    });

    it('scopes a token to its operation: the same actor\'s token from another write creates anew', async () => {
      const token = crypto.randomUUID();
      expect((await api.post(officer, '/units', { name: `หน่วยโทเค็น ${crypto.randomUUID().slice(0, 8)}` }, { 'x-retry-token': token })).statusCode).toBe(201);
      const before = await requestableCount();

      const res = await createRequestable(base(), token);

      expect(res.statusCode).toBe(201);
      expect(res.json().requestable_material_id).toMatch(UUID);
      expect(await requestableCount()).toBe(before + 1);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const token = crypto.randomUUID();
      const payload = base();
      const before = await requestableCount();

      const responses = await Promise.all(Array.from({ length: 8 }, () => createRequestable(payload, token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().requestable_material_id)).size).toBe(1);
      expect(await requestableCount()).toBe(before + 1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const unit = await unitNamed('โหลพักขอเบิก');
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [unit]);
      const token = crypto.randomUUID();
      const payload = base({ request_unit_id: unit });
      expect((await createRequestable(payload, token)).statusCode).toBe(400);
      await api.pool.query('UPDATE units SET is_active = true WHERE id = $1', [unit]);

      expect((await createRequestable(payload, token)).statusCode).toBe(201);
    });
  });
});
