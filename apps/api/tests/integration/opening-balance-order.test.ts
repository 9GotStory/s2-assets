import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T2 (#233): each rule an Opening Balance write reads under a lock, against every write that changes its fact
// (CODING_STANDARDS, "A rule read under a lock has a test of its order"; the lock-order plan, #233 comment 7122742883,
// rows 1–15). A confirm locks the Opening Balance FOR UPDATE, then its Stock Materials by id FOR UPDATE, then their
// Units' list entries FOR SHARE (#231 P4); a replace and a remove lock the Opening Balance. Each test queues the
// changing write first and shows that the rule sees its result, passing every rule checked before it.
describe('Opening Balance write order (Seam A - F010-T2)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const { unitNamed, created, materialOf, unitsAsRead, replaceUnits, correct } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { draft, line, complete, openingBalanceOf, replaceDraft, removeDraft, confirm } = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));
  const { whileHolding, whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A Stock Material counted in รีม with fractions, with กล่อง of 5 รีม, counted with fractions too, each Unit new.
  const stocked = async () => {
    const ream = await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`);
    const box = await unitNamed(`กล่อง ${crypto.randomUUID().slice(0, 6)}`);
    const name = `กระดาษ ${crypto.randomUUID().slice(0, 8)}`;
    const id = await created({
      name,
      base_unit: { unit_id: ream, whole_number_only: false },
      alternate_units: [{ unit_id: box, conversion_factor: '5', whole_number_only: false }],
    });
    return { id, name, ream, box };
  };

  // A Draft of one line of 2 กล่อง that confirms, and its Stock Material.
  const ready = async () => {
    const paper = await stocked();
    return { paper, id: await draft(complete([line(paper.id, paper.box, '2')])) };
  };

  // The Units write of the Stock Material `id` with its one Alternate Unit changed by `change`, at its version.
  const unitsChanged = async (id: string, change: Record<string, unknown>) => {
    const write = unitsAsRead(await materialOf(id));
    return { ...write, alternate_units: [{ ...write.alternate_units[0], ...change }] };
  };

  // A confirm refused for the one problem `problem`.
  const expectRefusedFor = (res: { statusCode: number; json: () => any }, problem: { field: string; message: string }) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_CONFIRMABLE', message: `The Opening Balance cannot be confirmed: ${problem.message}` });
    expect(res.json().problems).toEqual([problem]);
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_opening_order', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_opening_order', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a confirm behind a write of the same Opening Balance (rows 1–3)', () => {
    it('confirms only after a replace, then refuses the version it read as stale', async () => {
      const { paper, id } = await ready();
      const [replaced, res] = await whileHolding(
        'opening_balances',
        id,
        () => [replaceDraft(id, { ...complete([line(paper.id, paper.ream, '1')]), expected_version: 1 }), untilWaiting('opening_balances').then(() => confirm(id, 1))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(replaced.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 2, state: 'DRAFT' } });
    });

    it('confirms only after another confirm, then refuses it as no longer a Draft at the version that confirm left', async () => {
      const { id } = await ready();
      const [first, res] = await whileHolding(
        'opening_balances',
        id,
        () => [confirm(id, 1), untilWaiting('opening_balances').then(() => confirm(id, 2))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(first.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_DRAFT', message: 'The Opening Balance is confirmed: only a Draft can be replaced, removed or confirmed', current_values: { version: 2, state: 'CONFIRMED' } });
      expect((await openingBalanceOf(id)).lines[0].stock_movements).toHaveLength(1);
    });

    it('confirms only after a remove, then finds no Opening Balance', async () => {
      const { id } = await ready();
      const [removed, res] = await whileHolding(
        'opening_balances',
        id,
        () => [removeDraft(id, 1), untilWaiting('opening_balances').then(() => confirm(id, 1))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(removed.statusCode).toBe(200);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
    });
  });

  describe('a confirm behind a write of its Stock Material (rows 4–9)', () => {
    it('confirms only after another Opening Balance of the same Stock Material, then refuses it as in effect there: exactly one is in effect (Q28, story 63)', async () => {
      const paper = await stocked();
      const first = await draft(complete([line(paper.id, paper.ream, '3')]));
      const second = await draft(complete([line(paper.id, paper.ream, '4')]));
      const [won, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [confirm(first, 1), untilWaiting('stock_materials').then(() => confirm(second, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(won.statusCode).toBe(200);
      const number = won.json().opening_balance_number;
      expectRefusedFor(res, {
        field: 'lines[0].stock_material_id',
        message: `lines[0].stock_material_id names ${paper.name}, a Stock Material with a Stock Movement in effect, from Opening Balance ${number}`,
        in_effect_opening_balance: { opening_balance_id: first, opening_balance_number: number },
      } as any);
      expect((await materialOf(paper.id)).current_stock).toBe('3');
    });

    it('confirms only after a Units write makes its Unit Inactive, then refuses it', async () => {
      const { paper, id } = await ready();
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [unitsChanged(paper.id, { is_active: false }).then((write) => replaceUnits(paper.id, write)), untilWaiting('stock_materials').then(() => confirm(id, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expectRefusedFor(res, { field: 'lines[0].unit_id', message: 'lines[0].unit_id names a Unit that is not active on its Stock Material' });
    });

    it('confirms only after a Units write changes its Conversion Factor, then snapshots the new one', async () => {
      const { paper, id } = await ready();
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [unitsChanged(paper.id, { conversion_factor: '10' }).then((write) => replaceUnits(paper.id, write)), untilWaiting('stock_materials').then(() => confirm(id, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await openingBalanceOf(id)).lines[0].stock_movements[0]).toMatchObject({ conversion_factor: '10', base_quantity: '20' });
    });

    it('confirms only after a Units write makes its Unit whole-number, then refuses a fraction in it', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '0.5')]));
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [unitsChanged(paper.id, { whole_number_only: true }).then((write) => replaceUnits(paper.id, write)), untilWaiting('stock_materials').then(() => confirm(id, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expectRefusedFor(res, { field: 'lines[0].quantity', message: 'lines[0].quantity must be a whole number in its Unit' });
    });

    it('confirms only after a Units write changes the Base Unit, then snapshots the new Base Unit and factor (#231 story 62)', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.ream, '5')]));
      const page = await materialOf(paper.id);
      const baseChange = {
        expected_version: page.version,
        base_unit: { unit_id: paper.box, whole_number_only: false },
        alternate_units: [{ unit_id: paper.ream, conversion_factor: '0.2', whole_number_only: false, is_active: true }],
        minimum_stock: null,
      };
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [replaceUnits(paper.id, baseChange), untilWaiting('stock_materials').then(() => confirm(id, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await openingBalanceOf(id)).lines[0].stock_movements[0]).toMatchObject({
        base_unit: { unit_id: paper.box, name: expect.any(String) },
        conversion_factor: '0.2',
        base_quantity: '1',
      });
    });

    it('confirms only after a Material Correction renames the Stock Material, then records the new name (#175 P6)', async () => {
      const { paper, id } = await ready();
      const renamed = `กระดาษถ่ายเอกสาร ${crypto.randomUUID().slice(0, 6)}`;
      const page = await materialOf(paper.id);
      const [corrected, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [
          correct(paper.id, { expected_version: page.version, name: renamed, brand_id: null, model: null, specification: null, reason: 'สะกดผิด', explicit_continuation: true }),
          untilWaiting('stock_materials').then(() => confirm(id, 1)),
        ],
        () => untilWaiting('stock_materials', 2)
      );
      expect(corrected.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await openingBalanceOf(id)).history[0].facts.lines[0].stock_material).toEqual({ id: paper.id, name: renamed });
    });
  });

  describe("a confirm behind a rename of its Unit's list entry (row 10)", () => {
    it('confirms only after the rename, then records the new name (#175 P6)', async () => {
      const { paper, id } = await ready();
      const renamed = `ลัง ${crypto.randomUUID().slice(0, 6)}`;
      const [res] = await whileWriting(
        { sql: 'UPDATE units SET name = $2, version = version + 1 WHERE id = $1', params: [paper.box, renamed] },
        () => [confirm(id, 1)],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );
      expect(res.statusCode).toBe(200);
      expect((await openingBalanceOf(id)).history[0].facts.lines[0].unit).toEqual({ id: paper.box, name: renamed });
    });
  });

  describe('a replace or a remove behind a write of the same Opening Balance (rows 11–15)', () => {
    it('replaces only after another replace, then refuses the version it read as stale', async () => {
      const { id } = await ready();
      const [first, res] = await whileHolding(
        'opening_balances',
        id,
        () => [replaceDraft(id, { expected_version: 1, lines: [] }), untilWaiting('opening_balances').then(() => replaceDraft(id, { expected_version: 1, source: 'ช้าไป', lines: [] }))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(first.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 2, state: 'DRAFT' } });
    });

    it('replaces only after a confirm, then refuses it as no longer a Draft', async () => {
      const { id } = await ready();
      const [confirmedRes, res] = await whileHolding(
        'opening_balances',
        id,
        () => [confirm(id, 1), untilWaiting('opening_balances').then(() => replaceDraft(id, { expected_version: 2, lines: [] }))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(confirmedRes.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_DRAFT', message: 'The Opening Balance is confirmed: only a Draft can be replaced, removed or confirmed', current_values: { version: 2, state: 'CONFIRMED' } });
    });

    it('replaces only after a remove, then finds no Opening Balance', async () => {
      const { id } = await ready();
      const [removed, res] = await whileHolding(
        'opening_balances',
        id,
        () => [removeDraft(id, 1), untilWaiting('opening_balances').then(() => replaceDraft(id, { expected_version: 1, lines: [] }))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(removed.statusCode).toBe(200);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
    });

    it('removes only after a replace, then refuses the version it read as stale', async () => {
      const { id } = await ready();
      const [replaced, res] = await whileHolding(
        'opening_balances',
        id,
        () => [replaceDraft(id, { expected_version: 1, lines: [] }), untilWaiting('opening_balances').then(() => removeDraft(id, 1))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(replaced.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 2, state: 'DRAFT' } });
      expect((await openingBalanceOf(id)).state).toBe('DRAFT');
    });

    it('removes only after a confirm, then refuses it as no longer a Draft, keeping the Stock Movement', async () => {
      const { paper, id } = await ready();
      const [confirmedRes, res] = await whileHolding(
        'opening_balances',
        id,
        () => [confirm(id, 1), untilWaiting('opening_balances').then(() => removeDraft(id, 2))],
        () => untilWaiting('opening_balances', 2)
      );
      expect(confirmedRes.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_DRAFT', message: 'The Opening Balance is confirmed: only a Draft can be replaced, removed or confirmed', current_values: { version: 2, state: 'CONFIRMED' } });
      expect((await materialOf(paper.id)).current_stock).toBe('10');
    });
  });
});
