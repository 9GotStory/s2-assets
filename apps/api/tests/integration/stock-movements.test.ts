import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T4 (#235): a Stock Material's Stock Movements (รายการเคลื่อนไหว) through the composed application with real
// PostgreSQL (Seam A): each row's facts, the running balance in the business timeline, the Fiscal Year filter and the
// Fiscal Years offered, paging and permissions (#231 MSL-05, MSL-07, MSL-09–MSL-12, Q3, Q16, Q23, P3, P6; start
// comment 7152306861).
describe('Stock Movements of a Stock Material (Seam A - F010-T4)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let requester: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  const now = new Date('2026-11-25T10:00:00+07:00');

  const { unitNamed, created, materialOf, inactivate } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const receipts = materialReceiptHelpers(() => ({ api, officer, reader: readonly }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));

  // A Stock Material counted in รีม, with กล่อง of 5 รีม as an Alternate Unit, each Unit new and named.
  const stocked = async () => {
    const reamName = `รีม ${crypto.randomUUID().slice(0, 6)}`;
    const boxName = `กล่อง ${crypto.randomUUID().slice(0, 6)}`;
    const ream = await unitNamed(reamName);
    const box = await unitNamed(boxName);
    const id = await created({ name: `กระดาษ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: ream, whole_number_only: false }, alternate_units: [{ unit_id: box, conversion_factor: '5' }] });
    return { id, ream, reamName, box, boxName };
  };

  // A Stock Material counted in รีม with `alternates` more Units of 2, 3, … รีม: the Unit ids, Base Unit first.
  const withUnits = async (alternates: number) => {
    const units = [await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`)];
    for (let i = 0; i < alternates; i++) {
      units.push(await unitNamed(`ห่อ${i + 2} ${crypto.randomUUID().slice(0, 6)}`));
    }
    const id = await created({
      name: `กระดาษ ${crypto.randomUUID().slice(0, 8)}`,
      base_unit: { unit_id: units[0], whole_number_only: false },
      alternate_units: units.slice(1).map((unit, i) => ({ unit_id: unit, conversion_factor: String(i + 2) })),
    });
    return { id, units };
  };

  // The rows of `page`, each as its kind, source number, signed Base Quantity and balance after it.
  const timeline = (page: { items: any[] }) => page.items.map((row) => [row.kind, row.source.number, row.base_quantity, row.balance]);

  // The Stock Movements page of the Stock Material `id` as `query` asks for it.
  const movementsOf = async (id: string, query = '', actor: Actor = readonly) => {
    const res = await api.get(actor, `/stock-materials/${id}/stock-movements?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    officer = await api.actor('officer_stock_movements', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_stock_movements', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_stock_movements', 'READ_ONLY');
    requester = await api.actor('requester_stock_movements', 'REQUESTER');
    custodian = await api.actor('custodian_stock_movements', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_stock_movements', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_stock_movements', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a row (MSL-05, MSL-07, Q23, P6)', () => {
    it('gives each Stock Movement its kind, Effective Date, source, Original Quantity and Unit, Conversion Snapshot, signed Base Quantity, balance after it, and who recorded it and when', async () => {
      const paper = await stocked();
      const before = new Date();
      const openingBalance = await openingBalances.confirmed([openingBalances.line(paper.id, paper.box, '3')], { as_of_date: '2025-09-01' });
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '2.5')], { received_date: '2025-10-15' });
      const after = new Date();

      const page = await movementsOf(paper.id);
      expect(page).toMatchObject({ limit: 25, offset: 0, total_count: 2, has_more: false });
      expect(page.items).toEqual([
        {
          id: expect.any(String),
          kind: 'OPENING_BALANCE',
          effective_date: '2025-09-01',
          source: { kind: 'OPENING_BALANCE', id: openingBalance.id, number: openingBalance.number },
          original_quantity: '3',
          original_unit: { unit_id: paper.box, name: paper.boxName },
          base_unit: { unit_id: paper.ream, name: paper.reamName },
          conversion_factor: '5',
          base_quantity: '15',
          balance: '15',
          recorded_by: officer.id,
          recorded_by_username: 'officer_stock_movements',
          recorded_at: expect.any(String),
        },
        {
          id: expect.any(String),
          kind: 'MATERIAL_RECEIPT',
          effective_date: '2025-10-15',
          source: { kind: 'MATERIAL_RECEIPT', id: receipt.id, number: receipt.number },
          original_quantity: '2.5',
          original_unit: { unit_id: paper.ream, name: paper.reamName },
          base_unit: { unit_id: paper.ream, name: paper.reamName },
          conversion_factor: '1',
          base_quantity: '2.5',
          balance: '17.5',
          recorded_by: officer.id,
          recorded_by_username: 'officer_stock_movements',
          recorded_at: expect.any(String),
        },
      ]);
      for (const row of page.items) {
        expect(new Date(row.recorded_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
        expect(new Date(row.recorded_at).getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
      }
      // The ids are those of the source lines' Stock Movements in effect.
      const [openingLine] = (await openingBalances.openingBalanceOf(openingBalance.id)).lines;
      const [receiptLine] = (await receipts.receiptOf(receipt.id)).lines;
      expect(page.items.map((row: any) => row.id)).toEqual([openingLine.stock_movement_id, receiptLine.stock_movement_id]);
    });
  });

  describe('the business timeline and the running balance (MSL-07, MSL-12, story 52, P3)', () => {
    it('places a backdated Material Receipt by its Effective Date, and works out the balances after it again', async () => {
      const paper = await stocked();
      const opening = await openingBalances.confirmed([openingBalances.line(paper.id, paper.ream, '10')], { as_of_date: '2025-09-01' });
      const december = await receipts.received([receipts.line(paper.id, paper.ream, '2')], { received_date: '2025-12-01' });
      expect(timeline(await movementsOf(paper.id))).toEqual([
        ['OPENING_BALANCE', opening.number, '10', '10'],
        ['MATERIAL_RECEIPT', december.number, '2', '12'],
      ]);

      // Recorded after December's, dated before it.
      const october = await receipts.received([receipts.line(paper.id, paper.box, '1')], { received_date: '2025-10-01' });
      expect(timeline(await movementsOf(paper.id))).toEqual([
        ['OPENING_BALANCE', opening.number, '10', '10'],
        ['MATERIAL_RECEIPT', october.number, '5', '15'],
        ['MATERIAL_RECEIPT', december.number, '2', '17'],
      ]);
    });

    it('orders the Stock Movements of one Effective Date by when they were recorded', async () => {
      const paper = await stocked();
      const numbers: string[] = [];
      for (const quantity of ['1', '2', '3', '4', '5']) {
        numbers.push((await receipts.received([receipts.line(paper.id, paper.ream, quantity)], { received_date: '2025-11-01' })).number);
      }
      expect(timeline(await movementsOf(paper.id))).toEqual([
        ['MATERIAL_RECEIPT', numbers[0], '1', '1'],
        ['MATERIAL_RECEIPT', numbers[1], '2', '3'],
        ['MATERIAL_RECEIPT', numbers[2], '3', '6'],
        ['MATERIAL_RECEIPT', numbers[3], '4', '10'],
        ['MATERIAL_RECEIPT', numbers[4], '5', '15'],
      ]);
      // And a page at a time picks its rows in that order.
      const pages = [];
      for (const offset of [0, 2, 4]) {
        pages.push(...timeline(await movementsOf(paper.id, `limit=2&offset=${offset}`)).map((row: unknown[]) => row[1]));
      }
      expect(pages).toEqual(numbers);
    });

    // The lines of one Material Receipt share its Effective Date and its confirm's Recorded At, so their id decides,
    // across a page break too (CODING_STANDARDS, "An order test of a paged list splits a tie across a page break").
    it('orders the Stock Movements of one confirm by id, a balance for each, across a page break', async () => {
      const paper = await withUnits(3);
      const { number } = await receipts.received(paper.units.map((unit) => receipts.line(paper.id, unit, '1')));
      const byFactor = new Map(paper.units.map((unit, i) => [unit, String(i + 1)]));
      const lines = (await receipts.receiptOf((await receipts.listOf(`search=${number}`)).items[0].id)).lines;
      // Base Quantities 1, 2, 3 and 4 in the order of their Stock Movements' ids.
      const inIdOrder = lines
        .map((line: any) => ({ id: line.stock_movement_id, base: byFactor.get(line.unit.unit_id)! }))
        .sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1));
      let balance = 0;
      const expected = inIdOrder.map(({ id, base }: { id: string; base: string }) => [id, base, String((balance += Number(base)))]);

      const rowsOf = (page: { items: any[] }) => page.items.map((row) => [row.id, row.base_quantity, row.balance]);
      expect(rowsOf(await movementsOf(paper.id))).toEqual(expected);
      const first = await movementsOf(paper.id, 'limit=2');
      const second = await movementsOf(paper.id, 'limit=2&offset=2');
      expect(first).toMatchObject({ limit: 2, offset: 0, total_count: 4, has_more: true });
      expect(second).toMatchObject({ limit: 2, offset: 2, total_count: 4, has_more: false });
      expect([...rowsOf(first), ...rowsOf(second)]).toEqual(expected);
    });
  });

  describe('the Fiscal Year (MSL-09–MSL-11, Q16, P3; #235 start decisions 2 and 4)', () => {
    it('filters by Fiscal Year, 1 October to 30 September named by the Buddhist-era year it ends in, keeping the whole ledger\'s balance, and offers each Fiscal Year that has a Stock Movement, newest first', async () => {
      const paper = await stocked();
      const opening = await openingBalances.confirmed([openingBalances.line(paper.id, paper.ream, '1')], { as_of_date: '2024-09-30' });
      const numbers: Record<string, string> = {};
      for (const [date, quantity] of [
        ['2024-10-01', '2'],
        ['2025-09-30', '3'],
        ['2025-10-01', '4'],
        ['2026-09-30', '5'],
        ['2026-10-01', '6'],
      ]) {
        numbers[date] = (await receipts.received([receipts.line(paper.id, paper.ream, quantity)], { received_date: date })).number;
      }
      const yearsOffered = [2570, 2569, 2568, 2567];

      const all = await movementsOf(paper.id);
      expect(all).toMatchObject({ total_count: 6, fiscal_years: yearsOffered });
      expect(all.items.map((row: any) => row.balance)).toEqual(['1', '3', '6', '10', '15', '21']);
      const expected: Record<number, unknown[][]> = {
        2567: [['OPENING_BALANCE', opening.number, '1', '1']],
        2568: [
          ['MATERIAL_RECEIPT', numbers['2024-10-01'], '2', '3'],
          ['MATERIAL_RECEIPT', numbers['2025-09-30'], '3', '6'],
        ],
        2569: [
          ['MATERIAL_RECEIPT', numbers['2025-10-01'], '4', '10'],
          ['MATERIAL_RECEIPT', numbers['2026-09-30'], '5', '15'],
        ],
        2570: [['MATERIAL_RECEIPT', numbers['2026-10-01'], '6', '21']],
        2566: [],
      };
      for (const [year, rows] of Object.entries(expected)) {
        const page = await movementsOf(paper.id, `fiscal_year=${year}`);
        expect(page).toMatchObject({ total_count: rows.length, has_more: false, fiscal_years: yearsOffered });
        expect(timeline(page)).toEqual(rows);
      }
      // A filtered page pages on the rows the filter keeps.
      const second = await movementsOf(paper.id, 'fiscal_year=2569&limit=1&offset=1');
      expect(second).toMatchObject({ total_count: 2, has_more: false });
      expect(timeline(second)).toEqual([['MATERIAL_RECEIPT', numbers['2026-09-30'], '5', '15']]);
    });

    it('offers no Fiscal Year to a Stock Material with no Stock Movement', async () => {
      const paper = await stocked();
      expect(await movementsOf(paper.id)).toEqual({ items: [], limit: 25, offset: 0, total_count: 0, has_more: false, fiscal_years: [] });
    });

    it('refuses a Fiscal Year that is not a four-digit Buddhist-era year, and a page outside the list-query contract', async () => {
      const paper = await stocked();
      for (const query of ['fiscal_year=abc', 'fiscal_year=256', 'fiscal_year=25690', 'fiscal_year=0256', 'fiscal_year=', 'limit=0', 'limit=101', 'offset=-1', 'unknown=1']) {
        const res = await api.get(readonly, `/stock-materials/${paper.id}/stock-movements?${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(`Invalid query: ${query.split('=')[0] === 'unknown' ? 'query' : query.split('=')[0]}`) });
      }
    });
  });

  describe('which Stock Material (Q23)', () => {
    it('reads the Stock Movements of an Inactive Stock Material as those of an active one', async () => {
      const paper = await stocked();
      const { number } = await receipts.received([receipts.line(paper.id, paper.box, '2')], { received_date: '2025-11-01' });
      const page = await materialOf(paper.id);
      expect((await inactivate(paper.id, { expected_version: page.version })).statusCode).toBe(200);
      expect((await materialOf(paper.id)).is_active).toBe(false);

      const movements = await movementsOf(paper.id);
      expect(movements).toMatchObject({ total_count: 1, fiscal_years: [2569] });
      expect(timeline(movements)).toEqual([['MATERIAL_RECEIPT', number, '10', '10']]);
    });

    it('answers 404 for a Stock Material that does not exist, and 400 for an id that is not a UUID', async () => {
      const missing = await api.get(readonly, `/stock-materials/${crypto.randomUUID()}/stock-movements`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Stock Material not found' });
      const invalid = await api.get(readonly, '/stock-materials/not-a-uuid/stock-movements');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Stock Material ID must be a valid UUID string' });
    });
  });

  describe('permissions (Q3)', () => {
    it('lets every material:view holder read; every other role is refused, and sees nothing', async () => {
      const paper = await stocked();
      const { number } = await receipts.received([receipts.line(paper.id, paper.ream, '7')], { received_date: '2025-11-01' });
      const url = `/stock-materials/${paper.id}/stock-movements`;
      for (const reader of [officer, admin, readonly]) {
        expect(timeline(await movementsOf(paper.id, '', reader))).toEqual([['MATERIAL_RECEIPT', number, '7', '7']]);
      }
      for (const actor of [requester, custodian, staff, maintainer]) {
        const res = await api.get(actor, url);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
        expect(res.body).not.toContain(number);
      }
    });

    // The Supply Officer holds material:manage too, so a gate on it would let them through.
    it('needs material:view itself, failing closed when the lookup fails', async () => {
      const paper = await stocked();
      const { number } = await receipts.received([receipts.line(paper.id, paper.ream, '7')], { received_date: '2025-11-01' });
      const url = `/stock-materials/${paper.id}/stock-movements`;
      const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(officer, url));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
      expect(denied.body).not.toContain(number);
      const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(officer, url));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected internal server error occurred.' });
      expect(failed.body).not.toContain(number);
    });

    it('needs a session', async () => {
      const paper = await stocked();
      const res = await api.app.inject({ method: 'GET', url: `/stock-materials/${paper.id}/stock-movements` });
      expect(res.statusCode).toBe(401);
    });
  });
});
