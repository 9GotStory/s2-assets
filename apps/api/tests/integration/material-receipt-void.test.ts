import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';

// F010-T7 (#238): voiding a whole Material Receipt that never happened (ยกเลิกรายการ) through the composed application
// with real PostgreSQL (Seam A): its own write, with a reason, adding a Reversal (กลับรายการ) of every line's Stock
// Movement in effect; the Material Receipt stays shown as ยกเลิกแล้ว and takes no correction or void again (#231
// MRC-04, MADJ-02, Q18, P5, P9; start comment 7184458771).
describe('Material Receipt void (Seam A - F010-T7)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let otherOfficer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let requester: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  const now = new Date('2026-11-24T00:30:00+07:00');

  const { unitNamed, created, materialOf } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { draft, line, complete, receiptOf, received, correct, correctionAsRead, voidReceipt, listOf } = materialReceiptHelpers(() => ({ api, officer, reader: readonly }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));

  const tableCount = async (table: string): Promise<number> => (await api.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const counts = async () => ({
    material_receipt_lines: await tableCount('material_receipt_lines'),
    stock_movements: await tableCount('stock_movements'),
    material_receipt_history: await tableCount('material_receipt_history'),
  });

  // A Stock Material counted in รีม, with กล่อง of 5 รีม as an Alternate Unit, each Unit new, with their names.
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
  const stockOf = (receiptLine: any): string[] =>
    receiptLine.stock_movements.map(({ kind, original_quantity: quantity, conversion_factor: factor, base_quantity: base }: any) =>
      kind === 'REVERSAL' ? base : `${quantity} × ${factor} = ${base}`
    );

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    officer = await api.actor('officer_receipt_void', 'SUPPLY_OFFICER');
    otherOfficer = await api.actor('officer_receipt_void_two', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_receipt_void', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_receipt_void', 'READ_ONLY');
    requester = await api.actor('requester_receipt_void', 'REQUESTER');
    custodian = await api.actor('custodian_receipt_void', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_receipt_void', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_receipt_void', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('the void (Q18, P9)', () => {
    it('reverses every line in effect, keeps each line shown voided, records "voided" with the reason, and shows ยกเลิกแล้ว', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id, number } = await received([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);

      const res = await voidReceipt(id, 2, 'ผู้ขายไม่ได้ส่งของ', crypto.randomUUID(), otherOfficer);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ material_receipt_id: id, version: 3 });
      const receipt = await receiptOf(id);
      expect(receipt).toMatchObject({ state: 'VOIDED', version: 3, receipt_number: number });
      expect(receipt.lines.map((voided: any) => [voided.is_voided, voided.stock_movement_id, stockOf(voided)])).toEqual([
        [true, null, ['2 × 5 = 10', '-10']],
        [true, null, ['3 × 1 = 3', '-3']],
      ]);
      // Each Reversal on its Stock Movement's Effective Date, recorded by the voider at one moment (P9).
      const reversals = receipt.lines.map((voided: any) => voided.stock_movements[1]);
      expect(reversals.map(({ effective_date: date, recorded_by: by }: any) => [date, by])).toEqual([
        ['2026-11-01', otherOfficer.id],
        ['2026-11-01', otherOfficer.id],
      ]);
      expect(reversals[0].recorded_at).toBe(reversals[1].recorded_at);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(pens.id)).current_stock).toBe('0');
      expect(receipt.history).toHaveLength(2);
      expect(receipt.history[1]).toMatchObject({
        version: 3,
        kind: 'VOIDED',
        reason: 'ผู้ขายไม่ได้ส่งของ',
        recorded_by: otherOfficer.id,
        facts: {
          receipt_number: number,
          lines: [
            {
              change: 'VOIDED',
              line_id: receipt.lines[0].id,
              position: 0,
              line: {
                stock_material: { id: paper.id, name: paper.name },
                unit: { id: paper.box, name: paper.boxName },
                quantity: '2',
                unit_price: null,
                note: null,
                conversion_factor: '5',
                base_quantity: '10',
              },
            },
            {
              change: 'VOIDED',
              line_id: receipt.lines[1].id,
              position: 1,
              line: {
                stock_material: { id: pens.id, name: pens.name },
                unit: { id: pens.ream, name: pens.reamName },
                quantity: '3',
                unit_price: null,
                note: null,
                conversion_factor: '1',
                base_quantity: '3',
              },
            },
          ],
        },
      });
      const [entry] = (await listOf(`search=${number}`)).items;
      expect(entry).toMatchObject({ id, state: 'VOIDED', line_count: 2 });
      expect((await listOf(`search=${number}&state=voided`)).items.map(({ id: listed }: any) => listed)).toEqual([id]);
      expect((await listOf(`search=${number}&state=received`)).items).toEqual([]);
    });

    it('reverses each line’s Stock Movement in effect after a correction, never one already reversed, and leaves a line voided before as it was', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.box, '2'), line(pens.id, pens.ream, '3')]);
      const before = await receiptOf(id);
      const payload = correctionAsRead(before);
      payload.lines[0].quantity = '3';
      payload.lines.splice(1, 1);
      payload.voided_line_ids = [before.lines[1].id];
      expect((await correct(id, payload)).statusCode).toBe(200);

      expect((await voidReceipt(id, 3)).statusCode).toBe(200);

      const receipt = await receiptOf(id);
      expect(receipt.state).toBe('VOIDED');
      expect(receipt.lines.map(stockOf)).toEqual([
        ['2 × 5 = 10', '-10', '3 × 5 = 15', '-15'],
        ['3 × 1 = 3', '-3'],
      ]);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
      expect((await materialOf(pens.id)).current_stock).toBe('0');
      expect(receipt.history.map(({ kind }: any) => kind)).toEqual(['CONFIRMED', 'CORRECTED', 'VOIDED']);
      expect(receipt.history[2].facts.lines.map(({ line_id: lineId, line: voided }: any) => [lineId, voided.quantity, voided.base_quantity])).toEqual([[before.lines[0].id, '3', '15']]);
    });

    it('frees each Stock Material for an Opening Balance once it has no other Stock Movement in effect (Q28)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2'), line(pens.id, pens.ream, '1')]);
      await received([line(pens.id, pens.ream, '4')]);
      expect((await voidReceipt(id, 2)).statusCode).toBe(200);

      const opening = await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.ream, '7'), openingBalances.line(pens.id, pens.ream, '1')]));
      const refused = await openingBalances.confirm(opening, 1);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().problems.map(({ field }: any) => field)).toEqual(['lines[1].stock_material_id']);
      const freed = await openingBalances.confirmed([openingBalances.line(paper.id, paper.ream, '7')]);
      expect(freed.number).toMatch(/^\d+$/);
      expect((await materialOf(paper.id)).current_stock).toBe('7');
    });
  });

  describe('refusals', () => {
    it('refuses a correction and a second void of a voided Material Receipt, writing nothing', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const read = await receiptOf(id);
      expect((await voidReceipt(id, 2)).statusCode).toBe(200);
      const voided = await receiptOf(id);
      const before = await counts();
      const refusal = {
        code: 'VOIDED',
        message: 'The Material Receipt is voided: it can be neither corrected nor voided again',
        current_values: { version: 3, state: 'VOIDED' },
        expected_values: { version: 3 },
      };
      const again = await voidReceipt(id, 3);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject(refusal);
      const payload = { ...correctionAsRead(read), expected_version: 3 };
      payload.lines[0].quantity = '3';
      const corrected = await correct(id, payload);
      expect(corrected.statusCode).toBe(409);
      expect(corrected.json()).toMatchObject(refusal);
      expect(await counts()).toEqual(before);
      expect(await receiptOf(id)).toEqual(voided);
    });

    it('needs a nonblank reason of at most 2000 characters', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const before = await counts();
      for (const [reason, message] of [
        [' \n ', 'reason must not be blank'],
        ['', 'reason must not be blank'],
        ['ก'.repeat(2001), 'reason must be at most 2000 characters'],
      ]) {
        const res = await voidReceipt(id, 2, reason);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
      }
      const unsent = await api.post(officer, `/material-receipts/${id}/void`, { expected_version: 2 }, { 'x-retry-token': crypto.randomUUID() });
      expect(unsent.statusCode).toBe(400);
      expect(unsent.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/^Invalid request payload: reason: /) });
      expect(await counts()).toEqual(before);
      expect((await voidReceipt(id, 2, 'ก'.repeat(2000))).statusCode).toBe(200);
    });

    it('refuses a Draft, a stale version, a Material Receipt that does not exist and an id that is not a UUID', async () => {
      const paper = await stocked();
      const draftId = await draft(complete([line(paper.id, paper.ream, '1')]));
      const notReceived = await voidReceipt(draftId, 1);
      expect(notReceived.statusCode).toBe(409);
      expect(notReceived.json()).toMatchObject({
        code: 'NOT_RECEIVED',
        message: 'The Material Receipt is a Draft: only a Received one can be corrected or voided',
        current_values: { version: 1, state: 'DRAFT' },
        expected_values: { version: 1 },
      });
      const { id } = await received([line(paper.id, paper.ream, '1')]);
      const before = await counts();
      const stale = await voidReceipt(id, 1);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Receipt changed since it was read', current_values: { version: 2, state: 'RECEIVED' }, expected_values: { version: 1 } });
      expect(await counts()).toEqual(before);
      const missing = await voidReceipt(crypto.randomUUID(), 1);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
      const malformed = await voidReceipt('not-a-uuid', 1);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ code: 'INVALID_ID', message: 'Material Receipt ID must be a valid UUID string' });
    });
  });

  describe('retry tokens (Q26)', () => {
    it('needs a token, and answers a replay with its first answer, adding no second Reversal', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const untokened = await api.post(officer, `/material-receipts/${id}/void`, { expected_version: 2, reason: 'ไม่ได้รับจริง' });
      expect(untokened.statusCode).toBe(400);
      expect(untokened.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      const token = crypto.randomUUID();
      const first = await voidReceipt(id, 2, 'ไม่ได้รับจริง', token);
      expect(first.statusCode).toBe(200);
      const before = await counts();
      const replay = await voidReceipt(id, 2, 'ไม่ได้รับจริง', token);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await counts()).toEqual(before);
      expect((await materialOf(paper.id)).current_stock).toBe('0');
    });

    // One case per field the fingerprint covers (the fingerprint plan in start comment 7184458771).
    it('refuses a token replayed with the Material Receipt, the version or the reason changed', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const { id: other } = await received([line(paper.id, paper.ream, '1')]);
      const token = crypto.randomUUID();
      expect((await voidReceipt(id, 2, 'ไม่ได้รับจริง', token)).statusCode).toBe(200);
      const before = await counts();
      for (const res of [await voidReceipt(other, 2, 'ไม่ได้รับจริง', token), await voidReceipt(id, 3, 'ไม่ได้รับจริง', token), await voidReceipt(id, 2, 'อื่น', token)]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect(await counts()).toEqual(before);
      expect((await receiptOf(other)).state).toBe('RECEIVED');
    });
  });

  describe('permissions (Q3)', () => {
    it('lets only the Supply Officer void; every other role is refused, and nothing is written', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const before = await counts();
      for (const actor of [admin, readonly, requester, custodian, staff, maintainer]) {
        const res = await voidReceipt(id, 2, 'ไม่ได้รับจริง', crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
      }
      expect(await counts()).toEqual(before);
      expect((await voidReceipt(id, 2)).statusCode).toBe(200);
    });

    // The Supply Officer holds both capabilities, so a gate on material:view would let them through.
    it('needs material:manage itself, failing closed when the lookup fails, and a session and the CSRF token', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const before = await counts();
      const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => voidReceipt(id, 2));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => voidReceipt(id, 2));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected internal server error occurred.' });
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/material-receipts/${id}/void`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: { expected_version: 2, reason: 'ไม่ได้รับจริง' },
        });
      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await counts()).toEqual(before);
    });
  });
});
