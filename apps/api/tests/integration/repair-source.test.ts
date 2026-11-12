import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

// F005-T5 (#103): a Repair Record sent from a Loan Return recorded ชำรุด, which it cites as its Repair
// Source, and the Loan page that links back (LR-13, RM-08, #98 Q5).
describe('Repair Source (Seam A - F005-T5)', () => {
  let api: ApiHarness;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-12T05:00:00Z');

  const { registered, loanOf, lent, returned } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: '2026-11-01',
    dueDate: '2026-11-30',
  });
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { base, send, sent, recordOf, recordsOf, ended } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-11-05' });

  // An Asset lent on 2026-11-01 and returned on 2026-11-04 in `condition`, and its Loan Return.
  const returnedAs = async (condition: 'NORMAL' | 'DAMAGED' = 'DAMAGED', name?: string) => {
    const assetId = await registered(name);
    const { loanId, itemOf } = await lent([assetId]);
    await returned(loanId, [itemOf[assetId]], '2026-11-04', condition);
    const loanReturnId: string = (await loanOf(loanId)).items[0].loan_return.id;
    return { assetId, loanId, loanReturnId };
  };

  const fromLoanReturn = (loanReturnId: string) => ({ repair_source: { loan_return_id: loanReturnId } });

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    custodian = await api.actor('custodian_repair_source', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair_source', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('sending from a Loan Return recorded ชำรุด', () => {
    it('cites the Loan Return as its Repair Source, which the record shows with its Loan', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();

      const repairRecordId = await sent(assetId, fromLoanReturn(loanReturnId));

      expect((await recordOf(repairRecordId)).repair_source).toEqual({
        loan_return_id: loanReturnId,
        loan_id: loanId,
        return_date: '2026-11-04',
        condition: 'DAMAGED',
        is_voided: false,
      });
    });

    it('still sends an Asset with no Repair Source, as from the Asset page', async () => {
      const assetId = await registered();

      expect((await recordOf(await sent(assetId))).repair_source).toBeNull();
      expect((await recordOf(await sent(await registered(), { repair_source: null }))).repair_source).toBeNull();
    });

    it('saves once for a repeated submission, and refuses the token for another Repair Source', async () => {
      const { assetId, loanReturnId } = await returnedAs();
      const token = crypto.randomUUID();

      const first = await send(base(assetId, fromLoanReturn(loanReturnId)), token);
      const again = await send(base(assetId, fromLoanReturn(loanReturnId)), token);
      const changed = await send(base(assetId), token);

      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(201);
      expect(again.json()).toEqual(first.json());
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });
  });

  describe('what cannot be a Repair Source', () => {
    // A Repair Start of `assetId` citing `loanReturnId` is refused for `reason`, and nothing is saved.
    const refusedFor = async (assetId: string, loanReturnId: string, reason: string) => {
      const res = await send(base(assetId, fromLoanReturn(loanReturnId)));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { loan_return_id: loanReturnId, reason } });
      expect((await api.get(readonly, `/assets/${assetId}/repairs`)).json().records).toEqual([]);
    };

    it('refuses a Loan Return recorded ปกติ', async () => {
      const { assetId, loanReturnId } = await returnedAs('NORMAL');

      await refusedFor(assetId, loanReturnId, 'NOT_DAMAGED');
    });

    it('refuses a Loan Return of another Asset', async () => {
      const { loanReturnId } = await returnedAs();

      await refusedFor(await registered(), loanReturnId, 'OTHER_ASSET');
    });

    it('refuses a Loan Return voided by a Loan Correction', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const voided = await api.post(
        custodian,
        `/loans/${loanId}/corrections`,
        { expected_version: (await loanOf(loanId)).version, action: 'VOID', target: { kind: 'LOAN' }, reason: 'ไม่เคยยืมจริง' },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(voided.statusCode).toBe(201);

      await refusedFor(assetId, loanReturnId, 'VOIDED');
    });

    it('reads the Loan Return after locking its Asset, so a Loan Correction voiding it first is seen', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const voidLoan = {
        expected_version: (await loanOf(loanId)).version,
        action: 'VOID',
        target: { kind: 'LOAN' },
        reason: 'ไม่เคยยืมจริง',
      };

      // The correction queues at the Asset first, and the Repair Start behind it.
      const [voided, refused] = await whileHolding(
        'assets',
        assetId,
        () => [
          api.post(custodian, `/loans/${loanId}/corrections`, voidLoan, { 'x-retry-token': crypto.randomUUID() }),
          untilWaiting('assets', 1).then(() => send(base(assetId, fromLoanReturn(loanReturnId)))),
        ],
        () => untilWaiting('assets', 2)
      );

      expect(voided.statusCode).toBe(201);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { loan_return_id: loanReturnId, reason: 'VOIDED' } });
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('refuses a Not Returned, and an id that names no Loan Return', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const closed = await api.post(
        custodian,
        `/loans/${loanId}/not-returned`,
        { expected_version: (await loanOf(loanId)).version, not_returned_date: '2026-11-03', reason: 'แจ้งว่าหาย', items: [{ loan_item_id: itemOf[assetId] }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(closed.statusCode).toBe(201);
      // It turned up damaged, so it has both facts and is held by no Loan (#74 Q21).
      await returned(loanId, [itemOf[assetId]], '2026-11-04', 'DAMAGED');
      const notReturnedId: string = (await loanOf(loanId)).items[0].not_returned.id;

      await refusedFor(assetId, notReturnedId, 'NOT_LOAN_RETURN');
      await refusedFor(assetId, crypto.randomUUID(), 'NOT_LOAN_RETURN');
    });

    it('refuses an id that is not a UUID as a validation failure', async () => {
      const assetId = await registered();

      const res = await send(base(assetId, fromLoanReturn('not-a-uuid')));

      expect(res.statusCode).toBe(400);
      expect((await api.get(readonly, `/assets/${assetId}/repairs`)).json().records).toEqual([]);
    });

    it('keeps the Repair Start refusals: an Asset On Loan again, or already Under Repair, is refused', async () => {
      const { assetId, loanReturnId } = await returnedAs();
      const { loanId } = await lent([assetId], { loan_date: '2026-11-06' });

      const onLoan = await send(base(assetId, fromLoanReturn(loanReturnId)));
      expect(onLoan.statusCode).toBe(409);
      expect(onLoan.json()).toMatchObject({ code: 'REPAIR_START_REFUSED', asset: { asset_id: assetId, reason: 'ON_LOAN', loan_id: loanId } });

      const repairing = await returnedAs();
      const repairRecordId = await sent(repairing.assetId, fromLoanReturn(repairing.loanReturnId));
      const underRepair = await send(base(repairing.assetId, fromLoanReturn(repairing.loanReturnId)));
      expect(underRepair.statusCode).toBe(409);
      expect(underRepair.json()).toMatchObject({ code: 'REPAIR_START_REFUSED', asset: { reason: 'UNDER_REPAIR', repair_record_id: repairRecordId } });
    });
  });

  describe('reading', () => {
    it('lists on the Loan page, for its Loan Return, the Repair Records that cite it, oldest first', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const first = await sent(assetId, { ...fromLoanReturn(loanReturnId), repair_kind: 'MAINTENANCE', start_date: '2026-11-05' });
      await ended(first, { outcome: 'NOT_USABLE', outcome_date: '2026-11-06' });
      // Maintenance that found a fault ends ใช้งานไม่ได้, and a ซ่อม record starts from the same return (#98 Q16).
      const second = await sent(assetId, { ...fromLoanReturn(loanReturnId), start_date: '2026-11-06' });

      const loan = await loanOf(loanId);

      expect(loan.items[0].loan_return.repair_records).toEqual([
        { id: first, repair_kind: 'MAINTENANCE', start_date: '2026-11-05', is_voided: false },
        { id: second, repair_kind: 'REPAIR', start_date: '2026-11-06', is_voided: false },
      ]);
    });

    it('lists no Repair Record for a Loan Return that none cites', async () => {
      const { loanId } = await returnedAs();

      expect((await loanOf(loanId)).items[0].loan_return.repair_records).toEqual([]);
    });

    it('shows the Repair Source in the Repair list and among the Asset\'s Repair Records as on the record page', async () => {
      const { assetId, loanReturnId } = await returnedAs();
      const symptom = `จอแตกจากการยืม ${crypto.randomUUID()}`;
      const repairRecordId = await sent(assetId, { ...fromLoanReturn(loanReturnId), symptom_or_work: symptom });
      // The record page alone adds its corrections and what the viewer may do (F005-T6).
      const { can_record_repair: _canRecordRepair, can_correct_repair: _canCorrectRepair, corrections: _corrections, ...shown } = await recordOf(repairRecordId);

      expect((await recordsOf(assetId))[0]).toEqual(shown);
      const listed = await api.get(readonly, `/repairs?search=${encodeURIComponent(symptom)}`);
      expect(listed.json().items).toEqual([shown]);
    });

    it('tells the Loan page whether the viewer may send for repair, and fails closed', async () => {
      const { loanId } = await returnedAs();

      expect((await loanOf(loanId, custodian)).can_record_repair).toBe(true);
      expect((await loanOf(loanId, readonly)).can_record_repair).toBe(false);
      const denied = await withCapabilityAnswer(api.app, 'repair:record', async () => false, () => api.get(custodian, `/loans/${loanId}`));
      expect(denied.statusCode).toBe(200);
      expect(denied.json().can_record_repair).toBe(false);
    });

    it('keeps a Repair Record when its Loan Return is later voided, and shows its source ยกเลิกแล้ว on both pages', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const repairRecordId = await sent(assetId, fromLoanReturn(loanReturnId));
      await ended(repairRecordId, { outcome_date: '2026-11-07' });
      const before = await recordOf(repairRecordId);

      const voided = await api.post(
        custodian,
        `/loans/${loanId}/corrections`,
        {
          expected_version: (await loanOf(loanId)).version,
          action: 'VOID',
          target: { kind: 'LOAN_RETURN', id: loanReturnId },
          reason: 'บันทึกคืนผิดรายการ',
          // The Loan is open again from before the repair (F005-T7).
          confirmed_conflicts: [{ conflicting_repair_record_id: repairRecordId }],
        },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(voided.statusCode).toBe(201);

      const after = await recordOf(repairRecordId);
      expect(after).toEqual({ ...before, repair_source: { ...before.repair_source, is_voided: true }, conflicts: [expect.objectContaining({ kind: 'LOAN_ITEM', loan_id: loanId })] });
      const item = (await loanOf(loanId)).items[0];
      expect(item.loan_return).toBeNull();
      expect(item.voided_endings).toEqual([
        expect.objectContaining({ kind: 'LOAN_RETURN', id: loanReturnId, repair_records: [{ id: repairRecordId, repair_kind: 'REPAIR', start_date: '2026-11-05', is_voided: false }] }),
      ]);
    });
  });
});
