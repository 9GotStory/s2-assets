import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { loanHelpers } from './support/loan-helpers.ts';

// Today is 2026-11-05 in Asia/Bangkok.
const TODAY = '2026-11-05';
const DUE = '2026-11-20';

// F004-T7 (#81): two LoanItems of one Asset whose periods overlap, warned before saving, kept, marked
// and cleared by correction (#74 Q20, Q25).
describe('Loan Conflict (Seam A - F004-T7)', () => {
  let api: ApiHarness;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-05T05:00:00Z');

  const { registered, loanOf, start, lent, returned, closedNotReturned } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: TODAY, dueDate: DUE });

  // A Loan of `assetIds` from `loanDate`, returned on `returnDate`, with its LoanItem ids by Asset.
  const lentAndReturned = async (assetIds: string[], loanDate: string, returnDate: string) => {
    const loan = await lent(assetIds, { loan_date: loanDate, due_date: returnDate });
    await returned(loan.loanId, Object.values(loan.itemOf), returnDate);
    return loan;
  };

  const loansOf = async (assetId: string) => (await api.get(readonly, `/assets/${assetId}/loans`)).json().items;

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    custodian = await api.actor('custodian_loan_conflict', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_loan_conflict', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a backdated Loan', () => {
    it('is refused with a warning listing each Loan Conflict it would create, and saves nothing', async () => {
      const assetId = await registered('โปรเจกเตอร์ทับช่วง');
      const earlier = await lentAndReturned([assetId], '2026-10-10', '2026-10-20');

      const res = await start([assetId], { loan_date: '2026-10-15', due_date: '2026-10-25' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'LOAN_CONFLICTS_FOUND' });
      // The new Loan's item has no id, because nothing is saved.
      expect(res.json().conflicts).toEqual([
        {
          asset_id: assetId,
          name: 'โปรเจกเตอร์ทับช่วง',
          asset_number: null,
          loan_item_id: null,
          conflicting: { loan_id: earlier.loanId, loan_item_id: earlier.itemOf[assetId], loan_date: '2026-10-10', ending_date: '2026-10-20' },
        },
      ]);
      expect(await loansOf(assetId)).toHaveLength(1);
    });

    it('lists every Loan Conflict of every Asset it names', async () => {
      const [first, second] = [await registered(), await registered()];
      const one = await lentAndReturned([first], '2026-10-01', '2026-10-05');
      const two = await lentAndReturned([first], '2026-10-06', '2026-10-08');
      const three = await lentAndReturned([second], '2026-09-01', '2026-10-31');

      const res = await start([first, second], { loan_date: '2026-10-02', due_date: '2026-10-25' });

      expect(res.statusCode).toBe(409);
      const pairs = res.json().conflicts.map(({ asset_id, conflicting }: any) => [asset_id, conflicting.loan_item_id]);
      expect(pairs).toHaveLength(3);
      expect(pairs).toEqual(
        expect.arrayContaining([
          [first, one.itemOf[first]],
          [first, two.itemOf[first]],
          [second, three.itemOf[second]],
        ])
      );
    });

    it('is saved once the request confirms each conflict listed, and both Loans are kept', async () => {
      const assetId = await registered();
      const earlier = await lentAndReturned([assetId], '2026-10-10', '2026-10-20');

      const res = await start([assetId], {
        loan_date: '2026-10-15',
        due_date: '2026-10-25',
        confirmed_conflicts: [{ conflicting_loan_item_id: earlier.itemOf[assetId] }],
      });

      expect(res.statusCode).toBe(201);
      expect((await loansOf(assetId)).map(({ loan_id }: any) => loan_id).sort()).toEqual([earlier.loanId, res.json().loan_id].sort());
    });

    it('warns again about every conflict when the confirmation leaves one out', async () => {
      const assetId = await registered();
      const one = await lentAndReturned([assetId], '2026-10-01', '2026-10-05');
      const two = await lentAndReturned([assetId], '2026-10-06', '2026-10-08');

      const res = await start([assetId], { loan_date: '2026-10-02', due_date: '2026-10-25', confirmed_conflicts: [{ conflicting_loan_item_id: one.itemOf[assetId] }] });

      expect(res.statusCode).toBe(409);
      expect(res.json().conflicts.map(({ conflicting }: any) => conflicting.loan_item_id).sort()).toEqual([one.itemOf[assetId], two.itemOf[assetId]].sort());
      expect(await loansOf(assetId)).toHaveLength(2);
    });

    it('does not conflict with a Loan Return on its Loan Date: a same-day handover is normal', async () => {
      const assetId = await registered();
      await lentAndReturned([assetId], '2026-10-10', '2026-10-20');

      const res = await start([assetId], { loan_date: '2026-10-20', due_date: '2026-10-25' });

      expect(res.statusCode).toBe(201);
    });

    it('conflicts when its Loan Date is one day before that Loan Return', async () => {
      const assetId = await registered();
      await lentAndReturned([assetId], '2026-10-10', '2026-10-20');

      expect((await start([assetId], { loan_date: '2026-10-19', due_date: '2026-10-25' })).statusCode).toBe(409);
    });

    it('does not conflict with a Loan that ended before it', async () => {
      const assetId = await registered();
      await lentAndReturned([assetId], '2026-10-01', '2026-10-05');

      expect((await start([assetId], { loan_date: '2026-10-06', due_date: '2026-10-25' })).statusCode).toBe(201);
    });

    it('of an Asset On Loan today stays refused by LR-11, with no confirmation offered', async () => {
      const assetId = await registered();
      const current = await lent([assetId], { loan_date: '2026-10-20', due_date: DUE });

      const res = await start([assetId], {
        loan_date: '2026-10-01',
        due_date: '2026-10-05',
        confirmed_conflicts: [{ conflicting_loan_item_id: current.itemOf[assetId] }],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ASSETS_NOT_LENDABLE', assets: [{ asset_id: assetId, reason: 'ON_LOAN', loan_id: current.loanId }] });
      expect(await loansOf(assetId)).toHaveLength(1);
    });

    it('refuses a confirmation that names no LoanItem id', async () => {
      const assetId = await registered();

      const res = await start([assetId], { confirmed_conflicts: [{ conflicting_loan_item_id: 'not-an-id' }] });

      expect(res.statusCode).toBe(400);
      expect(await loansOf(assetId)).toHaveLength(0);
    });
  });

  // A Loan of `assetId` returned on 2026-10-20, and a backdated Loan from 2026-10-15, still Outstanding,
  // saved with the conflict confirmed. `alongside` joins the backdated Loan without a conflict.
  const inConflict = async (assetId: string, alongside: string[] = []) => {
    const earlier = await lentAndReturned([assetId], '2026-10-10', '2026-10-20');
    const later = await lent([assetId, ...alongside], {
      loan_date: '2026-10-15',
      due_date: '2026-10-25',
      confirmed_conflicts: [{ conflicting_loan_item_id: earlier.itemOf[assetId] }],
    });
    return { earlier, later };
  };

  const listed = async (query: string) => {
    const res = await api.get(readonly, `/loans?limit=100&${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().items.map(({ id }: any) => id);
  };

  describe('visibility', () => {
    it('marks each Loan Conflict on both Loan pages, by item', async () => {
      const [assetId, clean] = [await registered(), await registered()];
      const { earlier, later } = await inConflict(assetId, [clean]);

      const laterItems = (await loanOf(later.loanId)).items;
      expect(laterItems.find(({ id }: any) => id === later.itemOf[assetId]).conflicts).toEqual([
        { loan_id: earlier.loanId, loan_item_id: earlier.itemOf[assetId], loan_date: '2026-10-10', ending_date: '2026-10-20' },
      ]);
      expect(laterItems.find(({ id }: any) => id === later.itemOf[clean]).conflicts).toEqual([]);
      expect((await loanOf(earlier.loanId)).items[0].conflicts).toEqual([
        { loan_id: later.loanId, loan_item_id: later.itemOf[assetId], loan_date: '2026-10-15', ending_date: null },
      ]);
    });

    it("marks each Loan Conflict in the Asset's Loans, and the Asset detail says one exists", async () => {
      const [assetId, clean] = [await registered(), await registered()];
      const { earlier, later } = await inConflict(assetId, [clean]);

      const byLoan = Object.fromEntries((await loansOf(assetId)).map((item: any) => [item.loan_id, item.conflicts]));
      expect(byLoan).toEqual({
        [earlier.loanId]: [{ loan_id: later.loanId, loan_item_id: later.itemOf[assetId], loan_date: '2026-10-15', ending_date: null }],
        [later.loanId]: [{ loan_id: earlier.loanId, loan_item_id: earlier.itemOf[assetId], loan_date: '2026-10-10', ending_date: '2026-10-20' }],
      });
      expect((await loansOf(clean))[0].conflicts).toEqual([]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_loan_conflict).toBe(true);
      expect((await api.get(readonly, `/assets/${clean}`)).json().has_loan_conflict).toBe(false);
    });

    it('finds both Loans of a Loan Conflict through the "มี conflict ค้างตรวจ" filter, and no other Loan', async () => {
      const assetId = await registered();
      const { earlier, later } = await inConflict(assetId);
      const { loanId: clean } = await lent([await registered()]);

      const ids = await listed('has_loan_conflict=true');

      expect(ids).toEqual(expect.arrayContaining([earlier.loanId, later.loanId]));
      expect(ids).not.toContain(clean);
      expect(await listed('')).toContain(clean);
    });

    it('takes the filter only as true', async () => {
      expect((await api.get(readonly, '/loans?has_loan_conflict=false')).statusCode).toBe(400);
    });
  });

  const correct = (loanId: string, payload: Record<string, unknown>) =>
    api.post(custodian, `/loans/${loanId}/corrections`, payload, { 'x-retry-token': crypto.randomUUID() });

  // A correction of `target` against the Loan's latest version: an amendment with `changes`, or a void without.
  const correction = async (loanId: string, target: Record<string, unknown>, changes?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    expected_version: (await loanOf(loanId)).version,
    target,
    reason: 'บันทึกผิดจากใบยืม',
    ...(changes ? { action: 'AMEND', changes } : { action: 'VOID' }),
    ...extra,
  });

  const corrected = async (loanId: string, target: Record<string, unknown>, changes?: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const res = await correct(loanId, await correction(loanId, target, changes, extra));
    expect(res.statusCode).toBe(201);
  };

  const returnIdOf = async (loanId: string) => (await loanOf(loanId)).items[0].loan_return.id;
  const conflictsOf = async (loanId: string) => (await loanOf(loanId)).items[0].conflicts;

  describe('a Loan Correction', () => {
    it('that would create a Loan Conflict is refused with a warning naming it, and saves nothing', async () => {
      const assetId = await registered('กล้องแก้วันคืน');
      const earlier = await lentAndReturned([assetId], '2026-10-01', '2026-10-10');
      const later = await lent([assetId], { loan_date: '2026-10-10' });
      const before = await loanOf(earlier.loanId);

      const res = await correct(earlier.loanId, await correction(earlier.loanId, { kind: 'LOAN_RETURN', id: await returnIdOf(earlier.loanId) }, { return_date: '2026-10-12' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'LOAN_CONFLICTS_FOUND',
        conflicts: [
          {
            asset_id: assetId,
            name: 'กล้องแก้วันคืน',
            asset_number: null,
            loan_item_id: earlier.itemOf[assetId],
            conflicting: { loan_id: later.loanId, loan_item_id: later.itemOf[assetId], loan_date: '2026-10-10', ending_date: null },
          },
        ],
      });
      expect(await loanOf(earlier.loanId)).toEqual(before);
    });

    it('is saved once the request confirms the conflict, which is then marked', async () => {
      const assetId = await registered();
      const earlier = await lentAndReturned([assetId], '2026-10-01', '2026-10-10');
      const later = await lent([assetId], { loan_date: '2026-10-10' });

      await corrected(
        earlier.loanId,
        { kind: 'LOAN_RETURN', id: await returnIdOf(earlier.loanId) },
        { return_date: '2026-10-12' },
        { confirmed_conflicts: [{ conflicting_loan_item_id: later.itemOf[assetId] }] }
      );

      expect(await conflictsOf(later.loanId)).toEqual([{ loan_id: earlier.loanId, loan_item_id: earlier.itemOf[assetId], loan_date: '2026-10-01', ending_date: '2026-10-12' }]);
    });

    it('that voids a Loan Return and so reopens an overlap warns in the same way', async () => {
      const assetId = await registered();
      const earlier = await lentAndReturned([assetId], '2026-10-01', '2026-10-05');
      const later = await lentAndReturned([assetId], '2026-10-06', '2026-10-08');
      const target = { kind: 'LOAN_RETURN', id: await returnIdOf(earlier.loanId) };

      const res = await correct(earlier.loanId, await correction(earlier.loanId, target));

      expect(res.statusCode).toBe(409);
      expect(res.json().conflicts.map(({ conflicting }: any) => conflicting.loan_item_id)).toEqual([later.itemOf[assetId]]);
      await corrected(earlier.loanId, target, undefined, { confirmed_conflicts: [{ conflicting_loan_item_id: later.itemOf[assetId] }] });
      expect(await conflictsOf(earlier.loanId)).toHaveLength(1);
    });

    it('does not warn about a Loan Conflict that was already there', async () => {
      const assetId = await registered();
      const { earlier, later } = await inConflict(assetId);

      await corrected(later.loanId, { kind: 'LOAN' }, { remark: 'แก้หมายเหตุ' });
      await corrected(earlier.loanId, { kind: 'LOAN_RETURN', id: await returnIdOf(earlier.loanId) }, { return_date: '2026-10-21' });

      expect(await conflictsOf(later.loanId)).toHaveLength(1);
    });

    it('that removes the overlap clears the Loan Conflict, with no status to manage', async () => {
      const assetId = await registered();
      const { earlier, later } = await inConflict(assetId);

      await corrected(later.loanId, { kind: 'LOAN' }, { loan_date: '2026-10-20' });

      expect(await conflictsOf(later.loanId)).toEqual([]);
      expect(await conflictsOf(earlier.loanId)).toEqual([]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_loan_conflict).toBe(false);
      expect(await listed('has_loan_conflict=true')).not.toContain(later.loanId);
    });

    it('that voids a Loan clears its Loan Conflicts', async () => {
      const assetId = await registered();
      const { earlier, later } = await inConflict(assetId);

      await corrected(later.loanId, { kind: 'LOAN' });

      expect(await conflictsOf(earlier.loanId)).toEqual([]);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().has_loan_conflict).toBe(false);
      expect(await listed('has_loan_conflict=true')).not.toEqual(expect.arrayContaining([earlier.loanId]));
    });

    it('ends a period at the Not Returned date when the item has no Loan Return', async () => {
      const assetId = await registered();
      const earlier = await lent([assetId], { loan_date: '2026-09-01', due_date: '2026-10-10' });
      await returned(earlier.loanId, [earlier.itemOf[assetId]], '2026-09-10');
      const lost = await lent([assetId], { loan_date: '2026-09-20', due_date: '2026-09-25' });
      await closedNotReturned(lost.loanId, [lost.itemOf[assetId]], '2026-10-01');
      await corrected(
        earlier.loanId,
        { kind: 'LOAN_RETURN', id: await returnIdOf(earlier.loanId) },
        { return_date: '2026-10-05' },
        { confirmed_conflicts: [{ conflicting_loan_item_id: lost.itemOf[assetId] }] }
      );
      expect(await conflictsOf(lost.loanId)).toEqual([{ loan_id: earlier.loanId, loan_item_id: earlier.itemOf[assetId], loan_date: '2026-09-01', ending_date: '2026-10-05' }]);

      // From the Not Returned date on, the two periods only share a boundary day.
      await corrected(earlier.loanId, { kind: 'LOAN' }, { loan_date: '2026-10-01' });

      expect(await conflictsOf(lost.loanId)).toEqual([]);
    });
  });

  describe('a Loan Conflict', () => {
    it('never stops a Loan Return', async () => {
      const assetId = await registered();
      const { later } = await inConflict(assetId);

      await returned(later.loanId, [later.itemOf[assetId]], '2026-10-25');

      expect((await loanOf(later.loanId)).items[0]).toMatchObject({ ending_kind: 'LOAN_RETURN', conflicts: [expect.anything()] });
    });

    it('never stops a Not Returned', async () => {
      const assetId = await registered();
      const { later } = await inConflict(assetId);

      await closedNotReturned(later.loanId, [later.itemOf[assetId]], TODAY);

      expect((await loanOf(later.loanId)).items[0]).toMatchObject({ ending_kind: 'NOT_RETURNED', conflicts: [expect.anything()] });
    });
  });

  describe('retry', () => {
    it('stores nothing for a refused warning, so the same retry token carries the confirmed request, and a replay returns it', async () => {
      const assetId = await registered();
      const earlier = await lentAndReturned([assetId], '2026-10-10', '2026-10-20');
      const token = crypto.randomUUID();
      const request = {
        assets: [{ asset_id: assetId, condition: 'NORMAL' }],
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณยืมย้อนหลัง' },
        loan_date: '2026-10-15',
        due_date: '2026-10-25',
      };
      const confirmedRequest = { ...request, confirmed_conflicts: [{ conflicting_loan_item_id: earlier.itemOf[assetId] }] };

      const warned = await api.post(custodian, '/loans', request, { 'x-retry-token': token });
      const saved = await api.post(custodian, '/loans', confirmedRequest, { 'x-retry-token': token });
      const replayed = await api.post(custodian, '/loans', confirmedRequest, { 'x-retry-token': token });

      expect(warned.statusCode).toBe(409);
      expect(saved.statusCode).toBe(201);
      expect(replayed.statusCode).toBe(201);
      expect(replayed.json()).toEqual(saved.json());
      expect(await loansOf(assetId)).toHaveLength(2);
      // The unconfirmed request is not the one the token now carries.
      expect((await api.post(custodian, '/loans', request, { 'x-retry-token': token })).json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH' });
    });
  });
});
