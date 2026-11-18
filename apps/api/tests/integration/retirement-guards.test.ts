import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

const TODAY = '2026-11-17';

// F007-T2 (#156): a Retired Asset is never lent or sent for repair again, and no Loan or Repair Correction
// puts it back into use (DR-08, LR-12, #154 Q7, Q17, Q24).
describe('Retired Asset guards on Loans and Repairs (Seam A - F007-T2)', () => {
  let api: ApiHarness;
  let custodian: Actor;
  let readonly: Actor;
  // 12:00 on 17 November 2026 in Bangkok.
  const now = new Date('2026-11-17T05:00:00Z');

  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const {
    registered,
    loanOf,
    start,
    lent,
    returned,
    closedNotReturned,
    correct: correctLoan,
    voiding: loanVoiding,
    amended: loanAmended,
    voided: loanVoided,
  } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-01', dueDate: '2026-11-30' });
  const {
    base: repairOf,
    send,
    sent,
    ended,
    recordOf,
    recordsOf,
    correct: correctRepair,
    voiding: repairVoiding,
    amended: repairAmended,
    voided: repairVoided,
  } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-11-03' });

  const retire = (assetId: string) =>
    api.post(custodian, `/assets/${assetId}/retirements`, { retirement_date: TODAY, retirement_method: 'SALE' }, { 'x-retry-token': crypto.randomUUID() });

  // A Retired Asset, and its Retirement's id.
  const retired = async (assetId: string): Promise<string> => {
    const res = await retire(assetId);
    expect(res.statusCode).toBe(201);
    return res.json().retirement_id;
  };

  const loansOf = async (assetId: string) => {
    const res = await api.get(readonly, `/assets/${assetId}/loans`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    custodian = await api.actor('custodian_retirement_guards', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_retirement_guards', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('Loan start (DR-08, LR-12)', () => {
    it('refuses a Loan that names a Retired Asset, naming it and its Retirement beside the other refused Assets, and writes nothing', async () => {
      const free = await registered();
      const gone = await registered('เครื่องฉายที่จำหน่ายแล้ว');
      const held = await registered();
      const retirementId = await retired(gone);
      const { loanId: holding } = await lent([held]);

      const res = await start([free, gone, held]);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ASSETS_NOT_LENDABLE' });
      const byAsset = Object.fromEntries(res.json().assets.map((asset: any) => [asset.asset_id, asset]));
      expect(Object.keys(byAsset).sort()).toEqual([gone, held].sort());
      expect(byAsset[gone]).toEqual({ asset_id: gone, name: 'เครื่องฉายที่จำหน่ายแล้ว', asset_number: null, reason: 'RETIRED', retirement_id: retirementId });
      expect(byAsset[held]).toMatchObject({ reason: 'ON_LOAN', loan_id: holding });
      expect(await loansOf(free)).toEqual([]);
      expect(await loansOf(gone)).toEqual([]);
    });
  });

  describe('the Loan page (#154 Q7)', () => {
    it('says of each LoanItem whether its Asset is Retired, so that no Repair Start is offered from its Loan Return ชำรุด', async () => {
      const [gone, kept] = [await registered('ก เครื่องที่จำหน่ายแล้ว'), await registered('ข เครื่องที่ยังใช้อยู่')];
      const { loanId, itemOf } = await lent([gone, kept]);
      await returned(loanId, [itemOf[gone], itemOf[kept]], '2026-11-05', 'DAMAGED');
      expect((await loanOf(loanId)).items.map(({ asset }: any) => asset.retired)).toEqual([false, false]);

      await retired(gone);

      expect((await loanOf(loanId)).items.map(({ asset }: any) => asset)).toEqual([
        { id: gone, name: 'ก เครื่องที่จำหน่ายแล้ว', asset_number: null, retired: true },
        { id: kept, name: 'ข เครื่องที่ยังใช้อยู่', asset_number: null, retired: false },
      ]);
    });
  });

  describe('Repair Start (DR-08)', () => {
    it('refuses a Repair Start of a Retired Asset, of either kind, naming its Retirement, and writes nothing', async () => {
      const assetId = await registered('โปรเจกเตอร์ที่จำหน่ายแล้ว');
      const retirementId = await retired(assetId);

      for (const repair_kind of ['REPAIR', 'MAINTENANCE']) {
        const res = await send(repairOf(assetId, { repair_kind }));

        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          code: 'REPAIR_START_REFUSED',
          asset: { asset_id: assetId, name: 'โปรเจกเตอร์ที่จำหน่ายแล้ว', asset_number: null, reason: 'RETIRED', retirement_id: retirementId },
        });
      }
      expect(await recordsOf(assetId)).toEqual([]);
    });
  });

  describe('Repair Corrections (#154 Q17)', () => {
    // A Retired Asset whose Repair Record ended ซ่อมไม่ได้, with the record and its Retirement.
    const retiredAfterRepair = async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      await ended(repairRecordId, { outcome: 'NOT_USABLE', outcome_date: '2026-11-10' });
      return { assetId, repairRecordId, retirementId: await retired(assetId) };
    };
    const outcomeTarget = async (repairRecordId: string) => ({ kind: 'REPAIR_OUTCOME', id: (await recordOf(repairRecordId)).outcome.id });

    it('refuses voiding the Repair Outcome of a Retired Asset, naming its Retirement, and writes nothing', async () => {
      const { assetId, repairRecordId, retirementId } = await retiredAfterRepair();
      const before = await recordOf(repairRecordId);

      const res = await correctRepair(repairRecordId, await repairVoiding(repairRecordId, await outcomeTarget(repairRecordId)));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_OUTCOME_VOID_REFUSED', asset: { asset_id: assetId, reason: 'RETIRED', retirement_id: retirementId } });
      expect(await recordOf(repairRecordId)).toEqual(before);
    });

    it('still amends a Retired Asset\'s Repair Record and Repair Outcome, and voids the whole record', async () => {
      const { repairRecordId } = await retiredAfterRepair();

      await repairAmended(repairRecordId, { kind: 'REPAIR_RECORD' }, { start_date: '2026-11-02' });
      await repairAmended(repairRecordId, await outcomeTarget(repairRecordId), { outcome_date: '2026-11-11' });
      await repairVoided(repairRecordId, { kind: 'REPAIR_RECORD' });

      expect(await recordOf(repairRecordId)).toMatchObject({
        start_date: '2026-11-02',
        is_voided: true,
        outcome: null,
        voided_outcomes: [{ outcome_date: '2026-11-11' }],
      });
    });
  });

  describe('Loan Corrections (#154 Q17)', () => {
    it('refuses voiding the Loan Return of a Retired Asset, naming its Retirement, and writes nothing', async () => {
      const assetId = await registered('กล้องที่จำหน่ายแล้ว');
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-05');
      const retirementId = await retired(assetId);
      const returnId = (await loanOf(loanId)).items[0].loan_return.id;
      const before = await loanOf(loanId);

      const res = await correctLoan(loanId, await loanVoiding(loanId, { kind: 'LOAN_RETURN', id: returnId }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'ASSET_RETIRED',
        asset: { asset_id: assetId, name: 'กล้องที่จำหน่ายแล้ว', asset_number: null, retirement_id: retirementId },
      });
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('refuses voiding the Not Returned ending of a Retired Asset, naming its Retirement, and writes nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-10');
      const retirementId = await retired(assetId);
      const endingId = (await loanOf(loanId)).items[0].not_returned.id;
      const before = await loanOf(loanId);

      const res = await correctLoan(loanId, await loanVoiding(loanId, { kind: 'NOT_RETURNED', id: endingId }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: assetId, retirement_id: retirementId } });
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('still amends a Retired Asset\'s Loan and its ending, and voids the whole Loan or its LoanItem', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      await returned(loanId, [itemOf[first]], '2026-11-05');
      await closedNotReturned(loanId, [itemOf[second]], '2026-11-10');
      await retired(first);
      await retired(second);
      const { items } = await loanOf(loanId);
      const returnId = items.find((item: any) => item.id === itemOf[first]).loan_return.id;
      const endingId = items.find((item: any) => item.id === itemOf[second]).not_returned.id;

      await loanAmended(loanId, { kind: 'LOAN' }, { loan_date: '2026-11-02' });
      await loanAmended(loanId, { kind: 'LOAN_RETURN', id: returnId }, { return_date: '2026-11-06' });
      await loanAmended(loanId, { kind: 'NOT_RETURNED', id: endingId }, { not_returned_date: '2026-11-11' });
      await loanVoided(loanId, { kind: 'LOAN_ITEM', id: itemOf[first] });
      await loanVoided(loanId, { kind: 'LOAN' });

      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({ loan_date: '2026-11-02', is_voided: true });
      expect(loan.items.map(({ is_voided }: any) => is_voided)).toEqual([true, true]);
    });

    it('voids a Loan Return of a Retired Asset that leaves its LoanItem Not Returned, which a Retirement allows', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-04');
      await returned(loanId, [itemOf[assetId]], '2026-11-05');
      await retired(assetId);
      const returnId = (await loanOf(loanId)).items[0].loan_return.id;

      await loanVoided(loanId, { kind: 'LOAN_RETURN', id: returnId });

      expect((await loanOf(loanId)).items[0]).toMatchObject({ ending_kind: 'NOT_RETURNED', loan_return: null });
    });
  });

  describe('concurrency (#154 Q24)', () => {
    // `first` queues at the Asset row lock, and `second` behind it, while the test holds that row.
    const inOrder = <A, B>(assetId: string, first: () => Promise<A>, second: () => Promise<B>) =>
      whileHolding<A | B>('assets', assetId, () => [first(), untilWaiting('assets', 1).then(second)], () => untilWaiting('assets', 2)) as Promise<[A, B]>;

    it('refuses a Loan start queued behind a Retirement once it commits, and writes no Loan', async () => {
      const assetId = await registered();

      const [retirement, loan] = await inOrder(assetId, () => retire(assetId), () => start([assetId]));

      expect(retirement.statusCode).toBe(201);
      expect(loan.statusCode).toBe(409);
      expect(loan.json().assets).toEqual([expect.objectContaining({ asset_id: assetId, reason: 'RETIRED', retirement_id: retirement.json().retirement_id })]);
      expect(await loansOf(assetId)).toEqual([]);
    });

    it('refuses a Repair Start queued behind a Retirement once it commits, and writes no Repair Record', async () => {
      const assetId = await registered();

      const [retirement, repair] = await inOrder(assetId, () => retire(assetId), () => send(repairOf(assetId)));

      expect(retirement.statusCode).toBe(201);
      expect(repair.statusCode).toBe(409);
      expect(repair.json()).toMatchObject({ code: 'REPAIR_START_REFUSED', asset: { reason: 'RETIRED', retirement_id: retirement.json().retirement_id } });
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('refuses a Retirement queued behind a Loan start as On Loan, naming the new LoanItem', async () => {
      const assetId = await registered();

      const [loan, retirement] = await inOrder(assetId, () => start([assetId]), () => retire(assetId));

      expect(loan.statusCode).toBe(201);
      expect(retirement.statusCode).toBe(409);
      expect(retirement.json()).toMatchObject({
        code: 'RETIREMENT_REFUSED',
        asset: { reason: 'ON_LOAN', loan_id: loan.json().loan_id, loan_item_id: loan.json().items[0].id },
      });
    });

    it('refuses a Retirement queued behind a Repair Start as Under Repair, naming the new Repair Record', async () => {
      const assetId = await registered();

      const [repair, retirement] = await inOrder(assetId, () => send(repairOf(assetId)), () => retire(assetId));

      expect(repair.statusCode).toBe(201);
      expect(retirement.statusCode).toBe(409);
      expect(retirement.json()).toMatchObject({ code: 'RETIREMENT_REFUSED', asset: { reason: 'UNDER_REPAIR', repair_record_id: repair.json().repair_record_id } });
    });

    it('decides a Loan Return void after locking the Asset, so a Retirement queued first refuses it', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-05');
      const voidReturn = await loanVoiding(loanId, { kind: 'LOAN_RETURN', id: (await loanOf(loanId)).items[0].loan_return.id });

      const [retirement, refused] = await inOrder(assetId, () => retire(assetId), () => correctLoan(loanId, voidReturn));

      expect(retirement.statusCode).toBe(201);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { retirement_id: retirement.json().retirement_id } });
      expect((await loanOf(loanId)).items[0].loan_return).not.toBeNull();
    });

    it('decides a Repair Outcome void after locking the Asset, so a Retirement queued first refuses it', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      await ended(repairRecordId, { outcome: 'NOT_USABLE', outcome_date: '2026-11-10' });
      const voidOutcome = await repairVoiding(repairRecordId, { kind: 'REPAIR_OUTCOME', id: (await recordOf(repairRecordId)).outcome.id });

      const [retirement, refused] = await inOrder(assetId, () => retire(assetId), () => correctRepair(repairRecordId, voidOutcome));

      expect(retirement.statusCode).toBe(201);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'REPAIR_OUTCOME_VOID_REFUSED', asset: { reason: 'RETIRED', retirement_id: retirement.json().retirement_id } });
      expect((await recordOf(repairRecordId)).outcome).not.toBeNull();
    });
  });
});
