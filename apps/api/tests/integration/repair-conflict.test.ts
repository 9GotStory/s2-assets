import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

// Today is 2026-11-12 in Asia/Bangkok.
const TODAY = '2026-11-12';

// F005-T7 (#105): a Repair Record whose period overlaps another Repair Record or a LoanItem of the same
// Asset, warned before saving from either side, kept, marked and cleared by correction (#98 Q17, Q19).
describe('Repair Conflict (Seam A - F005-T7)', () => {
  let api: ApiHarness;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-12T05:00:00Z');

  const {
    registered,
    loanOf,
    start: startLoan,
    lent,
    returned,
    correct: loanCorrection,
    amendment: loanAmendment,
    voiding: loanVoiding,
    voided: loanVoided,
  } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: TODAY,
    dueDate: '2026-11-30',
  });
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const {
    base,
    send,
    sent,
    recordOf,
    recordsOf,
    ended,
    correct: repairCorrection,
    amendment: repairAmendment,
    voiding: repairVoiding,
    amended: repairAmended,
    voided: repairVoided,
  } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: TODAY });
  const RECORD = { kind: 'REPAIR_RECORD' };

  // A Loan of `assetId` from `loanDate`, returned on `returnDate`, and its LoanItem.
  const lentAndReturned = async (assetId: string, loanDate: string, returnDate: string) => {
    const loan = await lent([assetId], { loan_date: loanDate, due_date: returnDate });
    await returned(loan.loanId, [loan.itemOf[assetId]], returnDate);
    return { loanId: loan.loanId, loanItemId: loan.itemOf[assetId] };
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    custodian = await api.actor('custodian_repair_conflict', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair_conflict', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a backdated Repair Start', () => {
    it('that overlaps an old Loan is refused with a warning listing the Repair Conflict, and saves nothing', async () => {
      const assetId = await registered('เครื่องพิมพ์ซ่อมย้อนหลัง');
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      const res = await send(base(assetId, { start_date: '2026-10-01', outcome: { outcome: 'USABLE', outcome_date: '2026-10-15' } }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_CONFLICTS_FOUND' });
      // The new record has no id, because nothing is saved.
      expect(res.json().repair_conflicts).toEqual([
        {
          asset_id: assetId,
          name: 'เครื่องพิมพ์ซ่อมย้อนหลัง',
          asset_number: null,
          repair_record_id: null,
          conflicting: { kind: 'LOAN_ITEM', loan_id: loan.loanId, loan_item_id: loan.loanItemId, loan_date: '2026-10-10', ending_date: '2026-10-20' },
        },
      ]);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('is saved once the request confirms the conflict, and the record is marked with the LoanItem', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      const repairRecordId = await sent(assetId, {
        start_date: '2026-10-01',
        confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }],
      });

      expect((await recordOf(repairRecordId)).conflicts).toEqual([
        { kind: 'LOAN_ITEM', loan_id: loan.loanId, loan_item_id: loan.loanItemId, loan_date: '2026-10-10', ending_date: '2026-10-20' },
      ]);
    });

    it('that overlaps another Repair Record warns with it, and both records are then marked, each with the other', async () => {
      const assetId = await registered();
      const earlier = await sent(assetId, { start_date: '2026-10-01' });
      await ended(earlier, { outcome_date: '2026-10-10' });
      const fields = { start_date: '2026-10-05', repair_kind: 'MAINTENANCE', outcome: { outcome: 'USABLE', outcome_date: '2026-10-08' } };

      const warned = await send(base(assetId, fields));
      expect(warned.statusCode).toBe(409);
      expect(warned.json().repair_conflicts.map(({ conflicting }: any) => conflicting)).toEqual([
        { kind: 'REPAIR_RECORD', repair_record_id: earlier, repair_kind: 'REPAIR', start_date: '2026-10-01', outcome_date: '2026-10-10' },
      ]);

      const later = await sent(assetId, { ...fields, confirmed_conflicts: [{ conflicting_repair_record_id: earlier }] });
      expect((await recordOf(later)).conflicts).toEqual([{ kind: 'REPAIR_RECORD', repair_record_id: earlier, repair_kind: 'REPAIR', start_date: '2026-10-01', outcome_date: '2026-10-10' }]);
      expect((await recordOf(earlier)).conflicts).toEqual([{ kind: 'REPAIR_RECORD', repair_record_id: later, repair_kind: 'MAINTENANCE', start_date: '2026-10-05', outcome_date: '2026-10-08' }]);
    });

    it('warns again about every conflict when the confirmation leaves one out', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const earlier = await sent(assetId, { start_date: '2026-10-21' });
      await ended(earlier, { outcome_date: '2026-10-25' });

      const res = await send(base(assetId, { start_date: '2026-10-01', confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }] }));

      expect(res.statusCode).toBe(409);
      expect(res.json().repair_conflicts.map(({ conflicting }: any) => conflicting.kind)).toEqual(['LOAN_ITEM', 'REPAIR_RECORD']);
      expect(await recordsOf(assetId)).toHaveLength(1);
    });

    it('does not conflict with a Loan Return on its Start Date: a same-day handover is normal', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      expect((await send(base(assetId, { start_date: '2026-10-20' }))).statusCode).toBe(201);
    });

    it('conflicts when its Start Date is one day before that Loan Return', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      expect((await send(base(assetId, { start_date: '2026-10-19' }))).statusCode).toBe(409);
    });

    it('does not conflict with a Loan that starts on its Outcome Date', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      const res = await send(base(assetId, { start_date: '2026-10-01', outcome: { outcome: 'USABLE', outcome_date: '2026-10-10' } }));

      expect(res.statusCode).toBe(201);
    });

    it('does not conflict with a voided Repair Record or a voided Loan', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      await loanVoided(loan.loanId, { kind: 'LOAN' });
      const earlier = await sent(assetId, { start_date: '2026-10-01' });
      await repairVoided(earlier, RECORD);

      expect((await send(base(assetId, { start_date: '2026-10-05' }))).statusCode).toBe(201);
    });

    it('refuses a confirmation that names no id, or names both kinds at once', async () => {
      const assetId = await registered();

      for (const confirmed of [{ conflicting_repair_record_id: 'not-an-id' }, { conflicting_loan_item_id: crypto.randomUUID(), conflicting_repair_record_id: crypto.randomUUID() }]) {
        expect((await send(base(assetId, { confirmed_conflicts: [confirmed] }))).statusCode).toBe(400);
      }
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('stores nothing for a refused warning, so the same retry token carries the confirmed request, and a replay returns it', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const token = crypto.randomUUID();
      const request = base(assetId, { start_date: '2026-10-01' });
      const confirmedRequest = { ...request, confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }] };

      const warned = await send(request, token);
      const saved = await send(confirmedRequest, token);
      const replayed = await send(confirmedRequest, token);

      expect(warned.statusCode).toBe(409);
      expect(saved.statusCode).toBe(201);
      expect(replayed.json()).toEqual(saved.json());
      expect(await recordsOf(assetId)).toHaveLength(1);
      expect((await send(request, token)).json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH' });
    });
  });

  // An Asset lent from 2026-10-10 and returned 2026-10-20, then a Repair Record from 2026-10-01, Under
  // Repair, saved with its Repair Conflict confirmed.
  const inConflict = async () => {
    const assetId = await registered();
    const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
    const repairRecordId = await sent(assetId, { start_date: '2026-10-01', confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }] });
    return { assetId, loan, repairRecordId };
  };

  const listed = async (query: string) => {
    const res = await api.get(readonly, `/repairs?limit=100&${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().items.map(({ id }: any) => id);
  };

  describe('visibility', () => {
    it("marks each Repair Conflict in the Asset's Repair Records, and the Asset detail says one exists", async () => {
      const { assetId, loan, repairRecordId } = await inConflict();
      const clean = await registered();

      expect((await recordsOf(assetId)).map(({ id, conflicts }: any) => [id, conflicts.map(({ loan_item_id }: any) => loan_item_id)])).toEqual([[repairRecordId, [loan.loanItemId]]]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_repair_conflict).toBe(true);
      expect((await api.get(readonly, `/assets/${clean}`)).json().has_repair_conflict).toBe(false);
    });

    it('finds the records in a Repair Conflict through the "มี conflict ค้างตรวจ" filter, and no other record', async () => {
      const { repairRecordId } = await inConflict();
      const clean = await sent(await registered());

      const ids = await listed('has_repair_conflict=true');

      expect(ids).toContain(repairRecordId);
      expect(ids).not.toContain(clean);
    });

    it('takes the filter only as true', async () => {
      expect((await api.get(readonly, '/repairs?has_repair_conflict=false')).statusCode).toBe(400);
    });

    it("leaves the Loan list's Loan Conflict filter to two overlapping LoanItems", async () => {
      const { loan } = await inConflict();

      expect((await loanOf(loan.loanId)).items[0].conflicts).toEqual([]);
      const loans = await api.get(readonly, '/loans?limit=100&has_loan_conflict=true');
      expect(loans.json().items.map(({ id }: any) => id)).not.toContain(loan.loanId);
    });
  });

  describe('a backdated Loan', () => {
    it('that overlaps an old Repair Record is refused with a warning listing the Repair Conflict, and saves nothing', async () => {
      const assetId = await registered('สแกนเนอร์ยืมย้อนหลัง');
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      await ended(repairRecordId, { outcome_date: '2026-10-10' });

      const res = await startLoan([assetId], { loan_date: '2026-10-05', due_date: '2026-10-25' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_CONFLICTS_FOUND', conflicts: [] });
      expect(res.json().repair_conflicts).toEqual([
        {
          asset_id: assetId,
          name: 'สแกนเนอร์ยืมย้อนหลัง',
          asset_number: null,
          loan_item_id: null,
          conflicting: { kind: 'REPAIR_RECORD', repair_record_id: repairRecordId, repair_kind: 'REPAIR', start_date: '2026-10-01', outcome_date: '2026-10-10' },
        },
      ]);
      expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toHaveLength(0);
    });

    it('is saved once the request confirms the Repair Record, which is then marked with its LoanItem', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      await ended(repairRecordId, { outcome_date: '2026-10-10' });

      const loan = await lent([assetId], { loan_date: '2026-10-05', due_date: '2026-10-25', confirmed_conflicts: [{ conflicting_repair_record_id: repairRecordId }] });

      expect((await recordOf(repairRecordId)).conflicts).toEqual([
        { kind: 'LOAN_ITEM', loan_id: loan.loanId, loan_item_id: loan.itemOf[assetId], loan_date: '2026-10-05', ending_date: null },
      ]);
    });

    it('that would create both kinds lists both in one warning, and warns again until both are confirmed', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      await ended(repairRecordId, { outcome_date: '2026-10-10' });
      const earlier = await lentAndReturned(assetId, '2026-10-12', '2026-10-15');
      const dates = { loan_date: '2026-10-05', due_date: '2026-10-25' };

      const warned = await startLoan([assetId], dates);
      expect(warned.statusCode).toBe(409);
      expect(warned.json()).toMatchObject({ code: 'LOAN_CONFLICTS_FOUND' });
      expect(warned.json().conflicts.map(({ conflicting }: any) => conflicting.loan_item_id)).toEqual([earlier.loanItemId]);
      expect(warned.json().repair_conflicts.map(({ conflicting }: any) => conflicting.repair_record_id)).toEqual([repairRecordId]);

      const halfConfirmed = await startLoan([assetId], { ...dates, confirmed_conflicts: [{ conflicting_loan_item_id: earlier.loanItemId }] });
      expect(halfConfirmed.statusCode).toBe(409);
      expect(halfConfirmed.json()).toMatchObject({ code: 'LOAN_CONFLICTS_FOUND', repair_conflicts: [expect.anything()] });

      const confirmed = await startLoan([assetId], {
        ...dates,
        confirmed_conflicts: [{ conflicting_loan_item_id: earlier.loanItemId }, { conflicting_repair_record_id: repairRecordId }],
      });
      expect(confirmed.statusCode).toBe(201);
    });

    it('does not conflict with a Repair Outcome on its Loan Date', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      await ended(repairRecordId, { outcome_date: '2026-10-10' });

      expect((await startLoan([assetId], { loan_date: '2026-10-10', due_date: '2026-10-25' })).statusCode).toBe(201);
    });
  });

  const outcomeOf = async (repairRecordId: string) => ({ kind: 'REPAIR_OUTCOME', id: (await recordOf(repairRecordId)).outcome.id });

  // An Asset lent from 2026-10-10 and returned 2026-10-20, then sent on 2026-10-21 and ended on 2026-10-25.
  const repairedAfterLoan = async (name?: string) => {
    const assetId = await registered(name);
    const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
    const repairRecordId = await sent(assetId, { start_date: '2026-10-21' });
    await ended(repairRecordId, { outcome_date: '2026-10-25' });
    return { assetId, loan, repairRecordId };
  };

  describe('a Repair Correction', () => {
    it('that moves the Start Date into a Loan is refused with a warning naming the record, and saves nothing', async () => {
      const { assetId, loan, repairRecordId } = await repairedAfterLoan('จอแก้วันส่งซ่อม');
      const before = await recordOf(repairRecordId);

      const res = await repairCorrection(repairRecordId, await repairAmendment(repairRecordId, RECORD, { start_date: '2026-10-15' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'REPAIR_CONFLICTS_FOUND',
        repair_conflicts: [
          {
            asset_id: assetId,
            name: 'จอแก้วันส่งซ่อม',
            asset_number: null,
            repair_record_id: repairRecordId,
            conflicting: { kind: 'LOAN_ITEM', loan_id: loan.loanId, loan_item_id: loan.loanItemId, loan_date: '2026-10-10', ending_date: '2026-10-20' },
          },
        ],
      });
      expect(await recordOf(repairRecordId)).toEqual(before);
    });

    it('is saved once the request confirms the conflict, which is then marked', async () => {
      const { loan, repairRecordId } = await repairedAfterLoan();

      await repairAmended(repairRecordId, RECORD, { start_date: '2026-10-15' }, { confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }] });

      expect((await recordOf(repairRecordId)).conflicts.map(({ loan_item_id }: any) => loan_item_id)).toEqual([loan.loanItemId]);
    });

    it('that moves an Outcome Date into a later Repair Record warns in the same way', async () => {
      const assetId = await registered();
      const earlier = await sent(assetId, { start_date: '2026-10-01' });
      await ended(earlier, { outcome_date: '2026-10-05' });
      const later = await sent(assetId, { start_date: '2026-10-06' });
      await ended(later, { outcome_date: '2026-10-08' });

      const res = await repairCorrection(earlier, await repairAmendment(earlier, await outcomeOf(earlier), { outcome_date: '2026-10-07' }));

      expect(res.statusCode).toBe(409);
      expect(res.json().repair_conflicts.map(({ conflicting }: any) => conflicting.repair_record_id)).toEqual([later]);
    });

    it('that voids a Repair Outcome and so leaves the period open warns about the Loan after it', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      await ended(repairRecordId, { outcome_date: '2026-10-05' });
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const target = await outcomeOf(repairRecordId);

      const res = await repairCorrection(repairRecordId, await repairVoiding(repairRecordId, target));

      expect(res.statusCode).toBe(409);
      expect(res.json().repair_conflicts.map(({ conflicting }: any) => conflicting.loan_item_id)).toEqual([loan.loanItemId]);
      await repairVoided(repairRecordId, target, { confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }] });
      expect((await recordOf(repairRecordId)).conflicts).toHaveLength(1);
    });

    it('does not warn about a Repair Conflict that was already there', async () => {
      const { repairRecordId } = await inConflict();

      await repairAmended(repairRecordId, RECORD, { remark: 'แก้หมายเหตุ' });
      await repairAmended(repairRecordId, RECORD, { start_date: '2026-10-02' });

      expect((await recordOf(repairRecordId)).conflicts).toHaveLength(1);
    });

    it('that removes the overlap clears the Repair Conflict, with no status to manage', async () => {
      const { assetId, repairRecordId } = await inConflict();

      await repairAmended(repairRecordId, RECORD, { start_date: '2026-10-20' });

      expect((await recordOf(repairRecordId)).conflicts).toEqual([]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_repair_conflict).toBe(false);
      expect(await listed('has_repair_conflict=true')).not.toContain(repairRecordId);
    });

    it('that voids the record clears its Repair Conflicts', async () => {
      const { assetId, repairRecordId } = await inConflict();

      await repairVoided(repairRecordId, RECORD);

      expect((await recordOf(repairRecordId)).conflicts).toEqual([]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_repair_conflict).toBe(false);
    });
  });

  describe('a Loan Correction', () => {
    it('that moves a Loan Return into a later Repair Record is refused with a warning naming the item, and saves nothing', async () => {
      const { assetId, loan, repairRecordId } = await repairedAfterLoan('ลำโพงแก้วันคืน');
      const before = await loanOf(loan.loanId);
      const target = { kind: 'LOAN_RETURN', id: before.items[0].loan_return.id };

      const res = await loanCorrection(loan.loanId, await loanAmendment(loan.loanId, target, { return_date: '2026-10-23' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'REPAIR_CONFLICTS_FOUND',
        conflicts: [],
        repair_conflicts: [
          {
            asset_id: assetId,
            name: 'ลำโพงแก้วันคืน',
            asset_number: null,
            loan_item_id: loan.loanItemId,
            conflicting: { kind: 'REPAIR_RECORD', repair_record_id: repairRecordId, repair_kind: 'REPAIR', start_date: '2026-10-21', outcome_date: '2026-10-25' },
          },
        ],
      });
      expect(await loanOf(loan.loanId)).toEqual(before);
    });

    it('that voids a Loan Return after the repair that followed it has ended is accepted once its warning is confirmed (#98 Q19)', async () => {
      const { assetId, loan, repairRecordId } = await repairedAfterLoan();
      const target = { kind: 'LOAN_RETURN', id: (await loanOf(loan.loanId)).items[0].loan_return.id };

      const warned = await loanCorrection(loan.loanId, await loanVoiding(loan.loanId, target));
      expect(warned.statusCode).toBe(409);
      expect(warned.json().repair_conflicts.map(({ conflicting }: any) => conflicting.repair_record_id)).toEqual([repairRecordId]);

      const res = await loanCorrection(loan.loanId, await loanVoiding(loan.loanId, target, { confirmed_conflicts: [{ conflicting_repair_record_id: repairRecordId }] }));

      expect(res.statusCode).toBe(201);
      expect((await recordOf(repairRecordId)).conflicts).toEqual([{ kind: 'LOAN_ITEM', loan_id: loan.loanId, loan_item_id: loan.loanItemId, loan_date: '2026-10-10', ending_date: null }]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_repair_conflict).toBe(true);
    });

    it('that removes the overlap clears the Repair Conflict', async () => {
      const { loan, repairRecordId } = await inConflict();

      const res = await loanCorrection(loan.loanId, await loanAmendment(loan.loanId, { kind: 'LOAN' }, { loan_date: '2026-10-12' }));
      expect(res.statusCode).toBe(201);
      expect((await recordOf(repairRecordId)).conflicts).toHaveLength(1);

      const cleared = await loanCorrection(loan.loanId, await loanVoiding(loan.loanId, { kind: 'LOAN' }));
      expect(cleared.statusCode).toBe(201);
      expect((await recordOf(repairRecordId)).conflicts).toEqual([]);
      expect(await listed('has_repair_conflict=true')).not.toContain(repairRecordId);
    });
  });

  // Each write reads the Repair Conflicts under the Asset lock that every Loan and Repair write takes, so
  // one queued at the Asset first is seen (CODING_STANDARDS.md, a rule read under a lock).
  describe('lock order', () => {
    it('a Repair Start sees a Loan Correction queued at the Asset first, and warns about the overlap it opened', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-12');
      const target = { kind: 'LOAN_RETURN', id: (await loanOf(loan.loanId)).items[0].loan_return.id };
      const moveReturn = await loanAmendment(loan.loanId, target, { return_date: '2026-10-20' });

      const [moved, warned] = await whileHolding(
        'assets',
        assetId,
        () => [
          loanCorrection(loan.loanId, moveReturn),
          untilWaiting('assets', 1).then(() => send(base(assetId, { start_date: '2026-10-15', outcome: { outcome: 'USABLE', outcome_date: '2026-10-18' } }))),
        ],
        () => untilWaiting('assets', 2)
      );

      expect(moved.statusCode).toBe(201);
      expect(warned.statusCode).toBe(409);
      expect(warned.json().repair_conflicts.map(({ conflicting }: any) => conflicting.loan_item_id)).toEqual([loan.loanItemId]);
    });

    it('a Repair Correction reads what was there before it after the Asset lock, so an overlap a queued Loan Correction opened is not new to it', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-12');
      const repairRecordId = await sent(assetId, { start_date: '2026-10-15', outcome: { outcome: 'USABLE', outcome_date: '2026-10-18' } });
      const target = { kind: 'LOAN_RETURN', id: (await loanOf(loan.loanId)).items[0].loan_return.id };
      const moveReturn = await loanAmendment(loan.loanId, target, { return_date: '2026-10-20' }, { confirmed_conflicts: [{ conflicting_repair_record_id: repairRecordId }] });
      const remark = await repairAmendment(repairRecordId, RECORD, { remark: 'แก้หมายเหตุ' });

      const [moved, amended] = await whileHolding(
        'assets',
        assetId,
        () => [loanCorrection(loan.loanId, moveReturn), untilWaiting('assets', 1).then(() => repairCorrection(repairRecordId, remark))],
        () => untilWaiting('assets', 2)
      );

      expect(moved.statusCode).toBe(201);
      expect(amended.statusCode).toBe(201);
      expect((await recordOf(repairRecordId)).conflicts).toHaveLength(1);
    });

    it('a Loan Correction reads what was there before it after the Asset lock, so an overlap a queued Repair Correction opened is not new to it', async () => {
      const { assetId, loan, repairRecordId } = await repairedAfterLoan();
      const moveStart = await repairAmendment(repairRecordId, RECORD, { start_date: '2026-10-15' }, { confirmed_conflicts: [{ conflicting_loan_item_id: loan.loanItemId }] });
      const remark = await loanAmendment(loan.loanId, { kind: 'LOAN' }, { remark: 'แก้หมายเหตุ' });

      const [moved, amended] = await whileHolding(
        'assets',
        assetId,
        () => [repairCorrection(repairRecordId, moveStart), untilWaiting('assets', 1).then(() => loanCorrection(loan.loanId, remark))],
        () => untilWaiting('assets', 2)
      );

      expect(moved.statusCode).toBe(201);
      expect(amended.statusCode).toBe(201);
      expect((await recordOf(repairRecordId)).conflicts).toHaveLength(1);
    });

    it('a Loan start sees a Repair Start queued at the Asset first, and warns about the Repair Conflict', async () => {
      const assetId = await registered();

      const [started, warned] = await whileHolding(
        'assets',
        assetId,
        () => [
          send(base(assetId, { start_date: '2026-10-01', outcome: { outcome: 'USABLE', outcome_date: '2026-10-10' } })),
          untilWaiting('assets', 1).then(() => startLoan([assetId], { loan_date: '2026-10-05', due_date: '2026-10-25' })),
        ],
        () => untilWaiting('assets', 2)
      );

      expect(started.statusCode).toBe(201);
      expect(warned.statusCode).toBe(409);
      expect(warned.json()).toMatchObject({ code: 'REPAIR_CONFLICTS_FOUND', repair_conflicts: [{ conflicting: { repair_record_id: started.json().repair_record_id } }] });
    });
  });
});
