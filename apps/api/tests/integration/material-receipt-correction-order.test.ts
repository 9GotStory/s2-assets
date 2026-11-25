import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T6 (#237): each rule a Receipt Correction reads under a lock, against every write that changes its fact, and
// each rule another write reads that a correction changes (CODING_STANDARDS, "A rule read under a lock has a test of
// its order"; the lock-order plan, start comment 7163337923, rows 1–22). A correction locks the Material Receipt FOR
// UPDATE, then every Stock Material its lines name before and after, by id, FOR UPDATE, then their Units' list
// entries and the Source Party and Source Type it reads FOR SHARE (#231 P4). Each test queues the changing write first
// and shows that the rule sees its result, passing every rule checked before it.
describe('Receipt Correction write order (Seam A - F010-T6)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const materials = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, created, materialOf, unitsAsRead, replaceUnits } = materials;
  const { draft, line, complete, receiptOf, replaceDraft, removeDraft, confirm, received, correct, correctionAsRead, entryNamed, entryOf, entryWrite } = materialReceiptHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));
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

  // A Received Material Receipt of one line of 2 กล่อง, and the correction that keeps it as its page reads it.
  const ready = async () => {
    const paper = await stocked();
    const { id } = await received([line(paper.id, paper.box, '2')]);
    return { paper, id, payload: correctionAsRead(await receiptOf(id)) };
  };

  // The Units write of the Stock Material `id` with its one Alternate Unit changed by `change`, at its version.
  const unitsChanged = async (id: string, change: Record<string, unknown>) => {
    const write = unitsAsRead(await materialOf(id));
    return { ...write, alternate_units: [{ ...write.alternate_units[0], ...change }] };
  };

  // The Units write that makes กล่อง the Base Unit of `material`, valid in every other rule (F010-T5's `baseChange`).
  const baseChange = async (material: { id: string; ream: string; box: string }) => ({
    expected_version: (await materialOf(material.id)).version,
    base_unit: { unit_id: material.box, whole_number_only: false },
    alternate_units: [{ unit_id: material.ream, conversion_factor: '0.2', whole_number_only: false, is_active: true }],
  });

  // A correction refused for the one problem `problem`.
  const expectRefusedFor = (res: { statusCode: number; json: () => any }, problem: Record<string, unknown> & { message: string }) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_CORRECTABLE', message: `The Material Receipt cannot be corrected: ${problem.message}` });
    expect(res.json().problems).toEqual([problem]);
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_correction_order', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_correction_order', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a correction behind a write of the same Material Receipt (rows 1–4)', () => {
    it('corrects only after another correction, then refuses the version it read as stale', async () => {
      const { id, payload } = await ready();
      const first = { ...payload, lines: [{ ...payload.lines[0], quantity: '3' }] };
      const second = { ...payload, lines: [{ ...payload.lines[0], quantity: '4' }] };
      const [won, res] = await whileHolding(
        'material_receipts',
        id,
        () => [correct(id, first), untilWaiting('material_receipts').then(() => correct(id, second))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(won.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Receipt changed since it was read', current_values: { version: 3, state: 'RECEIVED' }, expected_values: { version: 2 } });
      expect((await receiptOf(id)).lines[0].quantity).toBe('3');
    });

    // The correction expects the version the confirm leaves, so only the state read under the lock decides.
    it('corrects only after a confirm, at the version the confirm leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [kept] = (await receiptOf(id)).lines;
      const payload = { expected_version: 2, received_date: '2026-11-01', lines: [{ line_id: kept.id, stock_material_id: paper.id, unit_id: paper.box, quantity: '3' }], reason: 'นับผิด' };
      const [confirmed, res] = await whileHolding(
        'material_receipts',
        id,
        () => [confirm(id, 1), untilWaiting('material_receipts').then(() => correct(id, payload))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(confirmed.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('15');
    });

    it('refuses a Draft only after a replace, as a Draft at the version the replace leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [kept] = (await receiptOf(id)).lines;
      const payload = { expected_version: 2, received_date: '2026-11-01', lines: [{ line_id: kept.id, stock_material_id: paper.id, unit_id: paper.box, quantity: '3' }], reason: 'นับผิด' };
      const [replaced, res] = await whileHolding(
        'material_receipts',
        id,
        () => [replaceDraft(id, { ...complete([line(paper.id, paper.box, '2')]), expected_version: 1 }), untilWaiting('material_receipts').then(() => correct(id, payload))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(replaced.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_RECEIVED', message: 'The Material Receipt is a Draft: only a Received one can be corrected', current_values: { version: 2, state: 'DRAFT' } });
    });

    it('finds no Material Receipt only after a remove', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [kept] = (await receiptOf(id)).lines;
      const payload = { expected_version: 1, received_date: '2026-11-01', lines: [{ line_id: kept.id, stock_material_id: paper.id, unit_id: paper.box, quantity: '3' }], reason: 'นับผิด' };
      const [removed, res] = await whileHolding(
        'material_receipts',
        id,
        () => [removeDraft(id, 1), untilWaiting('material_receipts').then(() => correct(id, payload))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(removed.statusCode).toBe(200);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
    });
  });

  describe('a correction behind a write of a Stock Material it names (rows 5–9, 11)', () => {
    it('corrects a Unit only after a Units write makes that Unit Inactive, then refuses it', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '10')]);
      const payload = correctionAsRead(await receiptOf(id));
      Object.assign(payload.lines[0], { unit_id: paper.box, quantity: '2' });
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [unitsChanged(paper.id, { is_active: false }).then((write) => replaceUnits(paper.id, write)), untilWaiting('stock_materials').then(() => correct(id, payload))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expectRefusedFor(res, { field: 'lines[0].unit_id', message: 'lines[0].unit_id names a Unit that is not active on its Stock Material' });
    });

    it('recalculates only after a Units write changes the Conversion Factor, then takes the new one (Q29)', async () => {
      const { paper, id, payload } = await ready();
      payload.lines[0].recalculate = true;
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [unitsChanged(paper.id, { conversion_factor: '12' }).then((write) => replaceUnits(paper.id, write)), untilWaiting('stock_materials').then(() => correct(id, payload))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('24');
    });

    it('fixes a quantity only after a Units write makes its Unit whole-number, then refuses a fraction in it', async () => {
      const { paper, id, payload } = await ready();
      payload.lines[0].quantity = '2.5';
      const [units, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [unitsChanged(paper.id, { whole_number_only: true }).then((write) => replaceUnits(paper.id, write)), untilWaiting('stock_materials').then(() => correct(id, payload))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expectRefusedFor(res, { field: 'lines[0].quantity', message: 'lines[0].quantity must be a whole number in its Unit' });
    });

    it('adds a line of a Stock Material with no Stock Movement only after a Units write changes its Base Unit, then snapshots the new one', async () => {
      const { id, payload } = await ready();
      const fresh = await stocked();
      payload.lines.push(line(fresh.id, fresh.ream, '1'));
      const change = await baseChange(fresh);
      const [units, res] = await whileHolding(
        'stock_materials',
        fresh.id,
        () => [replaceUnits(fresh.id, change), untilWaiting('stock_materials').then(() => correct(id, payload))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(units.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      const [movement] = (await receiptOf(id)).lines[1].stock_movements;
      expect(movement).toMatchObject({ base_unit: { unit_id: fresh.box }, conversion_factor: '0.2', base_quantity: '0.2' });
    });

    it('adds a line only after a Material Correction renames its Stock Material, then records the new name (#175 P6)', async () => {
      const { id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '1'));
      const renamed = `ปากกา ${crypto.randomUUID().slice(0, 6)}`;
      const page = await materialOf(pens.id);
      const [corrected, res] = await whileHolding(
        'stock_materials',
        pens.id,
        () => [
          materials.correct(pens.id, { expected_version: page.version, name: renamed, brand_id: null, model: null, specification: null, reason: 'สะกดผิด', explicit_continuation: true }),
          untilWaiting('stock_materials').then(() => correct(id, payload)),
        ],
        () => untilWaiting('stock_materials', 2)
      );
      expect(corrected.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).history[1].facts.lines[0].line.stock_material).toEqual({ id: pens.id, name: renamed });
    });

    it('adds a line only after an Opening Balance of its Stock Material, then refuses a Received Date on its As-of Date (Q21)', async () => {
      const { id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '1'));
      const opening = await openingBalances.draft(openingBalances.complete([openingBalances.line(pens.id, pens.ream, '3')], { as_of_date: '2026-11-01' }));
      const [won, res] = await whileHolding(
        'stock_materials',
        pens.id,
        () => [openingBalances.confirm(opening, 1), untilWaiting('stock_materials').then(() => correct(id, payload))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(won.statusCode).toBe(200);
      const number = won.json().opening_balance_number;
      expectRefusedFor(res, {
        field: 'lines[1].stock_material_id',
        message: `lines[1].stock_material_id names ${pens.name}, whose Opening Balance ${number} is as of 2026-11-01: received_date must be after it`,
        in_effect_opening_balance: { opening_balance_id: opening, opening_balance_number: number, as_of_date: '2026-11-01' },
      });
    });
  });

  describe("a correction behind a rename of a Unit's list entry (row 10)", () => {
    it('adds a line only after its Unit is renamed, then records the new name (#175 P6)', async () => {
      const { id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.box, '1'));
      const renamed = `ลัง ${crypto.randomUUID().slice(0, 6)}`;
      const [res] = await whileWriting(
        { sql: 'UPDATE units SET name = $2, version = version + 1 WHERE id = $1', params: [pens.box, renamed] },
        () => [correct(id, payload)],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).history[1].facts.lines[0].line.unit).toEqual({ id: pens.box, name: renamed });
    });
  });

  // Rows 12–19: the Inactive, the reactivation and the rename of a Source Party or a Source Type each change their own
  // row, which a correction locks FOR SHARE when it changes that list's entry: the held statement is that write's change
  // (CODING_STANDARDS, the paragraph on a read that locks the row of its fact).
  describe.each([
    { list: 'party', table: 'source_parties', field: 'source_party_id', concept: 'Source Party', fact: 'source_party' },
    { list: 'type', table: 'source_types', field: 'source_type_id', concept: 'Source Type', fact: 'source_type' },
  ] as const)('a correction behind a write of a $concept it names (rows 12–19)', ({ list, table, field, concept, fact }) => {
    it(`chooses a ${concept} only after it is made Inactive, then refuses it`, async () => {
      const { id, payload } = await ready();
      const entry = await entryNamed(list);
      const { name } = await entryOf(list, entry);
      const [res] = await whileWriting(
        { sql: `UPDATE ${table} SET is_active = false, version = version + 1 WHERE id = $1`, params: [entry] },
        () => [correct(id, { ...payload, [field]: entry })],
        () => untilWaiting(table, 1, 'FOR SHARE')
      );
      expectRefusedFor(res, { field, message: `${field} names ${name}, a ${concept} that is Inactive` });
    });

    it(`chooses a ${concept} only after it is reactivated, then corrects`, async () => {
      const { id, payload } = await ready();
      const entry = await entryNamed(list);
      expect((await entryWrite(list, entry, 'inactivate')).statusCode).toBe(200);
      const [res] = await whileWriting(
        { sql: `UPDATE ${table} SET is_active = true, version = version + 1 WHERE id = $1`, params: [entry] },
        () => [correct(id, { ...payload, [field]: entry })],
        () => untilWaiting(table, 1, 'FOR SHARE')
      );
      expect(res.statusCode).toBe(200);
    });

    it(`chooses a ${concept} only after it is renamed, then records the new name (#175 P6)`, async () => {
      const { id, payload } = await ready();
      const entry = await entryNamed(list);
      const renamed = `ชื่อใหม่ ${crypto.randomUUID().slice(0, 6)}`;
      const [res] = await whileWriting(
        { sql: `UPDATE ${table} SET name = $2, version = version + 1 WHERE id = $1`, params: [entry, renamed] },
        () => [correct(id, { ...payload, [field]: entry })],
        () => untilWaiting(table, 1, 'FOR SHARE')
      );
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).history[1].facts.changes[0]).toEqual({ field: fact, before: null, after: { id: entry, name: renamed } });
    });

    it(`replaces a ${concept} only after the one it replaces is renamed, then records that new name (#175 P6)`, async () => {
      const paper = await stocked();
      const entry = await entryNamed(list);
      const { id } = await received([line(paper.id, paper.box, '2')], { [field]: entry });
      const payload = { ...correctionAsRead(await receiptOf(id)), [field]: null };
      const renamed = `ชื่อใหม่ ${crypto.randomUUID().slice(0, 6)}`;
      const [res] = await whileWriting(
        { sql: `UPDATE ${table} SET name = $2, version = version + 1 WHERE id = $1`, params: [entry, renamed] },
        () => [correct(id, payload)],
        () => untilWaiting(table, 1, 'FOR SHARE')
      );
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).history[1].facts.changes[0]).toEqual({ field: fact, before: { id: entry, name: renamed }, after: null });
    });
  });

  describe('a write behind a correction that changes its fact (rows 20–22)', () => {
    it('changes a Base Unit only after a correction adds a line of its Stock Material, then refuses it (F010-T5; #236 plan row 3)', async () => {
      const { id, payload } = await ready();
      const fresh = await stocked();
      payload.lines.push(line(fresh.id, fresh.ream, '1'));
      const change = await baseChange(fresh);
      const [res, units] = await whileHolding(
        'stock_materials',
        fresh.id,
        () => [correct(id, payload), untilWaiting('stock_materials').then(() => replaceUnits(fresh.id, change))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(res.statusCode).toBe(200);
      expect(units.statusCode).toBe(409);
      expect(units.json()).toMatchObject({ code: 'BASE_UNIT_FROZEN', message: `base_unit.unit_id must stay ${fresh.ream}: a Stock Material with a Stock Movement keeps its Base Unit` });
    });

    it("confirms an Opening Balance only after a correction voids its Stock Material's only line in effect, then confirms it", async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '1')]);
      const payload = correctionAsRead(await receiptOf(id));
      const [voided] = payload.lines.splice(0, 1);
      payload.voided_line_ids = [voided.line_id];
      const opening = await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.ream, '3')]));
      const [res, won] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [correct(id, payload), untilWaiting('stock_materials').then(() => openingBalances.confirm(opening, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(res.statusCode).toBe(200);
      expect(won.statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('3');
    });

    it('confirms an Opening Balance only after a correction adds a line of its Stock Material, then refuses it naming that Material Receipt (story 40)', async () => {
      const { id, payload } = await ready();
      const number = (await receiptOf(id)).receipt_number;
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '1'));
      const opening = await openingBalances.draft(openingBalances.complete([openingBalances.line(pens.id, pens.ream, '3')]));
      const [res, refused] = await whileHolding(
        'stock_materials',
        pens.id,
        () => [correct(id, payload), untilWaiting('stock_materials').then(() => openingBalances.confirm(opening, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(res.statusCode).toBe(200);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().problems).toEqual([
        {
          field: 'lines[0].stock_material_id',
          message: expect.stringContaining(`from Material Receipt ${number}`),
          in_effect_material_receipt: { material_receipt_id: id, receipt_number: number },
        },
      ]);
    });
  });
});
