import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// F008-T3 (#178): a Stock Material's Alternate Units with their Conversion Factors, at creation and through the Units
// write that replaces its whole Unit set (#175 MC-05, MC-21, MC-22, MC-23, Q5, Q6, Q9, Q10, Q22, Q23, P2, P3), and
// the factor an Inactive Alternate Unit may leave unknown when the Base Unit changes (#178 PO decision 1).
describe('Stock Material Units (Seam A - F008-T3)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // รีม, counted whole unless a test says otherwise, and the Units most tests convert to it.
  let ream: string;
  let box: string;
  let crate: string;
  let sheet: string;

  const { unitNamed, createMaterial, created, materialOf, replaceUnits, unitsAsRead, materialCount } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A valid creation: กระดาษ A4 counted in รีม, unless `overrides` says otherwise.
  const paper = (overrides: Record<string, unknown> = {}) => ({ name: 'กระดาษ A4', base_unit: { unit_id: ream }, ...overrides });

  // A refused creation: its message naming `field`, and nothing saved.
  const expectCreateRefused = async (payload: Record<string, unknown>, field: string) => {
    const before = await materialCount();
    const res = await createMaterial(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialCount()).toBe(before);
  };

  // A Stock Material in รีม with กล่อง (1 กล่อง = 5 รีม), and its page.
  const paperWithBox = async (overrides: Record<string, unknown> = {}) => {
    const id = await created(paper({ alternate_units: [{ unit_id: box, conversion_factor: '5' }], ...overrides }));
    return materialOf(id);
  };

  // A refused Units write: its message naming `field`, and the Stock Material left as it was.
  const expectUnitsRefused = async (id: string, payload: Record<string, unknown>, field: string) => {
    const before = await materialOf(id);
    const res = await replaceUnits(id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialOf(id)).toEqual(before);
  };

  // `count` Units new to the list, as Alternate Units of 5 รีม each: a request that only the cap of 100 refuses.
  const manyAlternates = async (count: number) => {
    const res = await api.pool.query(
      `INSERT INTO units (name, created_by, updated_by) SELECT 'ห่อที่ ' || g || ' ' || $2, $1, $1 FROM generate_series(1, $3::int) g RETURNING id`,
      [officer.id, crypto.randomUUID().slice(0, 8), count]
    );
    return res.rows.map(({ id }: { id: string }) => ({ unit_id: id, conversion_factor: '5', whole_number_only: true, is_active: true }));
  };

  // The Units a history entry recorded after its change.
  const unitsRecordedBy = (entry: { changes: { field: string; after: unknown }[] }) => entry.changes.find(({ field }) => field === 'units')!.after;

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_units', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_units', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_units', 'READ_ONLY');
    custodian = await api.actor('custodian_units', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_units', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_units', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
    box = await unitNamed('กล่อง');
    crate = await unitNamed('ลัง');
    sheet = await unitNamed('แผ่น');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('creating with Alternate Units', () => {
    it('keeps each Alternate Unit with its Conversion Factor straight to the Base Unit, whole-number-only unless told otherwise', async () => {
      const res = await createMaterial(
        paper({
          alternate_units: [
            { unit_id: crate, conversion_factor: '50' },
            { unit_id: box, conversion_factor: '5.0', whole_number_only: false },
          ],
        })
      );

      expect(res.statusCode).toBe(201);
      const page = await materialOf(res.json().stock_material_id);
      // The Base Unit first, then the Alternate Units by name; "1 ลัง = 50 รีม" is entered straight, not through กล่อง.
      expect(page.units).toEqual([
        { unit_id: ream, name: 'รีม', unit_is_active: true, is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true },
        { unit_id: box, name: 'กล่อง', unit_is_active: true, is_base: false, conversion_factor: '5', whole_number_only: false, is_active: true },
        { unit_id: crate, name: 'ลัง', unit_is_active: true, is_base: false, conversion_factor: '50', whole_number_only: true, is_active: true },
      ]);
      expect(unitsRecordedBy(page.history[0])).toEqual([
        { unit_id: ream, name: 'รีม', is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true },
        { unit_id: box, name: 'กล่อง', is_base: false, conversion_factor: '5', whole_number_only: false, is_active: true },
        { unit_id: crate, name: 'ลัง', is_base: false, conversion_factor: '50', whole_number_only: true, is_active: true },
      ]);
    });

    it('keeps a factor of four decimal places exactly when the Base Unit takes fractions', async () => {
      const litre = await unitNamed('ลิตร');
      const bottle = await unitNamed('ขวดเล็ก');
      const id = await created({ name: 'น้ำยาถูพื้น', base_unit: { unit_id: litre, whole_number_only: false }, alternate_units: [{ unit_id: bottle, conversion_factor: '0.3333' }] });

      expect((await materialOf(id)).units[1]).toMatchObject({ unit_id: bottle, conversion_factor: '0.3333' });
    });

    it('refuses a Conversion Factor that is not greater than 0, has more than four decimal places, is too large, or is not a decimal, never rounding it', async () => {
      const field = 'alternate_units[0].conversion_factor';
      const fractional = { base_unit: { unit_id: ream, whole_number_only: false } };
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box, conversion_factor: '0' }] }), field);
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box, conversion_factor: '-5' }] }), field);
      await expectCreateRefused(paper({ ...fractional, alternate_units: [{ unit_id: box, conversion_factor: '2.50001' }] }), field);
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box, conversion_factor: '100000000000000' }] }), field);
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box, conversion_factor: '5e2' }] }), field);
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box }] }), field);
    });

    it('refuses the same Unit twice, and the Base Unit as an Alternate Unit', async () => {
      await expectCreateRefused(
        paper({ alternate_units: [{ unit_id: box, conversion_factor: '5' }, { unit_id: box, conversion_factor: '10' }] }),
        'alternate_units[1].unit_id'
      );
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: ream, conversion_factor: '1' }] }), 'alternate_units[0].unit_id is the Base Unit');
    });

    it('refuses an Alternate Unit that is not on the Unit list, Inactive there, or not an id', async () => {
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: crypto.randomUUID(), conversion_factor: '5' }] }), 'alternate_units[0].unit_id');
      const retired = await unitNamed('โหล (เลิกใช้)');
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [retired]);
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box, conversion_factor: '5' }, { unit_id: retired, conversion_factor: '12' }] }), 'alternate_units[1].unit_id');
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: 'not-a-unit', conversion_factor: '5' }] }), 'alternate_units[0].unit_id');
    });

    it('needs every Conversion Factor whole while the Base Unit is whole-number-only (P3)', async () => {
      await expectCreateRefused(paper({ alternate_units: [{ unit_id: box, conversion_factor: '2.5' }] }), 'alternate_units[0].conversion_factor');

      const fractional = await created(paper({ base_unit: { unit_id: ream, whole_number_only: false }, alternate_units: [{ unit_id: box, conversion_factor: '2.5' }] }));
      expect((await materialOf(fractional)).units[1].conversion_factor).toBe('2.5');
    });

    it('takes at most 100 Alternate Units', async () => {
      const alternates = (await manyAlternates(101)).map(({ unit_id, conversion_factor }) => ({ unit_id, conversion_factor }));
      await expectCreateRefused(paper({ alternate_units: alternates }), 'alternate_units: Too big');
      expect((await createMaterial(paper({ alternate_units: alternates.slice(0, 100) }))).statusCode).toBe(201);
    });

    it('waits for a Unit being made Inactive and then refuses it as an Alternate Unit', async () => {
      const unit = await unitNamed('แพ็ค');
      const before = await materialCount();

      const [res] = await whileWriting(
        // What making a Unit Inactive writes (F008-T8), held uncommitted.
        { sql: 'UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', params: [unit] },
        () => [createMaterial(paper({ alternate_units: [{ unit_id: unit, conversion_factor: '5' }] }))],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('alternate_units[0].unit_id');
      expect(await materialCount()).toBe(before);
    });

    it('fingerprints the Alternate Units with the rest of the request', async () => {
      const token = crypto.randomUUID();
      expect((await createMaterial(paper({ alternate_units: [{ unit_id: box, conversion_factor: '5' }] }), token)).statusCode).toBe(201);
      const before = await materialCount();

      const res = await createMaterial(paper({ alternate_units: [{ unit_id: box, conversion_factor: '6' }] }), token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await materialCount()).toBe(before);
    });
  });

  describe('the Units write', () => {
    it('changes a Conversion Factor and a whole-number rule, with the values before and after in history', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      const res = await replaceUnits(page.id, {
        ...payload,
        base_unit: { unit_id: ream, whole_number_only: false },
        alternate_units: [{ unit_id: box, conversion_factor: '2.5', whole_number_only: false, is_active: true }],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 2 });
      const after = await materialOf(page.id);
      expect(after.version).toBe(2);
      expect(after.units).toEqual([
        { unit_id: ream, name: 'รีม', unit_is_active: true, is_base: true, conversion_factor: '1', whole_number_only: false, is_active: true },
        { unit_id: box, name: 'กล่อง', unit_is_active: true, is_base: false, conversion_factor: '2.5', whole_number_only: false, is_active: true },
      ]);
      expect(after.history[1]).toEqual({
        version: 2,
        kind: 'UNITS_CHANGED',
        changes: [
          {
            field: 'units',
            before: [
              { unit_id: ream, name: 'รีม', is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true },
              { unit_id: box, name: 'กล่อง', is_base: false, conversion_factor: '5', whole_number_only: true, is_active: true },
            ],
            after: [
              { unit_id: ream, name: 'รีม', is_base: true, conversion_factor: '1', whole_number_only: false, is_active: true },
              { unit_id: box, name: 'กล่อง', is_base: false, conversion_factor: '2.5', whole_number_only: false, is_active: true },
            ],
          },
        ],
        reason: null,
        note: null,
        recorded_by: officer.id,
        recorded_by_username: 'officer_units',
        recorded_at: expect.any(String),
      });
    });

    it('changes an Alternate Unit\'s whole-number rule alone', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      expect((await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], whole_number_only: false }] })).statusCode).toBe(200);
      expect((await materialOf(page.id)).units[1]).toMatchObject({ unit_id: box, conversion_factor: '5', whole_number_only: false });
    });

    it('adds an Alternate Unit', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      const res = await replaceUnits(page.id, { ...payload, alternate_units: [...payload.alternate_units, { unit_id: crate, conversion_factor: '50', whole_number_only: true, is_active: true }] });

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).units.map(({ unit_id, conversion_factor }: { unit_id: string; conversion_factor: string }) => [unit_id, conversion_factor])).toEqual([
        [ream, '1'],
        [box, '5'],
        [crate, '50'],
      ]);
    });

    it('makes an Alternate Unit Inactive, keeping its factor, and reactivates it', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      expect((await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], is_active: false }] })).statusCode).toBe(200);
      const inactive = await materialOf(page.id);
      expect(inactive.units[1]).toMatchObject({ unit_id: box, conversion_factor: '5', is_active: false });

      expect((await replaceUnits(page.id, { ...payload, expected_version: 2, alternate_units: [{ ...payload.alternate_units[0], is_active: true }] })).statusCode).toBe(200);
      const reactivated = await materialOf(page.id);
      expect(reactivated.units[1]).toMatchObject({ unit_id: box, conversion_factor: '5', is_active: true });
      expect(reactivated.history.map(({ kind }: { kind: string }) => kind)).toEqual(['CREATED', 'UNITS_CHANGED', 'UNITS_CHANGED']);
      expect(unitsRecordedBy(reactivated.history[1])).toContainEqual(expect.objectContaining({ unit_id: box, is_active: false }));
    });

    it('never removes an Alternate Unit', async () => {
      const page = await paperWithBox();

      await expectUnitsRefused(page.id, { ...unitsAsRead(page), alternate_units: [] }, 'never removed');
    });

    it('never makes the Base Unit Inactive', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      await expectUnitsRefused(page.id, { ...payload, base_unit: { ...payload.base_unit, is_active: false } }, 'base_unit');
    });

    it('needs a factor for every active Alternate Unit, and lets an Inactive one leave it unknown', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);
      await expectUnitsRefused(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: null }] }, 'alternate_units[0].conversion_factor');

      expect((await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: null, is_active: false }] })).statusCode).toBe(200);
      expect((await materialOf(page.id)).units[1]).toMatchObject({ unit_id: box, conversion_factor: null, is_active: false });
    });

    it('applies the same Alternate Unit rules as creating', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);
      const plus = (entry: Record<string, unknown>) => ({ ...payload, alternate_units: [...payload.alternate_units, { whole_number_only: true, is_active: true, ...entry }] });

      await expectUnitsRefused(page.id, plus({ unit_id: crate, conversion_factor: '0' }), 'alternate_units[1].conversion_factor');
      await expectUnitsRefused(page.id, plus({ unit_id: box, conversion_factor: '10' }), 'alternate_units[1].unit_id');
      await expectUnitsRefused(page.id, plus({ unit_id: ream, conversion_factor: '1' }), 'alternate_units[1].unit_id is the Base Unit');
      await expectUnitsRefused(page.id, plus({ unit_id: crypto.randomUUID(), conversion_factor: '5' }), 'alternate_units[1].unit_id');
      await expectUnitsRefused(page.id, plus({ unit_id: crate, conversion_factor: '2.5' }), 'alternate_units[1].conversion_factor');
      await expectUnitsRefused(page.id, { ...payload, alternate_units: [payload.alternate_units[0], ...(await manyAlternates(100))] }, 'alternate_units: Too big');
    });

    it('refuses making the Base Unit whole-number-only while a Conversion Factor has a fraction, an Inactive one included (P3)', async () => {
      const id = await created(paper({ base_unit: { unit_id: ream, whole_number_only: false }, alternate_units: [{ unit_id: box, conversion_factor: '2.5' }] }));
      const page = await materialOf(id);
      const payload = unitsAsRead(page);
      await replaceUnits(id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], is_active: false }] });
      const inactive = unitsAsRead(await materialOf(id));

      await expectUnitsRefused(id, { ...inactive, base_unit: { unit_id: ream, whole_number_only: true } }, 'alternate_units[0].conversion_factor');
    });

    it('refuses a Unit new to the Stock Material, a new Base Unit or a reactivated Alternate Unit that is Inactive on the Unit list, and keeps one already in use', async () => {
      const retiring = await unitNamed(`ห่อ ${crypto.randomUUID().slice(0, 8)}`);
      const page = await paperWithBox({ alternate_units: [{ unit_id: box, conversion_factor: '5' }, { unit_id: retiring, conversion_factor: '10' }] });
      await api.pool.query('UPDATE units SET is_active = false WHERE id = $1', [retiring]);
      const payload = unitsAsRead(page);
      const [boxEntry, retiringEntry] = payload.alternate_units;

      // A Unit already in use keeps its Inactive list entry, and its factor can still change (#175 Q21).
      expect((await replaceUnits(page.id, { ...payload, alternate_units: [boxEntry, { ...retiringEntry, conversion_factor: '12' }] })).statusCode).toBe(200);
      const inUse = unitsAsRead(await materialOf(page.id));
      // As a new Base Unit, it is a new choice.
      await expectUnitsRefused(
        page.id,
        { ...inUse, base_unit: { unit_id: retiring, whole_number_only: true }, alternate_units: [{ ...inUse.alternate_units[0], conversion_factor: '1' }, { unit_id: ream, conversion_factor: '1', whole_number_only: true, is_active: true }] },
        'base_unit.unit_id'
      );
      // Reactivated, it is a new choice too.
      expect((await replaceUnits(page.id, { ...inUse, alternate_units: [inUse.alternate_units[0], { ...inUse.alternate_units[1], is_active: false }] })).statusCode).toBe(200);
      const inactive = unitsAsRead(await materialOf(page.id));
      await expectUnitsRefused(page.id, { ...inactive, alternate_units: [inactive.alternate_units[0], { ...inactive.alternate_units[1], is_active: true }] }, 'alternate_units[1].unit_id');
    });

    it('refuses a Units write that changes nothing', async () => {
      const page = await paperWithBox();

      await expectUnitsRefused(page.id, unitsAsRead(page), 'changes nothing');
      // A factor compares as the number it is: "5.0" is the 5 already kept.
      const payload = unitsAsRead(page);
      await expectUnitsRefused(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '5.0' }] }, 'changes nothing');
    });

    it('keeps Unit names in history as they were when recorded, while the page shows their names now', async () => {
      const pack = await unitNamed(`แพค ${crypto.randomUUID().slice(0, 8)}`);
      const page = await paperWithBox();
      const payload = unitsAsRead(page);
      await replaceUnits(page.id, { ...payload, alternate_units: [...payload.alternate_units, { unit_id: pack, conversion_factor: '2', whole_number_only: true, is_active: true }] });
      // The rename of F008-T8, written where it is stored.
      await api.pool.query(`UPDATE units SET name = 'แพ็ค (แก้ชื่อ)', version = version + 1 WHERE id = $1`, [pack]);

      const after = await materialOf(page.id);

      expect(after.units.find(({ unit_id }: { unit_id: string }) => unit_id === pack).name).toBe('แพ็ค (แก้ชื่อ)');
      expect(unitsRecordedBy(after.history[1])).toContainEqual(expect.objectContaining({ unit_id: pack, name: expect.stringMatching(/^แพค /) }));
    });
  });

  describe('changing the Base Unit (Q9, Q10, P2)', () => {
    it('changes the Base Unit when every active Alternate Unit carries its factor and the old Base Unit stays an Alternate Unit with one', async () => {
      // รีม with กล่อง and ลัง becomes แผ่น: 1 รีม = 500 แผ่น, 1 กล่อง = 2500 แผ่น, 1 ลัง = 25000 แผ่น.
      const page = await paperWithBox({ alternate_units: [{ unit_id: box, conversion_factor: '5' }, { unit_id: crate, conversion_factor: '50' }] });

      const res = await replaceUnits(page.id, {
        expected_version: 1,
        base_unit: { unit_id: sheet, whole_number_only: true },
        alternate_units: [
          { unit_id: ream, conversion_factor: '500', whole_number_only: true, is_active: true },
          { unit_id: box, conversion_factor: '2500', whole_number_only: true, is_active: true },
          { unit_id: crate, conversion_factor: '25000', whole_number_only: true, is_active: true },
        ],
      });

      expect(res.statusCode).toBe(200);
      const after = await materialOf(page.id);
      expect(after.units.map(({ name, is_base, conversion_factor }: { name: string; is_base: boolean; conversion_factor: string }) => [name, is_base, conversion_factor])).toEqual([
        ['แผ่น', true, '1'],
        ['กล่อง', false, '2500'],
        ['รีม', false, '500'],
        ['ลัง', false, '25000'],
      ]);
      expect(after.history[1].changes[0].before.find(({ is_base }: { is_base: boolean }) => is_base)).toMatchObject({ unit_id: ream, name: 'รีม' });
    });

    it('makes an Alternate Unit the Base Unit', async () => {
      // กล่อง becomes the Base Unit: 1 รีม = 0.2 กล่อง.
      const page = await paperWithBox();

      const res = await replaceUnits(page.id, {
        expected_version: 1,
        base_unit: { unit_id: box, whole_number_only: false },
        alternate_units: [{ unit_id: ream, conversion_factor: '0.2', whole_number_only: true, is_active: true }],
      });

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).units).toMatchObject([
        { unit_id: box, is_base: true, conversion_factor: '1', is_active: true },
        { unit_id: ream, is_base: false, conversion_factor: '0.2', is_active: true },
      ]);
    });

    it('swaps the Base Unit with an Alternate Unit of factor 1', async () => {
      const bigReam = await unitNamed(`รีมใหญ่ ${crypto.randomUUID().slice(0, 8)}`);
      const id = await created(paper({ alternate_units: [{ unit_id: bigReam, conversion_factor: '1' }] }));

      const res = await replaceUnits(id, {
        expected_version: 1,
        base_unit: { unit_id: bigReam, whole_number_only: true },
        alternate_units: [{ unit_id: ream, conversion_factor: '1', whole_number_only: true, is_active: true }],
      });

      expect(res.statusCode).toBe(200);
      expect((await materialOf(id)).units).toMatchObject([
        { unit_id: bigReam, is_base: true },
        { unit_id: ream, is_base: false, conversion_factor: '1' },
      ]);
    });

    it('refuses a Base Unit change that leaves an active Alternate Unit without its factor', async () => {
      const page = await paperWithBox();

      await expectUnitsRefused(
        page.id,
        {
          expected_version: 1,
          base_unit: { unit_id: sheet, whole_number_only: true },
          alternate_units: [
            { unit_id: ream, conversion_factor: '500', whole_number_only: true, is_active: true },
            { unit_id: box, whole_number_only: true, is_active: true },
          ],
        },
        'alternate_units[1].conversion_factor'
      );
    });

    it('refuses a Base Unit change that drops the old Base Unit', async () => {
      const page = await paperWithBox();

      await expectUnitsRefused(
        page.id,
        { expected_version: 1, base_unit: { unit_id: sheet, whole_number_only: true }, alternate_units: [{ unit_id: box, conversion_factor: '2500', whole_number_only: true, is_active: true }] },
        'never removed'
      );
    });

    it('lets the old Base Unit and an Inactive Alternate Unit go Inactive with their factors unknown, and reactivating one then needs a factor', async () => {
      const page = await paperWithBox({ alternate_units: [{ unit_id: box, conversion_factor: '5' }, { unit_id: crate, conversion_factor: '50' }] });
      const first = unitsAsRead(page);
      await replaceUnits(page.id, { ...first, alternate_units: [first.alternate_units[0], { ...first.alternate_units[1], is_active: false }] });

      const res = await replaceUnits(page.id, {
        expected_version: 2,
        base_unit: { unit_id: sheet, whole_number_only: true },
        alternate_units: [
          { unit_id: ream, whole_number_only: true, is_active: false },
          { unit_id: box, conversion_factor: '2500', whole_number_only: true, is_active: true },
          { unit_id: crate, whole_number_only: true, is_active: false },
        ],
      });

      expect(res.statusCode).toBe(200);
      const after = await materialOf(page.id);
      expect(after.units.map(({ name, conversion_factor, is_active }: { name: string; conversion_factor: string | null; is_active: boolean }) => [name, conversion_factor, is_active])).toEqual([
        ['แผ่น', '1', true],
        ['กล่อง', '2500', true],
        ['รีม', null, false],
        ['ลัง', null, false],
      ]);
      expect(unitsRecordedBy(after.history[2])).toContainEqual({ unit_id: ream, name: 'รีม', is_base: false, conversion_factor: null, whole_number_only: true, is_active: false });

      const unknown = unitsAsRead(after);
      await expectUnitsRefused(page.id, { ...unknown, alternate_units: unknown.alternate_units.map((entry) => (entry.unit_id === ream ? { ...entry, is_active: true } : entry)) }, 'conversion_factor');
      expect(
        (await replaceUnits(page.id, { ...unknown, alternate_units: unknown.alternate_units.map((entry) => (entry.unit_id === ream ? { ...entry, conversion_factor: '500', is_active: true } : entry)) })).statusCode
      ).toBe(200);
      expect((await materialOf(page.id)).units).toContainEqual(expect.objectContaining({ unit_id: ream, conversion_factor: '500', is_active: true }));
    });

    it('refuses a new Base Unit that is not on the Unit list', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      await expectUnitsRefused(
        page.id,
        { ...payload, base_unit: { unit_id: crypto.randomUUID(), whole_number_only: true }, alternate_units: [...payload.alternate_units, { unit_id: ream, whole_number_only: true, is_active: false }] },
        'base_unit.unit_id'
      );
    });
  });

  describe('versions and the request', () => {
    it('refuses a stale expected version with the current and expected versions, writing nothing', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);
      expect((await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] })).statusCode).toBe(200);
      const before = await materialOf(page.id);

      const res = await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '7' }] });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('waits for a write holding the Stock Material and then refuses the version it changed', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      const [res] = await whileWriting(
        // What another write of the Stock Material commits, held uncommitted.
        { sql: 'UPDATE stock_materials SET version = version + 1 WHERE id = $1', params: [page.id] },
        () => [replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] })],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect((await materialOf(page.id)).units[1].conversion_factor).toBe('5');
    });

    it('waits for a Unit being made Inactive and then refuses it as a new Alternate Unit', async () => {
      const unit = await unitNamed(`ถุง ${crypto.randomUUID().slice(0, 8)}`);
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      const [res] = await whileWriting(
        { sql: 'UPDATE units SET is_active = false, version = version + 1 WHERE id = $1', params: [unit] },
        () => [replaceUnits(page.id, { ...payload, alternate_units: [...payload.alternate_units, { unit_id: unit, conversion_factor: '3', whole_number_only: true, is_active: true }] })],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('alternate_units[1].unit_id');
      expect((await materialOf(page.id)).version).toBe(1);
    });

    it('needs an expected version', async () => {
      const page = await paperWithBox();
      const { expected_version: _version, ...payload } = unitsAsRead(page);

      await expectUnitsRefused(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] }, 'expected_version');
    });

    it('answers 404 for a Stock Material that does not exist, and 400 for an id that is not one', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);

      const missing = await replaceUnits(crypto.randomUUID(), payload);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');
      const invalid = await replaceUnits('not-an-id', payload);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe('INVALID_ID');
    });
  });

  describe('permissions', () => {
    it('lets only the Supply Officer replace the Units', async () => {
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };

      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await replaceUnits(page.id, payload, crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs material:manage itself, and fails closed when the lookup fails, writing nothing', async () => {
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };

      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => replaceUnits(page.id, payload))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => replaceUnits(page.id, payload));
      expect(failed.statusCode).toBe(500);
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs a session and the CSRF token', async () => {
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'PUT', url: `/stock-materials/${page.id}/units`, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await materialOf(page.id)).toEqual(page);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };

      const res = await api.put(officer, `/stock-materials/${page.id}/units`, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('answers an identical replay with the committed result and writes nothing, even after the version moved on', async () => {
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };
      const token = crypto.randomUUID();
      const first = await replaceUnits(page.id, payload, token);
      expect(first.statusCode).toBe(200);
      const before = await materialOf(page.id);

      const replay = await replaceUnits(page.id, payload, token);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);
      const token = crypto.randomUUID();
      expect((await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] }, token)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      const res = await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '7' }] }, token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_units_two', 'SUPPLY_OFFICER');
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };
      const token = crypto.randomUUID();
      expect((await replaceUnits(page.id, payload, token)).statusCode).toBe(200);

      // Their request under the same token is their own write, refused at the version the first one moved.
      const theirs = await replaceUnits(page.id, payload, token, otherOfficer);

      expect(theirs.statusCode).toBe(409);
      expect(theirs.json().code).toBe('STALE_BEFORE_CONFLICT');
    });

    it('scopes a token to its operation', async () => {
      const page = await paperWithBox();
      const payload = unitsAsRead(page);
      const token = crypto.randomUUID();
      expect((await createMaterial(paper(), token)).statusCode).toBe(201);

      const res = await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] }, token);

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).units[1].conversion_factor).toBe('6');
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const page = await paperWithBox();
      const payload = { ...unitsAsRead(page), alternate_units: [{ ...unitsAsRead(page).alternate_units[0], conversion_factor: '6' }] };
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 6 }, () => replaceUnits(page.id, payload, token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((res) => res.json().version))).toEqual(new Set([2]));
      expect((await materialOf(page.id)).history).toHaveLength(2);
    });
  });
});
