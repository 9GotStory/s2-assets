import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T2 (#233): the Stock Material list and page show Current Stock (คงเหลือ) and Low Stock (ต่ำกว่าขั้นต่ำ), summed
// from the Stock Movements on every read, and the list filters Low Stock (#231 MSL-01, MSL-03, MSL-06, MC-19, MC-20,
// Q14, Q22, P3).
describe('Current Stock and Low Stock (Seam A - F010-T2)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const { unitNamed, created, materialOf, changeDetails } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { line, confirmed } = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));

  // A Stock Material named with `tag`, counted in a new Unit with fractions, with `minimumStock` or none, and its Unit.
  const material = async (tag: string, minimumStock: string | null) => {
    const unit = await unitNamed();
    const id = await created({ name: `${tag} ${crypto.randomUUID().slice(0, 6)}`, base_unit: { unit_id: unit, whole_number_only: false }, minimum_stock: minimumStock });
    return { id, unit };
  };

  // The list rows found by `tag`, as `query` filters them, by id.
  const rowsOf = async (tag: string, query = '') => {
    const res = await api.get(readonly, `/stock-materials?search=${encodeURIComponent(tag)}&${query}`);
    expect(res.statusCode).toBe(200);
    return new Map(res.json().items.map((row: any) => [row.id, row]));
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_current_stock', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_current_stock', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  it('shows no Current Stock and never Low Stock for a Stock Material with no Stock Movement, a Minimum Stock set or not (Q22)', async () => {
    const tag = `ยังไม่เคลื่อนไหว${crypto.randomUUID().slice(0, 6)}`;
    const withMinimum = await material(tag, '10');
    const without = await material(tag, null);

    const rows = await rowsOf(tag);
    for (const { id } of [withMinimum, without]) {
      expect(rows.get(id)).toMatchObject({ current_stock: null, has_stock_movement: false, low_stock: false });
      expect(await materialOf(id)).toMatchObject({ current_stock: null, has_stock_movement: false, low_stock: false });
    }
    expect((await rowsOf(tag, 'low_stock=true')).size).toBe(0);
  });

  it('sums the Base Quantities into Current Stock, Low Stock only below a set Minimum Stock, on the list, the page and the Low Stock filter (MC-20)', async () => {
    const tag = `คงเหลือ${crypto.randomUUID().slice(0, 6)}`;
    const below = await material(tag, '10');
    const equal = await material(tag, '2.5');
    const above = await material(tag, '1');
    const noMinimum = await material(tag, null);
    await confirmed([line(below.id, below.unit, '9.9999'), line(equal.id, equal.unit, '2.5'), line(above.id, above.unit, '1.25'), line(noMinimum.id, noMinimum.unit, '0.5')]);

    const expected = [
      [below.id, '9.9999', true],
      [equal.id, '2.5', false],
      [above.id, '1.25', false],
      [noMinimum.id, '0.5', false],
    ] as const;
    const rows = await rowsOf(tag);
    for (const [id, currentStock, lowStock] of expected) {
      expect(rows.get(id)).toMatchObject({ current_stock: currentStock, has_stock_movement: true, low_stock: lowStock });
      expect(await materialOf(id)).toMatchObject({ current_stock: currentStock, has_stock_movement: true, low_stock: lowStock });
    }
    expect([...(await rowsOf(tag, 'low_stock=true')).keys()]).toEqual([below.id]);
  });

  it('works out Low Stock again on the next read when the Minimum Stock changes, with no stored copy (MSL-06)', async () => {
    const tag = `ขั้นต่ำใหม่${crypto.randomUUID().slice(0, 6)}`;
    const paper = await material(tag, '1');
    await confirmed([line(paper.id, paper.unit, '3')]);
    expect((await materialOf(paper.id)).low_stock).toBe(false);

    const page = await materialOf(paper.id);
    expect((await changeDetails(paper.id, { expected_version: page.version, material_category_id: null, note: null, minimum_stock: '5' })).statusCode).toBe(200);
    expect((await materialOf(paper.id)).low_stock).toBe(true);
    expect([...(await rowsOf(tag, 'low_stock=true')).keys()]).toEqual([paper.id]);
  });

  it('combines the Low Stock filter with the others, and refuses a value it does not know', async () => {
    const tag = `กรองรวม${crypto.randomUUID().slice(0, 6)}`;
    const paper = await material(tag, '10');
    await confirmed([line(paper.id, paper.unit, '1')]);
    expect([...(await rowsOf(tag, 'low_stock=true&minimum_stock=set&status=all')).keys()]).toEqual([paper.id]);
    expect((await rowsOf(tag, 'low_stock=true&minimum_stock=not_set')).size).toBe(0);
    expect((await rowsOf(tag, 'low_stock=true&status=inactive')).size).toBe(0);

    const refused = await api.get(readonly, '/stock-materials?low_stock=false');
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('low_stock') });
  });
});
