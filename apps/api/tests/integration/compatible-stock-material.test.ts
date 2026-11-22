import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// F009-T2 (#204): the Compatible Stock Materials (วัสดุที่ใช้จ่ายได้) a Supply Officer confirms for a Requestable
// Material, and whether it is offered to Requesters (#202 MRQ-15, MRQ-26, MRQ-27, MRQ-28, MRQ-30, MC-14, Q7, Q8, Q9,
// P1, P10, ADR 0002; start decisions, #204 comment 7075904252).
describe('Compatible Stock Material (Seam A - F009-T2)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit most Requestable Materials here are asked for in.
  let ream: string;

  const helpers = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed } = helpers;
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A Requestable Material asked for in `requestUnit`, and its id.
  const requestableIn = async (requestUnit: string = ream, name = `วัสดุขอเบิก ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await api.post(officer, '/requestable-materials', { name, request_unit_id: requestUnit }, { 'x-retry-token': crypto.randomUUID() });
    expect(res.statusCode).toBe(201);
    return res.json().requestable_material_id;
  };

  // A Stock Material whose Base Unit is `baseUnit`, named `name` or uniquely, and its id.
  const stockMaterialIn = (baseUnit: string, overrides: Record<string, unknown> = {}) => helpers.created({ base_unit: { unit_id: baseUnit }, ...overrides });

  // The Requestable Material page as `actor` reads it.
  const requestableOf = async (id: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/requestable-materials/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // Adds the Stock Material `stockMaterialId` as a Compatible Stock Material of `requestableId`, at `version` or the
  // version the page has now.
  const add = async (requestableId: string, stockMaterialId: string, { version, token = crypto.randomUUID(), actor = officer }: { version?: number; token?: string; actor?: Actor } = {}) =>
    api.post(
      actor,
      `/requestable-materials/${requestableId}/compatible-stock-materials`,
      { stock_material_id: stockMaterialId, expected_version: version ?? (await requestableOf(requestableId)).version },
      { 'x-retry-token': token }
    );

  // Ends the Compatible Stock Material `stockMaterialId` of `requestableId`, at `version` or the version the page has now.
  const end = async (requestableId: string, stockMaterialId: string, { version, token = crypto.randomUUID(), actor = officer }: { version?: number; token?: string; actor?: Actor } = {}) =>
    api.post(
      actor,
      `/requestable-materials/${requestableId}/compatible-stock-materials/${stockMaterialId}/end`,
      { expected_version: version ?? (await requestableOf(requestableId)).version },
      { 'x-retry-token': token }
    );

  // The Stock Materials of the page's Compatible Stock Materials, in its order, each with whether it is current.
  const pairsOf = async (id: string) => (await requestableOf(id)).compatible_stock_materials.map(({ stock_material_id, is_current }: any) => ({ stock_material_id, is_current }));

  // A Stock Material with the Base Unit `baseUnit` and the Alternate Unit `alternate`, active unless told otherwise.
  const stockMaterialWithAlternate = async (baseUnit: string, alternate: string, { isActive = true }: { isActive?: boolean } = {}): Promise<string> => {
    const id = await stockMaterialIn(baseUnit);
    const write = helpers.unitsAsRead(await helpers.materialOf(id));
    const res = await helpers.replaceUnits(id, { ...write, alternate_units: [{ unit_id: alternate, conversion_factor: '500', whole_number_only: true, is_active: isActive }] });
    expect(res.json()).toMatchObject({ version: 2 });
    return id;
  };

  // How many history entries the Requestable Material `id` has, to show that a refused write recorded nothing.
  const historyCount = async (id: string): Promise<number> => (await requestableOf(id)).history.length;

  // A refused add: its status and code, its message naming `reason`, and nothing written.
  const expectAddRefused = async (requestable: string, stockMaterial: string, reason: string) => {
    const before = await requestableOf(requestable);
    const res = await add(requestable, stockMaterial);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(reason) });
    const after = await requestableOf(requestable);
    expect(after.version).toBe(before.version);
    expect(after.history).toEqual(before.history);
    expect(after.compatible_stock_materials).toEqual(before.compatible_stock_materials);
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_compatible', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_compatible', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_compatible', 'READ_ONLY');
    custodian = await api.actor('custodian_compatible', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_compatible', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_compatible', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('adding', () => {
    it('adds a Stock Material whose Base Unit is the Request Unit, and the page lists it current with its name, status and Units', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream, { name: 'กระดาษถ่ายเอกสาร A4 80 แกรม' });

      const res = await add(requestable, paper, { version: 1 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: requestable, version: 2 });
      const page = await requestableOf(requestable);
      expect(page.version).toBe(2);
      expect(page.compatible_stock_materials).toEqual([
        {
          stock_material_id: paper,
          name: 'กระดาษถ่ายเอกสาร A4 80 แกรม',
          is_active: true,
          is_current: true,
          units: [{ unit_id: ream, name: 'รีม', unit_is_active: true, is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true }],
        },
      ]);
    });

    it('records the add in the history with the Stock Material under its name then, by whom and when', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream, { name: 'กระดาษสำหรับประวัติ' });

      expect((await add(requestable, paper)).statusCode).toBe(200);

      const entry = (await requestableOf(requestable)).history[1];
      expect(entry).toMatchObject({
        version: 2,
        kind: 'COMPATIBLE_STOCK_MATERIAL_ADDED',
        changes: [{ field: 'compatible_stock_material', before: null, after: { id: paper, name: 'กระดาษสำหรับประวัติ' } }],
        recorded_by: officer.id,
        recorded_by_username: 'officer_compatible',
      });
      expect(Date.now() - Date.parse(entry.recorded_at)).toBeLessThan(60_000);
    });

    it('adds a Stock Material whose active Alternate Unit is the Request Unit (ADR 0002)', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialWithAlternate(await unitNamed(), ream);

      expect((await add(requestable, paper)).statusCode).toBe(200);
      expect((await requestableOf(requestable)).compatible_stock_materials.map(({ stock_material_id }: any) => stock_material_id)).toEqual([paper]);
    });

    it('refuses a Stock Material that lacks the Request Unit, naming the reason (MRQ-28, Q7)', async () => {
      const requestable = await requestableIn();
      await expectAddRefused(requestable, await stockMaterialIn(await unitNamed()), 'do not include the Request Unit');
    });

    it('refuses a Stock Material whose Alternate Unit that is the Request Unit is Inactive', async () => {
      const requestable = await requestableIn();
      await expectAddRefused(requestable, await stockMaterialWithAlternate(await unitNamed(), ream, { isActive: false }), 'do not include the Request Unit');
    });

    it('refuses an Inactive Stock Material, naming the reason (Q8, MC-14)', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await helpers.inactivate(paper, { expected_version: (await helpers.materialOf(paper)).version })).statusCode).toBe(200);

      await expectAddRefused(requestable, paper, 'Inactive Stock Material');
    });

    it('refuses a Stock Material that does not exist, and an id that is not one', async () => {
      const requestable = await requestableIn();
      await expectAddRefused(requestable, crypto.randomUUID(), 'stock_material_id must name a Stock Material');
      await expectAddRefused(requestable, 'not-a-uuid', 'stock_material_id must be a valid UUID');
    });

    it('refuses a pair already current, naming the reason', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await add(requestable, paper)).statusCode).toBe(200);

      await expectAddRefused(requestable, paper, 'already a current Compatible Stock Material');
    });

    it('answers 404 for a Requestable Material that does not exist, and 400 for an id that is not one', async () => {
      const paper = await stockMaterialIn(ream);
      const missing = await add(crypto.randomUUID(), paper, { version: 1 });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Requestable Material not found' });
      expect((await add('not-a-uuid', paper, { version: 1 })).json().code).toBe('INVALID_ID');
    });

    it('takes no field it does not know, and needs the expected version', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      const post = (payload: Record<string, unknown>) =>
        api.post(officer, `/requestable-materials/${requestable}/compatible-stock-materials`, payload, { 'x-retry-token': crypto.randomUUID() });

      expect((await post({ stock_material_id: paper, expected_version: 1, is_current: false })).statusCode).toBe(400);
      expect((await post({ stock_material_id: paper })).json().message).toContain('expected_version');
      expect(await historyCount(requestable)).toBe(1);
    });
  });

  describe('ending and adding again (P1)', () => {
    it('ends a current one, which stays listed as ended, and records the end with the Stock Material under its name then', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream, { name: 'กระดาษที่เลิก' });
      expect((await add(requestable, paper)).statusCode).toBe(200);

      const res = await end(requestable, paper, { version: 2 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: requestable, version: 3 });
      const page = await requestableOf(requestable);
      expect(page.compatible_stock_materials).toMatchObject([{ stock_material_id: paper, name: 'กระดาษที่เลิก', is_active: true, is_current: false }]);
      expect(page.history[2]).toMatchObject({
        version: 3,
        kind: 'COMPATIBLE_STOCK_MATERIAL_ENDED',
        changes: [{ field: 'compatible_stock_material', before: { id: paper, name: 'กระดาษที่เลิก' }, after: null }],
        recorded_by: officer.id,
      });
    });

    it('adds an ended one again as the same pair, current again, with each change in the history', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await add(requestable, paper)).statusCode).toBe(200);
      expect((await end(requestable, paper)).statusCode).toBe(200);

      expect((await add(requestable, paper)).statusCode).toBe(200);

      const page = await requestableOf(requestable);
      expect(await pairsOf(requestable)).toEqual([{ stock_material_id: paper, is_current: true }]);
      expect(page.history.map(({ kind }: any) => kind)).toEqual(['CREATED', 'COMPATIBLE_STOCK_MATERIAL_ADDED', 'COMPATIBLE_STOCK_MATERIAL_ENDED', 'COMPATIBLE_STOCK_MATERIAL_ADDED']);
    });

    it('lists the current ones first, each part by name', async () => {
      const requestable = await requestableIn();
      const [b, a, d, c] = await Promise.all(['ข กระดาษ', 'ก กระดาษ', 'ง กระดาษ', 'ค กระดาษ'].map((name) => stockMaterialIn(ream, { name: `${name} ${crypto.randomUUID().slice(0, 4)}` })));
      for (const paper of [b, a, d, c]) {
        expect((await add(requestable, paper)).statusCode).toBe(200);
      }
      for (const paper of [d, b]) {
        expect((await end(requestable, paper)).statusCode).toBe(200);
      }

      expect(await pairsOf(requestable)).toEqual([
        { stock_material_id: a, is_current: true },
        { stock_material_id: c, is_current: true },
        { stock_material_id: b, is_current: false },
        { stock_material_id: d, is_current: false },
      ]);
    });

    it('refuses to end one already ended, writing nothing (#204 start decision 1)', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await add(requestable, paper)).statusCode).toBe(200);
      expect((await end(requestable, paper)).statusCode).toBe(200);
      const before = await requestableOf(requestable);

      const res = await end(requestable, paper);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('not a current Compatible Stock Material') });
      expect(await requestableOf(requestable)).toEqual(before);
    });

    it('answers 404 for a pair never added and for a Requestable Material that does not exist, and 400 for an id that is not one', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);

      const neverAdded = await end(requestable, paper);
      expect(neverAdded.statusCode).toBe(404);
      expect(neverAdded.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Compatible Stock Material not found' });
      const missing = await end(crypto.randomUUID(), paper, { version: 1 });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Requestable Material not found' });
      expect((await end('not-a-uuid', paper, { version: 1 })).json().code).toBe('INVALID_ID');
      expect((await end(requestable, 'not-a-uuid')).json().code).toBe('INVALID_ID');
      expect(await historyCount(requestable)).toBe(1);
    });

    it('ends one whose Stock Material went Inactive', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await add(requestable, paper)).statusCode).toBe(200);
      expect((await helpers.inactivate(paper, { expected_version: (await helpers.materialOf(paper)).version })).statusCode).toBe(200);

      expect((await end(requestable, paper)).statusCode).toBe(200);
      expect(await pairsOf(requestable)).toEqual([{ stock_material_id: paper, is_current: false }]);
    });
  });

  describe('many-to-many (MRQ-27) and Inactive (MC-14)', () => {
    it('lets one Stock Material fulfil several Requestable Materials and one Requestable Material have several Stock Materials', async () => {
      const [first, second] = [await requestableIn(), await requestableIn()];
      const [paper, otherPaper] = [await stockMaterialIn(ream, { name: 'ก กระดาษร่วม' }), await stockMaterialIn(ream, { name: 'ข กระดาษร่วม' })];

      for (const [requestable, stockMaterial] of [[first, paper], [first, otherPaper], [second, paper]]) {
        expect((await add(requestable, stockMaterial)).statusCode).toBe(200);
      }
      expect((await end(second, paper)).statusCode).toBe(200);

      expect(await pairsOf(first)).toEqual([
        { stock_material_id: paper, is_current: true },
        { stock_material_id: otherPaper, is_current: true },
      ]);
      expect(await pairsOf(second)).toEqual([{ stock_material_id: paper, is_current: false }]);
    });

    it('keeps a Stock Material compatible when it goes Inactive, showing that it is', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await add(requestable, paper)).statusCode).toBe(200);
      const versionBefore = (await requestableOf(requestable)).version;

      expect((await helpers.inactivate(paper, { expected_version: (await helpers.materialOf(paper)).version })).statusCode).toBe(200);

      const page = await requestableOf(requestable);
      expect(page.compatible_stock_materials).toMatchObject([{ stock_material_id: paper, is_active: false, is_current: true }]);
      expect(page.version).toBe(versionBefore);
    });
  });

  describe('stale version (Q17)', () => {
    it('refuses an add or an end based on an older version with the current one, writing nothing', async () => {
      const requestable = await requestableIn();
      const [paper, otherPaper] = [await stockMaterialIn(ream), await stockMaterialIn(ream)];
      expect((await add(requestable, paper)).statusCode).toBe(200);
      const before = await requestableOf(requestable);

      for (const res of [await add(requestable, otherPaper, { version: 1 }), await end(requestable, paper, { version: 1 })]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      }
      expect(await requestableOf(requestable)).toEqual(before);
    });
  });

  describe('offered (Q9, P10)', () => {
    // Whether the list row and the page say the Requestable Material `id` is offered, which they must agree on.
    const offeredOf = async (id: string): Promise<boolean> => {
      const page = await requestableOf(id);
      const res = await api.get(readonly, `/requestable-materials?search=${encodeURIComponent(page.name)}`);
      expect(res.statusCode).toBe(200);
      const row = res.json().items.find((item: any) => item.id === id);
      expect(row.is_offered).toBe(page.is_offered);
      return page.is_offered;
    };

    it('is not offered with No Compatible Stock Material, is once one is added, and is not once the last is ended', async () => {
      const requestable = await requestableIn();
      const [paper, otherPaper] = [await stockMaterialIn(ream), await stockMaterialIn(ream)];
      expect(await offeredOf(requestable)).toBe(false);

      expect((await add(requestable, paper)).statusCode).toBe(200);
      expect(await offeredOf(requestable)).toBe(true);
      expect((await add(requestable, otherPaper)).statusCode).toBe(200);
      expect((await end(requestable, paper)).statusCode).toBe(200);
      expect(await offeredOf(requestable)).toBe(true);
      expect((await end(requestable, otherPaper)).statusCode).toBe(200);
      expect(await offeredOf(requestable)).toBe(false);
    });

    it('stays offered while its only Compatible Stock Material is Inactive', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      expect((await add(requestable, paper)).statusCode).toBe(200);
      expect((await helpers.inactivate(paper, { expected_version: (await helpers.materialOf(paper)).version })).statusCode).toBe(200);

      expect(await offeredOf(requestable)).toBe(true);
    });

    it('is not offered while Inactive, even with a current Compatible Stock Material', async () => {
      const requestable = await requestableIn();
      expect((await add(requestable, await stockMaterialIn(ream))).statusCode).toBe(200);
      // What making a Requestable Material Inactive will write (F009-T7).
      await api.pool.query('UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', [requestable]);

      expect(await offeredOf(requestable)).toBe(false);
    });
  });

  describe('the Stock Materials to choose from (Q19, ADR 0002)', () => {
    // The choices `actor` gets for the Requestable Material `id` with `query`.
    const choicesOf = (id: string, query: string, actor: Actor = officer) => api.get(actor, `/requestable-materials/${id}/stock-material-choices?${query}`);

    it('lists the active Stock Materials matching a search by name, each saying whether its active Units include the Request Unit', async () => {
      const tag = `เลือก${crypto.randomUUID().slice(0, 6)}`;
      const requestable = await requestableIn();
      const other = await unitNamed();
      const base = await stockMaterialIn(ream, { name: `ก ${tag} หน่วยหลัก` });
      const alternate = await stockMaterialWithAlternate(other, ream);
      await api.pool.query('UPDATE stock_materials SET name = $2 WHERE id = $1', [alternate, `ข ${tag} หน่วยอื่น`]);
      const inactiveAlternate = await stockMaterialWithAlternate(other, ream, { isActive: false });
      await api.pool.query('UPDATE stock_materials SET name = $2 WHERE id = $1', [inactiveAlternate, `ค ${tag} หน่วยอื่นหยุดใช้`]);
      const lacking = await stockMaterialIn(other, { name: `ง ${tag} ไม่มีรีม` });
      const inactive = await stockMaterialIn(ream, { name: `จ ${tag} หยุดใช้` });
      expect((await helpers.inactivate(inactive, { expected_version: (await helpers.materialOf(inactive)).version })).statusCode).toBe(200);

      const res = await choicesOf(requestable, `search=${encodeURIComponent(tag)}`);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.map(({ id, handles_request_unit }: any) => ({ id, handles_request_unit }))).toEqual([
        { id: base, handles_request_unit: true },
        { id: alternate, handles_request_unit: true },
        { id: inactiveAlternate, handles_request_unit: false },
        { id: lacking, handles_request_unit: false },
      ]);
      expect(body.items[0]).toMatchObject({ name: `ก ${tag} หน่วยหลัก`, is_active: true, base_unit: { unit_id: ream, name: 'รีม' } });
      expect(body).toMatchObject({ total_count: 4, has_more: false, limit: 25, offset: 0 });
    });

    it('lists a Stock Material already compatible too, and creates no compatibility from a name (MRQ-15, MRQ-26)', async () => {
      const tag = `ชื่อเหมือน${crypto.randomUUID().slice(0, 6)}`;
      const requestable = await requestableIn(ream, `${tag} ขอเบิก`);
      const paper = await stockMaterialIn(ream, { name: `${tag} ขอเบิก` });

      const choices = (await choicesOf(requestable, `search=${encodeURIComponent(tag)}`)).json();

      expect(choices.items.map(({ id }: any) => id)).toEqual([paper]);
      expect((await requestableOf(requestable)).compatible_stock_materials).toEqual([]);
      expect((await requestableOf(requestable)).is_offered).toBe(false);
    });

    it('pages the choices by name', async () => {
      const tag = `หน้า${crypto.randomUUID().slice(0, 6)}`;
      const requestable = await requestableIn();
      const ids = [];
      for (const name of ['ก', 'ข', 'ค']) {
        ids.push(await stockMaterialIn(ream, { name: `${name} ${tag}` }));
      }

      const second = (await choicesOf(requestable, `search=${encodeURIComponent(tag)}&limit=2&offset=2`)).json();

      expect(second.items.map(({ id }: any) => id)).toEqual([ids[2]]);
      expect(second).toMatchObject({ total_count: 3, has_more: false, limit: 2, offset: 2 });
    });

    it('answers 404 for a Requestable Material that does not exist, 400 for an id that is not one, and refuses a query it does not take', async () => {
      const requestable = await requestableIn();
      expect((await choicesOf(crypto.randomUUID(), '')).statusCode).toBe(404);
      expect((await choicesOf('not-a-uuid', '')).json().code).toBe('INVALID_ID');
      for (const [query, rule] of [
        ['limit=101', 'limit: must be between 1 and 100'],
        ['search=%20', 'search: must not be blank'],
        ['status=all', 'Unrecognized key'],
      ]) {
        const res = await choicesOf(requestable, query);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain(rule);
      }
    });
  });

  describe('retry token', () => {
    it('needs a token to add or end', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      const url = `/requestable-materials/${requestable}/compatible-stock-materials`;

      for (const res of [
        await api.post(officer, url, { stock_material_id: paper, expected_version: 1 }),
        await api.post(officer, `${url}/${paper}/end`, { expected_version: 1 }),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('retry token');
      }
      expect(await historyCount(requestable)).toBe(1);
    });

    it('answers an identical replay of an add or an end with the committed result and writes nothing', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      for (const write of [add, end]) {
        const token = crypto.randomUUID();
        const version = (await requestableOf(requestable)).version;
        const first = await write(requestable, paper, { version, token });
        expect(first.statusCode).toBe(200);
        const before = await requestableOf(requestable);

        const replay = await write(requestable, paper, { version, token });

        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(first.json());
        expect(await requestableOf(requestable)).toEqual(before);
      }
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const [requestable, otherRequestable] = [await requestableIn(), await requestableIn()];
      const [paper, otherPaper] = [await stockMaterialIn(ream), await stockMaterialIn(ream)];
      const addToken = crypto.randomUUID();
      expect((await add(requestable, paper, { version: 1, token: addToken })).statusCode).toBe(200);
      const endToken = crypto.randomUUID();
      expect((await end(requestable, paper, { version: 2, token: endToken })).statusCode).toBe(200);
      const before = await requestableOf(requestable);

      for (const res of [
        await add(requestable, otherPaper, { version: 1, token: addToken }),
        await add(requestable, paper, { version: 3, token: addToken }),
        await add(otherRequestable, paper, { version: 1, token: addToken }),
        await end(requestable, otherPaper, { version: 2, token: endToken }),
        await end(requestable, paper, { version: 3, token: endToken }),
        await end(otherRequestable, paper, { version: 1, token: endToken }),
      ]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await requestableOf(requestable)).toEqual(before);
      expect(await historyCount(otherRequestable)).toBe(1);
    });

    it('scopes a token to its operation: an add\'s token carries an end anew', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream);
      const token = crypto.randomUUID();
      expect((await add(requestable, paper, { version: 1, token })).statusCode).toBe(200);

      const res = await end(requestable, paper, { version: 2, token });

      expect(res.json()).toEqual({ requestable_material_id: requestable, version: 3 });
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_compatible_two', 'SUPPLY_OFFICER');
      const [requestable, paper, otherPaper] = [await requestableIn(), await stockMaterialIn(ream), await stockMaterialIn(ream)];
      const token = crypto.randomUUID();
      expect((await add(requestable, paper, { version: 1, token })).statusCode).toBe(200);

      const theirs = await add(requestable, otherPaper, { version: 2, token, actor: otherOfficer });

      expect(theirs.json()).toEqual({ requestable_material_id: requestable, version: 3 });
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialWithAlternate(await unitNamed(), ream, { isActive: false });
      const token = crypto.randomUUID();
      expect((await add(requestable, paper, { version: 1, token })).statusCode).toBe(400);
      await api.pool.query('UPDATE stock_material_units SET is_active = true WHERE stock_material_id = $1', [paper]);

      expect((await add(requestable, paper, { version: 1, token })).statusCode).toBe(200);
    });
  });

  describe('permissions (Q18, P9)', () => {
    it('lets the Supply Officer, the Administrator and the Read-only User read the Compatible Stock Materials, and no one else', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(ream, { name: 'กระดาษที่ทุกคนไม่ควรเห็น' });
      expect((await add(requestable, paper)).statusCode).toBe(200);
      const url = `/requestable-materials/${requestable}`;

      for (const viewer of [officer, admin, readonly]) {
        const res = await api.get(viewer, url);
        expect(res.statusCode).toBe(200);
        expect(res.json().compatible_stock_materials[0].name).toBe('กระดาษที่ทุกคนไม่ควรเห็น');
      }
      for (const other of [custodian, staff, maintainer]) {
        const res = await api.get(other, url);
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain('กระดาษที่ทุกคนไม่ควรเห็น');
      }
    });

    it('lets only the Supply Officer choose, add and end, writing nothing for anyone else', async () => {
      const requestable = await requestableIn();
      const [paper, otherPaper] = [await stockMaterialIn(ream, { name: 'กระดาษเฉพาะเจ้าหน้าที่' }), await stockMaterialIn(ream)];
      expect((await add(requestable, paper)).statusCode).toBe(200);
      const before = await requestableOf(requestable);

      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const choices = await api.get(other, `/requestable-materials/${requestable}/stock-material-choices?search=${encodeURIComponent('กระดาษเฉพาะเจ้าหน้าที่')}`);
        expect(choices.statusCode).toBe(403);
        expect(choices.body).not.toContain('กระดาษเฉพาะเจ้าหน้าที่');
        for (const res of [await add(requestable, otherPaper, { version: 2, actor: other }), await end(requestable, paper, { version: 2, actor: other })]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        }
      }
      expect(await requestableOf(requestable)).toEqual(before);
    });

    // The Supply Officer holds material:view too, so a gate on it would let them through.
    it('needs material:manage itself to choose, add and end, and fails closed when the lookup fails, writing nothing', async () => {
      const requestable = await requestableIn();
      const [paper, otherPaper] = [await stockMaterialIn(ream, { name: 'กระดาษที่ต้องจัดการได้' }), await stockMaterialIn(ream)];
      expect((await add(requestable, paper)).statusCode).toBe(200);
      const before = await requestableOf(requestable);
      const requests = [
        () => api.get(officer, `/requestable-materials/${requestable}/stock-material-choices?search=${encodeURIComponent('กระดาษที่ต้องจัดการได้')}`),
        () => add(requestable, otherPaper, { version: 2 }),
        () => end(requestable, paper, { version: 2 }),
      ];

      for (const request of requests) {
        const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, request);
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('กระดาษที่ต้องจัดการได้');
        const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, request);
        expect(failed.statusCode).toBe(500);
        expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      }
      expect(await requestableOf(requestable)).toEqual(before);
    });

    it('needs a session and the CSRF token to add or end, and an inactive user is refused', async () => {
      const requestable = await requestableIn();
      const [paper, otherPaper] = [await stockMaterialIn(ream), await stockMaterialIn(ream)];
      expect((await add(requestable, paper)).statusCode).toBe(200);
      const before = await requestableOf(requestable);
      const url = `/requestable-materials/${requestable}/compatible-stock-materials`;
      const writes = [
        { url, payload: { stock_material_id: otherPaper, expected_version: 2 } },
        { url: `${url}/${paper}/end`, payload: { expected_version: 2 } },
      ];
      const leaving = await api.actor('officer_inactive_compatible', 'SUPPLY_OFFICER');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);

      for (const write of writes) {
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method: 'POST', url: write.url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: write.payload });
        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
        expect([401, 403]).toContain((await api.post(leaving, write.url, write.payload, { 'x-retry-token': crypto.randomUUID() })).statusCode);
      }
      const anonymous = await api.app.inject({ method: 'GET', url: `/requestable-materials/${requestable}/stock-material-choices` });
      expect(anonymous.statusCode).toBe(401);
      expect(await requestableOf(requestable)).toEqual(before);
    });
  });

  // Each rule an add or an end reads under a lock, queued behind a write that changes it (CODING_STANDARDS, "A rule
  // read under a lock has a test of its order"; the plan in #204 comment 7075904252). Each held statement is what that
  // write writes, and each queued write expects the version the held one leaves, so only the rule under test decides.
  describe('concurrency', () => {
    // What a Units write writes to the Unit `unitId` of the Stock Material `$1` (F008-T3): it locks the Stock Material
    // FOR UPDATE first.
    const unitsWrite = (change: string) => `WITH held AS (SELECT id FROM stock_materials WHERE id = $1 FOR UPDATE) ${change}`;
    // What an add or an end of a pair writes (this ticket): the Requestable Material's next version first.
    const pairWrite = (change: string) => `WITH bumped AS (UPDATE requestable_materials SET version = version + 1 WHERE id = $1 RETURNING id) ${change}`;

    it('an add waits for its Stock Material being made Inactive and then refuses it', async () => {
      const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream)];

      const [res] = await whileWriting(
        // What making a Stock Material Inactive writes (F008-T7), held uncommitted.
        { sql: 'UPDATE stock_materials SET is_active = false, version = version + 1 WHERE id = $1', params: [paper] },
        () => [add(requestable, paper, { version: 1 })],
        () => untilWaiting('stock_materials', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Inactive Stock Material');
      expect(await pairsOf(requestable)).toEqual([]);
    });

    it('an add waits for its Stock Material being reactivated and then takes it', async () => {
      const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream)];
      await api.pool.query('UPDATE stock_materials SET is_active = false, version = version + 1 WHERE id = $1', [paper]);

      const [res] = await whileWriting(
        // What reactivating a Stock Material writes (F008-T7), held uncommitted.
        { sql: 'UPDATE stock_materials SET is_active = true, version = version + 1 WHERE id = $1', params: [paper] },
        () => [add(requestable, paper, { version: 1 })],
        () => untilWaiting('stock_materials', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(200);
      expect(await pairsOf(requestable)).toEqual([{ stock_material_id: paper, is_current: true }]);
    });

    it('an add waits for a Units write making the Alternate Unit that is the Request Unit Inactive, and then refuses it', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialWithAlternate(await unitNamed(), ream);

      const [res] = await whileWriting(
        { sql: unitsWrite('UPDATE stock_material_units su SET is_active = false FROM held WHERE su.stock_material_id = held.id AND su.unit_id = $2'), params: [paper, ream] },
        () => [add(requestable, paper, { version: 1 })],
        () => untilWaiting('stock_materials', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('do not include the Request Unit');
      expect(await pairsOf(requestable)).toEqual([]);
    });

    it('an add waits for a Units write adding the Request Unit, and then takes the Stock Material', async () => {
      const requestable = await requestableIn();
      const paper = await stockMaterialIn(await unitNamed());

      const [res] = await whileWriting(
        {
          sql: unitsWrite(`INSERT INTO stock_material_units (stock_material_id, unit_id, is_base, conversion_factor, whole_number_only, is_active)
                           SELECT id, $2, false, 500, true, true FROM held`),
          params: [paper, ream],
        },
        () => [add(requestable, paper, { version: 1 })],
        () => untilWaiting('stock_materials', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(200);
      expect(await pairsOf(requestable)).toEqual([{ stock_material_id: paper, is_current: true }]);
    });

    for (const [write, setUp] of [
      ['an add', async () => undefined],
      ['an end', async (requestable: string, paper: string) => expect((await add(requestable, paper, { version: 1 })).statusCode).toBe(200)],
    ] as const) {
      it(`${write} waits for its Stock Material's Material Correction and records the new name in the history (#175 P6)`, async () => {
        const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream, { name: 'กระดาษชื่อเดิม' })];
        await setUp(requestable, paper);
        const version = (await requestableOf(requestable)).version;

        const [res] = await whileWriting(
          // What a Material Correction of the name writes (F008-T5), held uncommitted.
          { sql: `UPDATE stock_materials SET name = 'กระดาษชื่อใหม่', version = version + 1 WHERE id = $1`, params: [paper] },
          () => [write === 'an add' ? add(requestable, paper, { version }) : end(requestable, paper, { version })],
          () => untilWaiting('stock_materials', 1, 'FOR SHARE')
        );

        expect(res.statusCode).toBe(200);
        const [change] = (await requestableOf(requestable)).history.at(-1).changes;
        expect(write === 'an add' ? change.after : change.before).toEqual({ id: paper, name: 'กระดาษชื่อใหม่' });
      });
    }

    it('an add waits for another add of the pair and then refuses it as already current', async () => {
      const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream)];

      const [res] = await whileWriting(
        { sql: pairWrite('INSERT INTO compatible_stock_materials (requestable_material_id, stock_material_id) SELECT id, $2 FROM bumped'), params: [requestable, paper] },
        () => [add(requestable, paper, { version: 2 })],
        () => untilWaiting('requestable_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('already a current Compatible Stock Material');
    });

    it('an add waits for an end of the pair and then makes it current again', async () => {
      const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream)];
      expect((await add(requestable, paper, { version: 1 })).statusCode).toBe(200);

      const [res] = await whileWriting(
        {
          sql: pairWrite('UPDATE compatible_stock_materials c SET is_current = false FROM bumped WHERE c.requestable_material_id = bumped.id AND c.stock_material_id = $2'),
          params: [requestable, paper],
        },
        () => [add(requestable, paper, { version: 3 })],
        () => untilWaiting('requestable_materials')
      );

      expect(res.statusCode).toBe(200);
      expect(await pairsOf(requestable)).toEqual([{ stock_material_id: paper, is_current: true }]);
    });

    it('an end waits for another end of the pair and then refuses it as not current', async () => {
      const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream)];
      expect((await add(requestable, paper, { version: 1 })).statusCode).toBe(200);

      const [res] = await whileWriting(
        {
          sql: pairWrite('UPDATE compatible_stock_materials c SET is_current = false FROM bumped WHERE c.requestable_material_id = bumped.id AND c.stock_material_id = $2'),
          params: [requestable, paper],
        },
        () => [end(requestable, paper, { version: 3 })],
        () => untilWaiting('requestable_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('not a current Compatible Stock Material');
    });

    it('an end waits for an add of the pair and then ends it', async () => {
      const [requestable, paper] = [await requestableIn(), await stockMaterialIn(ream)];
      expect((await add(requestable, paper, { version: 1 })).statusCode).toBe(200);
      expect((await end(requestable, paper, { version: 2 })).statusCode).toBe(200);

      const [res] = await whileWriting(
        {
          sql: pairWrite('UPDATE compatible_stock_materials c SET is_current = true FROM bumped WHERE c.requestable_material_id = bumped.id AND c.stock_material_id = $2'),
          params: [requestable, paper],
        },
        () => [end(requestable, paper, { version: 4 })],
        () => untilWaiting('requestable_materials')
      );

      expect(res.statusCode).toBe(200);
      expect(await pairsOf(requestable)).toEqual([{ stock_material_id: paper, is_current: false }]);
    });
  });
});
