import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

const TODAY = '2026-11-12';
const START = '2026-11-02';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F005-T6 (#104): fixing a Repair fact recorded wrong, with a reason, and deleting nothing (#98 Q18).
describe('Repair Correction (Seam A - F005-T6)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-12T05:00:00Z');

  const { detailOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { registered, loanOf, start: startLoan, lent, returned, closedNotReturned } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: '2026-11-01',
    dueDate: '2026-11-30',
  });
  const { sent, recordOf, recordsOf, recordOutcome, ended } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: START });

  const correct = (repairRecordId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/repairs/${repairRecordId}/corrections`, payload, { 'x-retry-token': token });

  // An amendment of `target`, against the record's latest version unless `overrides` says otherwise.
  const amendment = async (repairRecordId: string, target: Record<string, unknown>, changes: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    expected_version: (await recordOf(repairRecordId)).version,
    action: 'AMEND',
    target,
    reason: 'บันทึกผิดจากใบส่งซ่อม',
    changes,
    ...overrides,
  });

  // A void of `target`, against the record's latest version unless `overrides` says otherwise.
  const voiding = async (repairRecordId: string, target: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    expected_version: (await recordOf(repairRecordId)).version,
    action: 'VOID',
    target,
    reason: 'ไม่เคยส่งซ่อมจริง',
    ...overrides,
  });

  const amended = async (repairRecordId: string, target: Record<string, unknown>, changes: Record<string, unknown>) => {
    const res = await correct(repairRecordId, await amendment(repairRecordId, target, changes));
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const voided = async (repairRecordId: string, target: Record<string, unknown>) => {
    const res = await correct(repairRecordId, await voiding(repairRecordId, target));
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const RECORD = { kind: 'REPAIR_RECORD' };
  const outcomeTarget = async (repairRecordId: string) => ({ kind: 'REPAIR_OUTCOME', id: (await recordOf(repairRecordId)).outcome.id });

  // An Asset sent on START and ended ใช้งานได้ on 2026-11-03, and its Repair Record.
  const endedRecord = async (fields: Record<string, unknown> = {}, outcome: Record<string, unknown> = {}) => {
    const assetId = await registered();
    const repairRecordId = await sent(assetId, fields);
    await ended(repairRecordId, { outcome_date: '2026-11-03', ...outcome });
    return { assetId, repairRecordId };
  };

  // An Asset lent on 2026-11-01 and returned on 2026-11-01 in `condition`, and its Loan Return.
  const returnedAs = async (condition: 'NORMAL' | 'DAMAGED' = 'DAMAGED', assetId?: string) => {
    const asset = assetId ?? (await registered());
    const { loanId, itemOf } = await lent([asset]);
    await returned(loanId, [itemOf[asset]], '2026-11-01', condition);
    const loanReturnId: string = (await loanOf(loanId)).items[0].loan_return.id;
    return { assetId: asset, loanId, loanReturnId };
  };

  // The record's state that a refused correction must leave as it was.
  const unchanged = async (repairRecordId: string) => {
    const { can_record_repair: _record, can_correct_repair: _correct, ...record } = await recordOf(repairRecordId);
    return record;
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_repair_correction', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_repair_correction', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair_correction', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('amending a Repair Record', () => {
    it('leaves the corrected value on the record and keeps the reason, the actor, Recorded At and the before and after', async () => {
      const repairRecordId = await sent(await registered(), { remark: 'ส่งร้านเดิม' });

      const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, { remark: 'ส่งร้านหน้าสำนักงาน' }));

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ repair_record_id: repairRecordId, version: 2, correction_id: expect.stringMatching(UUID) });
      const record = await recordOf(repairRecordId);
      expect(record).toMatchObject({ remark: 'ส่งร้านหน้าสำนักงาน', version: 2 });
      expect(record.corrections).toEqual([
        {
          id: res.json().correction_id,
          target: { kind: 'REPAIR_RECORD', id: repairRecordId },
          action: 'AMENDED',
          reason: 'บันทึกผิดจากใบส่งซ่อม',
          changes: [{ field: 'remark', before: 'ส่งร้านเดิม', after: 'ส่งร้านหน้าสำนักงาน' }],
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_repair_correction',
          recorded_at: expect.any(String),
        },
      ]);
    });

    it('amends the kind, Start Date, Repairer, symptom or work, warranty, cost and document reference, and removes the remark, recording each field changed', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { cost: '1500', document_reference: 'ใบส่ง 1', remark: 'หมายเหตุผิด' });

      await amended(repairRecordId, RECORD, {
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-01',
        repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อมดี' },
        symptom_or_work: 'ล้างเครื่องประจำปี',
        under_warranty: 'YES',
        warranty_end_date: '2027-01-31',
        cost: '1800.5',
        document_reference: 'ใบส่ง 2',
        remark: null,
      });

      const record = await recordOf(repairRecordId);
      expect(record).toMatchObject({
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-01',
        repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อมดี' },
        symptom_or_work: 'ล้างเครื่องประจำปี',
        under_warranty: 'YES',
        warranty_end_date: '2027-01-31',
        cost: '1800.50',
        document_reference: 'ใบส่ง 2',
        remark: null,
      });
      expect(record.corrections[0].changes).toEqual([
        { field: 'repair_kind', before: 'REPAIR', after: 'MAINTENANCE' },
        { field: 'start_date', before: START, after: '2026-11-01' },
        { field: 'repairer_kind', before: 'INTERNAL', after: 'EXTERNAL' },
        { field: 'repairer_name', before: null, after: 'ร้านซ่อมดี' },
        { field: 'symptom_or_work', before: 'เปิดไม่ติด', after: 'ล้างเครื่องประจำปี' },
        { field: 'under_warranty', before: 'UNSPECIFIED', after: 'YES' },
        { field: 'warranty_end_date', before: null, after: '2027-01-31' },
        { field: 'cost', before: '1500.00', after: '1800.50' },
        { field: 'document_reference', before: 'ใบส่ง 1', after: 'ใบส่ง 2' },
        { field: 'remark', before: 'หมายเหตุผิด', after: null },
      ]);
      // Under Repair is derived, so it follows the amended kind and Start Date at once.
      expect((await detailOf(assetId)).under_repair).toMatchObject({ repair_kind: 'MAINTENANCE', start_date: '2026-11-01', repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อมดี' } });
    });

    it('must change something: the same values, a cost written another way, or no changes at all are refused', async () => {
      const repairRecordId = await sent(await registered(), { cost: '1500', repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อมดี' } });
      const before = await unchanged(repairRecordId);

      for (const changes of [{ cost: '1500.0' }, { repairer: { kind: 'EXTERNAL', name: ' ร้านซ่อมดี ' } }, { start_date: START }, {}]) {
        const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, changes));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await unchanged(repairRecordId)).toEqual(before);
    });

    it('never changes the record\'s Asset: a changed Asset is refused and nothing is saved', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      const before = await unchanged(repairRecordId);

      const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, { asset_id: await registered() }));

      expect(res.statusCode).toBe(400);
      expect(await unchanged(repairRecordId)).toEqual(before);
      expect((await detailOf(assetId)).under_repair).toMatchObject({ repair_record_id: repairRecordId });
    });

    it('holds the date rules afterwards: a Start Date after today, or after the Outcome Date, is refused', async () => {
      const open = await sent(await registered());
      const { repairRecordId } = await endedRecord();

      for (const [id, startDate] of [
        [open, '2026-11-13'],
        [repairRecordId, '2026-11-04'],
      ]) {
        const before = await unchanged(id);
        const res = await correct(id, await amendment(id, RECORD, { start_date: startDate }));
        expect(res.statusCode).toBe(400);
        expect(await unchanged(id)).toEqual(before);
      }
      // Today, and the Outcome Date itself, are fine.
      await amended(open, RECORD, { start_date: TODAY });
      await amended(repairRecordId, RECORD, { start_date: '2026-11-03' });
    });

    it('holds the text rules: a blank symptom or work, a Repairer name over one line, or a cost that is not baht is refused', async () => {
      const repairRecordId = await sent(await registered());
      const before = await unchanged(repairRecordId);

      for (const changes of [{ symptom_or_work: '  ' }, { repairer: { kind: 'EXTERNAL', name: 'ร้าน\nซ่อม' } }, { cost: '-1' }, { start_date: '2026-02-30' }]) {
        const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, changes));
        expect(res.statusCode).toBe(400);
      }
      expect(await unchanged(repairRecordId)).toEqual(before);
    });

    it('refuses an outcome field on the record, and a record field on its outcome', async () => {
      const { repairRecordId } = await endedRecord();
      const before = await unchanged(repairRecordId);

      expect((await correct(repairRecordId, await amendment(repairRecordId, RECORD, { outcome: 'NOT_USABLE' }))).statusCode).toBe(400);
      expect((await correct(repairRecordId, await amendment(repairRecordId, await outcomeTarget(repairRecordId), { cost: '1' }))).statusCode).toBe(400);
      expect(await unchanged(repairRecordId)).toEqual(before);
    });
  });

  describe('amending the Repair Source', () => {
    it('cites a Loan Return recorded ชำรุด, changes it, and removes it, keeping each before and after as a Repair Source', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const later = await returnedAs('DAMAGED', assetId);
      const repairRecordId = await sent(assetId);

      await amended(repairRecordId, RECORD, { repair_source: { loan_return_id: loanReturnId } });
      expect((await recordOf(repairRecordId)).repair_source).toMatchObject({ loan_return_id: loanReturnId, loan_id: loanId });
      await amended(repairRecordId, RECORD, { repair_source: { loan_return_id: later.loanReturnId } });
      await amended(repairRecordId, RECORD, { repair_source: null });

      const record = await recordOf(repairRecordId);
      expect(record.repair_source).toBeNull();
      const source = (id: string, loan: string) => ({ loan_return_id: id, loan_id: loan, return_date: '2026-11-01', condition: 'DAMAGED', is_voided: false });
      expect(record.corrections.map(({ changes }: any) => changes)).toEqual([
        [{ field: 'repair_source_loan_return_id', before: null, after: source(loanReturnId, loanId) }],
        [{ field: 'repair_source_loan_return_id', before: source(loanReturnId, loanId), after: source(later.loanReturnId, later.loanId) }],
        [{ field: 'repair_source_loan_return_id', before: source(later.loanReturnId, later.loanId), after: null }],
      ]);
      expect((await loanOf(loanId)).items[0].loan_return.repair_records).toEqual([]);
    });

    it('holds the Repair Source rule of F005-T5 afterwards, and saves nothing', async () => {
      const { assetId, loanId, loanReturnId: voidedReturn } = await returnedAs();
      const voidedLoan = await api.post(
        custodian,
        `/loans/${loanId}/corrections`,
        { expected_version: (await loanOf(loanId)).version, action: 'VOID', target: { kind: 'LOAN_RETURN', id: voidedReturn }, reason: 'บันทึกคืนผิด' },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(voidedLoan.statusCode).toBe(201);
      // The voided return left its item On Loan: it comes back ปกติ, so the Asset can be sent.
      await returned(loanId, [(await loanOf(loanId)).items[0].id], '2026-11-01', 'NORMAL');
      const normalReturn: string = (await loanOf(loanId)).items[0].loan_return.id;
      const otherAsset = await returnedAs();
      const repairRecordId = await sent(assetId);
      const before = await unchanged(repairRecordId);

      for (const [loanReturnId, reason] of [
        [voidedReturn, 'VOIDED'],
        [normalReturn, 'NOT_DAMAGED'],
        [otherAsset.loanReturnId, 'OTHER_ASSET'],
        [crypto.randomUUID(), 'NOT_LOAN_RETURN'],
      ]) {
        const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, { repair_source: { loan_return_id: loanReturnId } }));
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { loan_return_id: loanReturnId, reason } });
      }
      expect(await unchanged(repairRecordId)).toEqual(before);
    });

    it('keeps citing a Loan Return voided later when another field is amended (#98 Q5)', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const repairRecordId = await sent(assetId, { repair_source: { loan_return_id: loanReturnId } });
      await ended(repairRecordId, { outcome_date: '2026-11-03' });
      const voidedReturn = await api.post(
        custodian,
        `/loans/${loanId}/corrections`,
        { expected_version: (await loanOf(loanId)).version, action: 'VOID', target: { kind: 'LOAN_RETURN', id: loanReturnId }, reason: 'บันทึกคืนผิด' },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(voidedReturn.statusCode).toBe(201);

      await amended(repairRecordId, RECORD, { remark: 'แก้หมายเหตุ' });

      expect((await recordOf(repairRecordId)).repair_source).toMatchObject({ loan_return_id: loanReturnId, is_voided: true });
    });

    it('reads the Loan Return after locking its Asset, so a Loan Correction voiding it first is seen', async () => {
      const { assetId, loanId, loanReturnId } = await returnedAs();
      const repairRecordId = await sent(assetId);
      const voidLoan = { expected_version: (await loanOf(loanId)).version, action: 'VOID', target: { kind: 'LOAN' }, reason: 'ไม่เคยยืมจริง' };
      const amend = await amendment(repairRecordId, RECORD, { repair_source: { loan_return_id: loanReturnId } });

      // The Loan Correction queues at the Asset first, and the amendment behind it.
      const [voidedLoan, refused] = await whileHolding(
        'assets',
        assetId,
        () => [
          api.post(custodian, `/loans/${loanId}/corrections`, voidLoan, { 'x-retry-token': crypto.randomUUID() }),
          untilWaiting('assets', 1).then(() => correct(repairRecordId, amend)),
        ],
        () => untilWaiting('assets', 2)
      );

      expect(voidedLoan.statusCode).toBe(201);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { loan_return_id: loanReturnId, reason: 'VOIDED' } });
      expect((await recordOf(repairRecordId)).repair_source).toBeNull();
    });
  });

  describe('amending a Repair Outcome', () => {
    it('amends the outcome, its date, note, document reference and Next Recommended Maintenance Date, which the Asset page follows', async () => {
      const { assetId, repairRecordId } = await endedRecord({}, { note: 'เปลี่ยนสายไฟ', next_recommended_maintenance_date: '2027-05-01' });
      const target = await outcomeTarget(repairRecordId);

      const { version, correction_id } = await amended(repairRecordId, target, {
        outcome: 'NOT_USABLE',
        outcome_date: '2026-11-04',
        note: 'อะไหล่ไม่มีขาย',
        document_reference: 'ใบแจ้งร้าน 9',
        next_recommended_maintenance_date: null,
      });

      expect(version).toBe(3);
      const record = await recordOf(repairRecordId);
      expect(record.outcome).toMatchObject({
        id: target.id,
        outcome: 'NOT_USABLE',
        outcome_date: '2026-11-04',
        note: 'อะไหล่ไม่มีขาย',
        document_reference: 'ใบแจ้งร้าน 9',
        next_recommended_maintenance_date: null,
      });
      expect(record.corrections).toEqual([
        expect.objectContaining({
          id: correction_id,
          target,
          action: 'AMENDED',
          changes: [
            { field: 'outcome', before: 'USABLE', after: 'NOT_USABLE' },
            { field: 'outcome_date', before: '2026-11-03', after: '2026-11-04' },
            { field: 'note', before: 'เปลี่ยนสายไฟ', after: 'อะไหล่ไม่มีขาย' },
            { field: 'document_reference', before: null, after: 'ใบแจ้งร้าน 9' },
            { field: 'next_recommended_maintenance_date', before: '2027-05-01', after: null },
          ],
        }),
      ]);
      const detail = await detailOf(assetId);
      expect(detail.next_recommended_maintenance_date).toBeNull();
      expect(detail.start_loan_warning).toEqual({ source: 'REPAIR_OUTCOME', date: '2026-11-04', repair_record_id: repairRecordId, repair_kind: 'REPAIR' });
    });

    it('holds the date rules afterwards: an Outcome Date after today or before the Start Date, or a Next Recommended Maintenance Date not after it, is refused', async () => {
      const { repairRecordId } = await endedRecord({}, { next_recommended_maintenance_date: '2027-05-01' });
      const target = await outcomeTarget(repairRecordId);
      const before = await unchanged(repairRecordId);

      for (const changes of [{ outcome_date: '2026-11-13' }, { outcome_date: '2026-11-01' }, { next_recommended_maintenance_date: '2026-11-03' }, { outcome_date: '2027-05-01' }]) {
        const res = await correct(repairRecordId, await amendment(repairRecordId, target, changes));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await unchanged(repairRecordId)).toEqual(before);
    });
  });

  describe('voiding', () => {
    it('voids a record without an outcome, which ends Under Repair; it stays shown and counts in nothing', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);

      const { correction_id } = await voided(repairRecordId, RECORD);

      const record = await recordOf(repairRecordId);
      expect(record).toMatchObject({ is_voided: true, outcome: null, voided_outcomes: [], version: 2 });
      expect(record.corrections).toEqual([
        expect.objectContaining({ id: correction_id, target: { kind: 'REPAIR_RECORD', id: repairRecordId }, action: 'VOIDED', reason: 'ไม่เคยส่งซ่อมจริง', changes: [] }),
      ]);
      expect(await recordsOf(assetId)).toEqual([expect.objectContaining({ id: repairRecordId, is_voided: true })]);
      expect((await detailOf(assetId)).under_repair).toBeNull();
      // The Asset is free: it can be lent, or sent again (#98 Q24).
      expect((await startLoan([assetId], { loan_date: TODAY })).statusCode).toBe(201);
    });

    it('voids a record with its Repair Outcome in the same action, so neither counts', async () => {
      const { assetId, repairRecordId } = await endedRecord({}, { outcome: 'NOT_USABLE', next_recommended_maintenance_date: '2027-05-01' });
      const { outcome } = await recordOf(repairRecordId);

      await voided(repairRecordId, RECORD);

      const record = await recordOf(repairRecordId);
      expect(record).toMatchObject({ is_voided: true, outcome: null, voided_outcomes: [outcome] });
      const detail = await detailOf(assetId);
      expect(detail).toMatchObject({ under_repair: null, next_recommended_maintenance_date: null, start_loan_warning: null });
    });

    it('voids only the Repair Outcome: the record is back without one, the Asset Under Repair again, and the cost the outcome replaced restored', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { cost: '500' });
      await ended(repairRecordId, { outcome_date: '2026-11-03', cost: '750' });
      const { outcome } = await recordOf(repairRecordId);

      const { version } = await voided(repairRecordId, { kind: 'REPAIR_OUTCOME', id: outcome.id });

      const record = await recordOf(repairRecordId);
      expect(record).toMatchObject({ is_voided: false, outcome: null, voided_outcomes: [outcome], cost: '500.00', version });
      expect((await detailOf(assetId)).under_repair).toMatchObject({ repair_record_id: repairRecordId, repair_kind: 'REPAIR' });
      const refusedLoan = await startLoan([assetId], { loan_date: TODAY });
      expect(refusedLoan.statusCode).toBe(409);
      expect(JSON.stringify(refusedLoan.json())).toContain('UNDER_REPAIR');
      // A new outcome may be recorded on it.
      expect((await recordOutcome(repairRecordId, { outcome_date: '2026-11-05' })).statusCode).toBe(201);
    });

    it('refuses to void an outcome while the Asset is On Loan, Not Returned, or Under Repair by another record, naming it, and changes nothing', async () => {
      const onLoan = await endedRecord();
      const loan = await lent([onLoan.assetId], { loan_date: '2026-11-04' });
      const notReturned = await endedRecord();
      const lost = await lent([notReturned.assetId], { loan_date: '2026-11-04' });
      await closedNotReturned(lost.loanId, [lost.itemOf[notReturned.assetId]], '2026-11-05');
      const again = await endedRecord();
      const later = await sent(again.assetId, { start_date: '2026-11-04' });

      for (const [{ assetId, repairRecordId }, asset] of [
        [onLoan, { reason: 'ON_LOAN', loan_id: loan.loanId }],
        [notReturned, { reason: 'NOT_RETURNED', loan_id: lost.loanId }],
        [again, { reason: 'UNDER_REPAIR', repair_record_id: later, repair_kind: 'REPAIR' }],
      ] as const) {
        const before = await unchanged(repairRecordId);
        const res = await correct(repairRecordId, await voiding(repairRecordId, await outcomeTarget(repairRecordId)));
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'REPAIR_OUTCOME_VOID_REFUSED', asset: { asset_id: assetId, ...asset } });
        expect(await unchanged(repairRecordId)).toEqual(before);
      }
      // Once the Loan is settled, the void goes through.
      await returned(loan.loanId, [loan.itemOf[onLoan.assetId]], '2026-11-05');
      await voided(onLoan.repairRecordId, await outcomeTarget(onLoan.repairRecordId));
    });

    it('decides the outcome void after locking the Asset, so a Loan start of it first is seen', async () => {
      const { assetId, repairRecordId } = await endedRecord();
      const voidOutcome = await voiding(repairRecordId, await outcomeTarget(repairRecordId));

      // The Loan start queues at the Asset first, and the void behind it.
      const [loan, refused] = await whileHolding(
        'assets',
        assetId,
        () => [startLoan([assetId], { loan_date: '2026-11-04' }), untilWaiting('assets', 1).then(() => correct(repairRecordId, voidOutcome))],
        () => untilWaiting('assets', 2)
      );

      expect(loan.statusCode).toBe(201);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'REPAIR_OUTCOME_VOID_REFUSED', asset: { reason: 'ON_LOAN', loan_id: loan.json().loan_id } });
      expect((await recordOf(repairRecordId)).outcome).not.toBeNull();
    });

    it('neither amends nor voids a voided fact again, nor an outcome voided with its record', async () => {
      const outcomeOnly = await endedRecord();
      const outcome = await outcomeTarget(outcomeOnly.repairRecordId);
      await voided(outcomeOnly.repairRecordId, outcome);
      const withRecord = await endedRecord();
      const cascaded = await outcomeTarget(withRecord.repairRecordId);
      await voided(withRecord.repairRecordId, RECORD);

      for (const [repairRecordId, target] of [
        [outcomeOnly.repairRecordId, outcome],
        [withRecord.repairRecordId, cascaded],
        [withRecord.repairRecordId, RECORD],
      ] as const) {
        const before = await unchanged(repairRecordId);
        const changes = target.kind === 'REPAIR_RECORD' ? { remark: 'แก้' } : { note: 'แก้' };
        for (const payload of [await amendment(repairRecordId, target, changes), await voiding(repairRecordId, target)]) {
          const res = await correct(repairRecordId, payload);
          expect(res.statusCode).toBe(400);
          expect(res.json().code).toBe('VALIDATION_FAILED');
        }
        expect(await unchanged(repairRecordId)).toEqual(before);
      }
    });

    it('needs a nonblank reason, and a void takes no changes', async () => {
      const repairRecordId = await sent(await registered());
      const before = await unchanged(repairRecordId);

      expect((await correct(repairRecordId, await voiding(repairRecordId, RECORD, { reason: '   ' }))).statusCode).toBe(400);
      expect((await correct(repairRecordId, await amendment(repairRecordId, RECORD, { remark: 'แก้' }, { reason: '' }))).statusCode).toBe(400);
      expect((await correct(repairRecordId, await voiding(repairRecordId, RECORD, { changes: { remark: 'แก้' } }))).statusCode).toBe(400);
      expect(await unchanged(repairRecordId)).toEqual(before);
    });

    it('answers an outcome of another record, or a record that does not exist, with 404, and a malformed target or id with 400', async () => {
      const { repairRecordId } = await endedRecord();
      const other = await endedRecord();

      expect((await correct(repairRecordId, await voiding(repairRecordId, await outcomeTarget(other.repairRecordId)))).statusCode).toBe(404);
      expect((await correct(crypto.randomUUID(), { expected_version: 1, action: 'VOID', target: RECORD, reason: 'ไม่มีจริง' })).statusCode).toBe(404);
      expect((await correct(repairRecordId, await voiding(repairRecordId, { kind: 'REPAIR_OUTCOME', id: 'not-a-uuid' }))).statusCode).toBe(400);
      expect((await correct(repairRecordId, await voiding(repairRecordId, { kind: 'ASSET' }))).statusCode).toBe(400);
      expect((await correct('not-a-uuid', { expected_version: 1, action: 'VOID', target: RECORD, reason: 'ไม่มีจริง' })).statusCode).toBe(400);
    });
  });

  describe('reading voided facts', () => {
    it('lists a voided record struck through, outside the with- and without-outcome filters and the outcome filter, but inside the others', async () => {
      const symptom = `เครื่องยกเลิก ${crypto.randomUUID()}`;
      const open = await sent(await registered(), { symptom_or_work: symptom });
      const { repairRecordId: closed } = await endedRecord({ symptom_or_work: symptom });
      await voided(open, RECORD);
      await voided(closed, RECORD);
      const listed = async (query: string) => (await api.get(readonly, `/repairs?search=${encodeURIComponent(symptom)}${query}`)).json().items.map(({ id }: any) => id);

      expect((await listed('')).sort()).toEqual([open, closed].sort());
      expect(await listed('&has_outcome=false')).toEqual([]);
      expect(await listed('&has_outcome=true')).toEqual([]);
      expect(await listed('&outcome=USABLE')).toEqual([]);
      expect((await listed('&repair_kind=REPAIR&repairer_kind=INTERNAL')).sort()).toEqual([open, closed].sort());
    });

    it('lists a record whose outcome alone was voided as without an outcome', async () => {
      const symptom = `ผลยกเลิก ${crypto.randomUUID()}`;
      const { repairRecordId } = await endedRecord({ symptom_or_work: symptom });
      await voided(repairRecordId, await outcomeTarget(repairRecordId));
      const listed = async (query: string) => (await api.get(readonly, `/repairs?search=${encodeURIComponent(symptom)}${query}`)).json().items.map(({ id }: any) => id);

      expect(await listed('&has_outcome=false')).toEqual([repairRecordId]);
      expect(await listed('&has_outcome=true')).toEqual([]);
    });

    it('shows corrections to every reader, oldest first, on the record page only', async () => {
      const { assetId, repairRecordId } = await endedRecord();
      const first = await amended(repairRecordId, RECORD, { remark: 'หนึ่ง' });
      const second = await amended(repairRecordId, await outcomeTarget(repairRecordId), { note: 'สอง' });

      for (const actor of [readonly, admin, custodian]) {
        expect((await recordOf(repairRecordId, actor)).corrections.map(({ id }: any) => id)).toEqual([first.correction_id, second.correction_id]);
      }
      expect((await recordsOf(assetId))[0]).not.toHaveProperty('corrections');
    });
  });

  describe('concurrency', () => {
    it('refuses a stale version with the stale-before conflict, and writes nothing', async () => {
      const repairRecordId = await sent(await registered());
      await amended(repairRecordId, RECORD, { remark: 'แก้ครั้งแรก' });
      const before = await unchanged(repairRecordId);

      const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, { remark: 'แก้ซ้อน' }, { expected_version: 1 }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await unchanged(repairRecordId)).toEqual(before);
    });

    it('locks the Repair Record, then its Asset', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      const payload = await amendment(repairRecordId, RECORD, { remark: 'แก้ระหว่างรอ' });
      const recordIsLocked = async (): Promise<boolean> => {
        const client = await api.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT 1 FROM repair_records WHERE id = $1 FOR UPDATE NOWAIT', [repairRecordId]);
          return false;
        } catch (err: any) {
          if (err.code === '55P03') {
            return true;
          }
          throw err;
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };

      // Held on the Asset, the correction waits there with the record already locked.
      const [res] = await whileHolding('assets', assetId, () => [correct(repairRecordId, payload)], async () => {
        await untilWaiting('assets');
        expect(await recordIsLocked()).toBe(true);
      });

      expect(res.statusCode).toBe(201);
    });

    it('ends concurrent corrections of one version with one correction, and the rest refused', async () => {
      const repairRecordId = await sent(await registered());
      const payloads = await Promise.all(Array.from({ length: 5 }, (_, i) => amendment(repairRecordId, RECORD, { remark: `แก้ ${i}` })));

      const responses = await Promise.all(payloads.map((payload) => correct(repairRecordId, payload)));

      expect(responses.filter((res) => res.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((res) => res.statusCode === 409)).toHaveLength(4);
      expect((await recordOf(repairRecordId)).corrections).toHaveLength(1);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const repairRecordId = await sent(await registered());

      const res = await api.post(custodian, `/repairs/${repairRecordId}/corrections`, await amendment(repairRecordId, RECORD, { remark: 'แก้' }));

      expect(res.statusCode).toBe(400);
      expect((await recordOf(repairRecordId)).corrections).toEqual([]);
    });

    it('answers an identical replay with the committed result and writes nothing, and refuses a changed payload', async () => {
      const repairRecordId = await sent(await registered());
      const token = crypto.randomUUID();
      const payload = await amendment(repairRecordId, RECORD, { remark: 'แก้ครั้งเดียว' });

      const first = await correct(repairRecordId, payload, token);
      const replay = await correct(repairRecordId, payload, token);
      const changed = await correct(repairRecordId, { ...payload, changes: { remark: 'แก้อย่างอื่น' } }, token);

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect((await recordOf(repairRecordId)).corrections).toHaveLength(1);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the void, the correction record, nor the receipt, and answers in the deterministic shape', async () => {
      const { assetId, repairRecordId } = await endedRecord();
      const payload = await voiding(repairRecordId, await outcomeTarget(repairRecordId));
      const token = 'repair-correction-fail-token';
      const before = await unchanged(repairRecordId);
      await api.pool.query(`
        CREATE FUNCTION fail_repair_correction() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected repair correction failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_repair_correction BEFORE INSERT ON repair_corrections
          FOR EACH ROW EXECUTE FUNCTION fail_repair_correction();
      `);
      try {
        const res = await correct(repairRecordId, payload, token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected repair correction failure');
      } finally {
        await api.pool.query('DROP TRIGGER fail_repair_correction ON repair_corrections; DROP FUNCTION fail_repair_correction();');
      }
      expect(await unchanged(repairRecordId)).toEqual(before);
      expect((await detailOf(assetId)).under_repair).toBeNull();
      expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);

      expect((await correct(repairRecordId, payload, token)).statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('lets an Administrator correct, and refuses a Read-only User and a System Maintainer, saving nothing', async () => {
      const repairRecordId = await sent(await registered());
      const maintainer = await api.actor('maintainer_repair_correction', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, maintainer]) {
        const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, { remark: 'แก้' }), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect((await recordOf(repairRecordId)).corrections).toEqual([]);

      const byAdmin = await correct(repairRecordId, await voiding(repairRecordId, RECORD), crypto.randomUUID(), admin);
      expect(byAdmin.statusCode).toBe(201);
      expect((await recordOf(repairRecordId)).corrections[0].recorded_by).toBe(admin.id);
    });

    it('needs repair:correct itself, and fails closed when the lookup fails, saving nothing', async () => {
      const repairRecordId = await sent(await registered());
      const payload = await voiding(repairRecordId, RECORD);
      const post = () => correct(repairRecordId, payload);

      expect((await withCapabilityAnswer(api.app, 'repair:correct', async () => false, post)).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'repair:correct', async () => { throw new Error('lookup failed'); }, post);
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await recordOf(repairRecordId)).toMatchObject({ is_voided: false, corrections: [] });
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const repairRecordId = await sent(await registered());
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/repairs/${repairRecordId}/corrections`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: { expected_version: 1, action: 'VOID', target: RECORD, reason: 'ไม่เคยส่ง' },
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_repair_correction', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await correct(repairRecordId, await voiding(repairRecordId, RECORD), crypto.randomUUID(), leaving)).statusCode);

      expect((await recordOf(repairRecordId)).is_voided).toBe(false);
    });

    it('tells the Repair Record page whether the viewer may correct it, which follows repair:correct alone', async () => {
      const repairRecordId = await sent(await registered());

      for (const actor of [custodian, admin]) {
        expect((await recordOf(repairRecordId, actor)).can_correct_repair).toBe(true);
      }
      expect((await recordOf(repairRecordId, readonly)).can_correct_repair).toBe(false);
      const denied = await withCapabilityAnswer(api.app, 'repair:correct', async () => false, () => api.get(custodian, `/repairs/${repairRecordId}`));
      expect(denied.json().can_correct_repair).toBe(false);
    });
  });
});
