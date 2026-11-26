import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T7 (#238): each rule the void of a whole Material Receipt reads under a lock, against every write that changes
// its fact, and each rule another write reads that the void changes (CODING_STANDARDS, "A rule read under a lock has a
// test of its order"; the lock-order plan, start comment 7184458771, rows 1–9 and 54). The void locks the Material
// Receipt FOR UPDATE, then the Stock Materials of its lines in effect, by id, FOR UPDATE, then their Units' list
// entries FOR SHARE (#231 P4). Each test queues the changing write first and shows that the rule sees its result,
// passing every rule checked before it.
describe('Material Receipt void write order (Seam A - F010-T7)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const materials = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, created, materialOf } = materials;
  const { draft, line, complete, receiptOf, replaceDraft, removeDraft, confirm, received, correct, correctionAsRead, voidReceipt } = materialReceiptHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));
  const { whileHolding, whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A Stock Material counted in รีม, with กล่อง of 5 รีม, each Unit new.
  const stocked = async () => {
    const ream = await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`);
    const box = await unitNamed(`กล่อง ${crypto.randomUUID().slice(0, 6)}`);
    const name = `กระดาษ ${crypto.randomUUID().slice(0, 8)}`;
    const id = await created({ name, base_unit: { unit_id: ream, whole_number_only: false }, alternate_units: [{ unit_id: box, conversion_factor: '5', whole_number_only: false }] });
    return { id, name, ream, box };
  };

  // A Received Material Receipt of one line of 2 กล่อง, at version 2.
  const ready = async () => {
    const paper = await stocked();
    const { id } = await received([line(paper.id, paper.box, '2')]);
    return { paper, id };
  };

  const VOIDED = { code: 'VOIDED', message: 'The Material Receipt is voided: it can be neither corrected nor voided again' };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_receipt_void_order', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_receipt_void_order', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a void behind a write of the same Material Receipt (rows 1–6)', () => {
    it('voids only after a correction, then refuses the version it read as stale', async () => {
      const { paper, id } = await ready();
      const payload = correctionAsRead(await receiptOf(id));
      payload.lines[0].quantity = '3';
      const [corrected, res] = await whileHolding(
        'material_receipts',
        id,
        () => [correct(id, payload), untilWaiting('material_receipts').then(() => voidReceipt(id, 2))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(corrected.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Receipt changed since it was read', current_values: { version: 3, state: 'RECEIVED' }, expected_values: { version: 2 } });
      expect((await materialOf(paper.id)).current_stock).toBe('15');
    });

    // The second void expects the version the first leaves, so only the voided state read under the lock decides.
    it('voids only after another void, then refuses it as voided at the version that void leaves', async () => {
      const { id } = await ready();
      const [voided, res] = await whileHolding(
        'material_receipts',
        id,
        () => [voidReceipt(id, 2), untilWaiting('material_receipts').then(() => voidReceipt(id, 3))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(voided.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ...VOIDED, current_values: { version: 3, state: 'VOIDED' }, expected_values: { version: 3 } });
    });

    it('voids only after a confirm, at the version the confirm leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [confirmed, res] = await whileHolding(
        'material_receipts',
        id,
        () => [confirm(id, 1), untilWaiting('material_receipts').then(() => voidReceipt(id, 2))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(confirmed.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).state).toBe('VOIDED');
      expect((await materialOf(paper.id)).current_stock).toBe('0');
    });

    it('refuses a Draft only after a replace, as a Draft at the version the replace leaves', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [replaced, res] = await whileHolding(
        'material_receipts',
        id,
        () => [replaceDraft(id, { ...complete([line(paper.id, paper.box, '3')]), expected_version: 1 }), untilWaiting('material_receipts').then(() => voidReceipt(id, 2))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(replaced.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_RECEIVED', message: 'The Material Receipt is a Draft: only a Received one can be corrected or voided', current_values: { version: 2, state: 'DRAFT' } });
    });

    it('finds no Material Receipt only after a remove', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '2')]));
      const [removed, res] = await whileHolding(
        'material_receipts',
        id,
        () => [removeDraft(id, 1), untilWaiting('material_receipts').then(() => voidReceipt(id, 1))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(removed.statusCode).toBe(200);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
    });

    it('voids only after a correction adds a line, then reverses the added line’s Stock Movement too', async () => {
      const { paper, id } = await ready();
      const pens = await stocked();
      const payload = correctionAsRead(await receiptOf(id));
      payload.lines.push(line(pens.id, pens.ream, '4'));
      const [corrected, res] = await whileHolding(
        'material_receipts',
        id,
        () => [correct(id, payload), untilWaiting('material_receipts').then(() => voidReceipt(id, 3))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(corrected.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await materialOf(pens.id)).current_stock).toBe('0');
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await receiptOf(id)).history[2].facts.lines.map(({ line: voided }: any) => voided.stock_material.id)).toEqual([paper.id, pens.id]);
    });
  });

  describe('a void behind a rename of a name its history records (rows 7–8)', () => {
    it('voids only after a Material Correction renames a line’s Stock Material, then records the new name (#175 P6)', async () => {
      const { paper, id } = await ready();
      const renamed = `ชื่อใหม่ ${crypto.randomUUID().slice(0, 6)}`;
      const page = await materialOf(paper.id);
      const [corrected, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [
          materials.correct(paper.id, { expected_version: page.version, name: renamed, brand_id: null, model: null, specification: null, reason: 'สะกดผิด', explicit_continuation: true }),
          untilWaiting('stock_materials').then(() => voidReceipt(id, 2)),
        ],
        () => untilWaiting('stock_materials', 2)
      );
      expect(corrected.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).history[1].facts.lines[0].line.stock_material).toEqual({ id: paper.id, name: renamed });
    });

    it('voids only after a line’s Unit is renamed, then records the new name (#175 P6)', async () => {
      const { paper, id } = await ready();
      const renamed = `ลัง ${crypto.randomUUID().slice(0, 6)}`;
      const [res] = await whileWriting(
        { sql: 'UPDATE units SET name = $2, version = version + 1 WHERE id = $1', params: [paper.box, renamed] },
        () => [voidReceipt(id, 2)],
        () => untilWaiting('units', 1, 'FOR SHARE')
      );
      expect(res.statusCode).toBe(200);
      expect((await receiptOf(id)).history[1].facts.lines[0].line.unit).toEqual({ id: paper.box, name: renamed });
    });
  });

  describe('another write behind a void (rows 9 and 54)', () => {
    // The correction expects the version the void leaves, so only the voided state read under the lock decides.
    it('corrects only after a void, then refuses it as voided at the version the void leaves', async () => {
      const { id } = await ready();
      const payload = { ...correctionAsRead(await receiptOf(id)), expected_version: 3 };
      payload.lines[0].quantity = '3';
      const [voided, res] = await whileHolding(
        'material_receipts',
        id,
        () => [voidReceipt(id, 2), untilWaiting('material_receipts').then(() => correct(id, payload))],
        () => untilWaiting('material_receipts', 2)
      );
      expect(voided.statusCode).toBe(200);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ...VOIDED, current_values: { version: 3, state: 'VOIDED' }, expected_values: { version: 3 } });
    });

    it("confirms an Opening Balance only after a void reverses its Stock Material's only Stock Movement in effect, then confirms it (Q28)", async () => {
      const { paper, id } = await ready();
      const opening = await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.ream, '7')]));
      const [voided, res] = await whileHolding(
        'stock_materials',
        paper.id,
        () => [voidReceipt(id, 2), untilWaiting('stock_materials').then(() => openingBalances.confirm(opening, 1))],
        () => untilWaiting('stock_materials', 2)
      );
      expect(voided.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('7');
    });
  });
});
