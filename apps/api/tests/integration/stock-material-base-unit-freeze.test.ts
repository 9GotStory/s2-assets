import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T5 (#236): Feature 008's Units write keeps the Base Unit of a Stock Material that has a Stock Movement, and
// still changes its Alternate Units for the future (#231 stories 53, 54, 62, Q15, Q28, MC-09, MC-21; start decisions,
// #236 comment 7157351764).
describe('Base Unit freeze (Seam A - F010-T5)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const { unitNamed, created, materialOf, replaceUnits, unitsAsRead } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));
  const receipts = materialReceiptHelpers(() => ({ api, officer, reader: readonly }));
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));

  // A Stock Material counted in รีม with fractions, with กล่อง of 5 รีม, each Unit new.
  const stocked = async () => {
    const ream = await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`);
    const box = await unitNamed(`กล่อง ${crypto.randomUUID().slice(0, 6)}`);
    const id = await created({
      name: `กระดาษ ${crypto.randomUUID().slice(0, 8)}`,
      base_unit: { unit_id: ream, whole_number_only: false },
      alternate_units: [{ unit_id: box, conversion_factor: '5', whole_number_only: false }],
    });
    return { id, ream, box };
  };

  // A Stock Material of `stocked` with two Stock Movements: an Opening Balance of 2 กล่อง (10 รีม) and a Material
  // Receipt of 1.5 รีม.
  const moved = async () => {
    const paper = await stocked();
    await openingBalances.confirmed([openingBalances.line(paper.id, paper.box, '2')]);
    await receipts.received([receipts.line(paper.id, paper.ream, '1.5')]);
    expect((await materialOf(paper.id)).current_stock).toBe('11.5');
    return paper;
  };

  // The Stock Movements of the Stock Material `id`, every one on a page.
  const movementsOf = async (id: string) => {
    const res = await api.get(readonly, `/stock-materials/${id}/stock-movements?limit=100`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The Base Unit of the Stock Material page `page`.
  const baseUnitOf = (page: { units: { unit_id: string; is_base: boolean }[] }) => page.units.find((unit) => unit.is_base)!.unit_id;

  // The Units write that makes กล่อง the Base Unit, with รีม at 0.2 กล่อง, at the version of the page `page`: valid in
  // every other rule, so only the Base Unit freeze refuses it.
  const baseChange = (page: { version: number }, paper: { ream: string; box: string }) => ({
    expected_version: page.version,
    base_unit: { unit_id: paper.box, whole_number_only: false },
    alternate_units: [{ unit_id: paper.ream, conversion_factor: '0.2', whole_number_only: false, is_active: true }],
  });

  // The Base Unit freeze's refusal of the Stock Material whose Base Unit is `baseUnitId` (story 53).
  const expectFrozen = (res: { statusCode: number; json: () => any }, baseUnitId: string) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'BASE_UNIT_FROZEN', message: `base_unit.unit_id must stay ${baseUnitId}: a Stock Material with a Stock Movement keeps its Base Unit` });
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_base_unit_freeze', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_base_unit_freeze', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('the refusal (story 53, Q15, MC-21)', () => {
    it('refuses a Base Unit change once an Opening Balance is confirmed, and leaves the Stock Material as it was', async () => {
      const paper = await stocked();
      await openingBalances.confirmed([openingBalances.line(paper.id, paper.box, '2')]);
      const before = await materialOf(paper.id);

      expectFrozen(await replaceUnits(paper.id, baseChange(before, paper)), paper.ream);
      expect(await materialOf(paper.id)).toEqual(before);
    });

    it('refuses a Base Unit change once a Material Receipt is Received, and leaves the Stock Material as it was', async () => {
      const paper = await stocked();
      await receipts.received([receipts.line(paper.id, paper.ream, '1.5')]);
      const before = await materialOf(paper.id);

      expectFrozen(await replaceUnits(paper.id, baseChange(before, paper)), paper.ream);
      expect(await materialOf(paper.id)).toEqual(before);
    });
  });

  describe('a Base Unit change still allowed (Q15)', () => {
    it('changes the Base Unit of a Stock Material with no Stock Movement, while others have one', async () => {
      await moved();
      const paper = await stocked();

      expect((await replaceUnits(paper.id, baseChange(await materialOf(paper.id), paper))).statusCode).toBe(200);
      expect(baseUnitOf(await materialOf(paper.id))).toBe(paper.box);
    });

    it('changes the Base Unit of a Stock Material that has only a Draft Opening Balance and a Draft Material Receipt', async () => {
      const paper = await stocked();
      await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.box, '2')]));
      await receipts.draft(receipts.complete([receipts.line(paper.id, paper.ream, '1.5')]));
      expect(await materialOf(paper.id)).toMatchObject({ current_stock: null, has_stock_movement: false });

      expect((await replaceUnits(paper.id, baseChange(await materialOf(paper.id), paper))).statusCode).toBe(200);
      expect(baseUnitOf(await materialOf(paper.id))).toBe(paper.box);
    });
  });

  describe('Alternate Units after a Stock Movement (story 54, MC-09)', () => {
    // Sends the Units write that `change` makes of the Stock Material's page as read, and expects it written with every
    // earlier Stock Movement, its Conversion Snapshot, Base Quantity and balance after it, and the Current Stock as
    // they were. Answers the page after it.
    const expectWrittenForTheFuture = async (id: string, change: (write: ReturnType<typeof unitsAsRead>) => Record<string, unknown>) => {
      const movements = await movementsOf(id);
      expect(movements.total_count).toBe(2);
      const res = await replaceUnits(id, change(unitsAsRead(await materialOf(id))));
      expect(res.statusCode).toBe(200);
      expect(await movementsOf(id)).toEqual(movements);
      const page = await materialOf(id);
      expect(page.current_stock).toBe('11.5');
      return page;
    };

    it('adds an Alternate Unit', async () => {
      const paper = await moved();
      const pack = await unitNamed(`แพ็ค ${crypto.randomUUID().slice(0, 6)}`);

      const page = await expectWrittenForTheFuture(paper.id, (write) => ({
        ...write,
        alternate_units: [...write.alternate_units, { unit_id: pack, conversion_factor: '2.5', whole_number_only: true, is_active: true }],
      }));
      expect(page.units).toContainEqual(expect.objectContaining({ unit_id: pack, is_base: false, conversion_factor: '2.5', is_active: true }));
    });

    it('changes a Conversion Factor', async () => {
      const paper = await moved();

      const page = await expectWrittenForTheFuture(paper.id, (write) => ({ ...write, alternate_units: [{ ...write.alternate_units[0], conversion_factor: '6' }] }));
      expect(page.units).toContainEqual(expect.objectContaining({ unit_id: paper.box, conversion_factor: '6' }));
    });

    it('makes an Alternate Unit Inactive and reactivates it', async () => {
      const paper = await moved();

      const inactive = await expectWrittenForTheFuture(paper.id, (write) => ({ ...write, alternate_units: [{ ...write.alternate_units[0], is_active: false }] }));
      expect(inactive.units).toContainEqual(expect.objectContaining({ unit_id: paper.box, is_active: false }));
      const reactivated = await expectWrittenForTheFuture(paper.id, (write) => ({ ...write, alternate_units: [{ ...write.alternate_units[0], is_active: true }] }));
      expect(reactivated.units).toContainEqual(expect.objectContaining({ unit_id: paper.box, conversion_factor: '5', is_active: true }));
    });

    it('changes the whole-number rule of the Base Unit and of an Alternate Unit', async () => {
      const paper = await moved();

      const page = await expectWrittenForTheFuture(paper.id, (write) => ({
        ...write,
        base_unit: { ...write.base_unit, whole_number_only: true },
        alternate_units: [{ ...write.alternate_units[0], whole_number_only: true }],
      }));
      expect(page.units).toContainEqual(expect.objectContaining({ unit_id: paper.ream, is_base: true, whole_number_only: true }));
      expect(page.units).toContainEqual(expect.objectContaining({ unit_id: paper.box, whole_number_only: true }));
    });
  });

  // The lock-order plan (start comment 7157351764, rows 1 and 2): a Units write locks the Stock Material FOR UPDATE and
  // reads Has a Stock Movement after it; a confirm locks the same row before it adds its Stock Movements (P4). Each test
  // holds that row, queues the confirm and then the Units write, and shows that the Units write sees the confirm. The
  // confirm leaves the Stock Material's version as it was, so the write passes every rule checked before the freeze.
  // The other order, a confirm behind a Base Unit change, is in opening-balance-order.test.ts and
  // material-receipt-order.test.ts.
  describe('a Base Unit change behind a confirm of the same Stock Material (story 62, P4)', () => {
    it('is refused after an Opening Balance confirm, which counts in the Base Unit it found', async () => {
      const paper = await stocked();
      const id = await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.box, '2')]));
      const page = await materialOf(paper.id);

      const [confirmed, units] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [openingBalances.confirm(id, 1), untilWaiting('stock_materials').then(() => replaceUnits(paper.id, baseChange(page, paper)))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(confirmed.statusCode).toBe(200);
      expectFrozen(units, paper.ream);
      expect(baseUnitOf(await materialOf(paper.id))).toBe(paper.ream);
      expect((await openingBalances.openingBalanceOf(id)).lines[0].stock_movements[0]).toMatchObject({
        base_unit: { unit_id: paper.ream },
        conversion_factor: '5',
        base_quantity: '10',
      });
    });

    it('is refused after a Material Receipt confirm, which counts in the Base Unit it found', async () => {
      const paper = await stocked();
      const id = await receipts.draft(receipts.complete([receipts.line(paper.id, paper.box, '2')]));
      const page = await materialOf(paper.id);

      const [confirmed, units] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [receipts.confirm(id, 1), untilWaiting('stock_materials').then(() => replaceUnits(paper.id, baseChange(page, paper)))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(confirmed.statusCode).toBe(200);
      expectFrozen(units, paper.ream);
      expect(baseUnitOf(await materialOf(paper.id))).toBe(paper.ream);
      expect((await receipts.receiptOf(id)).lines[0].stock_movements[0]).toMatchObject({
        base_unit: { unit_id: paper.ream },
        conversion_factor: '5',
        base_quantity: '10',
      });
    });
  });
});
