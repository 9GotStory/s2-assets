import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// F008-T6 (#182): a Stock Material's optional Minimum Stock (จำนวนขั้นต่ำ) in its Base Unit, set at creation or
// through other details, re-entered when the Units write changes the Base Unit, and the list filtered by whether one
// is set (#175 MC-20, MC-23, Q11, Q14, Q23, P1, P3; #182 decisions 1-3, comment 7005449327).
describe('Stock Material Minimum Stock (Seam A - F008-T6)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;
  // รีม, counted whole; ลิตร, counted with fractions; กล่อง of 5 รีม and แผ่น, 500 to a รีม, for Base Unit changes.
  let ream: string;
  let litre: string;
  let box: string;
  let sheet: string;

  const { unitNamed, createMaterial, created, materialOf, changeDetails, replaceUnits, unitsAsRead, materialCount } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A Stock Material counted in `baseUnit`, whole-number-only unless `wholeNumberOnly` says otherwise, with `overrides`,
  // and its page.
  const materialIn = async (baseUnit: string, wholeNumberOnly: boolean, overrides: Record<string, unknown> = {}) =>
    materialOf(await created({ name: `วัสดุ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: baseUnit, whole_number_only: wholeNumberOnly }, ...overrides }));

  // The details write that keeps a page's other details as they are, at its version, for a test to change.
  const detailsAsRead = (page: { version: number; material_category: { id: string } | null; note: string | null; minimum_stock: string | null }) => ({
    expected_version: page.version,
    material_category_id: page.material_category?.id ?? null,
    note: page.note,
    minimum_stock: page.minimum_stock,
  });

  // A creation counted in `baseUnit`, whole-number-only unless `wholeNumberOnly` says otherwise, with `overrides`.
  const creation = (baseUnit: string, wholeNumberOnly: boolean, overrides: Record<string, unknown> = {}) => ({
    name: `วัสดุ ${crypto.randomUUID().slice(0, 8)}`,
    base_unit: { unit_id: baseUnit, whole_number_only: wholeNumberOnly },
    ...overrides,
  });

  // A refused creation: its message naming `field`, and nothing saved.
  const expectCreateRefused = async (payload: Record<string, unknown>, field: string) => {
    const before = await materialCount();
    const res = await createMaterial(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialCount()).toBe(before);
  };

  // A refused Units write: its message naming `field`, and the Stock Material left as it was.
  const expectUnitsRefused = async (id: string, payload: Record<string, unknown>, field: string) => {
    const before = await materialOf(id);
    const res = await replaceUnits(id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialOf(id)).toEqual(before);
  };

  // กระดาษ counted in รีม with กล่อง (1 กล่อง = 5 รีม) and a Minimum Stock of 10 รีม, and its page.
  const paperWithMinimum = async () =>
    materialOf(await created({ name: `กระดาษ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: ream }, alternate_units: [{ unit_id: box, conversion_factor: '5' }], minimum_stock: '10' }));

  // The Units write that makes กล่อง the Base Unit of `paperWithMinimum`, counted with fractions, with รีม kept at 0.2
  // กล่อง, and `overrides`.
  const boxAsBase = (overrides: Record<string, unknown> = {}) => ({
    expected_version: 1,
    base_unit: { unit_id: box, whole_number_only: false },
    alternate_units: [{ unit_id: ream, conversion_factor: '0.2', whole_number_only: true, is_active: true }],
    ...overrides,
  });

  // A refused details write: its message naming `field`, and the Stock Material left as it was.
  const expectDetailsRefused = async (id: string, payload: Record<string, unknown>, field: string) => {
    const before = await materialOf(id);
    const res = await changeDetails(id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialOf(id)).toEqual(before);
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_minimum', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_minimum', 'READ_ONLY');
    ream = await unitNamed('รีม');
    litre = await unitNamed('ลิตร');
    box = await unitNamed('กล่อง');
    sheet = await unitNamed('แผ่น');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('the list', () => {
    // The ids of the rows a reader gets for `query`, sorted.
    const idsListed = async (query: string): Promise<string[]> => {
      const res = await api.get(readonly, `/stock-materials?${query}&limit=100`);
      expect(res.statusCode).toBe(200);
      return res.json().items.map(({ id }: { id: string }) => id).sort();
    };

    it('shows each row with its Minimum Stock, or none', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const withOne = await created(creation(litre, false, { name: `แถว ${tag} ก`, minimum_stock: '1.5' }));
      const withNone = await created(creation(ream, true, { name: `แถว ${tag} ข` }));

      const res = await api.get(readonly, `/stock-materials?search=${encodeURIComponent(`แถว ${tag}`)}`);

      expect(res.json().items).toMatchObject([
        { id: withOne, minimum_stock: '1.5', base_unit: { unit_id: litre, name: 'ลิตร' } },
        { id: withNone, minimum_stock: null },
      ]);
    });

    it('filters by a Minimum Stock set or not set, with the other filters (MC-20)', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const set = [await created(creation(ream, true, { name: `กรอง ${tag} 1`, minimum_stock: '5' })), await created(creation(litre, false, { name: `กรอง ${tag} 2`, minimum_stock: '0.5' }))];
      const notSet = await created(creation(ream, true, { name: `กรอง ${tag} 3` }));
      const search = `search=${encodeURIComponent(`กรอง ${tag}`)}`;

      expect(await idsListed(`${search}&minimum_stock=set`)).toEqual(set.sort());
      expect(await idsListed(`${search}&minimum_stock=not_set`)).toEqual([notSet]);
      expect(await idsListed(search)).toEqual([...set, notSet].sort());
      // A Minimum Stock cleared is not set again.
      const page = await materialOf(set[0]);
      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: null })).statusCode).toBe(200);
      expect(await idsListed(`${search}&minimum_stock=not_set`)).toEqual([set[0], notSet].sort());
    });

    it('counts and pages within the Minimum Stock filter', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      await created(creation(ream, true, { name: `นับ ${tag} ก`, minimum_stock: '1' }));
      await created(creation(ream, true, { name: `นับ ${tag} ข`, minimum_stock: '2' }));
      await created(creation(ream, true, { name: `นับ ${tag} ค` }));

      const res = await api.get(readonly, `/stock-materials?search=${encodeURIComponent(`นับ ${tag}`)}&minimum_stock=set&limit=1`);

      expect(res.json()).toMatchObject({ total_count: 2, has_more: true, items: [{ name: `นับ ${tag} ก` }] });
    });

    it('refuses a Minimum Stock filter that is neither "set" nor "not_set"', async () => {
      for (const value of ['SET', 'none', 'true', '']) {
        const res = await api.get(readonly, `/stock-materials?minimum_stock=${value}`);
        expect(res.statusCode, value).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('minimum_stock') });
      }
    });
  });

  describe('creating (#182 decision 1)', () => {
    it('creates a Stock Material with a Minimum Stock, which its page shows and its created entry records', async () => {
      const res = await createMaterial(creation(ream, true, { note: 'ใช้ทั่วไป', minimum_stock: '10' }));

      expect(res.statusCode).toBe(201);
      const page = await materialOf(res.json().stock_material_id);
      expect(page.minimum_stock).toBe('10');
      expect(page.history[0].changes.map(({ field }: { field: string }) => field)).toEqual(['name', 'note', 'minimum_stock', 'units']);
      expect(page.history[0].changes).toContainEqual({ field: 'minimum_stock', before: null, after: '10' });
    });

    it('needs none: a Minimum Stock left out or null stays blank, and the created entry lists none (MC-20)', async () => {
      for (const payload of [creation(ream, true), creation(ream, true, { minimum_stock: null })]) {
        const page = await materialOf((await createMaterial(payload)).json().stock_material_id);

        expect(page.minimum_stock).toBeNull();
        expect(page.history[0].changes.map(({ field }: { field: string }) => field)).toEqual(['name', 'units']);
      }
    });

    it('keeps a fraction when the Base Unit allows fractions, and refuses it when the Base Unit is whole-number-only (P3)', async () => {
      const page = await materialOf((await createMaterial(creation(litre, false, { minimum_stock: '2.75' }))).json().stock_material_id);
      expect(page.minimum_stock).toBe('2.75');

      await expectCreateRefused(creation(ream, true, { minimum_stock: '2.5' }), 'minimum_stock must be a whole number while the Base Unit is whole-number-only');
      // A Base Unit is whole-number-only unless told otherwise (Q6).
      await expectCreateRefused({ name: 'กระดาษ', base_unit: { unit_id: ream }, minimum_stock: '0.5' }, 'minimum_stock must be a whole number');
    });

    it('refuses a Minimum Stock of zero or less, more than four decimal places, not a decimal, or too large', async () => {
      for (const [value, refusal] of [
        ['0', 'must be greater than 0'],
        ['-3', 'must be greater than 0'],
        ['1.23456', 'must have at most four decimal places'],
        ['ten', 'must be a decimal number'],
        ['100000000000000', 'is too large'],
      ]) {
        await expectCreateRefused(creation(litre, false, { minimum_stock: value }), `minimum_stock ${refusal}`);
      }
      await expectCreateRefused(creation(litre, false, { minimum_stock: 10 }), 'minimum_stock');
    });

    it('fingerprints the Minimum Stock with the rest of the request', async () => {
      const token = crypto.randomUUID();
      const payload = creation(ream, true, { minimum_stock: '10' });
      expect((await createMaterial(payload, token)).statusCode).toBe(201);
      const before = await materialCount();

      const res = await createMaterial({ ...payload, minimum_stock: '11' }, token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await materialCount()).toBe(before);
    });
  });

  describe('through other details', () => {
    it('sets a Minimum Stock without a reason, with the values before and after in history, and changes nothing else', async () => {
      const page = await materialIn(ream, true);
      expect(page.minimum_stock).toBeNull();

      const res = await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 2 });
      const after = await materialOf(page.id);
      expect(after).toEqual({ ...page, version: 2, minimum_stock: '10', history: [...page.history, expect.anything()] });
      expect(after.history[1]).toEqual({
        version: 2,
        kind: 'DETAILS_CHANGED',
        changes: [{ field: 'minimum_stock', before: null, after: '10' }],
        reason: null,
        note: null,
        recorded_by: officer.id,
        recorded_by_username: 'officer_minimum',
        recorded_at: expect.any(String),
      });
    });

    it('clears a Minimum Stock, which stays blank, and sets it again', async () => {
      const page = await materialIn(ream, true);
      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' })).statusCode).toBe(200);

      expect((await changeDetails(page.id, { ...detailsAsRead(page), expected_version: 2, minimum_stock: null })).statusCode).toBe(200);
      const cleared = await materialOf(page.id);
      expect(cleared.minimum_stock).toBeNull();
      expect(cleared.history[2].changes).toEqual([{ field: 'minimum_stock', before: '10', after: null }]);

      expect((await changeDetails(page.id, { ...detailsAsRead(cleared), minimum_stock: '4' })).statusCode).toBe(200);
      expect((await materialOf(page.id)).history[3].changes).toEqual([{ field: 'minimum_stock', before: null, after: '4' }]);
    });

    it('keeps a fraction exactly to four decimal places when the Base Unit allows fractions, without trailing zeros', async () => {
      const page = await materialIn(litre, false);

      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '2.5000' })).statusCode).toBe(200);
      expect((await materialOf(page.id)).minimum_stock).toBe('2.5');
      expect((await changeDetails(page.id, { ...detailsAsRead(page), expected_version: 2, minimum_stock: '0.0001' })).statusCode).toBe(200);
      expect((await materialOf(page.id)).minimum_stock).toBe('0.0001');
    });

    it('takes a whole number written with zero decimals when the Base Unit is whole-number-only', async () => {
      const page = await materialIn(ream, true);

      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '12.00' })).statusCode).toBe(200);
      expect((await materialOf(page.id)).minimum_stock).toBe('12');
    });

    it('refuses a Minimum Stock of zero or less, more than four decimal places, not a decimal, or too large, never rounding', async () => {
      const page = await materialIn(litre, false);

      for (const [value, refusal] of [
        ['0', 'must be greater than 0'],
        ['0.0000', 'must be greater than 0'],
        ['-1', 'must be greater than 0'],
        ['1.00001', 'must have at most four decimal places'],
        ['2.50000', 'must have at most four decimal places'],
        ['abc', 'must be a decimal number'],
        ['', 'must be a decimal number'],
        [' 2', 'must be a decimal number'],
        ['1e3', 'must be a decimal number'],
        ['100000000000000', 'is too large'],
      ]) {
        await expectDetailsRefused(page.id, { ...detailsAsRead(page), minimum_stock: value }, `minimum_stock ${refusal}`);
      }
    });

    it('refuses a fraction while the Base Unit is whole-number-only (P3)', async () => {
      const page = await materialIn(ream, true);

      await expectDetailsRefused(page.id, { ...detailsAsRead(page), minimum_stock: '2.5' }, 'minimum_stock must be a whole number while the Base Unit is whole-number-only');
    });

    it('refuses a details write that changes nothing, the same Minimum Stock written otherwise included', async () => {
      const page = await materialIn(ream, true);
      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' })).statusCode).toBe(200);
      const after = await materialOf(page.id);

      await expectDetailsRefused(page.id, detailsAsRead(after), 'changes nothing');
      await expectDetailsRefused(page.id, { ...detailsAsRead(after), minimum_stock: '10.000' }, 'changes nothing');
    });

    it('lists only what changed when the Minimum Stock changes with the note', async () => {
      const page = await materialIn(ream, true, { note: 'เดิม' });

      expect((await changeDetails(page.id, { ...detailsAsRead(page), note: 'ใหม่', minimum_stock: '3' })).statusCode).toBe(200);

      expect((await materialOf(page.id)).history[1].changes).toEqual([
        { field: 'note', before: 'เดิม', after: 'ใหม่' },
        { field: 'minimum_stock', before: null, after: '3' },
      ]);
    });

    it('needs the Minimum Stock stated, as a decimal string or null', async () => {
      const page = await materialIn(ream, true);
      const { minimum_stock: _minimumStock, ...unstated } = detailsAsRead(page);

      await expectDetailsRefused(page.id, { ...unstated, note: 'ใหม่' }, 'minimum_stock');
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), minimum_stock: 10 }, 'minimum_stock');
    });
  });

  describe('the Units write (P3; #182 decision 2)', () => {
    it('refuses making the Base Unit whole-number-only while the Minimum Stock has a fraction, naming the field', async () => {
      const page = await materialIn(litre, false, { minimum_stock: '2.5' });
      const payload = unitsAsRead(page);

      await expectUnitsRefused(page.id, { ...payload, base_unit: { ...payload.base_unit, whole_number_only: true } }, 'base_unit.whole_number_only');
      const res = await replaceUnits(page.id, { ...payload, base_unit: { ...payload.base_unit, whole_number_only: true } });
      expect(res.json().message).toContain('Minimum Stock 2.5');
    });

    it('makes the Base Unit whole-number-only while the Minimum Stock is whole, or none', async () => {
      for (const minimumStock of ['3', null]) {
        const page = await materialIn(litre, false, { minimum_stock: minimumStock });
        const payload = unitsAsRead(page);

        expect((await replaceUnits(page.id, { ...payload, base_unit: { ...payload.base_unit, whole_number_only: true } })).statusCode).toBe(200);
        expect(await materialOf(page.id)).toMatchObject({ minimum_stock: minimumStock, units: [{ unit_id: litre, whole_number_only: true }] });
      }
    });

    it('keeps a fraction while the Base Unit keeps allowing fractions, and records no Minimum Stock change', async () => {
      const page = await materialIn(litre, false, { alternate_units: [{ unit_id: box, conversion_factor: '20' }], minimum_stock: '2.5' });
      const payload = unitsAsRead(page);

      expect((await replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '18.5' }] })).statusCode).toBe(200);

      const after = await materialOf(page.id);
      expect(after.minimum_stock).toBe('2.5');
      expect(after.history[1].changes.map(({ field }: { field: string }) => field)).toEqual(['units']);
    });

    it('takes the Minimum Stock again in the new Base Unit when the Base Unit changes, with both in history', async () => {
      // 10 รีม is 2 กล่อง.
      const page = await paperWithMinimum();

      const res = await replaceUnits(page.id, boxAsBase({ minimum_stock: '2' }));

      expect(res.statusCode).toBe(200);
      const after = await materialOf(page.id);
      expect(after.minimum_stock).toBe('2');
      expect(after.history[1].kind).toBe('UNITS_CHANGED');
      expect(after.history[1].changes.map(({ field }: { field: string }) => field)).toEqual(['units', 'minimum_stock']);
      expect(after.history[1].changes[1]).toEqual({ field: 'minimum_stock', before: '10', after: '2' });
    });

    it('records the Minimum Stock stated again with the same number, which now counts another Base Unit', async () => {
      const page = await paperWithMinimum();

      expect((await replaceUnits(page.id, boxAsBase({ minimum_stock: '10' }))).statusCode).toBe(200);

      expect((await materialOf(page.id)).history[1].changes[1]).toEqual({ field: 'minimum_stock', before: '10', after: '10' });
    });

    it('clears the Minimum Stock when the Base Unit changes and the request says none', async () => {
      const page = await paperWithMinimum();

      expect((await replaceUnits(page.id, boxAsBase({ minimum_stock: null }))).statusCode).toBe(200);

      const after = await materialOf(page.id);
      expect(after.minimum_stock).toBeNull();
      expect(after.history[1].changes[1]).toEqual({ field: 'minimum_stock', before: '10', after: null });
    });

    it('takes a whole Minimum Stock in a new whole-number-only Base Unit, the fraction it had in the old one notwithstanding', async () => {
      // 2.5 ลิตร is 2500 มิลลิลิตร, counted whole.
      const millilitre = await unitNamed(`มิลลิลิตร ${crypto.randomUUID().slice(0, 8)}`);
      const page = await materialIn(litre, false, { minimum_stock: '2.5' });

      const res = await replaceUnits(page.id, {
        expected_version: 1,
        base_unit: { unit_id: millilitre, whole_number_only: true },
        alternate_units: [{ unit_id: litre, conversion_factor: '1000', whole_number_only: false, is_active: true }],
        minimum_stock: '2500',
      });

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).minimum_stock).toBe('2500');
    });

    it('refuses a Base Unit change that does not state the Minimum Stock again, so 10 รีม never becomes 10 กล่อง', async () => {
      const page = await paperWithMinimum();

      await expectUnitsRefused(page.id, boxAsBase(), 'minimum_stock must be stated again in the new Base Unit');
    });

    it('lets a Base Unit change leave out a Minimum Stock there is none of, keeping none and recording none', async () => {
      const page = await materialIn(ream, true, { alternate_units: [{ unit_id: box, conversion_factor: '5' }] });

      expect((await replaceUnits(page.id, boxAsBase())).statusCode).toBe(200);

      const after = await materialOf(page.id);
      expect(after.minimum_stock).toBeNull();
      expect(after.history[1].changes.map(({ field }: { field: string }) => field)).toEqual(['units']);
    });

    it('checks the Minimum Stock stated again against the new Base Unit: a fraction only where it allows fractions', async () => {
      const page = await paperWithMinimum();
      // แผ่น, counted whole: 1 รีม = 500 แผ่น, 1 กล่อง = 2500 แผ่น.
      const sheetAsBase = (minimumStock: string) =>
        boxAsBase({
          base_unit: { unit_id: sheet, whole_number_only: true },
          alternate_units: [
            { unit_id: ream, conversion_factor: '500', whole_number_only: true, is_active: true },
            { unit_id: box, conversion_factor: '2500', whole_number_only: true, is_active: true },
          ],
          minimum_stock: minimumStock,
        });

      await expectUnitsRefused(page.id, sheetAsBase('2.5'), 'minimum_stock must be a whole number while the Base Unit is whole-number-only');
      await expectUnitsRefused(page.id, boxAsBase({ minimum_stock: '0' }), 'minimum_stock must be greater than 0');
      expect((await replaceUnits(page.id, boxAsBase({ minimum_stock: '2.5' }))).statusCode).toBe(200);
      expect((await materialOf(page.id)).minimum_stock).toBe('2.5');
    });

    it('refuses a Minimum Stock in a Units write that keeps the Base Unit, which other details change', async () => {
      const page = await paperWithMinimum();
      const payload = unitsAsRead(page);
      const changed = { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] };

      for (const minimumStock of ['20', '10', null]) {
        await expectUnitsRefused(page.id, { ...changed, minimum_stock: minimumStock }, 'minimum_stock changes through other details unless the Base Unit changes');
      }
    });

    it('fingerprints the Minimum Stock with the rest of the request', async () => {
      const page = await paperWithMinimum();
      const token = crypto.randomUUID();
      expect((await replaceUnits(page.id, boxAsBase({ minimum_stock: '2' }), token)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      for (const minimumStock of ['3', null]) {
        const res = await replaceUnits(page.id, boxAsBase({ minimum_stock: minimumStock }), token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('waits for a details write setting a fraction and then refuses making the Base Unit whole-number-only', async () => {
      const page = await materialIn(litre, false);
      const payload = unitsAsRead(page);

      const [res] = await whileWriting(
        // What a details write setting a Minimum Stock of 2.5 ลิตร commits, held uncommitted.
        { sql: `UPDATE stock_materials SET minimum_stock = 2.5, version = version + 1 WHERE id = $1`, params: [page.id] },
        // At the version that write leaves, so only the whole-number rule can refuse it.
        () => [replaceUnits(page.id, { ...payload, expected_version: 2, base_unit: { ...payload.base_unit, whole_number_only: true } })],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('base_unit.whole_number_only');
      expect((await materialOf(page.id)).units[0].whole_number_only).toBe(false);
    });

    it('waits for a details write setting a Minimum Stock and then refuses a Base Unit change that does not state it again', async () => {
      const page = await materialIn(ream, true, { alternate_units: [{ unit_id: box, conversion_factor: '5' }] });

      const [res] = await whileWriting(
        { sql: `UPDATE stock_materials SET minimum_stock = 10, version = version + 1 WHERE id = $1`, params: [page.id] },
        () => [replaceUnits(page.id, boxAsBase({ expected_version: 2 }))],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('minimum_stock must be stated again');
      expect((await materialOf(page.id)).units[0].unit_id).toBe(ream);
    });
  });

  describe('versions and the request of other details', () => {
    it('refuses a stale expected version with the current and expected versions, writing nothing (Q23)', async () => {
      const page = await materialIn(ream, true);
      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' })).statusCode).toBe(200);
      const before = await materialOf(page.id);

      const res = await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '20' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('waits for a Units write making the Base Unit whole-number-only and then refuses a fraction (P3)', async () => {
      const page = await materialIn(litre, false);

      const [res] = await whileWriting(
        // What a Units write that makes the Base Unit whole-number-only commits, held uncommitted.
        {
          sql: `WITH base AS (UPDATE stock_material_units SET whole_number_only = true WHERE stock_material_id = $1 AND is_base)
                UPDATE stock_materials SET version = version + 1 WHERE id = $1`,
          params: [page.id],
        },
        // At the version that write leaves, so only the whole-number rule can refuse it.
        () => [changeDetails(page.id, { ...detailsAsRead(page), expected_version: 2, minimum_stock: '2.5' })],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('minimum_stock must be a whole number while the Base Unit is whole-number-only');
      expect((await materialOf(page.id)).minimum_stock).toBeNull();
    });
  });

  describe('retry token of the Minimum Stock', () => {
    it('answers an identical replay with the committed result and writes nothing', async () => {
      const page = await materialIn(ream, true);
      const token = crypto.randomUUID();
      const first = await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' }, token);
      expect(first.statusCode).toBe(200);
      const before = await materialOf(page.id);

      const replay = await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' }, token);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('refuses the same token with another Minimum Stock, and writes nothing', async () => {
      const page = await materialIn(ream, true);
      const token = crypto.randomUUID();
      expect((await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: '10' }, token)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      for (const minimumStock of ['11', null]) {
        const res = await changeDetails(page.id, { ...detailsAsRead(page), minimum_stock: minimumStock }, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await materialOf(page.id)).toEqual(before);
    });
  });
});
