import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// F009-T3 (#205): Feature 008's Units write keeps the Request Unit of each current Compatible Stock Material (#202 Q15,
// ADR 0002; start decisions, #205 comment 7079575589).
describe('Units write and the Request Unit (Seam A - F009-T3)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;
  // The Unit most Requestable Materials here are asked for in.
  let ream: string;

  const helpers = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, materialOf, replaceUnits, unitsAsRead } = helpers;
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A Requestable Material asked for in `requestUnit`, and its id.
  const requestableIn = async (requestUnit: string = ream, name = `วัสดุขอเบิก ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await api.post(officer, '/requestable-materials', { name, request_unit_id: requestUnit }, { 'x-retry-token': crypto.randomUUID() });
    expect(res.statusCode).toBe(201);
    return res.json().requestable_material_id;
  };

  // The Requestable Material page as the Read-only User reads it.
  const requestableOf = async (id: string) => {
    const res = await api.get(readonly, `/requestable-materials/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // Adds the Stock Material `stockMaterialId` as a Compatible Stock Material of `requestableId` (F009-T2).
  const add = async (requestableId: string, stockMaterialId: string) =>
    api.post(
      officer,
      `/requestable-materials/${requestableId}/compatible-stock-materials`,
      { stock_material_id: stockMaterialId, expected_version: (await requestableOf(requestableId)).version },
      { 'x-retry-token': crypto.randomUUID() }
    );

  // Ends the Compatible Stock Material `stockMaterialId` of `requestableId` (F009-T2).
  const end = async (requestableId: string, stockMaterialId: string) =>
    api.post(
      officer,
      `/requestable-materials/${requestableId}/compatible-stock-materials/${stockMaterialId}/end`,
      { expected_version: (await requestableOf(requestableId)).version },
      { 'x-retry-token': crypto.randomUUID() }
    );

  const expectAdded = async (requestableId: string, stockMaterialId: string) => expect((await add(requestableId, stockMaterialId)).statusCode).toBe(200);

  // A Stock Material whose Base Unit is a Unit of its own and whose Alternate Units are `alternates`, each active at a
  // factor of 500; its id.
  const stockMaterialWith = async (...alternates: string[]): Promise<string> => {
    const id = await helpers.created();
    const write = unitsAsRead(await materialOf(id));
    const res = await replaceUnits(id, {
      ...write,
      alternate_units: alternates.map((unit_id) => ({ unit_id, conversion_factor: '500', whole_number_only: true, is_active: true })),
    });
    expect(res.statusCode).toBe(200);
    return id;
  };

  // The Units write that keeps the Stock Material `id` as it is but makes its Alternate Unit `unitId` Inactive.
  const makingInactive = async (id: string, unitId: string) => {
    const write = unitsAsRead(await materialOf(id));
    return { ...write, alternate_units: write.alternate_units.map((unit) => (unit.unit_id === unitId ? { ...unit, is_active: false } : unit)) };
  };

  // The Units write `write` with its Alternate Units in the order `settings` names them, each active or not as told:
  // the page lists them by name, and a refusal names a Unit by its place in the request.
  const inOrder = (write: ReturnType<typeof unitsAsRead>, ...settings: [string, boolean][]) => ({
    ...write,
    alternate_units: settings.map(([unitId, isActive]) => ({ ...write.alternate_units.find((unit) => unit.unit_id === unitId)!, is_active: isActive })),
  });

  // A refused Units write: 400 with Feature 002's validation shape, its message holding each of `parts`, and the Stock
  // Material left as it was.
  const expectUnitsRefused = async (id: string, payload: Record<string, unknown>, parts: string[]) => {
    const before = await materialOf(id);
    const res = await replaceUnits(id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.any(String) });
    for (const part of parts) {
      expect(res.json().message).toContain(part);
    }
    expect(await materialOf(id)).toEqual(before);
    return res.json().message as string;
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_request_unit', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_request_unit', 'READ_ONLY');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('the guard (Q15, ADR 0002)', () => {
    it('refuses making Inactive an Alternate Unit that is the Request Unit of a current Compatible Stock Material, naming its field and the Requestable Material', async () => {
      const paper = await stockMaterialWith(ream);
      const requestable = await requestableIn(ream, 'กระดาษ A4 ขอเบิก');
      await expectAdded(requestable, paper);

      await expectUnitsRefused(paper, await makingInactive(paper, ream), ['alternate_units[0].is_active', '"กระดาษ A4 ขอเบิก"']);
    });

    it('names every Requestable Material asked for in that Unit through this Stock Material, by name, an Inactive one included (#205 start decision 2), and no other', async () => {
      const box = await unitNamed();
      const paper = await stockMaterialWith(box, ream);
      const other = await stockMaterialWith(ream);
      const [second, first, inBoxes, elsewhere] = [
        await requestableIn(ream, 'ขอเบิกกระดาษ ข'),
        await requestableIn(ream, 'ขอเบิกกระดาษ ก'),
        await requestableIn(box, 'ขอเบิกกระดาษ ค'),
        await requestableIn(ream, 'ขอเบิกกระดาษ ง'),
      ];
      for (const requestable of [second, first, inBoxes]) {
        await expectAdded(requestable, paper);
      }
      await expectAdded(elsewhere, other);
      // What F009-T7's write leaves, written where it is stored.
      await api.pool.query('UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', [first]);

      const message = await expectUnitsRefused(paper, inOrder(unitsAsRead(await materialOf(paper)), [box, true], [ream, false]), [
        'alternate_units[1].is_active',
        '"ขอเบิกกระดาษ ก", "ขอเบิกกระดาษ ข"',
      ]);
      expect(message).not.toContain('ขอเบิกกระดาษ ค');
      expect(message).not.toContain('ขอเบิกกระดาษ ง');
    });

    it('names the field of the Unit it keeps active when the write makes several Inactive', async () => {
      const [box, pack] = [await unitNamed(), await unitNamed()];
      const paper = await stockMaterialWith(box, pack);
      await expectAdded(await requestableIn(pack, 'ขอเบิกเป็นห่อ'), paper);

      await expectUnitsRefused(paper, inOrder(unitsAsRead(await materialOf(paper)), [box, false], [pack, false]), ['alternate_units[1].is_active', '"ขอเบิกเป็นห่อ"']);
    });

    it('lets another Alternate Unit go Inactive while the Request Unit stays active', async () => {
      const box = await unitNamed();
      const paper = await stockMaterialWith(ream, box);
      await expectAdded(await requestableIn(), paper);

      expect((await replaceUnits(paper, await makingInactive(paper, box))).statusCode).toBe(200);
    });

    it('lets a Stock Material that is no Compatible Stock Material make the Unit Inactive, while another one is', async () => {
      const [paper, other] = [await stockMaterialWith(ream), await stockMaterialWith(ream)];
      await expectAdded(await requestableIn(), other);

      expect((await replaceUnits(paper, await makingInactive(paper, ream))).statusCode).toBe(200);
    });

    it('lets an ended Compatible Stock Material make its Request Unit Inactive', async () => {
      const paper = await stockMaterialWith(ream);
      const requestable = await requestableIn();
      await expectAdded(requestable, paper);
      expect((await end(requestable, paper)).statusCode).toBe(200);

      expect((await replaceUnits(paper, await makingInactive(paper, ream))).statusCode).toBe(200);
      expect((await requestableOf(requestable)).compatible_stock_materials).toMatchObject([{ stock_material_id: paper, is_current: false }]);
    });
  });

  describe('a Base Unit change keeps every compatibility (#202 story 30, ADR 0002)', () => {
    // The Units of the Compatible Stock Material `stockMaterialId` as the Requestable Material page lists them.
    const compatibleUnitsOf = async (requestable: string, stockMaterialId: string) => {
      const page = await requestableOf(requestable);
      const [pair] = page.compatible_stock_materials.filter((row: any) => row.stock_material_id === stockMaterialId);
      return { is_offered: page.is_offered, is_current: pair.is_current, units: pair.units.map(({ unit_id, is_base, is_active }: any) => ({ unit_id, is_base, is_active })) };
    };

    it('takes the Request Unit from the Base Unit to an active Alternate Unit, and the compatibility stays offered', async () => {
      const paper = await helpers.created({ base_unit: { unit_id: ream } });
      const sheet = await unitNamed();
      const requestable = await requestableIn();
      await expectAdded(requestable, paper);
      const { expected_version } = unitsAsRead(await materialOf(paper));

      const res = await replaceUnits(paper, {
        expected_version,
        base_unit: { unit_id: sheet, whole_number_only: true },
        alternate_units: [{ unit_id: ream, conversion_factor: '500', whole_number_only: true, is_active: true }],
      });

      expect(res.statusCode).toBe(200);
      expect(await compatibleUnitsOf(requestable, paper)).toEqual({
        is_offered: true,
        is_current: true,
        units: [
          { unit_id: sheet, is_base: true, is_active: true },
          { unit_id: ream, is_base: false, is_active: true },
        ],
      });
    });

    it('takes the Request Unit from an Alternate Unit to the Base Unit, and the compatibility stays offered', async () => {
      const paper = await stockMaterialWith(ream);
      const requestable = await requestableIn();
      await expectAdded(requestable, paper);
      const write = unitsAsRead(await materialOf(paper));

      const res = await replaceUnits(paper, {
        expected_version: write.expected_version,
        base_unit: { unit_id: ream, whole_number_only: true },
        alternate_units: [{ unit_id: write.base_unit.unit_id, conversion_factor: null, whole_number_only: true, is_active: false }],
      });

      expect(res.statusCode).toBe(200);
      expect(await compatibleUnitsOf(requestable, paper)).toMatchObject({ is_offered: true, is_current: true, units: [{ unit_id: ream, is_base: true, is_active: true }, { is_active: false }] });
    });

    it('refuses a Base Unit change that leaves the Request Unit an Inactive Alternate Unit', async () => {
      const paper = await helpers.created({ base_unit: { unit_id: ream } });
      const sheet = await unitNamed();
      await expectAdded(await requestableIn(ream, 'ขอเบิกเป็นรีมเดิม'), paper);
      const { expected_version } = unitsAsRead(await materialOf(paper));

      await expectUnitsRefused(
        paper,
        { expected_version, base_unit: { unit_id: sheet, whole_number_only: true }, alternate_units: [{ unit_id: ream, conversion_factor: null, whole_number_only: true, is_active: false }] },
        ['alternate_units[0].is_active', '"ขอเบิกเป็นรีมเดิม"']
      );
    });
  });

  describe('a Unit made Inactive in the shared Unit list (Q15)', () => {
    it('leaves the Requestable Materials asked for in it working, and no new one can choose it', async () => {
      const bottle = await unitNamed('ขวดขอเบิก');
      const [ink, spare] = [await stockMaterialWith(bottle), await stockMaterialWith(bottle)];
      const requestable = await requestableIn(bottle, 'หมึกขอเบิกเป็นขวด');
      await expectAdded(requestable, ink);
      expect((await api.post(officer, `/units/${bottle}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);

      // Still offered, and another Stock Material that has the Unit can still be added.
      expect((await requestableOf(requestable)).is_offered).toBe(true);
      await expectAdded(requestable, spare);
      // A Units write that keeps the Unit as it is still saves; one making it Inactive is still refused.
      const write = unitsAsRead(await materialOf(ink));
      expect((await replaceUnits(ink, { ...write, alternate_units: [{ ...write.alternate_units[0], conversion_factor: '250' }] })).statusCode).toBe(200);
      await expectUnitsRefused(ink, await makingInactive(ink, bottle), ['alternate_units[0].is_active', '"หมึกขอเบิกเป็นขวด"']);
      // A new Requestable Material cannot choose it (F009-T1).
      const res = await api.post(officer, '/requestable-materials', { name: 'หมึกขอเบิกใหม่', request_unit_id: bottle }, { 'x-retry-token': crypto.randomUUID() });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('request_unit_id must name an active Unit') });
    });
  });

  // #205 start decisions (comment 7079575589): the Units write reads the guard after it locks the Stock Material FOR
  // UPDATE; each write that changes what the guard reads locks it FOR SHARE first. The other direction, an add waiting
  // for a Units write, is F009-T2's (compatible-stock-material.test.ts).
  describe('concurrency', () => {
    // What a write on a pair or a Request Unit writes once it holds the Stock Material `$1` FOR SHARE.
    const sharing = (change: string) => `WITH held AS (SELECT id FROM stock_materials WHERE id = $1 FOR SHARE) ${change}`;

    it('a Units write waits for an add of a Compatible Stock Material and then refuses making its Request Unit Inactive', async () => {
      const paper = await stockMaterialWith(ream);
      const requestable = await requestableIn(ream, 'ขอเบิกระหว่างเพิ่ม');
      const write = await makingInactive(paper, ream);

      const [res] = await whileWriting(
        // What adding a Compatible Stock Material writes (F009-T2), held uncommitted.
        { sql: sharing('INSERT INTO compatible_stock_materials (requestable_material_id, stock_material_id) SELECT $2, id FROM held'), params: [paper, requestable] },
        () => [replaceUnits(paper, write)],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('"ขอเบิกระหว่างเพิ่ม"') });
    });

    it('a Units write waits for an end of the Compatible Stock Material and then makes its Request Unit Inactive', async () => {
      const paper = await stockMaterialWith(ream);
      const requestable = await requestableIn();
      await expectAdded(requestable, paper);
      const write = await makingInactive(paper, ream);

      const [res] = await whileWriting(
        // What ending a Compatible Stock Material writes (F009-T2), held uncommitted.
        {
          sql: sharing('UPDATE compatible_stock_materials c SET is_current = false FROM held WHERE c.stock_material_id = held.id AND c.requestable_material_id = $2'),
          params: [paper, requestable],
        },
        () => [replaceUnits(paper, write)],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(200);
      expect((await materialOf(paper)).units.find((unit: any) => unit.unit_id === ream).is_active).toBe(false);
    });

    it('a Units write waits for a Request Unit change and then refuses making the new Request Unit Inactive (F009-T8, #205 start decision 3)', async () => {
      const box = await unitNamed();
      const paper = await stockMaterialWith(ream, box);
      const requestable = await requestableIn(ream, 'ขอเบิกเปลี่ยนหน่วย');
      await expectAdded(requestable, paper);
      const write = await makingInactive(paper, box);

      const [res] = await whileWriting(
        // What F009-T8's Request Unit change must write, held uncommitted: it locks each current Compatible Stock
        // Material FOR SHARE first.
        { sql: sharing('UPDATE requestable_materials r SET request_unit_id = $3, version = version + 1 FROM held WHERE r.id = $2'), params: [paper, requestable, box] },
        () => [replaceUnits(paper, write)],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('"ขอเบิกเปลี่ยนหน่วย"') });
    });
  });
});
