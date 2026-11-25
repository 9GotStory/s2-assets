import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';

// F010-T6 (#237): the Receipt Correction (แก้ไขรายการที่บันทึกผิด) of a Received Material Receipt through the composed
// application with real PostgreSQL (Seam A): each fix that changes stock adds a Reversal (กลับรายการ) of the line's
// Stock Movement in effect and, where something did happen, a new Stock Movement; nothing is overwritten (#231 MRC-04,
// MRC-08, MRC-11, MADJ-02, MC-09, Q18, Q29, P5, P9; start comment 7163337923).
describe('Receipt Correction (Seam A - F010-T6)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let otherOfficer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let requester: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // Today in Asia/Bangkok is 2026-11-24 while it is still 2026-11-23 in UTC, so a check against the UTC date shows.
  const now = new Date('2026-11-24T00:30:00+07:00');

  const { unitNamed, created, materialOf, replaceUnits, unitsAsRead, inactivate } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { draft, line, complete, receiptOf, received, correct, correctionAsRead, entryNamed, entryWrite } = materialReceiptHelpers(() => ({ api, officer, reader: readonly }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));

  const tableCount = async (table: string): Promise<number> => (await api.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const counts = async () => ({
    material_receipt_lines: await tableCount('material_receipt_lines'),
    stock_movements: await tableCount('stock_movements'),
    material_receipt_history: await tableCount('material_receipt_history'),
  });

  // A Stock Material counted in รีม, whole numbers only, with กล่อง of 5 รีม as an Alternate Unit, each Unit new.
  const stocked = async () => {
    const ream = await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`);
    const box = await unitNamed(`กล่อง ${crypto.randomUUID().slice(0, 6)}`);
    const name = `กระดาษ ${crypto.randomUUID().slice(0, 8)}`;
    const id = await created({ name, base_unit: { unit_id: ream, whole_number_only: true }, alternate_units: [{ unit_id: box, conversion_factor: '5' }] });
    return { id, name, ream, box };
  };

  // The Stock Movements of the Stock Material `id`, oldest first in the business timeline, as รายการเคลื่อนไหว reads them.
  const ledgerOf = async (id: string) => {
    const res = await api.get(readonly, `/stock-materials/${id}/stock-movements?limit=100`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  // The Units write of the Stock Material `id` with its กล่อง changed by `change`, answered 200.
  const boxChanged = async (id: string, change: Record<string, unknown>) => {
    const write = unitsAsRead(await materialOf(id));
    const res = await replaceUnits(id, { ...write, alternate_units: [{ ...write.alternate_units[0], ...change }] });
    expect(res.statusCode).toBe(200);
  };

  // A line's Stock Movements as "<Original Quantity> × <factor> = <Base Quantity>", a Reversal as its Base Quantity.
  const stockOf = (receiptLine: any): string[] =>
    receiptLine.stock_movements.map(({ kind, original_quantity: quantity, conversion_factor: factor, base_quantity: base }: any) =>
      kind === 'REVERSAL' ? base : `${quantity} × ${factor} = ${base}`
    );

  // A correction of the Material Receipt `id` as its page reads it, changed by `change`, answered 200.
  const corrected = async (id: string, change: (payload: any) => void, actor: Actor = officer) => {
    const payload = correctionAsRead(await receiptOf(id));
    change(payload);
    const res = await correct(id, payload, crypto.randomUUID(), actor);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // A correction of the Material Receipt `id`, as its page reads it changed by `change`, refused as `refusal`, with
  // nothing written and the Material Receipt left as it was.
  const expectRefused = async (id: string, change: (payload: any) => void, refusal: { statusCode: number } & Record<string, unknown>) => {
    const receipt = await receiptOf(id);
    const payload = correctionAsRead(receipt);
    change(payload);
    const before = await counts();
    const res = await correct(id, payload);
    const { statusCode, ...body } = refusal;
    expect(res.statusCode).toBe(statusCode);
    expect(res.json()).toMatchObject(body);
    expect(await counts()).toEqual(before);
    expect(await receiptOf(id)).toEqual(receipt);
    return res.json();
  };

  // A correction refused for exactly `problems` (#231 Q25, as a confirm is refused).
  const notCorrectable = (problems: Record<string, unknown>[]) => ({
    statusCode: 409,
    code: 'NOT_CORRECTABLE',
    message: `The Material Receipt cannot be corrected: ${problems.map(({ message }) => message).join('; ')}`,
    problems,
  });

  // A correction refused with Feature 002's validation shape and the message `message`.
  const invalid = (message: string) => ({ statusCode: 400, code: 'VALIDATION_FAILED', message });

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    officer = await api.actor('officer_correction', 'SUPPLY_OFFICER');
    otherOfficer = await api.actor('officer_correction_two', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_correction', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_correction', 'READ_ONLY');
    requester = await api.actor('requester_correction', 'REQUESTER');
    custodian = await api.actor('custodian_correction', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_correction', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_correction', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('fixes that change stock (Q18, Q29, P9)', () => {
    it('reverses a quantity-only fix on the first Effective Date and adds a new Stock Movement that keeps the Conversion Snapshot', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2')]);
      const [first] = (await receiptOf(id)).lines;

      const answer = await corrected(id, (payload) => {
        payload.lines[0].quantity = '3';
      }, otherOfficer);

      expect(answer).toEqual({ material_receipt_id: id, version: 3 });
      const [fixed] = (await receiptOf(id)).lines;
      expect(fixed).toMatchObject({ id: first.id, quantity: '3', is_voided: false });
      expect(fixed.stock_movements).toHaveLength(3);
      const [original, reversal, replacement] = fixed.stock_movements;
      expect(original.id).toBe(first.stock_movement_id);
      expect(reversal).toMatchObject({
        kind: 'REVERSAL',
        effective_date: '2026-11-01',
        original_quantity: '2',
        original_unit: { unit_id: paper.box },
        base_unit: { unit_id: paper.ream },
        conversion_factor: '5',
        base_quantity: '-10',
        recorded_by: otherOfficer.id,
      });
      expect(replacement).toMatchObject({
        kind: 'MATERIAL_RECEIPT',
        effective_date: '2026-11-01',
        original_quantity: '3',
        original_unit: { unit_id: paper.box },
        base_unit: { unit_id: paper.ream },
        conversion_factor: '5',
        base_quantity: '15',
        recorded_by: otherOfficer.id,
      });
      expect(reversal.recorded_at).toBe(replacement.recorded_at);
      expect(fixed.stock_movement_id).toBe(replacement.id);
      expect((await materialOf(paper.id)).current_stock).toBe('15');
      expect((await ledgerOf(paper.id)).map(({ kind, base_quantity, balance }: any) => [kind, base_quantity, balance])).toEqual([
        ['MATERIAL_RECEIPT', '10', '10'],
        ['REVERSAL', '-10', '0'],
        ['MATERIAL_RECEIPT', '15', '15'],
      ]);
    });

    it('keeps the Conversion Snapshot of a quantity-only fix whose Unit has since been given another factor (Q29)', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2')]);
      await boxChanged(paper.id, { conversion_factor: '6' });
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '4';
      });
      expect(stockOf((await receiptOf(id)).lines[0])).toEqual(['2 × 5 = 10', '-10', '4 × 5 = 20']);
      expect((await materialOf(paper.id)).current_stock).toBe('20');
    });

    // A factor becomes unknown only through a Base Unit change, which a Stock Material with a Stock Movement refuses
    // (F010-T5), so a recorded line's Unit always keeps one.
    it('keeps the Conversion Snapshot of a quantity-only fix whose Unit is now Inactive (start decision 4)', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2')]);
      await boxChanged(paper.id, { is_active: false });
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '1';
      });
      expect(stockOf((await receiptOf(id)).lines[0])).toEqual(['2 × 5 = 10', '-10', '1 × 5 = 5']);
      expect((await materialOf(paper.id)).current_stock).toBe('5');
    });

    it("takes today's Conversion Factor of the new Unit on a Unit change", async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '10')]);
      await boxChanged(paper.id, { conversion_factor: '6' });
      await corrected(id, (payload) => {
        payload.lines[0].unit_id = paper.box;
        payload.lines[0].quantity = '2';
      });
      const [fixed] = (await receiptOf(id)).lines;
      expect(fixed).toMatchObject({ unit: { unit_id: paper.box }, quantity: '2' });
      expect(stockOf(fixed)).toEqual(['10 × 1 = 10', '-10', '2 × 6 = 12']);
      expect((await materialOf(paper.id)).current_stock).toBe('12');
    });

    it("moves the stock to the new Stock Material on a Stock Material change, at today's factor of its Unit", async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2')]);
      await corrected(id, (payload) => {
        payload.lines[0].stock_material_id = pens.id;
        payload.lines[0].unit_id = pens.box;
      });
      const [fixed] = (await receiptOf(id)).lines;
      expect(fixed.stock_material).toMatchObject({ id: pens.id, name: pens.name });
      expect(fixed.stock_movements.map(({ kind, base_quantity: quantity, base_unit: base }: any) => [kind, quantity, base.unit_id])).toEqual([
        ['MATERIAL_RECEIPT', '10', paper.ream],
        ['REVERSAL', '-10', paper.ream],
        ['MATERIAL_RECEIPT', '10', pens.ream],
      ]);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(pens.id)).current_stock).toBe('10');
      expect((await ledgerOf(paper.id)).map(({ kind }: any) => kind)).toEqual(['MATERIAL_RECEIPT', 'REVERSAL']);
      expect((await ledgerOf(pens.id)).map(({ kind }: any) => kind)).toEqual(['MATERIAL_RECEIPT']);
    });

    it('moves the stock on a Stock Material change that keeps the Unit, a Unit both Stock Materials count in', async () => {
      const paper = await stocked();
      const name = `กระดาษสี ${crypto.randomUUID().slice(0, 8)}`;
      const colored = await created({ name, base_unit: { unit_id: paper.ream, whole_number_only: true } });
      const { id } = await received([line(paper.id, paper.ream, '3')]);
      await corrected(id, (payload) => {
        payload.lines[0].stock_material_id = colored;
      });
      expect((await receiptOf(id)).lines[0].stock_material).toMatchObject({ id: colored, name });
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(colored)).current_stock).toBe('3');
    });

    it("recalculates with today's factor (คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน): 5 กล่อง under a mistaken 1 กล่อง = 10 รีม become 60 รีม (Q29)", async () => {
      const paper = await stocked();
      await boxChanged(paper.id, { conversion_factor: '10' });
      const { id } = await received([line(paper.id, paper.box, '5')]);
      expect((await materialOf(paper.id)).current_stock).toBe('50');
      await boxChanged(paper.id, { conversion_factor: '12' });
      await corrected(id, (payload) => {
        payload.lines[0].recalculate = true;
      });
      const [fixed] = (await receiptOf(id)).lines;
      expect(fixed.quantity).toBe('5');
      expect(stockOf(fixed)).toEqual(['5 × 10 = 50', '-50', '5 × 12 = 60']);
      expect((await materialOf(paper.id)).current_stock).toBe('60');
    });

    it('moves the stock of a line recalculated at the factor recorded when its quantity, or the Received Date, changes too (start decision 3)', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2')]);
      await corrected(id, (payload) => {
        Object.assign(payload.lines[0], { quantity: '3', recalculate: true });
      });
      await corrected(id, (payload) => {
        payload.received_date = '2026-11-03';
        payload.lines[0].recalculate = true;
      });
      const [fixed] = (await receiptOf(id)).lines;
      expect(fixed.stock_movements.map(({ kind, effective_date: date, base_quantity: quantity }: any) => [kind, date, quantity])).toEqual([
        ['MATERIAL_RECEIPT', '2026-11-01', '10'],
        ['REVERSAL', '2026-11-01', '-10'],
        ['MATERIAL_RECEIPT', '2026-11-01', '15'],
        ['REVERSAL', '2026-11-01', '-15'],
        ['MATERIAL_RECEIPT', '2026-11-03', '15'],
      ]);
    });

    it('moves every line to a corrected Received Date, each keeping its Conversion Snapshot', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);
      await boxChanged(paper.id, { conversion_factor: '6' });
      await corrected(id, (payload) => {
        payload.received_date = '2026-11-05';
      });
      const receipt = await receiptOf(id);
      expect(receipt.received_date).toBe('2026-11-05');
      expect(receipt.lines.map(({ stock_movements: movements }: any) => movements.map(({ kind, effective_date: date, base_quantity: quantity }: any) => [kind, date, quantity]))).toEqual([
        [
          ['MATERIAL_RECEIPT', '2026-11-01', '10'],
          ['REVERSAL', '2026-11-01', '-10'],
          ['MATERIAL_RECEIPT', '2026-11-05', '10'],
        ],
        [
          ['MATERIAL_RECEIPT', '2026-11-01', '3'],
          ['REVERSAL', '2026-11-01', '-3'],
          ['MATERIAL_RECEIPT', '2026-11-05', '3'],
        ],
      ]);
      expect((await materialOf(paper.id)).current_stock).toBe('10');
      expect((await materialOf(pens.id)).current_stock).toBe('3');
    });

    it("adds a Stock Movement for a new line, at today's factor, after the lines recorded", async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      await corrected(id, (payload) => {
        payload.lines.push(line(pens.id, pens.box, '1', { unit_price: '120', note: 'ตกหล่น' }));
      });
      const receipt = await receiptOf(id);
      expect(receipt.lines).toHaveLength(2);
      expect(receipt.lines[0].stock_movements).toHaveLength(1);
      const [, addedLine] = receipt.lines;
      expect(addedLine).toMatchObject({ position: 1, stock_material: { id: pens.id }, unit: { unit_id: pens.box }, quantity: '1', unit_price: '120', note: 'ตกหล่น', is_voided: false });
      expect(stockOf(addedLine)).toEqual(['1 × 5 = 5']);
      expect(addedLine.stock_movement_id).toBe(addedLine.stock_movements[0].id);
      expect((await materialOf(pens.id)).current_stock).toBe('5');
      expect((await materialOf(paper.id)).current_stock).toBe('2');
    });

    it('adds a line in an active Unit of a Stock Material whose other Unit is Inactive', async () => {
      const paper = await stocked();
      const pens = await stocked();
      await boxChanged(pens.id, { is_active: false });
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      await corrected(id, (payload) => {
        payload.lines.push(line(pens.id, pens.ream, '4'));
      });
      expect((await materialOf(pens.id)).current_stock).toBe('4');
    });

    it('adds only a Reversal for a voided line (ยกเลิกรายการ), which stays shown, voided, with no Stock Movement in effect', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);
      const before = await receiptOf(id);
      await corrected(id, (payload) => {
        payload.lines.splice(0, 1);
        payload.voided_line_ids = [before.lines[0].id];
      });
      const [voided, kept] = (await receiptOf(id)).lines;
      expect(voided).toMatchObject({ id: before.lines[0].id, quantity: '2', unit: { unit_id: paper.box }, is_voided: true, stock_movement_id: null });
      expect(stockOf(voided)).toEqual(['2 × 5 = 10', '-10']);
      expect(kept.stock_movements).toEqual(before.lines[1].stock_movements);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(pens.id)).current_stock).toBe('3');
    });

    it('lets two lines of one Stock Material trade their Units', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '3'), line(paper.id, paper.box, '2')]);
      await corrected(id, (payload) => {
        payload.lines[0].unit_id = paper.box;
        payload.lines[1].unit_id = paper.ream;
      });
      const [first, second] = (await receiptOf(id)).lines;
      expect(first).toMatchObject({ unit: { unit_id: paper.box }, quantity: '3' });
      expect(second).toMatchObject({ unit: { unit_id: paper.ream }, quantity: '2' });
      expect((await materialOf(paper.id)).current_stock).toBe('17');
    });

    it('corrects a Material Receipt of a Stock Material that has become Inactive (story 37)', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const page = await materialOf(paper.id);
      expect((await inactivate(paper.id, { expected_version: page.version })).statusCode).toBe(200);
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '1';
      });
      expect((await materialOf(paper.id)).current_stock).toBe('1');
    });

    it('reverses the Stock Movement in effect, never one already reversed, on a second fix of the same line', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '3';
      });
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '4';
      });
      const [fixed] = (await receiptOf(id)).lines;
      const movements = fixed.stock_movements;
      expect(movements.map(({ kind, base_quantity: quantity }: any) => [kind, quantity])).toEqual([
        ['MATERIAL_RECEIPT', '2'],
        ['REVERSAL', '-2'],
        ['MATERIAL_RECEIPT', '3'],
        ['REVERSAL', '-3'],
        ['MATERIAL_RECEIPT', '4'],
      ]);
      expect(fixed.stock_movement_id).toBe(movements[4].id);
      expect((await materialOf(paper.id)).current_stock).toBe('4');
    });

    it('shows each กลับรายการ in รายการเคลื่อนไหว before its new Stock Movement, linked to its Material Receipt (build decision 5)', async () => {
      const paper = await stocked();
      const { id, number } = await received([line(paper.id, paper.ream, '1')]);
      // Each fix records its Reversal and its new Stock Movement at one moment, so only the kind orders them.
      for (const quantity of ['2', '3', '4', '5', '6', '7', '8', '9']) {
        await corrected(id, (payload) => {
          payload.lines[0].quantity = quantity;
        });
      }
      const ledger = await ledgerOf(paper.id);
      expect(ledger.map(({ base_quantity: quantity, balance }: any) => [quantity, balance])).toEqual([
        ['1', '1'],
        ['-1', '0'],
        ['2', '2'],
        ['-2', '0'],
        ['3', '3'],
        ['-3', '0'],
        ['4', '4'],
        ['-4', '0'],
        ['5', '5'],
        ['-5', '0'],
        ['6', '6'],
        ['-6', '0'],
        ['7', '7'],
        ['-7', '0'],
        ['8', '8'],
        ['-8', '0'],
        ['9', '9'],
      ]);
      expect(ledger[1]).toMatchObject({ kind: 'REVERSAL', source: { kind: 'MATERIAL_RECEIPT', id, number } });
      // The line's own Stock Movements, as its Material Receipt's page lists them, in the same order.
      expect((await receiptOf(id)).lines[0].stock_movements.map(({ base_quantity: quantity }: any) => quantity)).toEqual(ledger.map(({ base_quantity: quantity }: any) => quantity));
    });
  });

  describe('fixes that move no stock (MRC-08, MRC-11)', () => {
    it('fixes the Source Party, Source Type, Receipt Reference, note, a Unit Price and a line note without any Stock Movement', async () => {
      const paper = await stocked();
      const [party, otherParty, type, otherType] = [await entryNamed('party'), await entryNamed('party'), await entryNamed('type'), await entryNamed('type')];
      const { id } = await received([line(paper.id, paper.ream, '2', { unit_price: '100', note: 'ชั้นบน' }), line(paper.id, paper.box, '1')], {
        source_party_id: party,
        source_type_id: type,
        receipt_reference: 'ใบส่งของ 1',
        note: 'เดิม',
      });
      const before = await counts();
      await corrected(id, (payload) => {
        Object.assign(payload, { source_party_id: otherParty, source_type_id: otherType, receipt_reference: 'ใบส่งของ 2', note: null });
        Object.assign(payload.lines[0], { unit_price: '95.5', note: 'ชั้นล่าง' });
      });
      expect(await counts()).toEqual({ ...before, material_receipt_history: before.material_receipt_history + 1 });
      const receipt = await receiptOf(id);
      expect(receipt).toMatchObject({ source_party: { id: otherParty }, source_type: { id: otherType }, receipt_reference: 'ใบส่งของ 2', note: null, version: 3 });
      expect(receipt.lines[0]).toMatchObject({ unit_price: '95.5', note: 'ชั้นล่าง', quantity: '2' });
      expect(receipt.lines[0].stock_movements).toHaveLength(1);
      expect((await materialOf(paper.id)).current_stock).toBe('7');
      // The history names the line changed alone, never the one left as it was.
      expect(receipt.history[1].facts.lines).toEqual([
        {
          change: 'CHANGED',
          line_id: receipt.lines[0].id,
          position: 0,
          changes: [
            { field: 'unit_price', before: '100', after: '95.5' },
            { field: 'note', before: 'ชั้นบน', after: 'ชั้นล่าง' },
          ],
        },
      ]);
    });

    it('keeps a Source Party and a Source Type made Inactive since, when the correction leaves them as they were', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const type = await entryNamed('type');
      const { id } = await received([line(paper.id, paper.ream, '2')], { source_party_id: party, source_type_id: type });
      expect((await entryWrite('party', party, 'inactivate')).statusCode).toBe(200);
      expect((await entryWrite('type', type, 'inactivate')).statusCode).toBe(200);
      await corrected(id, (payload) => {
        payload.receipt_reference = 'ใบส่งของ 3';
      });
      expect(await receiptOf(id)).toMatchObject({ source_party: { id: party, is_active: false }, source_type: { id: type, is_active: false }, receipt_reference: 'ใบส่งของ 3' });
    });
  });

  describe('the history (story 35)', () => {
    it('records each changed field and line, old and new, with names as they were then, the corrector, the time and the reason', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const party = await entryNamed('party', `ร้านเดิม ${crypto.randomUUID().slice(0, 6)}`);
      const otherParty = await entryNamed('party', `ร้านใหม่ ${crypto.randomUUID().slice(0, 6)}`);
      const { id, number } = await received([line(paper.id, paper.box, '2', { unit_price: '100' }), line(pens.id, pens.ream, '3')], { source_party_id: party, note: 'เดิม' });
      const before = await receiptOf(id);
      await corrected(
        id,
        (payload) => {
          Object.assign(payload, { received_date: '2026-11-02', source_party_id: otherParty, note: 'ใหม่', reason: 'นับผิดและลืมบรรทัด' });
          Object.assign(payload.lines[0], { quantity: '3', unit_price: '90' });
          payload.lines.splice(1, 1);
          payload.voided_line_ids = [before.lines[1].id];
          payload.lines.push(line(glue.id, glue.box, '1'));
        },
        otherOfficer
      );
      // A rename after the correction leaves its history as it was.
      const renamed = await api.post(officer, `/stock-materials/${paper.id}/corrections`, { expected_version: (await materialOf(paper.id)).version, name: `${paper.name} ใหม่`, brand_id: null, model: null, specification: null, reason: 'สะกด' }, { 'x-retry-token': crypto.randomUUID() });
      expect(renamed.statusCode).toBe(200);
      const receipt = await receiptOf(id);
      const added = receipt.lines[2];
      expect(receipt.history).toHaveLength(2);
      expect(receipt.history[1]).toMatchObject({ version: 3, kind: 'CORRECTED', reason: 'นับผิดและลืมบรรทัด', recorded_by: otherOfficer.id, recorded_by_username: 'officer_correction_two' });
      expect(receipt.history[1].recorded_at).toBe(added.stock_movements[0].recorded_at);
      const paperUnits = (await materialOf(paper.id)).units;
      const nameOf = (units: any[], unitId: string) => units.find(({ unit_id: candidate }) => candidate === unitId).name;
      const pensUnits = (await materialOf(pens.id)).units;
      const glueUnits = (await materialOf(glue.id)).units;
      expect(receipt.history[1].facts).toEqual({
        receipt_number: number,
        changes: [
          { field: 'received_date', before: '2026-11-01', after: '2026-11-02' },
          { field: 'source_party', before: { id: party, name: expect.stringMatching(/^ร้านเดิม/) }, after: { id: otherParty, name: expect.stringMatching(/^ร้านใหม่/) } },
          { field: 'note', before: 'เดิม', after: 'ใหม่' },
        ],
        lines: [
          {
            change: 'CHANGED',
            line_id: before.lines[0].id,
            position: 0,
            changes: [
              { field: 'quantity', before: '2', after: '3' },
              { field: 'unit_price', before: '100', after: '90' },
              { field: 'base_quantity', before: '10', after: '15' },
            ],
          },
          {
            change: 'ADDED',
            line_id: added.id,
            position: 2,
            line: {
              stock_material: { id: glue.id, name: glue.name },
              unit: { id: glue.box, name: nameOf(glueUnits, glue.box) },
              quantity: '1',
              unit_price: null,
              note: null,
              conversion_factor: '5',
              base_quantity: '5',
            },
          },
          {
            change: 'VOIDED',
            line_id: before.lines[1].id,
            position: 1,
            line: {
              stock_material: { id: pens.id, name: pens.name },
              unit: { id: pens.ream, name: nameOf(pensUnits, pens.ream) },
              quantity: '3',
              unit_price: null,
              note: null,
              conversion_factor: '1',
              base_quantity: '3',
            },
          },
        ],
      });
      expect(receipt.history[1].facts.lines[0].changes.some(({ field }: any) => field === 'stock_material')).toBe(false);
      expect(nameOf(paperUnits, paper.box)).toBeDefined();
    });

    it('records a changed Stock Material, Unit and Conversion Factor under their names as they were then', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2')]);
      await corrected(id, (payload) => {
        Object.assign(payload.lines[0], { stock_material_id: pens.id, unit_id: pens.ream, quantity: '7' });
      });
      const [, entry] = (await receiptOf(id)).history;
      const unitName = async (material: { id: string }, unitId: string) => (await materialOf(material.id)).units.find(({ unit_id: candidate }: any) => candidate === unitId).name;
      expect(entry.facts.lines).toEqual([
        {
          change: 'CHANGED',
          line_id: expect.any(String),
          position: 0,
          changes: [
            { field: 'stock_material', before: { id: paper.id, name: paper.name }, after: { id: pens.id, name: pens.name } },
            { field: 'unit', before: { id: paper.box, name: await unitName(paper, paper.box) }, after: { id: pens.ream, name: await unitName(pens, pens.ream) } },
            { field: 'quantity', before: '2', after: '7' },
            { field: 'conversion_factor', before: '5', after: '1' },
            { field: 'base_quantity', before: '10', after: '7' },
          ],
        },
      ]);
      expect(entry.facts.changes).toEqual([]);
    });
  });

  describe('refusals by rule (Q9, Q11, Q21, Q25; start decisions 1, 2)', () => {
    it("refuses a new line, a Unit change or a recalculate on a Unit that is not active, naming each line, as T3's confirm does", async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '10'), line(pens.id, pens.box, '1')]);
      await boxChanged(paper.id, { is_active: false });
      await boxChanged(pens.id, { is_active: false });
      await boxChanged(glue.id, { is_active: false });
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload.lines[0], { unit_id: paper.box, quantity: '2' });
          payload.lines[1].recalculate = true;
          payload.lines.push(line(glue.id, glue.box, '1'));
        },
        notCorrectable([
          { field: 'lines[0].unit_id', message: 'lines[0].unit_id names a Unit that is not active on its Stock Material' },
          { field: 'lines[1].unit_id', message: 'lines[1].unit_id names a Unit that is not active on its Stock Material' },
          { field: 'lines[2].unit_id', message: 'lines[2].unit_id names a Unit that is not active on its Stock Material' },
        ])
      );
    });

    it('refuses a quantity a Unit counts only in whole numbers, on a quantity-only fix, a Unit change and a new line', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '10'), line(pens.id, pens.box, '1')]);
      await expectRefused(
        id,
        (payload) => {
          payload.lines[0].quantity = '1.5';
          Object.assign(payload.lines[1], { unit_id: pens.ream, quantity: '2.5' });
          payload.lines.push(line(glue.id, glue.ream, '0.5'));
        },
        notCorrectable([
          { field: 'lines[0].quantity', message: 'lines[0].quantity must be a whole number in its Unit' },
          { field: 'lines[1].quantity', message: 'lines[1].quantity must be a whole number in its Unit' },
          { field: 'lines[2].quantity', message: 'lines[2].quantity must be a whole number in its Unit' },
        ])
      );
    });

    it('refuses a Received Date after today in Asia/Bangkok', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '1')]);
      await expectRefused(
        id,
        (payload) => {
          payload.received_date = '2026-11-25';
        },
        notCorrectable([{ field: 'received_date', message: 'received_date must not be after today (2026-11-24, Asia/Bangkok)' }])
      );
      await corrected(id, (payload) => {
        payload.received_date = '2026-11-24';
      });
    });

    it('checks the As-of Date rule (Q21) again on a Received Date change, a Stock Material change and a new line', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const opening = await openingBalances.confirmed([openingBalances.line(paper.id, paper.ream, '5'), openingBalances.line(pens.id, pens.ream, '5'), openingBalances.line(glue.id, glue.ream, '5')], { as_of_date: '2026-10-31' });
      const other = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '1'), line(other.id, other.ream, '1')]);
      const ob = { opening_balance_id: opening.id, opening_balance_number: opening.number, as_of_date: '2026-10-31' };
      const asOf = (index: number, name: string) => ({
        field: `lines[${index}].stock_material_id`,
        message: `lines[${index}].stock_material_id names ${name}, whose Opening Balance ${opening.number} is as of 2026-10-31: received_date must be after it`,
        in_effect_opening_balance: ob,
      });
      await expectRefused(
        id,
        (payload) => {
          payload.received_date = '2026-10-31';
        },
        notCorrectable([asOf(0, paper.name)])
      );
      await expectRefused(
        id,
        (payload) => {
          payload.received_date = '2026-10-31';
          Object.assign(payload.lines[1], { stock_material_id: pens.id, unit_id: pens.ream });
          payload.lines.push(line(glue.id, glue.ream, '1'));
        },
        notCorrectable([asOf(0, paper.name), asOf(1, pens.name), asOf(2, glue.name)])
      );
      await corrected(id, (payload) => {
        Object.assign(payload.lines[1], { stock_material_id: pens.id, unit_id: pens.ream });
      });
      expect((await materialOf(pens.id)).current_stock).toBe('6');
    });

    it('refuses a newly chosen Source Party or Source Type that is Inactive', async () => {
      const paper = await stocked();
      const [partyName, typeName] = [`ร้านปิด ${crypto.randomUUID().slice(0, 6)}`, `วิธีปิด ${crypto.randomUUID().slice(0, 6)}`];
      const party = await entryNamed('party', partyName);
      const type = await entryNamed('type', typeName);
      expect((await entryWrite('party', party, 'inactivate')).statusCode).toBe(200);
      expect((await entryWrite('type', type, 'inactivate')).statusCode).toBe(200);
      const { id } = await received([line(paper.id, paper.ream, '1')]);
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload, { source_party_id: party, source_type_id: type });
        },
        notCorrectable([
          { field: 'source_party_id', message: `source_party_id names ${partyName}, a Source Party that is Inactive` },
          { field: 'source_type_id', message: `source_type_id names ${typeName}, a Source Type that is Inactive` },
        ])
      );
    });

    it('refuses a correction that changes nothing, a quantity written another way and a recalculate at the factor recorded included (story 36; start decision 3)', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2', { unit_price: '10' })]);
      const nothing = invalid('This Receipt Correction changes nothing');
      await expectRefused(id, () => undefined, nothing);
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload.lines[0], { quantity: '2.000', unit_price: '10.0', recalculate: true });
        },
        nothing
      );
    });

    it('refuses a line added in, or changed to, the Stock Material and Unit of a voided line (start decision 1)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3'), line(paper.id, paper.ream, '1')]);
      const lines = (await receiptOf(id)).lines;
      await expectRefused(
        id,
        (payload) => {
          payload.lines.splice(0, 1);
          payload.voided_line_ids = [lines[0].id];
          payload.lines.push(line(paper.id, paper.box, '2'));
        },
        invalid('lines[2].unit_id repeats the Stock Material and Unit of the voided Receipt Line at position 0')
      );
      await corrected(id, (payload) => {
        payload.lines.splice(0, 1);
        payload.voided_line_ids = [lines[0].id];
      });
      await expectRefused(
        id,
        (payload) => {
          payload.lines[1].unit_id = paper.box;
        },
        invalid('lines[1].unit_id repeats the Stock Material and Unit of the voided Receipt Line at position 0')
      );
    });

    it('refuses voiding every line left, and lets a line be voided while a new one is added (start decision 2)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const [only] = (await receiptOf(id)).lines;
      await expectRefused(
        id,
        (payload) => {
          payload.lines = [];
          payload.voided_line_ids = [only.id];
        },
        invalid('lines must keep at least one line not voided: void the whole Material Receipt instead')
      );
      await corrected(id, (payload) => {
        payload.lines = [line(pens.id, pens.ream, '2')];
        payload.voided_line_ids = [only.id];
      });
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(pens.id)).current_stock).toBe('2');
    });

    it('refuses more than 50 lines, voided ones included', async () => {
      const materials = await Promise.all(Array.from({ length: 25 }, () => stocked()));
      const { id } = await received(materials.flatMap((material) => [line(material.id, material.ream, '1'), line(material.id, material.box, '1')]));
      const lines = (await receiptOf(id)).lines;
      const extra = await stocked();
      await expectRefused(
        id,
        (payload) => {
          payload.lines.splice(0, 1);
          payload.voided_line_ids = [lines[0].id];
          payload.lines.push(line(extra.id, extra.ream, '1'));
        },
        invalid('lines must hold at most 50 lines, voided ones included')
      );
    }, 60_000);
  });

  describe('refusals by shape (#231 P5, P7)', () => {
    it('needs a nonblank reason of at most 2000 characters', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const fixed = (reason: unknown) => (payload: any) => {
        Object.assign(payload, { reason });
        payload.lines[0].quantity = '3';
      };
      await expectRefused(id, fixed('   '), invalid('reason must not be blank'));
      await expectRefused(id, fixed('ก'.repeat(2001)), invalid('reason must be at most 2000 characters'));
      await expectRefused(
        id,
        (payload) => {
          delete payload.reason;
          payload.lines[0].quantity = '3';
        },
        invalid('Invalid request payload: reason: Invalid input: expected string, received undefined')
      );
      await corrected(id, fixed(`${'ก'.repeat(1990)}\nนับผิด`));
      expect((await receiptOf(id)).history[1].reason).toBe(`${'ก'.repeat(1990)}\nนับผิด`);
    });

    it('names a line that is not this Material Receipt’s, one voided already, one sent twice, and one neither kept nor voided', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '3')]);
      const lines = (await receiptOf(id)).lines;
      // A line of another Material Receipt.
      const { id: otherId } = await received([line(paper.id, paper.ream, '1')]);
      const [stranger] = (await receiptOf(otherId)).lines.map(({ id: lineId }: { id: string }) => lineId);
      await expectRefused(id, (payload) => (payload.lines[0].line_id = stranger), invalid('lines[0].line_id must name a Receipt Line of this Material Receipt'));
      await expectRefused(id, (payload) => (payload.voided_line_ids = [stranger]), invalid('voided_line_ids[0] must name a Receipt Line of this Material Receipt'));
      await expectRefused(id, (payload) => (payload.lines[1].line_id = lines[0].id), invalid('lines[1].line_id repeats lines[0]'));
      await expectRefused(id, (payload) => (payload.voided_line_ids = [lines[0].id]), invalid('voided_line_ids[0] names lines[0], which the correction keeps'));
      await expectRefused(
        id,
        (payload) => {
          payload.lines.splice(1, 1);
          payload.voided_line_ids = [lines[1].id, lines[1].id];
        },
        invalid('voided_line_ids[1] repeats voided_line_ids[0]')
      );
      await expectRefused(id, (payload) => payload.lines.splice(1, 1), invalid('lines must keep or void the Receipt Line at position 1'));
      await corrected(id, (payload) => {
        payload.lines.splice(1, 1);
        payload.voided_line_ids = [lines[1].id];
      });
      await expectRefused(id, (payload) => payload.lines.push({ ...line(pens.id, pens.box, '1'), line_id: lines[1].id }), invalid('lines[1].line_id names a Receipt Line already voided'));
      await expectRefused(id, (payload) => (payload.voided_line_ids = [lines[1].id]), invalid('voided_line_ids[0] names a Receipt Line already voided'));
    });

    it('names a Stock Material, Unit, Source Party or Source Type that does not exist, a repeated pair, and a malformed field', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      await expectRefused(id, (payload) => payload.lines.push(line(crypto.randomUUID(), paper.ream, '1')), invalid('lines[1].stock_material_id must name a Stock Material'));
      await expectRefused(id, (payload) => payload.lines.push(line(pens.id, paper.box, '1')), invalid('lines[1].unit_id must name a Unit of its Stock Material'));
      await expectRefused(id, (payload) => (payload.source_party_id = crypto.randomUUID()), invalid('source_party_id must name a Source Party'));
      await expectRefused(id, (payload) => (payload.source_type_id = crypto.randomUUID()), invalid('source_type_id must name a Source Type'));
      await expectRefused(id, (payload) => payload.lines.push(line(paper.id, paper.ream, '1')), invalid('lines[1].unit_id repeats the Stock Material and Unit of lines[0]'));
      await expectRefused(id, (payload) => (payload.received_date = '2026-02-30'), invalid('received_date must be a date (YYYY-MM-DD)'));
      await expectRefused(id, (payload) => (payload.lines[0].line_id = 'not-a-uuid'), invalid('lines[0].line_id must be a valid UUID'));
      await expectRefused(id, (payload) => (payload.lines[0].stock_material_id = 'not-a-uuid'), invalid('lines[0].stock_material_id must be a valid UUID'));
      await expectRefused(id, (payload) => (payload.lines[0].unit_id = 'not-a-uuid'), invalid('lines[0].unit_id must be a valid UUID'));
      await expectRefused(id, (payload) => (payload.voided_line_ids = ['not-a-uuid']), invalid('voided_line_ids[0] must be a valid UUID'));
      await expectRefused(id, (payload) => (payload.lines[0].quantity = '0'), invalid('lines[0].quantity must be greater than 0'));
      await expectRefused(id, (payload) => (payload.lines[0].unit_price = '-1'), invalid('lines[0].unit_price must be at least 0'));
      await expectRefused(id, (payload) => (payload.lines[0].note = 'ก'.repeat(501)), invalid('lines[0].note must be at most 500 characters'));
      await expectRefused(id, (payload) => (payload.receipt_reference = 'ก'.repeat(501)), invalid('receipt_reference must be at most 500 characters'));
      await expectRefused(id, (payload) => (payload.note = 'ก'.repeat(2001)), invalid('note must be at most 2000 characters'));
      await expectRefused(id, (payload) => (payload.source_party_id = 'not-a-uuid'), invalid('source_party_id must be a valid UUID'));
    });

    it('refuses a Draft, a stale version, a Material Receipt that does not exist and an id that is not a UUID', async () => {
      const paper = await stocked();
      const draftId = await draft(complete([line(paper.id, paper.ream, '1')]));
      const sent = { expected_version: 1, received_date: '2026-11-01', lines: [line(paper.id, paper.ream, '2')], reason: 'นับผิด' };
      const notReceived = await correct(draftId, sent);
      expect(notReceived.statusCode).toBe(409);
      expect(notReceived.json()).toMatchObject({
        code: 'NOT_RECEIVED',
        message: 'The Material Receipt is a Draft: only a Received one can be corrected',
        current_values: { version: 1, state: 'DRAFT' },
        expected_values: { version: 1 },
      });
      const { id } = await received([line(paper.id, paper.ream, '1')]);
      await expectRefused(
        id,
        (payload) => {
          payload.expected_version = 1;
          payload.lines[0].quantity = '2';
        },
        { statusCode: 409, code: 'STALE_BEFORE_CONFLICT', message: 'The Material Receipt changed since it was read', current_values: { version: 2, state: 'RECEIVED' }, expected_values: { version: 1 } }
      );
      const missing = await correct(crypto.randomUUID(), sent);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
      const malformed = await correct('not-a-uuid', sent);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ code: 'INVALID_ID', message: 'Material Receipt ID must be a valid UUID string' });
    });
  });

  describe('retry tokens (Q26)', () => {
    it('needs a token, and answers a replay with its first answer, adding no second Reversal or Stock Movement', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const payload = correctionAsRead(await receiptOf(id));
      payload.lines[0].quantity = '3';
      const untokened = await api.post(officer, `/material-receipts/${id}/correct`, payload);
      expect(untokened.statusCode).toBe(400);
      expect(untokened.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      const token = crypto.randomUUID();
      const first = await correct(id, payload, token);
      expect(first.statusCode).toBe(200);
      const before = await counts();
      const replay = await correct(id, payload, token);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await counts()).toEqual(before);
      expect((await materialOf(paper.id)).current_stock).toBe('3');
    });

    // One case per field the fingerprint covers (CODING_STANDARDS, "A refusal test sends a request only its rule
    // refuses"; the fingerprint plan in start comment 7163337923).
    it('refuses a token replayed with the Material Receipt, the version or one field of a correction changed', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const party = await entryNamed('party');
      const type = await entryNamed('type');
      const { id } = await received([line(paper.id, paper.ream, '2', { unit_price: '10', note: 'ชั้นบน' }), line(pens.id, pens.ream, '1')]);
      const { id: other } = await received([line(paper.id, paper.ream, '1')]);
      const lines = (await receiptOf(id)).lines;
      const base = correctionAsRead(await receiptOf(id));
      base.lines[0].quantity = '3';
      const kept = (change: Record<string, unknown>) => ({ ...base, lines: [{ ...base.lines[0], ...change }, base.lines[1]] });
      const changes: Record<string, unknown>[] = [
        { reason: 'อื่น' },
        { received_date: '2026-11-02' },
        { source_party_id: party },
        { source_type_id: type },
        { receipt_reference: 'ใบ 2' },
        { note: 'อื่น' },
        { lines: [base.lines[0]], voided_line_ids: [lines[1].id] },
        kept({ line_id: null }),
        kept({ stock_material_id: (await stocked()).id }),
        kept({ unit_id: paper.box }),
        kept({ quantity: '4' }),
        kept({ unit_price: '11' }),
        kept({ note: 'ชั้นล่าง' }),
        kept({ recalculate: true }),
      ];
      const token = crypto.randomUUID();
      expect((await correct(id, base, token)).statusCode).toBe(200);
      const before = await counts();
      const expectMismatch = (res: { statusCode: number; json: () => any }) => {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      };
      expectMismatch(await correct(other, { ...base, lines: [{ ...base.lines[0], line_id: (await receiptOf(other)).lines[0].id }] }, token));
      expectMismatch(await correct(id, { ...base, expected_version: 3 }, token));
      for (const change of changes) {
        expectMismatch(await correct(id, { ...base, ...change }, token));
      }
      expectMismatch(await correct(id, { ...base, lines: [base.lines[0], { ...base.lines[1], line_id: lines[1].id }, line(pens.id, pens.box, '1')] }, token));
      expect(await counts()).toEqual(before);
      expect((await receiptOf(other)).version).toBe(2);
    });
  });

  describe('permissions (Q3)', () => {
    it('lets only the Supply Officer correct; every other role is refused, and nothing is written', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const payload = correctionAsRead(await receiptOf(id));
      payload.lines[0].quantity = '3';
      const before = await counts();
      for (const actor of [admin, readonly, requester, custodian, staff, maintainer]) {
        const res = await correct(id, payload, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
      }
      expect(await counts()).toEqual(before);
      expect((await correct(id, payload)).statusCode).toBe(200);
    });

    // The Supply Officer holds both capabilities, so a gate on material:view would let them through.
    it('needs material:manage itself, failing closed when the lookup fails, and a session and the CSRF token', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const payload = correctionAsRead(await receiptOf(id));
      payload.lines[0].quantity = '3';
      const before = await counts();
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => correct(id, payload));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => correct(id, payload));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected internal server error occurred.' });
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: `/material-receipts/${id}/correct`, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });
      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await counts()).toEqual(before);
    });
  });

  describe('Stock Movements at the database (MSL-04, story 64)', () => {
    it('refuses a second Reversal of one Stock Movement and a Reversal of a Reversal', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '3';
      });
      const [original, reversal] = (await receiptOf(id)).lines[0].stock_movements;
      const reverse = (movementId: string) =>
        api.pool.query(
          `INSERT INTO stock_movements (stock_material_id, kind, material_receipt_line_id, reverses_stock_movement_id, effective_date, original_quantity, original_unit_id, base_unit_id, conversion_factor, base_quantity, recorded_by)
           SELECT stock_material_id, 'REVERSAL', material_receipt_line_id, id, effective_date, original_quantity, original_unit_id, base_unit_id, conversion_factor, -base_quantity, recorded_by
           FROM stock_movements WHERE id = $1`,
          [movementId]
        );
      await expect(reverse(original.id)).rejects.toThrow(/reverses_stock_movement_id/);
      await expect(reverse(reversal.id)).rejects.toThrow(/stock_movements_reversal_check/);
      expect((await materialOf(paper.id)).current_stock).toBe('3');
    });
  });

  describe('the Base Unit freeze, Reversals included (#236 carry-over, comment 7159579815)', () => {
    it('still refuses a Base Unit change of a Stock Material whose only Stock Movement is reversed', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '1')]);
      const [paperLine] = (await receiptOf(id)).lines;
      await corrected(id, (payload) => {
        payload.lines.splice(0, 1);
        payload.voided_line_ids = [paperLine.id];
      });
      const page = await materialOf(paper.id);
      expect(page).toMatchObject({ current_stock: '0', has_stock_movement: true });
      // Valid in every other rule, as F010-T5's `baseChange`, so only the Base Unit freeze refuses it.
      const res = await replaceUnits(paper.id, {
        expected_version: page.version,
        base_unit: { unit_id: paper.box, whole_number_only: false },
        alternate_units: [{ unit_id: paper.ream, conversion_factor: '0.2', whole_number_only: false, is_active: true }],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'BASE_UNIT_FROZEN',
        message: `base_unit.unit_id must stay ${paper.ream}: a Stock Material with a Stock Movement keeps its Base Unit`,
      });
      expect((await materialOf(paper.id)).units.find(({ is_base: isBase }: any) => isBase).unit_id).toBe(paper.ream);
    });
  });
});
