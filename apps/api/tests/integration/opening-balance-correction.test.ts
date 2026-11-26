import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';

// F010-T7 (#238): the correction (แก้ไขรายการที่บันทึกผิด) and the void (ยกเลิกรายการ) of a confirmed Opening Balance
// through the composed application with real PostgreSQL (Seam A), the same way as a Material Receipt (T6): each fix
// that changes stock adds a Reversal (กลับรายการ) and, where something did happen, a new Stock Movement; a new or
// changed line takes a Stock Material with no other Stock Movement in effect (Q28), and an As-of Date change keeps
// every Material Receipt in effect after it (Q21) (#231 MOB-03, MOB-04, MADJ-02, Q20, Q21, Q28, P5, P9; start comment
// 7184458771).
describe('Opening Balance correction and void (Seam A - F010-T7)', () => {
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
  const receipts = materialReceiptHelpers(() => ({ api, officer, reader: readonly }));
  const { draft, line, complete, openingBalanceOf, confirm, confirmed, correct, correctionAsRead, voidOpeningBalance, listOf } = openingBalanceHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));

  const tableCount = async (table: string): Promise<number> => (await api.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const counts = async () => ({
    opening_balance_lines: await tableCount('opening_balance_lines'),
    stock_movements: await tableCount('stock_movements'),
    opening_balance_history: await tableCount('opening_balance_history'),
  });

  // A Stock Material counted in รีม, whole numbers only, with กล่อง of 5 รีม as an Alternate Unit, each Unit new, with
  // their names.
  const stocked = async () => {
    const reamName = `รีม ${crypto.randomUUID().slice(0, 6)}`;
    const boxName = `กล่อง ${crypto.randomUUID().slice(0, 6)}`;
    const ream = await unitNamed(reamName);
    const box = await unitNamed(boxName);
    const name = `กระดาษ ${crypto.randomUUID().slice(0, 8)}`;
    const id = await created({ name, base_unit: { unit_id: ream, whole_number_only: true }, alternate_units: [{ unit_id: box, conversion_factor: '5' }] });
    return { id, name, ream, box, reamName, boxName };
  };

  // A line's Stock Movements as "<Original Quantity> × <factor> = <Base Quantity>", a Reversal as its Base Quantity.
  const stockOf = (balanceLine: any): string[] =>
    balanceLine.stock_movements.map(({ kind, original_quantity: quantity, conversion_factor: factor, base_quantity: base }: any) =>
      kind === 'REVERSAL' ? base : `${quantity} × ${factor} = ${base}`
    );

  // The Units write of the Stock Material `id` with its กล่อง changed by `change`, answered 200.
  const boxChanged = async (id: string, change: Record<string, unknown>) => {
    const write = unitsAsRead(await materialOf(id));
    const res = await replaceUnits(id, { ...write, alternate_units: [{ ...write.alternate_units[0], ...change }] });
    expect(res.statusCode).toBe(200);
  };

  // A correction of the Opening Balance `id` as its page reads it, changed by `change`, answered 200.
  const corrected = async (id: string, change: (payload: any) => void, actor: Actor = officer) => {
    const payload = correctionAsRead(await openingBalanceOf(id));
    change(payload);
    const res = await correct(id, payload, crypto.randomUUID(), actor);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // A correction of the Opening Balance `id`, as its page reads it changed by `change`, refused as `refusal`, with
  // nothing written and the Opening Balance left as it was.
  const expectRefused = async (id: string, change: (payload: any) => void, refusal: { statusCode: number } & Record<string, unknown>) => {
    const balance = await openingBalanceOf(id);
    const payload = correctionAsRead(balance);
    change(payload);
    const before = await counts();
    const res = await correct(id, payload);
    const { statusCode, ...body } = refusal;
    expect(res.statusCode).toBe(statusCode);
    expect(res.json()).toMatchObject(body);
    expect(await counts()).toEqual(before);
    expect(await openingBalanceOf(id)).toEqual(balance);
    return res.json();
  };

  // A correction refused for exactly `problems` (#231 Q25, as a confirm is refused).
  const notCorrectable = (problems: Record<string, unknown>[]) => ({
    statusCode: 409,
    code: 'NOT_CORRECTABLE',
    message: `The Opening Balance cannot be corrected: ${problems.map(({ message }) => message).join('; ')}`,
    problems,
  });

  // A correction refused with Feature 002's validation shape and the message `message`.
  const invalid = (message: string) => ({ statusCode: 400, code: 'VALIDATION_FAILED', message });

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    officer = await api.actor('officer_balance_correction', 'SUPPLY_OFFICER');
    otherOfficer = await api.actor('officer_balance_correction_two', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_balance_correction', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_balance_correction', 'READ_ONLY');
    requester = await api.actor('requester_balance_correction', 'REQUESTER');
    custodian = await api.actor('custodian_balance_correction', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_balance_correction', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_balance_correction', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('fixes that change stock (Q18, Q20, Q29, P9)', () => {
    it('reverses a quantity-only fix on the As-of Date and adds a new Stock Movement that keeps the Conversion Snapshot', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2')]);
      const [first] = (await openingBalanceOf(id)).lines;

      const answer = await corrected(id, (payload) => {
        payload.lines[0].quantity = '3';
        // A correction that voids no line may leave voided_line_ids out.
        delete payload.voided_line_ids;
      }, otherOfficer);

      expect(answer).toEqual({ opening_balance_id: id, version: 3 });
      const balance = await openingBalanceOf(id);
      expect(balance).toMatchObject({ state: 'CONFIRMED', version: 3 });
      const [fixed] = balance.lines;
      expect(fixed).toMatchObject({ id: first.id, quantity: '3', is_voided: false });
      expect(stockOf(fixed)).toEqual(['2 × 5 = 10', '-10', '3 × 5 = 15']);
      expect(fixed.stock_movements.map(({ effective_date: date, recorded_by: by }: any) => [date, by])).toEqual([
        ['2026-09-30', officer.id],
        ['2026-09-30', otherOfficer.id],
        ['2026-09-30', otherOfficer.id],
      ]);
      expect(fixed.stock_movements[1].recorded_at).toBe(fixed.stock_movements[2].recorded_at);
      expect(fixed.stock_movement_id).toBe(fixed.stock_movements[2].id);
      expect((await materialOf(paper.id)).current_stock).toBe('15');
    });

    it('keeps the Conversion Snapshot of a quantity-only fix whose Unit has since taken another factor (Q29)', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2')]);
      await boxChanged(paper.id, { conversion_factor: '12' });
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '3';
      });
      expect(stockOf((await openingBalanceOf(id)).lines[0])).toEqual(['2 × 5 = 10', '-10', '3 × 5 = 15']);
    });

    it("takes today's Conversion Factor on a Unit change, a recalculate (คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน) and a Stock Material change", async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      // The Stock Material line 2 moves to counts in glue's own Units, so only its Stock Material changes.
      const fresh = { id: await created({ name: `กระดาษ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: glue.ream, whole_number_only: true }, alternate_units: [{ unit_id: glue.box, conversion_factor: '5' }] }) };
      const { id } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.box, '2'), line(glue.id, glue.box, '1')]);
      await boxChanged(pens.id, { conversion_factor: '12' });
      await boxChanged(glue.id, { conversion_factor: '6' });

      await corrected(id, (payload) => {
        Object.assign(payload.lines[0], { unit_id: paper.ream, quantity: '7' });
        payload.lines[1].recalculate = true;
        payload.lines[2].stock_material_id = fresh.id;
      });

      const [unitChanged, recalculated, moved] = (await openingBalanceOf(id)).lines;
      expect(stockOf(unitChanged)).toEqual(['2 × 5 = 10', '-10', '7 × 1 = 7']);
      expect(stockOf(recalculated)).toEqual(['2 × 5 = 10', '-10', '2 × 12 = 24']);
      expect(stockOf(moved)).toEqual(['1 × 5 = 5', '-5', '1 × 5 = 5']);
      expect(moved.stock_material.id).toBe(fresh.id);
      expect((await materialOf(paper.id)).current_stock).toBe('7');
      expect((await materialOf(pens.id)).current_stock).toBe('24');
      expect((await materialOf(glue.id)).current_stock).toBe('0');
      expect((await materialOf(fresh.id)).current_stock).toBe('5');
    });

    it('moves every line to a corrected As-of Date, each keeping its Conversion Snapshot, the Reversal on the first date', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);
      await boxChanged(paper.id, { conversion_factor: '12' });
      await corrected(id, (payload) => {
        payload.as_of_date = '2026-10-15';
      });
      const balance = await openingBalanceOf(id);
      expect(balance.as_of_date).toBe('2026-10-15');
      expect(balance.lines.map(stockOf)).toEqual([
        ['2 × 5 = 10', '-10', '2 × 5 = 10'],
        ['3 × 1 = 3', '-3', '3 × 1 = 3'],
      ]);
      expect(balance.lines[0].stock_movements.map(({ effective_date: date }: any) => date)).toEqual(['2026-09-30', '2026-09-30', '2026-10-15']);
      // Each line moved by the date alone records its Conversion Factor and Base Quantity, unchanged (#237 review decision 1).
      expect(balance.history[1].facts.changes).toEqual([{ field: 'as_of_date', before: '2026-09-30', after: '2026-10-15' }]);
      expect(balance.history[1].facts.lines).toEqual([
        {
          change: 'CHANGED',
          line_id: balance.lines[0].id,
          position: 0,
          changes: [
            { field: 'conversion_factor', before: '5', after: '5' },
            { field: 'base_quantity', before: '10', after: '10' },
          ],
        },
        {
          change: 'CHANGED',
          line_id: balance.lines[1].id,
          position: 1,
          changes: [
            { field: 'conversion_factor', before: '1', after: '1' },
            { field: 'base_quantity', before: '3', after: '3' },
          ],
        },
      ]);
    });

    it("adds a Stock Movement for a new line, at today's factor, after the lines there are", async () => {
      const paper = await stocked();
      const glue = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      await corrected(id, (payload) => {
        payload.lines.push(line(glue.id, glue.box, '2', { note: 'ลืมนับ' }));
      });
      const [kept, added] = (await openingBalanceOf(id)).lines;
      expect(stockOf(kept)).toEqual(['2 × 1 = 2']);
      expect(added).toMatchObject({ position: 1, stock_material: { id: glue.id }, quantity: '2', note: 'ลืมนับ', is_voided: false });
      expect(stockOf(added)).toEqual(['2 × 5 = 10']);
      expect((await materialOf(glue.id)).current_stock).toBe('10');
    });

    it('corrects an Opening Balance of a Stock Material that has become Inactive (story 37)', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const page = await materialOf(paper.id);
      expect((await inactivate(paper.id, { expected_version: page.version })).statusCode).toBe(200);
      await corrected(id, (payload) => {
        payload.lines[0].quantity = '1';
      });
      expect((await materialOf(paper.id)).current_stock).toBe('1');
    });
  });

  describe('a voided line (story 43)', () => {
    it('adds only a Reversal for a voided line, which stays shown, voided, with no Stock Movement in effect', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.lines.splice(0, 1);
        payload.voided_line_ids = [before.lines[0].id];
      });
      const [voided, kept] = (await openingBalanceOf(id)).lines;
      expect(voided).toMatchObject({ id: before.lines[0].id, quantity: '2', is_voided: true, stock_movement_id: null });
      expect(stockOf(voided)).toEqual(['2 × 5 = 10', '-10']);
      expect(kept.stock_movements).toEqual(before.lines[1].stock_movements);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
    });

    it('frees the Stock Material of a voided line for a new Opening Balance, while it has no other Stock Movement in effect', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '3'), line(glue.id, glue.ream, '1')]);
      const { number: receiptNumber } = await receipts.received([receipts.line(pens.id, pens.ream, '1')], { received_date: '2026-10-01' });
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.lines = [payload.lines[2]];
        payload.voided_line_ids = [before.lines[0].id, before.lines[1].id];
      });

      const freed = await confirmed([line(paper.id, paper.ream, '9')], { as_of_date: '2026-10-31' });
      expect(freed.number).toMatch(/^\d+$/);
      expect((await materialOf(paper.id)).current_stock).toBe('9');
      const held = await draft(complete([line(pens.id, pens.ream, '9')]));
      const refused = await confirm(held, 1);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().problems).toMatchObject([{ field: 'lines[0].stock_material_id', in_effect_material_receipt: { receipt_number: receiptNumber } }]);
    });
  });

  describe('fixes that move no stock', () => {
    it('fixes ที่มาของยอด, the note and a line note without a Stock Movement, a Stock Material with a Material Receipt in effect included', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2', { note: 'ชั้นบน' })], { note: 'เดิม' });
      await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-01' });
      const before = await counts();
      await corrected(id, (payload) => {
        Object.assign(payload, { source: 'บัญชีคุมวัสดุ ปี 2569', note: 'ใหม่' });
        payload.lines[0].note = 'ชั้นล่าง';
      });
      expect(await counts()).toEqual({ ...before, opening_balance_history: before.opening_balance_history + 1 });
      const balance = await openingBalanceOf(id);
      expect(balance).toMatchObject({ source: 'บัญชีคุมวัสดุ ปี 2569', note: 'ใหม่', lines: [{ note: 'ชั้นล่าง' }] });
      expect(balance.history[1].facts).toEqual({
        opening_balance_number: balance.opening_balance_number,
        changes: [
          { field: 'source', before: 'สมุดคุมวัสดุ', after: 'บัญชีคุมวัสดุ ปี 2569' },
          { field: 'note', before: 'เดิม', after: 'ใหม่' },
        ],
        lines: [{ change: 'CHANGED', line_id: balance.lines[0].id, position: 0, changes: [{ field: 'note', before: 'ชั้นบน', after: 'ชั้นล่าง' }] }],
      });
    });
  });

  describe('the history (story 35)', () => {
    it('records each changed field and line, old and new, with names as they were then, the corrector, the time and the reason', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id, number } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);
      const before = await openingBalanceOf(id);
      await corrected(
        id,
        (payload) => {
          Object.assign(payload, { as_of_date: '2026-10-01', reason: 'นับผิดและลืมบรรทัด' });
          payload.lines[0].quantity = '3';
          payload.lines.splice(1, 1);
          payload.voided_line_ids = [before.lines[1].id];
          payload.lines.push(line(glue.id, glue.box, '1'));
        },
        otherOfficer
      );
      const balance = await openingBalanceOf(id);
      const added = balance.lines[2];
      expect(balance.history).toHaveLength(2);
      expect(balance.history[1]).toMatchObject({ version: 3, kind: 'CORRECTED', reason: 'นับผิดและลืมบรรทัด', recorded_by: otherOfficer.id });
      expect(balance.history[1].facts).toEqual({
        opening_balance_number: number,
        changes: [{ field: 'as_of_date', before: '2026-09-30', after: '2026-10-01' }],
        lines: [
          {
            change: 'CHANGED',
            line_id: before.lines[0].id,
            position: 0,
            changes: [
              { field: 'quantity', before: '2', after: '3' },
              { field: 'conversion_factor', before: '5', after: '5' },
              { field: 'base_quantity', before: '10', after: '15' },
            ],
          },
          {
            change: 'ADDED',
            line_id: added.id,
            position: 2,
            line: { stock_material: { id: glue.id, name: glue.name }, unit: { id: glue.box, name: glue.boxName }, quantity: '1', note: null, conversion_factor: '5', base_quantity: '5' },
          },
          {
            change: 'VOIDED',
            line_id: before.lines[1].id,
            position: 1,
            line: { stock_material: { id: pens.id, name: pens.name }, unit: { id: pens.ream, name: pens.reamName }, quantity: '3', note: null, conversion_factor: '1', base_quantity: '3' },
          },
        ],
      });
    });

    it('records a changed Stock Material and Unit under their names, old and new', async () => {
      const paper = await stocked();
      const fresh = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2')]);
      await corrected(id, (payload) => {
        Object.assign(payload.lines[0], { stock_material_id: fresh.id, unit_id: fresh.ream, quantity: '2' });
      });
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].changes).toEqual([
        { field: 'stock_material', before: { id: paper.id, name: paper.name }, after: { id: fresh.id, name: fresh.name } },
        { field: 'unit', before: { id: paper.box, name: paper.boxName }, after: { id: fresh.ream, name: fresh.reamName } },
        { field: 'conversion_factor', before: '5', after: '1' },
        { field: 'base_quantity', before: '10', after: '2' },
      ]);
    });
  });

  describe('another Stock Movement in effect (Q28; start decision 2)', () => {
    it('refuses a quantity, Unit or Stock Material change, a recalculate and a new line on a Stock Material with a Material Receipt in effect, naming it', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.box, '2')]);
      const paperReceipt = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-01' });
      const pensReceipt = await receipts.received([receipts.line(pens.id, pens.ream, '1')], { received_date: '2026-10-01' });
      const glueReceipt = await receipts.received([receipts.line(glue.id, glue.ream, '1')], { received_date: '2026-10-01' });
      await boxChanged(pens.id, { conversion_factor: '12' });
      const held = (field: string, material: { name: string }, receipt: { id: string; number: string }) => ({
        field,
        message: `${field} names ${material.name}, a Stock Material with a Stock Movement in effect, from Material Receipt ${receipt.number}`,
        in_effect_material_receipt: { material_receipt_id: receipt.id, receipt_number: receipt.number },
      });
      await expectRefused(
        id,
        (payload) => {
          payload.lines[0].quantity = '3';
          payload.lines[1].recalculate = true;
          payload.lines.push(line(glue.id, glue.ream, '1'));
        },
        notCorrectable([
          held('lines[0].stock_material_id', paper, paperReceipt),
          held('lines[1].stock_material_id', pens, pensReceipt),
          held('lines[2].stock_material_id', glue, glueReceipt),
        ])
      );
      await expectRefused(
        id,
        (payload) => {
          payload.lines[0].unit_id = paper.ream;
        },
        notCorrectable([held('lines[0].stock_material_id', paper, paperReceipt)])
      );
      await expectRefused(
        id,
        (payload) => {
          payload.lines[1].stock_material_id = glue.id;
          payload.lines[1].unit_id = glue.box;
        },
        notCorrectable([held('lines[1].stock_material_id', glue, glueReceipt)])
      );
    });

    it('refuses a new line or a Stock Material change to one held by another Opening Balance, naming it', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const other = await confirmed([line(pens.id, pens.ream, '1'), line(glue.id, glue.ream, '1')]);
      const held = (field: string, material: { name: string }) => ({
        field,
        message: `${field} names ${material.name}, a Stock Material with a Stock Movement in effect, from Opening Balance ${other.number}`,
        in_effect_opening_balance: { opening_balance_id: other.id, opening_balance_number: other.number },
      });
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload.lines[0], { stock_material_id: pens.id, unit_id: pens.ream });
          payload.lines.push(line(glue.id, glue.ream, '1'));
        },
        notCorrectable([held('lines[0].stock_material_id', pens), held('lines[1].stock_material_id', glue)])
      );
    });

    it('lets a Stock Material whose only other Stock Movement is reversed take a new line', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const receipt = await receipts.received([receipts.line(pens.id, pens.ream, '1')], { received_date: '2026-10-01' });
      expect((await receipts.voidReceipt(receipt.id, 2)).statusCode).toBe(200);
      await corrected(id, (payload) => {
        payload.lines.push(line(pens.id, pens.ream, '4'));
      });
      expect((await materialOf(pens.id)).current_stock).toBe('4');
    });
  });

  describe('an As-of Date change (Q21)', () => {
    it('refuses an As-of Date on or after a Material Receipt in effect of a Stock Material it keeps, naming it, and allows one before it', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '1')]);
      const early = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-10' });
      await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-20' });
      const voided = await receipts.received([receipts.line(pens.id, pens.ream, '1')], { received_date: '2026-10-05' });
      expect((await receipts.voidReceipt(voided.id, 2)).statusCode).toBe(200);
      const message = `lines[0].stock_material_id names ${paper.name}, whose Material Receipt ${early.number} of 2026-10-10 is in effect: as_of_date must be before it`;
      for (const asOfDate of ['2026-10-10', '2026-10-25']) {
        await expectRefused(
          id,
          (payload) => {
            payload.as_of_date = asOfDate;
          },
          notCorrectable([{ field: 'lines[0].stock_material_id', message, in_effect_material_receipt: { material_receipt_id: early.id, receipt_number: early.number } }])
        );
      }
      await corrected(id, (payload) => {
        payload.as_of_date = '2026-10-09';
      });
      expect((await openingBalanceOf(id)).as_of_date).toBe('2026-10-09');
    });

    it('checks no Stock Material of a line voided in the same correction', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '1')]);
      await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-10' });
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.as_of_date = '2026-10-31';
        payload.lines = [payload.lines[1]];
        payload.voided_line_ids = [before.lines[0].id];
      });
      expect((await openingBalanceOf(id)).as_of_date).toBe('2026-10-31');
    });

    it('refuses an As-of Date after today in Asia/Bangkok', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      await expectRefused(
        id,
        (payload) => {
          payload.as_of_date = '2026-11-25';
        },
        notCorrectable([{ field: 'as_of_date', message: 'as_of_date must not be after today (2026-11-24, Asia/Bangkok)' }])
      );
      await corrected(id, (payload) => {
        payload.as_of_date = '2026-11-24';
      });
    });
  });

  describe('refusals by rule (Q11, Q13, Q25; start decisions 2, 3)', () => {
    it("refuses a new line, a Unit change or a recalculate on a Unit that is not active, and a fraction in a whole-number Unit, naming each line", async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      // Tape counts its กล่อง in fractions until the กล่อง becomes whole-number.
      const tapeBox = await unitNamed(`กล่อง ${crypto.randomUUID().slice(0, 6)}`);
      const tape = {
        id: await created({
          name: `เทป ${crypto.randomUUID().slice(0, 8)}`,
          base_unit: { unit_id: await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`), whole_number_only: true },
          alternate_units: [{ unit_id: tapeBox, conversion_factor: '5', whole_number_only: false }],
        }),
        box: tapeBox,
      };
      const { id } = await confirmed([line(paper.id, paper.ream, '10'), line(pens.id, pens.box, '1'), line(tape.id, tape.box, '1.4')]);
      await boxChanged(paper.id, { is_active: false });
      await boxChanged(pens.id, { is_active: false });
      await boxChanged(tape.id, { whole_number_only: true });
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload.lines[0], { unit_id: paper.box, quantity: '2' });
          payload.lines[1].recalculate = true;
          // Recalculated alone, a fraction recorded before its Unit became whole-number is refused too.
          payload.lines[2].recalculate = true;
          payload.lines.push(line(glue.id, glue.ream, '1.5'));
        },
        notCorrectable([
          { field: 'lines[0].unit_id', message: 'lines[0].unit_id names a Unit that is not active on its Stock Material' },
          { field: 'lines[1].unit_id', message: 'lines[1].unit_id names a Unit that is not active on its Stock Material' },
          { field: 'lines[2].quantity', message: 'lines[2].quantity must be a whole number in its Unit' },
          { field: 'lines[3].quantity', message: 'lines[3].quantity must be a whole number in its Unit' },
        ])
      );
    });

    it('refuses a blank ที่มาของยอด, as a confirm does', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      await expectRefused(
        id,
        (payload) => {
          payload.source = '  ';
        },
        notCorrectable([{ field: 'source', message: 'source is required' }])
      );
    });

    it('refuses a correction that changes nothing, a quantity written another way and a recalculate at the factor recorded included (story 36)', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.box, '2')]);
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload.lines[0], { quantity: '2.00', recalculate: true });
        },
        invalid('This correction changes nothing')
      );
    });

    it('refuses a line taking the Stock Material of another line, voided or kept, and a swap of two lines, naming each (start decision 3)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '3'), line(glue.id, glue.ream, '1')]);
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.lines.splice(2, 1);
        payload.voided_line_ids = [before.lines[2].id];
      });
      await expectRefused(
        id,
        (payload) => {
          payload.lines.push(line(glue.id, glue.ream, '1'));
        },
        notCorrectable([{ field: 'lines[2].stock_material_id', message: 'lines[2].stock_material_id repeats the Stock Material of the Opening Balance line at position 2' }])
      );
      await expectRefused(
        id,
        (payload) => {
          Object.assign(payload.lines[0], { stock_material_id: pens.id, unit_id: pens.ream });
          Object.assign(payload.lines[1], { stock_material_id: paper.id, unit_id: paper.ream });
        },
        notCorrectable([
          { field: 'lines[0].stock_material_id', message: 'lines[0].stock_material_id repeats the Stock Material of the Opening Balance line at position 1' },
          { field: 'lines[1].stock_material_id', message: 'lines[1].stock_material_id repeats the Stock Material of the Opening Balance line at position 0' },
        ])
      );
    });

    it('refuses voiding every line left, and lets a line be voided while a new one is added (#237 start decision 2)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const before = await openingBalanceOf(id);
      await expectRefused(
        id,
        (payload) => {
          payload.lines = [];
          payload.voided_line_ids = [before.lines[0].id];
        },
        invalid('lines must keep at least one line not voided: void the whole Opening Balance instead')
      );
      await corrected(id, (payload) => {
        payload.lines = [line(pens.id, pens.ream, '1')];
        payload.voided_line_ids = [before.lines[0].id];
      });
      expect((await openingBalanceOf(id)).lines.map(({ is_voided: isVoided }: any) => isVoided)).toEqual([true, false]);
    });

    it('refuses more than 50 lines, voided ones included', async () => {
      const materials = await Promise.all(Array.from({ length: 50 }, () => stocked()));
      const { id } = await confirmed(materials.slice(0, 49).map((material) => line(material.id, material.ream, '1')));
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.voided_line_ids = [before.lines[0].id];
        payload.lines = payload.lines.slice(1);
      });
      await expectRefused(
        id,
        (payload) => {
          payload.lines.push(line(materials[49].id, materials[49].ream, '1'), line(materials[0].id, materials[0].ream, '1'));
        },
        invalid('lines must hold at most 50 lines, voided ones included')
      );
      await corrected(id, (payload) => {
        payload.lines.push(line(materials[49].id, materials[49].ream, '1'));
      });
    });
  });

  describe('refusals by shape (#231 P5, P7)', () => {
    it('needs a nonblank reason of at most 2000 characters', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      for (const [reason, message] of [
        [' ', 'reason must not be blank'],
        ['ก'.repeat(2001), 'reason must be at most 2000 characters'],
      ]) {
        await expectRefused(
          id,
          (payload) => {
            Object.assign(payload, { reason });
            payload.lines[0].quantity = '3';
          },
          invalid(message)
        );
      }
    });

    it('names a line that is not this Opening Balance’s, one voided already, one sent twice, and one neither kept nor voided', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '1')]);
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.lines = [payload.lines[0]];
        payload.voided_line_ids = [before.lines[1].id];
      });
      await expectRefused(id, (payload) => {
        payload.lines[0].line_id = crypto.randomUUID();
      }, invalid('lines[0].line_id must name a line of this Opening Balance'));
      await expectRefused(id, (payload) => {
        payload.voided_line_ids = [before.lines[1].id];
      }, invalid('voided_line_ids[0] names a line already voided'));
      await expectRefused(id, (payload) => {
        payload.lines.push({ ...payload.lines[0], stock_material_id: pens.id });
      }, invalid('lines[1].line_id repeats lines[0]'));
      await expectRefused(id, (payload) => {
        payload.lines = [line(pens.id, pens.ream, '1')];
        payload.voided_line_ids = [before.lines[0].id, before.lines[0].id];
      }, invalid('voided_line_ids[1] repeats voided_line_ids[0]'));
      await expectRefused(id, (payload) => {
        payload.lines = [line(pens.id, pens.ream, '1')];
      }, invalid('lines must keep or void the line at position 0'));
      await expectRefused(id, (payload) => {
        payload.voided_line_ids = [payload.lines[0].line_id];
      }, invalid('voided_line_ids[0] names lines[0], which the correction keeps'));
      // A line voided before is neither kept nor voided again.
      await corrected(id, (payload) => {
        payload.note = 'ตรวจนับแล้ว';
      });
    });

    it('names a Stock Material or Unit that does not exist, a repeated Stock Material, and a malformed field', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      await expectRefused(id, (payload) => {
        payload.lines.push(line(crypto.randomUUID(), paper.ream, '1'));
      }, invalid('lines[1].stock_material_id must name a Stock Material'));
      await expectRefused(id, (payload) => {
        payload.lines.push(line(pens.id, paper.ream, '1'));
      }, invalid('lines[1].unit_id must name a Unit of its Stock Material'));
      await expectRefused(id, (payload) => {
        payload.lines.push(line(paper.id, paper.box, '1'));
      }, invalid('lines[1].stock_material_id repeats the Stock Material of lines[0]'));
      await expectRefused(id, (payload) => {
        payload.as_of_date = '2026-02-30';
      }, invalid('as_of_date must be a date (YYYY-MM-DD)'));
      await expectRefused(id, (payload) => {
        payload.lines[0].quantity = '0';
      }, invalid('lines[0].quantity must be greater than 0'));
      await expectRefused(id, (payload) => {
        payload.lines[0].unit_id = 'not-a-uuid';
      }, invalid('lines[0].unit_id must be a valid UUID'));
      await expectRefused(id, (payload) => {
        payload.voided_line_ids = ['x'];
      }, invalid('voided_line_ids[0] must be a valid UUID'));
    });

    it('refuses a Draft, a stale version, an Opening Balance that does not exist and an id that is not a UUID', async () => {
      const paper = await stocked();
      const draftId = await draft(complete([line(paper.id, paper.ream, '1')]));
      const sent = { expected_version: 1, as_of_date: '2026-09-30', source: 'สมุด', lines: [line(paper.id, paper.ream, '2')], reason: 'นับผิด' };
      const notConfirmed = await correct(draftId, sent);
      expect(notConfirmed.statusCode).toBe(409);
      expect(notConfirmed.json()).toMatchObject({
        code: 'NOT_CONFIRMED',
        message: 'The Opening Balance is a Draft: only a confirmed one can be corrected or voided',
        current_values: { version: 1, state: 'DRAFT' },
        expected_values: { version: 1 },
      });
      const fresh = await stocked();
      const { id: received } = await confirmed([line(fresh.id, fresh.ream, '1')]);
      await expectRefused(
        received,
        (payload) => {
          payload.expected_version = 1;
          payload.lines[0].quantity = '2';
        },
        { statusCode: 409, code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 2, state: 'CONFIRMED' }, expected_values: { version: 1 } }
      );
      const missing = await correct(crypto.randomUUID(), sent);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
      const malformed = await correct('not-a-uuid', sent);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ code: 'INVALID_ID', message: 'Opening Balance ID must be a valid UUID string' });
    });
  });

  describe('the void of a whole Opening Balance (story 43)', () => {
    it('reverses every line in effect, keeps each line shown voided, records "voided" with the reason, and shows ยกเลิกแล้ว', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id, number } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3'), line(glue.id, glue.ream, '1')]);
      const before = await openingBalanceOf(id);
      await corrected(id, (payload) => {
        payload.lines.splice(2, 1);
        payload.voided_line_ids = [before.lines[2].id];
      });

      const res = await voidOpeningBalance(id, 3, 'นับซ้ำทั้งใบ', crypto.randomUUID(), otherOfficer);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ opening_balance_id: id, version: 4 });
      const balance = await openingBalanceOf(id);
      expect(balance).toMatchObject({ state: 'VOIDED', version: 4 });
      expect(balance.lines.map((voided: any) => [voided.is_voided, voided.stock_movement_id, stockOf(voided)])).toEqual([
        [true, null, ['2 × 5 = 10', '-10']],
        [true, null, ['3 × 1 = 3', '-3']],
        [true, null, ['1 × 1 = 1', '-1']],
      ]);
      const reversals = balance.lines.slice(0, 2).map((voided: any) => voided.stock_movements[1]);
      expect(reversals.map(({ effective_date: date, recorded_by: by }: any) => [date, by])).toEqual([
        ['2026-09-30', otherOfficer.id],
        ['2026-09-30', otherOfficer.id],
      ]);
      expect(reversals[0].recorded_at).toBe(reversals[1].recorded_at);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(pens.id)).current_stock).toBe('0');
      expect(balance.history.map(({ kind }: any) => kind)).toEqual(['CONFIRMED', 'CORRECTED', 'VOIDED']);
      expect(balance.history[2]).toMatchObject({ version: 4, reason: 'นับซ้ำทั้งใบ', recorded_by: otherOfficer.id });
      expect(balance.history[2].facts).toEqual({
        opening_balance_number: number,
        lines: [
          {
            change: 'VOIDED',
            line_id: before.lines[0].id,
            position: 0,
            line: { stock_material: { id: paper.id, name: paper.name }, unit: { id: paper.box, name: paper.boxName }, quantity: '2', note: null, conversion_factor: '5', base_quantity: '10' },
          },
          {
            change: 'VOIDED',
            line_id: before.lines[1].id,
            position: 1,
            line: { stock_material: { id: pens.id, name: pens.name }, unit: { id: pens.ream, name: pens.reamName }, quantity: '3', note: null, conversion_factor: '1', base_quantity: '3' },
          },
        ],
      });
      const entry = (await listOf(`search=${number}`)).items.find(({ id: listed }: any) => listed === id);
      expect(entry).toMatchObject({ id, state: 'VOIDED' });
      // A search by number finds every number holding its digits, so the filters are read by state and by id.
      const voidedOnes = (await listOf(`search=${number}&state=voided`)).items;
      expect(voidedOnes.map(({ id: listed }: any) => listed)).toContain(id);
      expect(voidedOnes.every(({ state }: any) => state === 'VOIDED')).toBe(true);
      expect((await listOf(`search=${number}&state=confirmed`)).items.map(({ id: listed }: any) => listed)).not.toContain(id);
      const freed = await confirmed([line(paper.id, paper.ream, '4')]);
      expect(freed.number).toMatch(/^\d+$/);
      expect((await materialOf(paper.id)).current_stock).toBe('4');
    });

    it('refuses a correction and a second void of a voided Opening Balance, a void of a Draft, a stale version and a blank reason', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const read = await openingBalanceOf(id);
      const stale = await voidOpeningBalance(id, 1);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 2, state: 'CONFIRMED' } });
      for (const [reason, message] of [
        [' ', 'reason must not be blank'],
        ['ก'.repeat(2001), 'reason must be at most 2000 characters'],
      ]) {
        const res = await voidOpeningBalance(id, 2, reason);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
      }
      expect((await voidOpeningBalance(id, 2, 'ก'.repeat(2000))).statusCode).toBe(200);
      const voided = await openingBalanceOf(id);
      const before = await counts();
      const refusal = {
        code: 'VOIDED',
        message: 'The Opening Balance is voided: it can be neither corrected nor voided again',
        current_values: { version: 3, state: 'VOIDED' },
        expected_values: { version: 3 },
      };
      const again = await voidOpeningBalance(id, 3);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject(refusal);
      const payload = { ...correctionAsRead(read), expected_version: 3 };
      payload.lines[0].quantity = '3';
      const fixed = await correct(id, payload);
      expect(fixed.statusCode).toBe(409);
      expect(fixed.json()).toMatchObject(refusal);
      expect(await counts()).toEqual(before);
      expect(await openingBalanceOf(id)).toEqual(voided);
      const draftId = await draft(complete([line(paper.id, paper.ream, '1')]));
      const notConfirmed = await voidOpeningBalance(draftId, 1);
      expect(notConfirmed.statusCode).toBe(409);
      expect(notConfirmed.json()).toMatchObject({ code: 'NOT_CONFIRMED', message: 'The Opening Balance is a Draft: only a confirmed one can be corrected or voided', current_values: { version: 1, state: 'DRAFT' } });
      const missing = await voidOpeningBalance(crypto.randomUUID(), 1);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
      const malformed = await voidOpeningBalance('not-a-uuid', 1);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ code: 'INVALID_ID', message: 'Opening Balance ID must be a valid UUID string' });
    });
  });

  describe('retry tokens (Q26)', () => {
    it('needs a token, and answers a replay of a correction or a void with its first answer, adding nothing', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const payload = correctionAsRead(await openingBalanceOf(id));
      payload.lines[0].quantity = '3';
      const untokened = await api.post(officer, `/opening-balances/${id}/correct`, payload);
      expect(untokened.statusCode).toBe(400);
      expect(untokened.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      const unvoided = await api.post(officer, `/opening-balances/${id}/void`, { expected_version: 2, reason: 'ซ้ำ' });
      expect(unvoided.statusCode).toBe(400);
      expect(unvoided.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      const token = crypto.randomUUID();
      const first = await correct(id, payload, token);
      expect(first.statusCode).toBe(200);
      const before = await counts();
      const replay = await correct(id, payload, token);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await counts()).toEqual(before);
      const voidToken = crypto.randomUUID();
      const voided = await voidOpeningBalance(id, 3, 'ซ้ำ', voidToken);
      expect(voided.statusCode).toBe(200);
      const afterVoid = await counts();
      const voidReplay = await voidOpeningBalance(id, 3, 'ซ้ำ', voidToken);
      expect(voidReplay.statusCode).toBe(200);
      expect(voidReplay.json()).toEqual(voided.json());
      expect(await counts()).toEqual(afterVoid);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
    });

    // One case per field the fingerprint covers (the fingerprint plan in start comment 7184458771).
    it('refuses a token replayed with the Opening Balance, the version or one field of a correction changed', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const glue = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2', { note: 'ชั้นบน' }), line(pens.id, pens.ream, '1')]);
      const { id: other } = await confirmed([line(glue.id, glue.ream, '1')]);
      const lines = (await openingBalanceOf(id)).lines;
      const base = correctionAsRead(await openingBalanceOf(id));
      base.lines[0].quantity = '3';
      const kept = (change: Record<string, unknown>) => ({ ...base, lines: [{ ...base.lines[0], ...change }, base.lines[1]] });
      const changes: Record<string, unknown>[] = [
        { reason: 'อื่น' },
        { as_of_date: '2026-09-29' },
        { source: 'อื่น' },
        { note: 'อื่น' },
        { lines: [base.lines[0]], voided_line_ids: [lines[1].id] },
        // voided_line_ids alone: an id no line holds, which only the work after the token's check refuses.
        { voided_line_ids: [crypto.randomUUID()] },
        kept({ line_id: null }),
        kept({ stock_material_id: (await stocked()).id }),
        kept({ unit_id: crypto.randomUUID() }),
        kept({ quantity: '4' }),
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
      // The same request, to another Opening Balance.
      expectMismatch(await correct(other, base, token));
      expectMismatch(await correct(id, { ...base, expected_version: 3 }, token));
      for (const change of changes) {
        expectMismatch(await correct(id, { ...base, ...change }, token));
      }
      expect(await counts()).toEqual(before);
      expect((await openingBalanceOf(other)).version).toBe(2);
    });

    it('refuses a void token replayed with the Opening Balance, the version or the reason changed', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const pens = await stocked();
      const { id: other } = await confirmed([line(pens.id, pens.ream, '1')]);
      const token = crypto.randomUUID();
      expect((await voidOpeningBalance(id, 2, 'ซ้ำ', token)).statusCode).toBe(200);
      const before = await counts();
      for (const res of [await voidOpeningBalance(other, 2, 'ซ้ำ', token), await voidOpeningBalance(id, 3, 'ซ้ำ', token), await voidOpeningBalance(id, 2, 'อื่น', token)]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect(await counts()).toEqual(before);
    });
  });

  describe('permissions (Q3)', () => {
    it('lets only the Supply Officer correct and void; every other role is refused, and nothing is written', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const payload = correctionAsRead(await openingBalanceOf(id));
      payload.lines[0].quantity = '3';
      const before = await counts();
      for (const actor of [admin, readonly, requester, custodian, staff, maintainer]) {
        for (const res of [await correct(id, payload, crypto.randomUUID(), actor), await voidOpeningBalance(id, 2, 'ซ้ำ', crypto.randomUUID(), actor)]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
        }
      }
      expect(await counts()).toEqual(before);
      expect((await correct(id, payload)).statusCode).toBe(200);
      expect((await voidOpeningBalance(id, 3)).statusCode).toBe(200);
    });

    // The Supply Officer holds both capabilities, so a gate on material:view would let them through.
    it('needs material:manage itself, failing closed when the lookup fails, and a session and the CSRF token', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const payload = correctionAsRead(await openingBalanceOf(id));
      payload.lines[0].quantity = '3';
      const before = await counts();
      for (const [path, body] of [
        ['correct', payload],
        ['void', { expected_version: 2, reason: 'ซ้ำ' }],
      ] as const) {
        const send = () => api.post(officer, `/opening-balances/${id}/${path}`, body, { 'x-retry-token': crypto.randomUUID() });
        const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, send);
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
        const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, send);
        expect(failed.statusCode).toBe(500);
        expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected internal server error occurred.' });
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method: 'POST', url: `/opening-balances/${id}/${path}`, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: body });
        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      }
      expect(await counts()).toEqual(before);
    });
  });
});
