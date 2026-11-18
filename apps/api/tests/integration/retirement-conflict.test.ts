import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, assignmentWriteHelpers } from './support/assignment-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';
import { retirementHelpers } from './support/retirement-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const TODAY = '2026-11-17';

// F007-T6 (#160): a Retirement whose Retirement Date falls before another fact of the same Asset, warned before
// saving, kept, shown, and gone once a correction fixes either side (DR-18, DR-19, #154 Q8, Q21, P1, P2).
describe('Retirement Conflict (Seam A - F007-T6)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-17T05:00:00Z');

  const { registered, loanOf, lent, returned, closedNotReturned, correct: loanCorrection, amendment: loanAmendment, amended: loanAmended, voided: loanVoided } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-01', dueDate: '2026-11-30' });
  const { base, retire, correct: retirementCorrection, voided: retirementVoided } = retirementHelpers(() => ({ api, custodian }), { retirementDate: TODAY });
  const { sent, recordOf, ended, correct: repairCorrection, amendment: repairAmendment, amended: repairAmended, voided: repairVoided } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-10-10' });
  const { entry, timelineOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { reassign, correct: assignmentCorrection } = assignmentWriteHelpers(() => ({ api, custodian, reader: readonly }), { effectiveDate: '2026-10-10' });
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { opened, record: recordVerification, finding, recorded, closeOpenRound } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // What a Retirement of `assetId` dated `retirementDate` would conflict with, as its refused warning lists them.
  const warnedOf = async (assetId: string, retirementDate: string) => {
    const res = await retire(assetId, base({ retirement_date: retirementDate }));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('RETIREMENT_CONFLICTS_FOUND');
    return res.json().retirement_conflicts;
  };

  // A confirmation of each fact a warning listed.
  const confirmationOf = (conflicts: { kind: string; fact_id: string }[]) =>
    conflicts.map(({ kind, fact_id }) => ({ conflicting_fact_kind: kind, conflicting_fact_id: fact_id }));

  // The Retirement of `assetId` dated `retirementDate`, recorded after confirming each fact its warning listed.
  const retiredDespite = async (assetId: string, retirementDate: string): Promise<string> => {
    const conflicts = await warnedOf(assetId, retirementDate);
    const res = await retire(assetId, base({ retirement_date: retirementDate, confirmed_conflicts: confirmationOf(conflicts) }));
    expect(res.statusCode).toBe(201);
    return res.json().retirement_id;
  };

  // The ids of the Asset list's rows whose name holds `tag`, with `query` added.
  const listedIds = async (tag: string, query = '') => {
    const res = await api.get(readonly, `/assets/search?field=name&value=${encodeURIComponent(tag)}&limit=100${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().items.map(({ id }: any) => id).sort();
  };

  const conflictsOf = async (assetId: string) => (await detailOf(assetId)).retirement_conflicts;

  // An amendment of the Retirement's Retirement Date, against its first version unless `overrides` says otherwise.
  const dateAmendment = (retirementDate: string, overrides: Record<string, unknown> = {}) => ({
    expected_version: 1,
    action: 'AMEND',
    reason: 'วันที่ตามคำสั่งจำหน่ายผิด',
    changes: { retirement_date: retirementDate },
    ...overrides,
  });

  // An Asset registered with an Initial Assignment at a new Location, dated `effectiveDate`, or of unknown date when null.
  const placedOn = async (effectiveDate: string | null): Promise<string> => {
    const location = await entry('locations', `ห้อง ${crypto.randomUUID()}`);
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: location.id, effective_date: effectiveDate }, { 'x-retry-token': crypto.randomUUID() });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A Loan of `assetId` from `loanDate`, returned on `returnDate`: its Loan, LoanItem and Loan Return.
  const lentAndReturned = async (assetId: string, loanDate: string, returnDate: string) => {
    const loan = await lent([assetId], { loan_date: loanDate, due_date: returnDate });
    await returned(loan.loanId, [loan.itemOf[assetId]], returnDate);
    return { loanId: loan.loanId, loanItemId: loan.itemOf[assetId], loanReturnId: (await loanOf(loan.loanId)).items[0].loan_return.id as string };
  };

  const detailOf = async (assetId: string) => {
    const res = await api.get(readonly, `/assets/${assetId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_retirement_conflict', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_retirement_conflict', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_retirement_conflict', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('recording a backdated Retirement', () => {
    it('is refused with a warning listing a later Loan Date and Loan Return, and saves nothing', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      const res = await retire(assetId, base({ retirement_date: '2026-10-01' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'RETIREMENT_CONFLICTS_FOUND', error: 'RETIREMENT_CONFLICTS_FOUND', message: expect.any(String) });
      expect(res.json().retirement_conflicts).toEqual([
        { kind: 'LOAN_DATE', fact_id: loan.loanItemId, fact_date: '2026-10-10', record_id: loan.loanId },
        { kind: 'LOAN_RETURN', fact_id: loan.loanReturnId, fact_date: '2026-10-20', record_id: loan.loanId },
      ]);
      expect((await detailOf(assetId)).retirements).toEqual([]);
    });

    it('is saved once the request confirms each fact, changes no other fact, and the Asset page lists its conflicts', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const loanBefore = await loanOf(loan.loanId);

      const res = await retire(
        assetId,
        base({
          retirement_date: '2026-10-01',
          confirmed_conflicts: [
            { conflicting_fact_kind: 'LOAN_DATE', conflicting_fact_id: loan.loanItemId },
            { conflicting_fact_kind: 'LOAN_RETURN', conflicting_fact_id: loan.loanReturnId.toUpperCase() },
          ],
        })
      );

      expect(res.statusCode).toBe(201);
      const detail = await detailOf(assetId);
      expect(detail).toMatchObject({ retired: true, retirement: { id: res.json().retirement_id, retirement_date: '2026-10-01' } });
      expect(detail.retirement_conflicts).toEqual([
        { kind: 'LOAN_DATE', fact_id: loan.loanItemId, fact_date: '2026-10-10', record_id: loan.loanId },
        { kind: 'LOAN_RETURN', fact_id: loan.loanReturnId, fact_date: '2026-10-20', record_id: loan.loanId },
      ]);
      // DR-18: the Loan page reads the Asset Retired (F007-T2), and nothing else of the Loan changed.
      expect(await loanOf(loan.loanId)).toEqual({ ...loanBefore, items: loanBefore.items.map((item: any) => ({ ...item, asset: { ...item.asset, retired: true } })) });
    });

    it('warns again about every fact when the confirmation leaves one out, and saves nothing', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      const res = await retire(assetId, base({ retirement_date: '2026-10-01', confirmed_conflicts: [{ conflicting_fact_kind: 'LOAN_DATE', conflicting_fact_id: loan.loanItemId }] }));

      expect(res.statusCode).toBe(409);
      expect(res.json().retirement_conflicts.map(({ kind }: any) => kind)).toEqual(['LOAN_DATE', 'LOAN_RETURN']);
      expect((await detailOf(assetId)).retirements).toEqual([]);
    });

    it('does not count a fact on the Retirement Date: an Asset returned and retired on one day has no conflict', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      expect((await retire(assetId, base({ retirement_date: '2026-10-20' }))).statusCode).toBe(201);
      expect((await detailOf(assetId)).retirement_conflicts).toEqual([]);
    });

    it('counts a fact one day after the Retirement Date, and only it', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');

      const res = await retire(assetId, base({ retirement_date: '2026-10-19' }));

      expect(res.statusCode).toBe(409);
      expect(res.json().retirement_conflicts).toEqual([{ kind: 'LOAN_RETURN', fact_id: loan.loanReturnId, fact_date: '2026-10-20', record_id: loan.loanId }]);
    });
  });

  describe('the facts compared (P1)', () => {
    it('counts a later Not Returned ending', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { loan_date: '2026-10-10', due_date: '2026-10-15' });
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-10-25');
      const notReturnedId = (await loanOf(loanId)).items[0].not_returned.id;

      expect(await warnedOf(assetId, '2026-10-10')).toEqual([{ kind: 'NOT_RETURNED', fact_id: notReturnedId, fact_date: '2026-10-25', record_id: loanId }]);
    });

    it('counts a later Repair Start and Repair Outcome', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-10' });
      await ended(repairRecordId, { outcome_date: '2026-10-20' });
      const outcomeId = (await recordOf(repairRecordId)).outcome.id;

      expect(await warnedOf(assetId, '2026-10-01')).toEqual([
        { kind: 'REPAIR_START', fact_id: repairRecordId, fact_date: '2026-10-10', record_id: repairRecordId },
        { kind: 'REPAIR_OUTCOME', fact_id: outcomeId, fact_date: '2026-10-20', record_id: repairRecordId },
      ]);
    });

    it('counts a later dated Initial Assignment and Reassignment, each by its assignment fact', async () => {
      const assetId = await placedOn('2026-10-10');
      const location = await entry('locations', `ห้อง ${crypto.randomUUID()}`);
      expect((await reassign(assetId, { location_id: location.id, effective_date: '2026-10-20' })).statusCode).toBe(201);
      const timeline = await timelineOf(assetId);
      const initial = timeline.find(({ kind }: any) => kind === 'INITIAL');
      const reassignment = timeline.find(({ kind }: any) => kind === 'REASSIGNMENT');

      expect(await warnedOf(assetId, '2026-10-01')).toEqual([
        { kind: 'INITIAL_ASSIGNMENT', fact_id: initial.id, fact_date: '2026-10-10', record_id: initial.id },
        { kind: 'REASSIGNMENT', fact_id: reassignment.id, fact_date: '2026-10-20', record_id: reassignment.id },
      ]);
    });

    it('does not count an Initial Assignment without an Effective Date', async () => {
      const assetId = await placedOn(null);

      expect((await retire(assetId, base({ retirement_date: '2026-10-01' }))).statusCode).toBe(201);
    });

    it('counts a later Found result by its revision, and links its Round', async () => {
      await closeOpenRound();
      const assetId = await registered();
      const roundId = await opened();
      const { verification_revision_id: revisionId } = await recorded(roundId, assetId, { verification_date: TODAY });

      expect(await warnedOf(assetId, '2026-11-16')).toEqual([{ kind: 'FOUND', fact_id: revisionId, fact_date: TODAY, record_id: roundId }]);
      await closeOpenRound();
    });

    it('does not count a Not Found result', async () => {
      await closeOpenRound();
      const assetId = await registered();
      const roundId = await opened();
      await recorded(roundId, assetId, { result: 'NOT_FOUND', condition: null, verification_date: TODAY });

      expect((await retire(assetId, base({ retirement_date: '2026-11-16' }))).statusCode).toBe(201);
      await closeOpenRound();
    });

    it('does not count a voided Loan Return or Not Returned ending: only the ending recorded again', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      await loanVoided(loan.loanId, { kind: 'LOAN_RETURN', id: loan.loanReturnId });
      await closedNotReturned(loan.loanId, [loan.loanItemId], '2026-10-25');
      const notReturnedId = (await loanOf(loan.loanId)).items[0].not_returned.id;
      await loanVoided(loan.loanId, { kind: 'NOT_RETURNED', id: notReturnedId });
      await returned(loan.loanId, [loan.loanItemId], '2026-10-12');

      expect((await retire(assetId, base({ retirement_date: '2026-10-15' }))).statusCode).toBe(201);
    });

    it('does not count a voided Repair Outcome: only the outcome recorded again', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-10' });
      await ended(repairRecordId, { outcome_date: '2026-10-20' });
      await repairVoided(repairRecordId, { kind: 'REPAIR_OUTCOME', id: (await recordOf(repairRecordId)).outcome.id });
      await ended(repairRecordId, { outcome_date: '2026-10-12' });

      expect((await retire(assetId, base({ retirement_date: '2026-10-15' }))).statusCode).toBe(201);
    });

    it('does not count a Due Date or a Due Date Extension', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { loan_date: '2026-10-10', due_date: '2026-10-20' });
      const extension = await api.post(
        custodian,
        `/loans/${loanId}/due-date-extensions`,
        { expected_version: (await loanOf(loanId)).version, new_due_date: '2026-11-30', items: [{ loan_item_id: itemOf[assetId] }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(extension.statusCode).toBe(201);
      await returned(loanId, [itemOf[assetId]], '2026-10-12');

      expect((await retire(assetId, base({ retirement_date: '2026-10-12' }))).statusCode).toBe(201);
    });
  });

  describe('amending the Retirement Date (P2)', () => {
    it('to an earlier date warns with only the conflicts it creates, saves nothing, and saves once they are confirmed', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const retirementId = await retiredDespite(assetId, '2026-10-15');
      const loanReturn = { kind: 'LOAN_RETURN', fact_id: loan.loanReturnId, fact_date: '2026-10-20', record_id: loan.loanId };
      const loanDate = { kind: 'LOAN_DATE', fact_id: loan.loanItemId, fact_date: '2026-10-10', record_id: loan.loanId };

      const warned = await retirementCorrection(retirementId, dateAmendment('2026-10-05'));

      expect(warned.statusCode).toBe(409);
      expect(warned.json()).toMatchObject({ code: 'RETIREMENT_CONFLICTS_FOUND', retirement_conflicts: [loanDate] });
      expect((await detailOf(assetId)).retirement).toMatchObject({ retirement_date: '2026-10-15', version: 1, corrections: [] });

      const res = await retirementCorrection(retirementId, dateAmendment('2026-10-05', { confirmed_conflicts: confirmationOf([loanDate]) }));

      expect(res.statusCode).toBe(201);
      expect((await detailOf(assetId)).retirement).toMatchObject({ retirement_date: '2026-10-05', version: 2 });
      expect(await conflictsOf(assetId)).toEqual([loanDate, loanReturn]);
    });

    it('of another field alone warns of nothing, though the Retirement has conflicts', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const retirementId = await retiredDespite(assetId, '2026-10-01');

      const res = await retirementCorrection(retirementId, { expected_version: 1, action: 'AMEND', reason: 'ผิดวิธี', changes: { retirement_method: 'EXCHANGE' } });

      expect(res.statusCode).toBe(201);
      expect(await conflictsOf(assetId)).toHaveLength(2);
    });
  });

  describe('the conflict goes away after a correction of either side (DR-19)', () => {
    it('when the Retirement Date is amended to the fact\'s date', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const retirementId = await retiredDespite(assetId, '2026-10-15');

      expect((await retirementCorrection(retirementId, dateAmendment('2026-10-20'))).statusCode).toBe(201);
      expect(await conflictsOf(assetId)).toEqual([]);
    });

    it('when the Retirement is voided, which then has none', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const retirementId = await retiredDespite(assetId, '2026-10-15');

      await retirementVoided(retirementId);

      expect(await detailOf(assetId)).toMatchObject({ retired: false, retirement: null, retirement_conflicts: [] });
    });

    it('when a Loan Correction amends the Loan Return to the Retirement Date', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      await retiredDespite(assetId, '2026-10-15');

      await loanAmended(loan.loanId, { kind: 'LOAN_RETURN', id: loan.loanReturnId }, { return_date: '2026-10-15' });

      expect(await conflictsOf(assetId)).toEqual([]);
    });

    it('when a Loan Correction voids the whole Loan', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      await retiredDespite(assetId, '2026-10-05');

      await loanVoided(loan.loanId, { kind: 'LOAN' });

      expect(await conflictsOf(assetId)).toEqual([]);
    });

    it('when a Repair Correction amends the Repair Outcome to the Retirement Date', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-10' });
      await ended(repairRecordId, { outcome_date: '2026-10-20' });
      await retiredDespite(assetId, '2026-10-15');

      await repairAmended(repairRecordId, { kind: 'REPAIR_OUTCOME', id: (await recordOf(repairRecordId)).outcome.id }, { outcome_date: '2026-10-15' });

      expect(await conflictsOf(assetId)).toEqual([]);
    });

    it('when a Repair Correction voids the whole Repair Record', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-10' });
      await ended(repairRecordId, { outcome_date: '2026-10-20' });
      await retiredDespite(assetId, '2026-10-05');

      await repairVoided(repairRecordId, { kind: 'REPAIR_RECORD' });

      expect(await conflictsOf(assetId)).toEqual([]);
    });

    it('when an Assignment Correction amends the Effective Date, or voids the fact', async () => {
      const assetId = await placedOn(null);
      const [roomA, roomB] = [await entry('locations', `ห้อง ${crypto.randomUUID()}`), await entry('locations', `ห้อง ${crypto.randomUUID()}`)];
      expect((await reassign(assetId, { location_id: roomA.id, effective_date: '2026-10-20' })).statusCode).toBe(201);
      expect((await reassign(assetId, { location_id: roomB.id, effective_date: '2026-10-25' })).statusCode).toBe(201);
      const [first, second] = (await timelineOf(assetId)).filter(({ kind }: any) => kind === 'REASSIGNMENT').sort((a: any, b: any) => a.effective_date.localeCompare(b.effective_date));
      await retiredDespite(assetId, '2026-10-15');

      const amended = await assignmentCorrection(assetId, first.id, { action: 'AMEND', effective_date: '2026-10-15' });
      expect(amended.statusCode).toBe(201);
      expect((await conflictsOf(assetId)).map(({ fact_id }: any) => fact_id)).toEqual([second.id]);

      expect((await assignmentCorrection(assetId, second.id, { action: 'VOID' })).statusCode).toBe(201);
      expect(await conflictsOf(assetId)).toEqual([]);
    });

    it('when a Verification Correction voids the Found result', async () => {
      await closeOpenRound();
      const assetId = await registered();
      const roundId = await opened();
      const { verification_revision_id: revisionId } = await recorded(roundId, assetId, { verification_date: TODAY });
      await retiredDespite(assetId, '2026-11-16');

      const res = await api.post(
        custodian,
        `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`,
        { verification_revision_id: revisionId, reason: 'บันทึกผิดครุภัณฑ์' },
        { 'x-retry-token': crypto.randomUUID() }
      );

      expect(res.statusCode).toBe(201);
      expect(await conflictsOf(assetId)).toEqual([]);
      await closeOpenRound();
    });
  });

  describe('retry', () => {
    it('takes the warned request again under its token once confirmed, replays it, and refuses that token for another payload', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      const token = crypto.randomUUID();
      const confirmed = base({ retirement_date: '2026-10-15', confirmed_conflicts: [{ conflicting_fact_kind: 'LOAN_RETURN', conflicting_fact_id: loan.loanReturnId }] });

      expect((await retire(assetId, base({ retirement_date: '2026-10-15' }), token)).statusCode).toBe(409);
      const saved = await retire(assetId, confirmed, token);
      const replayed = await retire(assetId, confirmed, token);
      const other = await retire(assetId, base({ retirement_date: '2026-10-15' }), token);

      expect(saved.statusCode).toBe(201);
      expect(replayed.statusCode).toBe(201);
      expect(replayed.json()).toEqual(saved.json());
      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH' });
      expect((await detailOf(assetId)).retirements).toHaveLength(1);
    });

    it('refuses a confirmation that names no valid fact id', async () => {
      const assetId = await registered();

      const res = await retire(assetId, base({ confirmed_conflicts: [{ conflicting_fact_kind: 'LOAN_DATE', conflicting_fact_id: 'not-a-uuid' }] }));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('conflicting_fact_id must be a valid UUID') });
    });
  });

  describe('the Asset list filter (P6)', () => {
    it('keeps only Assets whose current Retirement has a conflict, and combines with the other filters', async () => {
      const tag = `กรองวันจำหน่าย ${crypto.randomUUID()}`;
      const [withConflict, withoutConflict, voidedRetirement, neverRetired] = [
        await registered(`${tag} ขัด`),
        await registered(`${tag} ไม่ขัด`),
        await registered(`${tag} ยกเลิก`),
        await registered(`${tag} ยังไม่จำหน่าย`),
      ];
      for (const assetId of [withConflict, withoutConflict, voidedRetirement, neverRetired]) {
        await lentAndReturned(assetId, '2026-10-10', '2026-10-20');
      }
      await retiredDespite(withConflict, '2026-10-15');
      expect((await retire(withoutConflict, base({ retirement_date: '2026-10-20' }))).statusCode).toBe(201);
      await retirementVoided(await retiredDespite(voidedRetirement, '2026-10-15'));

      expect(await listedIds(tag)).toEqual([withConflict, withoutConflict, voidedRetirement, neverRetired].sort());
      expect(await listedIds(tag, '&has_retirement_conflict=true')).toEqual([withConflict]);
      expect(await listedIds(tag, '&has_retirement_conflict=true&retired=true')).toEqual([withConflict]);
      expect(await listedIds(tag, '&has_retirement_conflict=true&retired=false')).toEqual([]);
      expect(await listedIds(tag, '&has_retirement_conflict=true&on_loan=true')).toEqual([]);
    });

    it("takes only 'true'", async () => {
      const res = await api.get(readonly, '/assets/search?has_retirement_conflict=false');

      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain("has_retirement_conflict must be 'true' when given");
    });
  });

  describe('concurrency (#154 Q24): the conflicts are read under the Asset lock', () => {
    // `first` queues at the Asset row lock the test holds, and the Retirement write `then` behind it.
    const behind = <B>(assetId: string, first: () => Promise<any>, then: () => Promise<B>, firstMode: 'FOR UPDATE' | 'FOR SHARE' = 'FOR UPDATE') =>
      whileHolding<any>('assets', assetId, () => [first(), untilWaiting('assets', 1, firstMode).then(then)], () => untilWaiting('assets', firstMode === 'FOR UPDATE' ? 2 : 1));

    it('a Retirement queued behind a Loan Correction that moves the Loan Return later is warned of it', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-12');
      const moveReturn = await loanAmendment(loan.loanId, { kind: 'LOAN_RETURN', id: loan.loanReturnId }, { return_date: '2026-10-20' });

      const [moved, warned] = await behind(assetId, () => loanCorrection(loan.loanId, moveReturn), () => retire(assetId, base({ retirement_date: '2026-10-15' })));

      expect(moved.statusCode).toBe(201);
      expect(warned.statusCode).toBe(409);
      expect(warned.json().retirement_conflicts.map(({ fact_id }: any) => fact_id)).toEqual([loan.loanReturnId]);
    });

    it('a Retirement queued behind a Repair Correction that moves the Repair Outcome later is warned of it', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-10' });
      await ended(repairRecordId, { outcome_date: '2026-10-12' });
      const outcomeId = (await recordOf(repairRecordId)).outcome.id;
      const moveOutcome = await repairAmendment(repairRecordId, { kind: 'REPAIR_OUTCOME', id: outcomeId }, { outcome_date: '2026-10-20' });

      const [moved, warned] = await behind(assetId, () => repairCorrection(repairRecordId, moveOutcome), () => retire(assetId, base({ retirement_date: '2026-10-15' })));

      expect(moved.statusCode).toBe(201);
      expect(warned.statusCode).toBe(409);
      expect(warned.json().retirement_conflicts.map(({ fact_id }: any) => fact_id)).toEqual([outcomeId]);
    });

    it('a Retirement queued behind an Assignment Correction that moves an Effective Date later is warned of it', async () => {
      const assetId = await placedOn('2026-10-12');
      const [initial] = await timelineOf(assetId);
      const moveDate = () => assignmentCorrection(assetId, initial.id, { action: 'AMEND', effective_date: '2026-10-20' });

      const [moved, warned] = await behind(assetId, moveDate, () => retire(assetId, base({ retirement_date: '2026-10-15' })));

      expect(moved.statusCode).toBe(201);
      expect(warned.statusCode).toBe(409);
      expect(warned.json().retirement_conflicts.map(({ fact_id }: any) => fact_id)).toEqual([initial.id]);
    });

    it('a Retirement queued behind a Found result, which locks the Asset in share mode, is warned of it', async () => {
      await closeOpenRound();
      const assetId = await registered();
      const roundId = await opened();

      const [found, warned] = await behind(
        assetId,
        () => recordVerification(roundId, assetId, finding({ verification_date: TODAY })),
        () => retire(assetId, base({ retirement_date: '2026-11-16' })),
        'FOR SHARE'
      );

      expect(found.statusCode).toBe(201);
      expect(warned.statusCode).toBe(409);
      expect(warned.json().retirement_conflicts).toEqual([{ kind: 'FOUND', fact_id: found.json().verification_revision_id, fact_date: TODAY, record_id: roundId }]);
      await closeOpenRound();
    });

    // An amendment of a Retirement recorded on 2026-10-15 to 2026-10-20, queued behind `first`, which moves a fact of the
    // Asset from before 2026-10-15 to 2026-10-25: the conflict is there before the amendment, so it saves unwarned.
    const amendedBehind = async (assetId: string, first: () => Promise<any>) => {
      const recorded = await retire(assetId, base({ retirement_date: '2026-10-15' }));
      expect(recorded.statusCode).toBe(201);
      const [moved, amended] = await behind(assetId, first, () => retirementCorrection(recorded.json().retirement_id, dateAmendment('2026-10-20')));
      expect(moved.statusCode).toBe(201);
      expect(amended.statusCode).toBe(201);
    };

    it('an amended Retirement Date reads what was there before it after the Asset lock, so a conflict a queued Repair Correction opened is not new to it', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { start_date: '2026-10-10' });
      await ended(repairRecordId, { outcome_date: '2026-10-12' });
      const outcomeId = (await recordOf(repairRecordId)).outcome.id;
      const moveOutcome = await repairAmendment(repairRecordId, { kind: 'REPAIR_OUTCOME', id: outcomeId }, { outcome_date: '2026-10-25' });

      await amendedBehind(assetId, () => repairCorrection(repairRecordId, moveOutcome));

      expect((await conflictsOf(assetId)).map(({ fact_id }: any) => fact_id)).toEqual([outcomeId]);
    });

    it('an amended Retirement Date reads what was there before it after the Asset lock, so a conflict a queued Assignment Correction opened is not new to it', async () => {
      const assetId = await placedOn('2026-10-12');
      const [initial] = await timelineOf(assetId);

      await amendedBehind(assetId, () => assignmentCorrection(assetId, initial.id, { action: 'AMEND', effective_date: '2026-10-25' }));

      expect((await conflictsOf(assetId)).map(({ fact_id }: any) => fact_id)).toEqual([initial.id]);
    });

    it('an amended Retirement Date reads what was there before it after the Asset lock, so a conflict a queued Loan Correction opened is not new to it', async () => {
      const assetId = await registered();
      const loan = await lentAndReturned(assetId, '2026-10-10', '2026-10-12');
      const recorded = await retire(assetId, base({ retirement_date: '2026-10-15' }));
      expect(recorded.statusCode).toBe(201);
      const retirementId = recorded.json().retirement_id;
      // The queued correction moves the Loan Return past the Retirement Date, so the conflict is there before the amendment.
      const moveReturn = await loanAmendment(loan.loanId, { kind: 'LOAN_RETURN', id: loan.loanReturnId }, { return_date: '2026-10-25' });

      const [moved, amended] = await behind(assetId, () => loanCorrection(loan.loanId, moveReturn), () => retirementCorrection(retirementId, dateAmendment('2026-10-20')));

      expect(moved.statusCode).toBe(201);
      expect(amended.statusCode).toBe(201);
      expect((await conflictsOf(assetId)).map(({ fact_id }: any) => fact_id)).toEqual([loan.loanReturnId]);
    });
  });
});
