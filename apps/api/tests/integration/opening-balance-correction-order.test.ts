import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

type Answer = { statusCode: number; json: () => any };

// F010-T7 (#238): each rule an Opening Balance correction or void reads under a lock, against every write that changes
// its fact, and each rule another write reads that they change (CODING_STANDARDS, "A rule read under a lock has a test
// of its order"; the lock-order plan, start comment 7184458771, rows 10–53 and 55–59). Each locks the Opening Balance
// FOR UPDATE, then every Stock Material its lines name before and after, by id, FOR UPDATE, then their Units' list
// entries FOR SHARE (#231 P4). Each test queues the changing write first and shows that the rule sees its result,
// passing every rule checked before it.
describe('Opening Balance correction and void write order (Seam A - F010-T7)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const materials = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, created, materialOf, unitsAsRead, replaceUnits } = materials;
  const receipts = materialReceiptHelpers(() => ({ api, officer, reader: readonly }));
  const { draft, line, complete, openingBalanceOf, replaceDraft, removeDraft, confirm, confirmed, correct, correctionAsRead, voidOpeningBalance } = openingBalanceHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));
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

  // A confirmed Opening Balance of one line of 2 กล่อง, as of 2026-09-30, and the correction that keeps it as its page
  // reads it.
  const ready = async () => {
    const paper = await stocked();
    const { id, number } = await confirmed([line(paper.id, paper.box, '2')]);
    return { paper, id, number, payload: correctionAsRead(await openingBalanceOf(id)) };
  };

  // A confirmed Opening Balance of `paper` and `pens`, and the correction that voids its line of `paper`.
  const voidingFirst = async (paper: { id: string; box: string }, pens: { id: string; ream: string }) => {
    const { id, number } = await confirmed([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '1')]);
    const payload = correctionAsRead(await openingBalanceOf(id));
    const [voided] = payload.lines.splice(0, 1);
    payload.voided_line_ids = [voided.line_id];
    return { id, number, payload };
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

  // Holds the row `rowId` of `table`, starts `held`, then `queued` once `held` waits on it: both answers, in that order.
  const behind = (table: 'stock_materials' | 'opening_balances' | 'material_receipts', rowId: string, held: () => Promise<Answer>, queued: () => Promise<Answer>) =>
    whileHolding(table, rowId, () => [held(), untilWaiting(table).then(queued)], () => untilWaiting(table, 2));

  // A Material Correction renaming the Stock Material `id` at its version: the request and the new name.
  const renaming = async (id: string) => {
    const renamed = `ชื่อใหม่ ${crypto.randomUUID().slice(0, 6)}`;
    const page = await materialOf(id);
    return {
      renamed,
      write: () => materials.correct(id, { expected_version: page.version, name: renamed, brand_id: null, model: null, specification: null, reason: 'สะกดผิด', explicit_continuation: true }),
    };
  };

  // `write`, behind a rename of the Unit `unitId` held uncommitted: its answer and the new name.
  const behindUnitRename = async (unitId: string, write: () => Promise<Answer>): Promise<{ res: Answer; renamed: string }> => {
    const renamed = `ลัง ${crypto.randomUUID().slice(0, 6)}`;
    const [res] = await whileWriting({ sql: 'UPDATE units SET name = $2, version = version + 1 WHERE id = $1', params: [unitId, renamed] }, () => [write()], () => untilWaiting('units', 1, 'FOR SHARE'));
    return { res, renamed };
  };

  const expectOk = (...answers: Answer[]) => {
    for (const answer of answers) {
      expect(answer.statusCode).toBe(200);
    }
  };

  // An Opening Balance correction refused for exactly `problems`.
  const expectNotCorrectable = (res: Answer, problems: (Record<string, unknown> & { message: string })[]) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_CORRECTABLE', message: `The Opening Balance cannot be corrected: ${problems.map(({ message }) => message).join('; ')}` });
    expect(res.json().problems).toEqual(problems);
  };

  // The Q28 problem of `field`, naming the Stock Material `material` and the Material Receipt `receipt`.
  const heldByReceipt = (field: string, material: { name: string }, receipt: { id: string; number: string }) => ({
    field,
    message: `${field} names ${material.name}, a Stock Material with a Stock Movement in effect, from Material Receipt ${receipt.number}`,
    in_effect_material_receipt: { material_receipt_id: receipt.id, receipt_number: receipt.number },
  });

  // The Q28 problem of `field`, naming the Stock Material `material` and the Opening Balance `balance`.
  const heldByBalance = (field: string, material: { name: string }, balance: { id: string; number: string }) => ({
    field,
    message: `${field} names ${material.name}, a Stock Material with a Stock Movement in effect, from Opening Balance ${balance.number}`,
    in_effect_opening_balance: { opening_balance_id: balance.id, opening_balance_number: balance.number },
  });

  // A Material Receipt confirm or correction refused by the As-of Date rule (Q21) of the Opening Balance `balance`.
  const expectAsOfRefusal = (res: Answer, code: 'NOT_CONFIRMABLE' | 'NOT_CORRECTABLE', balance: { id: string; number: string }, asOfDate: string) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code, message: expect.stringContaining('received_date must be after it') });
    expect(res.json().problems).toMatchObject([
      { message: expect.stringContaining(`whose Opening Balance ${balance.number} is as of ${asOfDate}`), in_effect_opening_balance: { opening_balance_id: balance.id, opening_balance_number: balance.number, as_of_date: asOfDate } },
    ]);
  };

  const VOIDED = { code: 'VOIDED', message: 'The Opening Balance is voided: it can be neither corrected nor voided again' };
  const NOT_CONFIRMED = { code: 'NOT_CONFIRMED', message: 'The Opening Balance is a Draft: only a confirmed one can be corrected or voided' };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_balance_correction_order', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_balance_correction_order', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a correction behind a write of the same Opening Balance (rows 10–14)', () => {
    it('corrects only after another correction, then refuses the version it read as stale', async () => {
      const { paper, id, payload } = await ready();
      const first = { ...payload, lines: [{ ...payload.lines[0], quantity: '3' }] };
      const second = { ...payload, lines: [{ ...payload.lines[0], quantity: '4' }] };
      const [won, res] = await behind('opening_balances', id, () => correct(id, first), () => correct(id, second));
      expectOk(won);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 3, state: 'CONFIRMED' }, expected_values: { version: 2 } });
      expect((await materialOf(paper.id)).current_stock).toBe('15');
    });

    // The correction expects the version the confirm leaves, so only the state read under the lock decides.
    it('corrects only after a confirm, at the version the confirm leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [kept] = (await openingBalanceOf(id)).lines;
      const payload = { expected_version: 2, as_of_date: '2026-09-30', source: 'สมุดคุมวัสดุ', lines: [{ line_id: kept.id, stock_material_id: paper.id, unit_id: paper.box, quantity: '3' }], reason: 'นับผิด' };
      const [confirmedRes, res] = await behind('opening_balances', id, () => confirm(id, 1), () => correct(id, payload));
      expectOk(confirmedRes, res);
      expect((await materialOf(paper.id)).current_stock).toBe('15');
    });

    it('refuses a Draft only after a replace, as a Draft at the version the replace leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [kept] = (await openingBalanceOf(id)).lines;
      const payload = { expected_version: 2, as_of_date: '2026-09-30', source: 'สมุดคุมวัสดุ', lines: [{ line_id: kept.id, stock_material_id: paper.id, unit_id: paper.box, quantity: '3' }], reason: 'นับผิด' };
      const [replaced, res] = await behind('opening_balances', id, () => replaceDraft(id, { ...complete([line(paper.id, paper.box, '2')]), expected_version: 1 }), () => correct(id, payload));
      expectOk(replaced);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ...NOT_CONFIRMED, current_values: { version: 2, state: 'DRAFT' } });
    });

    it('finds no Opening Balance only after a remove', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [kept] = (await openingBalanceOf(id)).lines;
      const payload = { expected_version: 1, as_of_date: '2026-09-30', source: 'สมุดคุมวัสดุ', lines: [{ line_id: kept.id, stock_material_id: paper.id, unit_id: paper.box, quantity: '3' }], reason: 'นับผิด' };
      const [removed, res] = await behind('opening_balances', id, () => removeDraft(id, 1), () => correct(id, payload));
      expectOk(removed);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
    });

    // The correction expects the version the void leaves, so only the voided state read under the lock decides.
    it('corrects only after a void, then refuses it as voided at the version the void leaves', async () => {
      const { id, payload } = await ready();
      const sent = { ...payload, expected_version: 3, lines: [{ ...payload.lines[0], quantity: '3' }] };
      const [voided, res] = await behind('opening_balances', id, () => voidOpeningBalance(id, 2), () => correct(id, sent));
      expectOk(voided);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ...VOIDED, current_values: { version: 3, state: 'VOIDED' }, expected_values: { version: 3 } });
    });
  });

  describe('a correction behind a write of a Stock Material it names (rows 15–18)', () => {
    it('changes a Unit only after a Units write makes that Unit Inactive, then refuses it', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '10')]);
      const payload = correctionAsRead(await openingBalanceOf(id));
      Object.assign(payload.lines[0], { unit_id: paper.box, quantity: '2' });
      const write = await unitsChanged(paper.id, { is_active: false });
      const [units, res] = await behind('stock_materials', paper.id, () => replaceUnits(paper.id, write), () => correct(id, payload));
      expectOk(units);
      expectNotCorrectable(res, [{ field: 'lines[0].unit_id', message: 'lines[0].unit_id names a Unit that is not active on its Stock Material' }]);
    });

    it('recalculates only after a Units write changes the Conversion Factor, then takes the new one (Q29)', async () => {
      const { paper, id, payload } = await ready();
      payload.lines[0].recalculate = true;
      const write = await unitsChanged(paper.id, { conversion_factor: '12' });
      const [units, res] = await behind('stock_materials', paper.id, () => replaceUnits(paper.id, write), () => correct(id, payload));
      expectOk(units, res);
      expect((await materialOf(paper.id)).current_stock).toBe('24');
    });

    it('fixes a quantity only after a Units write makes its Unit whole-number, then refuses a fraction in it', async () => {
      const { paper, id, payload } = await ready();
      payload.lines[0].quantity = '2.5';
      const write = await unitsChanged(paper.id, { whole_number_only: true });
      const [units, res] = await behind('stock_materials', paper.id, () => replaceUnits(paper.id, write), () => correct(id, payload));
      expectOk(units);
      expectNotCorrectable(res, [{ field: 'lines[0].quantity', message: 'lines[0].quantity must be a whole number in its Unit' }]);
    });

    it('adds a line of a Stock Material with no Stock Movement only after a Units write changes its Base Unit, then snapshots the new one', async () => {
      const { id, payload } = await ready();
      const fresh = await stocked();
      payload.lines.push(line(fresh.id, fresh.ream, '1'));
      const change = await baseChange(fresh);
      const [units, res] = await behind('stock_materials', fresh.id, () => replaceUnits(fresh.id, change), () => correct(id, payload));
      expectOk(units, res);
      const [movement] = (await openingBalanceOf(id)).lines[1].stock_movements;
      expect(movement).toMatchObject({ base_unit: { unit_id: fresh.box }, conversion_factor: '0.2', base_quantity: '0.2' });
    });
  });

  describe('a correction behind a rename of a name its history records (rows 19–24)', () => {
    it('adds a line only after a Material Correction renames its Stock Material, then records the new name (#175 P6)', async () => {
      const { id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '1'));
      const { renamed, write } = await renaming(pens.id);
      const [corrected, res] = await behind('stock_materials', pens.id, write, () => correct(id, payload));
      expectOk(corrected, res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].line.stock_material).toEqual({ id: pens.id, name: renamed });
    });

    it('changes the Stock Material of a line only after a Material Correction renames the one it replaces, then records that new name (#175 P6)', async () => {
      const { paper, id, payload } = await ready();
      const pens = await stocked();
      Object.assign(payload.lines[0], { stock_material_id: pens.id, unit_id: pens.box });
      const { renamed, write } = await renaming(paper.id);
      const [corrected, res] = await behind('stock_materials', paper.id, write, () => correct(id, payload));
      expectOk(corrected, res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].changes[0]).toEqual({ field: 'stock_material', before: { id: paper.id, name: renamed }, after: { id: pens.id, name: pens.name } });
    });

    it('voids a line only after a Material Correction renames its Stock Material, then records the new name (#175 P6)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id, payload } = await voidingFirst(paper, pens);
      const { renamed, write } = await renaming(paper.id);
      const [corrected, res] = await behind('stock_materials', paper.id, write, () => correct(id, payload));
      expectOk(corrected, res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].line.stock_material).toEqual({ id: paper.id, name: renamed });
    });

    it('adds a line only after its Unit is renamed, then records the new name (#175 P6)', async () => {
      const { id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.box, '1'));
      const { res, renamed } = await behindUnitRename(pens.box, () => correct(id, payload));
      expectOk(res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].line.unit).toEqual({ id: pens.box, name: renamed });
    });

    it('changes the Unit of a line only after the Unit it replaces is renamed, then records that new name (#175 P6)', async () => {
      const { paper, id, payload } = await ready();
      payload.lines[0].unit_id = paper.ream;
      const { res, renamed } = await behindUnitRename(paper.box, () => correct(id, payload));
      expectOk(res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].changes[0]).toMatchObject({ field: 'unit', before: { id: paper.box, name: renamed }, after: { id: paper.ream } });
    });

    it('voids a line only after its Unit is renamed, then records the new name (#175 P6)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id, payload } = await voidingFirst(paper, pens);
      const { res, renamed } = await behindUnitRename(paper.box, () => correct(id, payload));
      expectOk(res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].line.unit).toEqual({ id: paper.box, name: renamed });
    });
  });

  // A new line of `pens` in a correction of the Opening Balance `ready()` gives, behind a write that adds or takes back
  // the only other Stock Movement in effect of `pens` (start decision 2).
  describe('a new or changed line behind a write of another Stock Movement of its Stock Material (Q28, rows 25–32)', () => {
    const addingPens = async () => {
      const { id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '1'));
      return { id, payload, pens };
    };

    it('adds a line only after a Material Receipt confirm of its Stock Material, then refuses it naming that Material Receipt', async () => {
      const { id, payload, pens } = await addingPens();
      const receipt = await receipts.draft(receipts.complete([receipts.line(pens.id, pens.ream, '1')]));
      const number = async () => (await receipts.receiptOf(receipt)).receipt_number;
      const [confirmedRes, res] = await behind('stock_materials', pens.id, () => receipts.confirm(receipt, 1), () => correct(id, payload));
      expectOk(confirmedRes);
      expectNotCorrectable(res, [heldByReceipt('lines[1].stock_material_id', pens, { id: receipt, number: await number() })]);
    });

    it('adds a line only after a Receipt Correction adds a line of its Stock Material, then refuses it naming that Material Receipt', async () => {
      const { id, payload, pens } = await addingPens();
      const other = await stocked();
      const receipt = await receipts.received([receipts.line(other.id, other.ream, '1')]);
      const fix = receipts.correctionAsRead(await receipts.receiptOf(receipt.id));
      fix.lines.push(receipts.line(pens.id, pens.ream, '1'));
      const [fixed, res] = await behind('stock_materials', pens.id, () => receipts.correct(receipt.id, fix), () => correct(id, payload));
      expectOk(fixed);
      expectNotCorrectable(res, [heldByReceipt('lines[1].stock_material_id', pens, receipt)]);
    });

    it("adds a line only after a Receipt Correction voids its Stock Material's only line in effect, then adds it", async () => {
      const { id, payload, pens } = await addingPens();
      const other = await stocked();
      const receipt = await receipts.received([receipts.line(pens.id, pens.ream, '1'), receipts.line(other.id, other.ream, '1')]);
      const fix = receipts.correctionAsRead(await receipts.receiptOf(receipt.id));
      const [voided] = fix.lines.splice(0, 1);
      fix.voided_line_ids = [voided.line_id];
      const [fixed, res] = await behind('stock_materials', pens.id, () => receipts.correct(receipt.id, fix), () => correct(id, payload));
      expectOk(fixed, res);
      expect((await materialOf(pens.id)).current_stock).toBe('1');
    });

    it('adds a line only after a Material Receipt void takes back its Stock Material’s only Stock Movement in effect, then adds it', async () => {
      const { id, payload, pens } = await addingPens();
      const receipt = await receipts.received([receipts.line(pens.id, pens.ream, '1')]);
      const [voided, res] = await behind('stock_materials', pens.id, () => receipts.voidReceipt(receipt.id, 2), () => correct(id, payload));
      expectOk(voided, res);
      expect((await materialOf(pens.id)).current_stock).toBe('1');
    });

    it('adds a line only after another Opening Balance of its Stock Material is confirmed, then refuses it naming that Opening Balance', async () => {
      const { id, payload, pens } = await addingPens();
      const other = await draft(complete([line(pens.id, pens.ream, '2')]));
      const [confirmedRes, res] = await behind('stock_materials', pens.id, () => confirm(other, 1), () => correct(id, payload));
      expectOk(confirmedRes);
      expectNotCorrectable(res, [heldByBalance('lines[1].stock_material_id', pens, { id: other, number: confirmedRes.json().opening_balance_number })]);
    });

    it("adds a line only after another Opening Balance's correction adds a line of its Stock Material, then refuses it naming that Opening Balance", async () => {
      const { id, payload, pens } = await addingPens();
      const other = await ready();
      other.payload.lines.push(line(pens.id, pens.ream, '2'));
      const [fixed, res] = await behind('stock_materials', pens.id, () => correct(other.id, other.payload), () => correct(id, payload));
      expectOk(fixed);
      expectNotCorrectable(res, [heldByBalance('lines[1].stock_material_id', pens, other)]);
    });

    it("adds a line only after another Opening Balance's correction voids its line of that Stock Material, then adds it", async () => {
      const { id, payload, pens } = await addingPens();
      const other = await voidingFirst(pens, await stocked());
      const [fixed, res] = await behind('stock_materials', pens.id, () => correct(other.id, other.payload), () => correct(id, payload));
      expectOk(fixed, res);
      expect((await materialOf(pens.id)).current_stock).toBe('1');
    });

    it('adds a line only after a void of the other Opening Balance holding its Stock Material, then adds it', async () => {
      const { id, payload, pens } = await addingPens();
      const other = await confirmed([line(pens.id, pens.ream, '2')]);
      const [voided, res] = await behind('stock_materials', pens.id, () => voidOpeningBalance(other.id, 2), () => correct(id, payload));
      expectOk(voided, res);
      expect((await materialOf(pens.id)).current_stock).toBe('1');
    });
  });

  // The ticket's order test: an As-of Date change against the Material Receipts of its Stock Material (rows 33–37).
  describe('an As-of Date change behind a write of a Material Receipt of its Stock Material (Q21, rows 33–37)', () => {
    // A confirmed Opening Balance of `paper` as of 2026-09-30, and the correction moving it to 2026-10-10.
    const movingTo1010 = async () => {
      const { paper, id, payload } = await ready();
      payload.as_of_date = '2026-10-10';
      return { paper, id, payload };
    };
    const refusedBy = (res: Answer, paper: { name: string }, receipt: { id: string; number: string }, date: string) =>
      expectNotCorrectable(res, [
        {
          field: 'lines[0].stock_material_id',
          message: `lines[0].stock_material_id names ${paper.name}, whose Material Receipt ${receipt.number} of ${date} is in effect: as_of_date must be before it`,
          in_effect_material_receipt: { material_receipt_id: receipt.id, receipt_number: receipt.number },
        },
      ]);

    it('moves the As-of Date only after a Material Receipt confirm of its Stock Material, then refuses a date on or after it', async () => {
      const { paper, id, payload } = await movingTo1010();
      const receipt = await receipts.draft(receipts.complete([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-05' }));
      const [confirmedRes, res] = await behind('stock_materials', paper.id, () => receipts.confirm(receipt, 1), () => correct(id, payload));
      expectOk(confirmedRes);
      refusedBy(res, paper, { id: receipt, number: confirmedRes.json().receipt_number }, '2026-10-05');
    });

    it('moves the As-of Date only after a Receipt Correction moves its Received Date to on or before it, then refuses it', async () => {
      const { paper, id, payload } = await movingTo1010();
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-20' });
      const fix = { ...receipts.correctionAsRead(await receipts.receiptOf(receipt.id)), received_date: '2026-10-05' };
      const [fixed, res] = await behind('stock_materials', paper.id, () => receipts.correct(receipt.id, fix), () => correct(id, payload));
      expectOk(fixed);
      refusedBy(res, paper, receipt, '2026-10-05');
    });

    it('moves the As-of Date only after a Receipt Correction adds a line of its Stock Material, then refuses it', async () => {
      const { paper, id, payload } = await movingTo1010();
      const other = await stocked();
      const receipt = await receipts.received([receipts.line(other.id, other.ream, '1')], { received_date: '2026-10-05' });
      const fix = receipts.correctionAsRead(await receipts.receiptOf(receipt.id));
      fix.lines.push(receipts.line(paper.id, paper.ream, '1'));
      const [fixed, res] = await behind('stock_materials', paper.id, () => receipts.correct(receipt.id, fix), () => correct(id, payload));
      expectOk(fixed);
      refusedBy(res, paper, receipt, '2026-10-05');
    });

    it('moves the As-of Date only after a Receipt Correction voids the line of its Stock Material, then moves it', async () => {
      const { paper, id, payload } = await movingTo1010();
      const other = await stocked();
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '1'), receipts.line(other.id, other.ream, '1')], { received_date: '2026-10-05' });
      const fix = receipts.correctionAsRead(await receipts.receiptOf(receipt.id));
      const [voided] = fix.lines.splice(0, 1);
      fix.voided_line_ids = [voided.line_id];
      const [fixed, res] = await behind('stock_materials', paper.id, () => receipts.correct(receipt.id, fix), () => correct(id, payload));
      expectOk(fixed, res);
      expect((await openingBalanceOf(id)).as_of_date).toBe('2026-10-10');
    });

    it('moves the As-of Date only after a Material Receipt void, then moves it', async () => {
      const { paper, id, payload } = await movingTo1010();
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-05' });
      const [voided, res] = await behind('stock_materials', paper.id, () => receipts.voidReceipt(receipt.id, 2), () => correct(id, payload));
      expectOk(voided, res);
      expect((await openingBalanceOf(id)).as_of_date).toBe('2026-10-10');
    });
  });

  describe('a void behind a write of the same Opening Balance or of a name its history records (rows 38–45)', () => {
    it('voids only after a correction, then refuses the version it read as stale', async () => {
      const { paper, id, payload } = await ready();
      const [fixed, res] = await behind('opening_balances', id, () => correct(id, { ...payload, lines: [{ ...payload.lines[0], quantity: '3' }] }), () => voidOpeningBalance(id, 2));
      expectOk(fixed);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 3, state: 'CONFIRMED' }, expected_values: { version: 2 } });
      expect((await materialOf(paper.id)).current_stock).toBe('15');
    });

    // The second void expects the version the first leaves, so only the voided state read under the lock decides.
    it('voids only after another void, then refuses it as voided at the version that void leaves', async () => {
      const { id } = await ready();
      const [voided, res] = await behind('opening_balances', id, () => voidOpeningBalance(id, 2), () => voidOpeningBalance(id, 3));
      expectOk(voided);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ...VOIDED, current_values: { version: 3, state: 'VOIDED' }, expected_values: { version: 3 } });
    });

    it('voids only after a confirm, at the version the confirm leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [confirmedRes, res] = await behind('opening_balances', id, () => confirm(id, 1), () => voidOpeningBalance(id, 2));
      expectOk(confirmedRes, res);
      expect((await openingBalanceOf(id)).state).toBe('VOIDED');
      expect((await materialOf(paper.id)).current_stock).toBe('0');
    });

    it('refuses a Draft only after a replace, as a Draft at the version the replace leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [replaced, res] = await behind('opening_balances', id, () => replaceDraft(id, { ...complete([line(paper.id, paper.box, '3')]), expected_version: 1 }), () => voidOpeningBalance(id, 2));
      expectOk(replaced);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ...NOT_CONFIRMED, current_values: { version: 2, state: 'DRAFT' } });
    });

    it('finds no Opening Balance only after a remove', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [removed, res] = await behind('opening_balances', id, () => removeDraft(id, 1), () => voidOpeningBalance(id, 1));
      expectOk(removed);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
    });

    it('voids only after a correction adds a line, then reverses the added line’s Stock Movement too', async () => {
      const { paper, id, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '4'));
      const [fixed, res] = await behind('opening_balances', id, () => correct(id, payload), () => voidOpeningBalance(id, 3));
      expectOk(fixed, res);
      expect((await materialOf(pens.id)).current_stock).toBe('0');
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await openingBalanceOf(id)).history[2].facts.lines.map(({ line: voided }: any) => voided.stock_material.id)).toEqual([paper.id, pens.id]);
    });

    it('voids only after a Material Correction renames a line’s Stock Material, then records the new name (#175 P6)', async () => {
      const { paper, id } = await ready();
      const { renamed, write } = await renaming(paper.id);
      const [corrected, res] = await behind('stock_materials', paper.id, write, () => voidOpeningBalance(id, 2));
      expectOk(corrected, res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].line.stock_material).toEqual({ id: paper.id, name: renamed });
    });

    it('voids only after a line’s Unit is renamed, then records the new name (#175 P6)', async () => {
      const { paper, id } = await ready();
      const { res, renamed } = await behindUnitRename(paper.box, () => voidOpeningBalance(id, 2));
      expectOk(res);
      expect((await openingBalanceOf(id)).history[1].facts.lines[0].line.unit).toEqual({ id: paper.box, name: renamed });
    });
  });

  // The ticket's order test from the Material Receipt's side: a confirm against an As-of Date change (#231 Seam A).
  describe('a Material Receipt confirm or correction behind an Opening Balance write of its Stock Material (Q21, rows 46–53)', () => {
    it('confirms a Material Receipt only after an As-of Date change to on or after its Received Date, then refuses it', async () => {
      const { paper, id, number, payload } = await ready();
      payload.as_of_date = '2026-10-10';
      const receipt = await receipts.draft(receipts.complete([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-05' }));
      const [fixed, res] = await behind('stock_materials', paper.id, () => correct(id, payload), () => receipts.confirm(receipt, 1));
      expectOk(fixed);
      expectAsOfRefusal(res, 'NOT_CONFIRMABLE', { id, number }, '2026-10-10');
    });

    it("confirms a Material Receipt only after a correction voids its Stock Material's Opening Balance line, then confirms it", async () => {
      const paper = await stocked();
      const { id, payload } = await voidingFirst(paper, await stocked());
      const receipt = await receipts.draft(receipts.complete([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-09-15' }));
      const [fixed, res] = await behind('stock_materials', paper.id, () => correct(id, payload), () => receipts.confirm(receipt, 1));
      expectOk(fixed, res);
      expect((await materialOf(paper.id)).current_stock).toBe('1');
    });

    it('confirms a Material Receipt only after a void of its Stock Material’s Opening Balance, then confirms it', async () => {
      const { paper, id } = await ready();
      const receipt = await receipts.draft(receipts.complete([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-09-15' }));
      const [voided, res] = await behind('stock_materials', paper.id, () => voidOpeningBalance(id, 2), () => receipts.confirm(receipt, 1));
      expectOk(voided, res);
      expect((await materialOf(paper.id)).current_stock).toBe('1');
    });

    it('confirms a Material Receipt only after a correction adds an Opening Balance line of its Stock Material, then refuses it', async () => {
      const { id, number, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '2'));
      const receipt = await receipts.draft(receipts.complete([receipts.line(pens.id, pens.ream, '1')], { received_date: '2026-09-15' }));
      const [fixed, res] = await behind('stock_materials', pens.id, () => correct(id, payload), () => receipts.confirm(receipt, 1));
      expectOk(fixed);
      expectAsOfRefusal(res, 'NOT_CONFIRMABLE', { id, number }, '2026-09-30');
    });

    it('corrects a Received Date only after an As-of Date change to on or after it, then refuses it', async () => {
      const { paper, id, number, payload } = await ready();
      payload.as_of_date = '2026-10-10';
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-20' });
      const fix = { ...receipts.correctionAsRead(await receipts.receiptOf(receipt.id)), received_date: '2026-10-05' };
      const [fixed, res] = await behind('stock_materials', paper.id, () => correct(id, payload), () => receipts.correct(receipt.id, fix));
      expectOk(fixed);
      expectAsOfRefusal(res, 'NOT_CORRECTABLE', { id, number }, '2026-10-10');
    });

    it("corrects a Received Date only after a correction voids its Stock Material's Opening Balance line, then corrects it", async () => {
      const paper = await stocked();
      const { id, payload } = await voidingFirst(paper, await stocked());
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-20' });
      const fix = { ...receipts.correctionAsRead(await receipts.receiptOf(receipt.id)), received_date: '2026-09-15' };
      const [fixed, res] = await behind('stock_materials', paper.id, () => correct(id, payload), () => receipts.correct(receipt.id, fix));
      expectOk(fixed, res);
      expect((await receipts.receiptOf(receipt.id)).received_date).toBe('2026-09-15');
    });

    it('corrects a Received Date only after a void of its Stock Material’s Opening Balance, then corrects it', async () => {
      const { paper, id } = await ready();
      const receipt = await receipts.received([receipts.line(paper.id, paper.ream, '1')], { received_date: '2026-10-20' });
      const fix = { ...receipts.correctionAsRead(await receipts.receiptOf(receipt.id)), received_date: '2026-09-15' };
      const [voided, res] = await behind('stock_materials', paper.id, () => voidOpeningBalance(id, 2), () => receipts.correct(receipt.id, fix));
      expectOk(voided, res);
      expect((await receipts.receiptOf(receipt.id)).received_date).toBe('2026-09-15');
    });

    it('adds a Receipt Line only after a correction adds an Opening Balance line of its Stock Material, then refuses it', async () => {
      const { id, number, payload } = await ready();
      const pens = await stocked();
      const other = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '2'));
      const receipt = await receipts.received([receipts.line(other.id, other.ream, '1')], { received_date: '2026-09-15' });
      const fix = receipts.correctionAsRead(await receipts.receiptOf(receipt.id));
      fix.lines.push(receipts.line(pens.id, pens.ream, '1'));
      const [fixed, res] = await behind('stock_materials', pens.id, () => correct(id, payload), () => receipts.correct(receipt.id, fix));
      expectOk(fixed);
      expectAsOfRefusal(res, 'NOT_CORRECTABLE', { id, number }, '2026-09-30');
    });
  });

  describe('an Opening Balance confirm or a Units write behind an Opening Balance write of its Stock Material (rows 55–59)', () => {
    it("confirms an Opening Balance only after a correction voids its Stock Material's line in another one, then confirms it", async () => {
      const paper = await stocked();
      const { id, payload } = await voidingFirst(paper, await stocked());
      const opening = await draft(complete([line(paper.id, paper.ream, '3')]));
      const [fixed, res] = await behind('stock_materials', paper.id, () => correct(id, payload), () => confirm(opening, 1));
      expectOk(fixed, res);
      expect((await materialOf(paper.id)).current_stock).toBe('3');
    });

    it('confirms an Opening Balance only after a void of the one holding its Stock Material, then confirms it', async () => {
      const { paper, id } = await ready();
      const opening = await draft(complete([line(paper.id, paper.ream, '3')]));
      const [voided, res] = await behind('stock_materials', paper.id, () => voidOpeningBalance(id, 2), () => confirm(opening, 1));
      expectOk(voided, res);
      expect((await materialOf(paper.id)).current_stock).toBe('3');
    });

    it('confirms an Opening Balance only after a correction adds a line of its Stock Material to another one, then refuses it naming that Opening Balance (story 40)', async () => {
      const { id, number, payload } = await ready();
      const pens = await stocked();
      payload.lines.push(line(pens.id, pens.ream, '1'));
      const opening = await draft(complete([line(pens.id, pens.ream, '3')]));
      const [fixed, res] = await behind('stock_materials', pens.id, () => correct(id, payload), () => confirm(opening, 1));
      expectOk(fixed);
      expect(res.statusCode).toBe(409);
      expect(res.json().problems).toEqual([
        { field: 'lines[0].stock_material_id', message: expect.stringContaining(`from Opening Balance ${number}`), in_effect_opening_balance: { opening_balance_id: id, opening_balance_number: number } },
      ]);
    });

    it('changes a Base Unit only after a correction adds a line of its Stock Material, then refuses it (F010-T5)', async () => {
      const { id, payload } = await ready();
      const fresh = await stocked();
      payload.lines.push(line(fresh.id, fresh.ream, '1'));
      const change = await baseChange(fresh);
      const [res, units] = await behind('stock_materials', fresh.id, () => correct(id, payload), () => replaceUnits(fresh.id, change));
      expectOk(res);
      expect(units.statusCode).toBe(409);
      expect(units.json()).toMatchObject({ code: 'BASE_UNIT_FROZEN', message: `base_unit.unit_id must stay ${fresh.ream}: a Stock Material with a Stock Movement keeps its Base Unit` });
    });

    it('changes a Base Unit only after a correction moves a line to its Stock Material, then refuses it (F010-T5)', async () => {
      const { id, payload } = await ready();
      const fresh = await stocked();
      Object.assign(payload.lines[0], { stock_material_id: fresh.id, unit_id: fresh.ream });
      const change = await baseChange(fresh);
      const [res, units] = await behind('stock_materials', fresh.id, () => correct(id, payload), () => replaceUnits(fresh.id, change));
      expectOk(res);
      expect(units.statusCode).toBe(409);
      expect(units.json()).toMatchObject({ code: 'BASE_UNIT_FROZEN', message: `base_unit.unit_id must stay ${fresh.ream}: a Stock Material with a Stock Movement keeps its Base Unit` });
    });
  });
});
