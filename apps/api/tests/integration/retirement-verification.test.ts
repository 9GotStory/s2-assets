import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, assignmentWriteHelpers } from './support/assignment-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { retirementHelpers } from './support/retirement-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const TODAY = '2026-11-17';

// F007-T4 (#158): Verification Rounds respect Retirement without rewriting their history. A new Round leaves a
// Retired Asset out and a Late Addition of one is refused; an Asset retired while a Round is open stays in its
// Scope Snapshot, takes no new result, and is never Awaiting Action (DR-08, DR-10, DR-11, AV-17, #154 Q12, Q18,
// Q19, Q20, Q24, P5).
describe('Retirement in Verification Rounds (Seam A - F007-T4)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  // 12:00 on 17 November 2026 in Bangkok.
  const now = new Date('2026-11-17T05:00:00Z');

  const { entries } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { placed } = assignmentWriteHelpers(() => ({ api, custodian, reader: readonly }), { effectiveDate: '2026-01-05' });
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { retire, retired } = retirementHelpers(() => ({ api, custodian }), { retirementDate: TODAY });
  const { opening, open, opened, roundOf, entriesOf, scopeOf, entryOf, finding, record, recorded, closed, reopened, closeOpenRound } = verificationHelpers(() => ({
    api,
    custodian,
    reader: readonly,
  }));

  const addLate = (roundId: string, payload: Record<string, unknown>) =>
    api.post(custodian, `/verification-rounds/${roundId}/late-additions`, payload, { 'x-retry-token': crypto.randomUUID() });

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_retirement_verification', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_retirement_verification', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_retirement_verification', 'READ_ONLY');
  }, 120_000);

  afterEach(async () => {
    await closeOpenRound();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('opening a Round (DR-10, #154 Q18)', () => {
    it('leaves out every Asset Retired at the moment of opening, Retired on the start date itself included', async () => {
      const [room] = await entries('locations', `ห้องเปิดรอบ ${crypto.randomUUID()}`, 1);
      const [kept, gone] = [await placed(room), await placed(room)];
      await retired(gone, { retirement_date: TODAY });

      const roundId = await opened();

      const scope = await scopeOf(roundId);
      expect(scope).toContain(kept);
      expect(scope).not.toContain(gone);
    });

    it('applies the filters to the Assets left, and refuses a Round whose filters match only Retired Assets as an empty scope', async () => {
      const [room, other] = await entries('locations', `ห้องกรองรอบ ${crypto.randomUUID()}`, 2);
      const [gone] = [await placed(room)];
      const [elsewhere] = [await placed(other)];
      await retired(gone);

      const refused = await open(opening({ location_ids: [room.id] }));

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'EMPTY_VERIFICATION_SCOPE' });

      const roundId = await opened({ location_ids: [room.id, other.id] });
      expect(await scopeOf(roundId)).toEqual([elsewhere]);
    });
  });

  describe('Late Addition (DR-10, #154 Q12)', () => {
    it('refuses a Late Addition of a Retired Asset, naming it and its Retirement, and adds nothing to the Round', async () => {
      const [room] = await entries('locations', `ห้องเพิ่มภายหลัง ${crypto.randomUUID()}`, 1);
      const roundId = await opened();
      const before = await scopeOf(roundId);
      const gone = await placed(room, 'เครื่องพิมพ์ที่จำหน่ายแล้ว');
      const retirementId = await retired(gone);

      const res = await addLate(roundId, { asset_id: gone, reason: 'พบภายหลังว่าตกหล่น' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'ASSET_RETIRED',
        asset: { asset_id: gone, name: 'เครื่องพิมพ์ที่จำหน่ายแล้ว', asset_number: null, retirement_id: retirementId },
      });
      expect(await scopeOf(roundId)).toEqual(before);
    });
  });

  describe('an Asset retired while a Round is open (DR-11, AV-17, #154 Q12, P5)', () => {
    // A Round over a room of its own holding `count` Assets, and the Assets.
    const roundOver = async (count: number) => {
      const [room] = await entries('locations', `ห้องรอบตรวจ ${crypto.randomUUID()}`, 1);
      const assetIds: string[] = [];
      for (let i = 0; i < count; i++) {
        assetIds.push(await placed(room));
      }
      return { roundId: await opened({ location_ids: [room.id] }), assetIds, room };
    };

    // A Verification Correction voiding the result `revisionId` (#125 Q18).
    const voidResult = (roundId: string, assetId: string, revisionId: string) =>
      api.post(
        custodian,
        `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`,
        { verification_revision_id: revisionId, reason: 'บันทึกผิดเครื่อง' },
        { 'x-retry-token': crypto.randomUUID() }
      );

    const revisionsOf = async (roundId: string, assetId: string) => {
      const res = await api.get(readonly, `/verification-rounds/${roundId}/assets/${assetId}/verifications`);
      expect(res.statusCode).toBe(200);
      return res.json().items;
    };

    it('keeps it in the Scope Snapshot as it was, Not Yet Verified, and says it is Retired', async () => {
      const {
        roundId,
        assetIds: [gone],
      } = await roundOver(1);
      const before = await entryOf(roundId, gone);
      expect(before).toMatchObject({ result: 'NOT_YET_VERIFIED', retired: false });

      await retired(gone);

      expect(await entryOf(roundId, gone)).toEqual({ ...before, retired: true });
    });

    it('refuses a first result for it, naming its Retirement, and writes nothing', async () => {
      const {
        roundId,
        assetIds: [gone],
      } = await roundOver(1);
      const retirementId = await retired(gone);
      const before = await entryOf(roundId, gone);

      for (const payload of [finding(), finding({ result: 'NOT_FOUND', condition: null })]) {
        const res = await record(roundId, gone, payload);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: gone, retirement_id: retirementId } });
      }
      expect(await entryOf(roundId, gone)).toEqual(before);
      expect(await revisionsOf(roundId, gone)).toEqual([]);
    });

    it('refuses a Re-verification of it, naming its Retirement, and keeps its current result', async () => {
      const {
        roundId,
        assetIds: [gone],
      } = await roundOver(1);
      const { verification_revision_id: revisionId } = await recorded(roundId, gone);
      const retirementId = await retired(gone);
      const before = await entryOf(roundId, gone);

      const res = await record(roundId, gone, finding({ condition: 'DAMAGED', expected_revision_id: revisionId }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: gone, retirement_id: retirementId } });
      expect(await entryOf(roundId, gone)).toEqual(before);
      expect(await revisionsOf(roundId, gone)).toHaveLength(1);
    });

    it('keeps refusing a first result and a Re-verification once the Round is Reopened, and still lets its result be voided (P5)', async () => {
      const {
        roundId,
        assetIds: [pending, verified],
      } = await roundOver(2);
      const { verification_revision_id: revisionId } = await recorded(roundId, verified);
      await closed(roundId);
      const retirementIds = { pending: await retired(pending), verified: await retired(verified) };
      await reopened(roundId);

      const first = await record(roundId, pending, finding());
      const again = await record(roundId, verified, finding({ expected_revision_id: revisionId }));

      expect(first.statusCode).toBe(409);
      expect(first.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: pending, retirement_id: retirementIds.pending } });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: verified, retirement_id: retirementIds.verified } });
      expect(await revisionsOf(roundId, pending)).toEqual([]);
      expect(await revisionsOf(roundId, verified)).toHaveLength(1);

      expect((await voidResult(roundId, verified, revisionId)).statusCode).toBe(201);
      expect(await entryOf(roundId, verified)).toMatchObject({ result: 'NOT_YET_VERIFIED', current: null, retired: true });
    });

    it('still lets a Verification Correction void its result, which leaves it Not Yet Verified', async () => {
      const {
        roundId,
        assetIds: [gone],
      } = await roundOver(1);
      const { verification_revision_id: revisionId } = await recorded(roundId, gone);
      await retired(gone);

      const res = await voidResult(roundId, gone, revisionId);

      expect(res.statusCode).toBe(201);
      expect(await entryOf(roundId, gone)).toMatchObject({ result: 'NOT_YET_VERIFIED', current: null, retired: true });
    });

    it('counts it Not Yet Verified with no result, keeps its result counted, and adds no count, before and at the close (Q20)', async () => {
      const {
        roundId,
        assetIds: [pending, verified, kept],
      } = await roundOver(3);
      await recorded(roundId, verified);
      await retired(pending);
      await retired(verified);
      const counts = { in_scope: 3, found: 1, not_found: 0, not_yet_verified: 2, with_discrepancy: 0 };

      expect((await roundOf(roundId)).counts).toEqual(counts);
      expect((await entriesOf(roundId, 'result=NOT_YET_VERIFIED')).items.map(({ asset_id }: any) => asset_id).sort()).toEqual([pending, kept].sort());

      await closed(roundId);

      const { in_scope: _inScope, ...stored } = counts;
      expect((await roundOf(roundId)).history.at(-1)).toMatchObject({ kind: 'CLOSED', counts: stored });
    });

    it('leaves the counts a close stored, and the Round counts, as they were when an Asset with no result is retired later', async () => {
      const {
        roundId,
        assetIds: [pending, verified],
      } = await roundOver(2);
      await recorded(roundId, verified, { result: 'NOT_FOUND', condition: null });
      await closed(roundId);
      const before = await roundOf(roundId);

      await retired(pending);
      await retired(verified);

      expect(await roundOf(roundId)).toEqual(before);
    });
  });

  describe('the Asset page\'s "ตรวจประจำปี" panel (#154 Q12, Q22)', () => {
    const detailOf = async (assetId: string) => {
      const res = await api.get(custodian, `/assets/${assetId}`);
      expect(res.statusCode).toBe(200);
      return res.json();
    };

    it('says the Asset in the open Round is Retired and offers no recording, keeping the Verification Correction', async () => {
      const [room] = await entries('locations', `ห้องแผงตรวจ ${crypto.randomUUID()}`, 1);
      const gone = await placed(room);
      await opened({ location_ids: [room.id] });
      expect(await detailOf(gone)).toMatchObject({ verification: { retired: false }, can_record_verification: true, can_correct_verification: true });

      await retired(gone);

      expect(await detailOf(gone)).toMatchObject({ verification: { retired: true }, can_record_verification: false, can_correct_verification: true });
    });

    it('offers no Late Addition of a Retired Asset that is not in the open Round', async () => {
      const [room, other] = await entries('locations', `ห้องแผงเพิ่มภายหลัง ${crypto.randomUUID()}`, 2);
      await placed(room);
      const gone = await placed(other);
      await opened({ location_ids: [room.id] });
      expect(await detailOf(gone)).toMatchObject({ verification: { entry: null, retired: false }, can_manage_verification: true });

      await retired(gone);

      expect(await detailOf(gone)).toMatchObject({ verification: { entry: null, retired: true }, can_manage_verification: false });
    });
  });

  describe('concurrency (#154 Q24)', () => {
    // A Retirement queues at the Asset row lock, and `write` behind it in share mode, while the test holds that row.
    const behindRetirement = <B>(assetId: string, write: () => Promise<B>) =>
      whileHolding<any>(
        'assets',
        assetId,
        () => [retire(assetId), untilWaiting('assets', 1).then(write)],
        () => untilWaiting('assets', 1, 'FOR SHARE')
      ) as Promise<[any, B]>;

    it('refuses a result queued behind a Retirement of its Asset once the Retirement commits, and writes nothing', async () => {
      const [room] = await entries('locations', `ห้องรอคิวบันทึกผล ${crypto.randomUUID()}`, 1);
      const gone = await placed(room);
      const roundId = await opened({ location_ids: [room.id] });

      const [retirement, result] = await behindRetirement(gone, () => record(roundId, gone, finding()));

      expect(retirement.statusCode).toBe(201);
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: gone, retirement_id: retirement.json().retirement_id } });
      expect(await entryOf(roundId, gone)).toMatchObject({ result: 'NOT_YET_VERIFIED', revision_count: 0, retired: true });
    });

    it('refuses a Late Addition queued behind a Retirement of its Asset once the Retirement commits, and adds nothing', async () => {
      const [room, other] = await entries('locations', `ห้องรอคิวเพิ่มภายหลัง ${crypto.randomUUID()}`, 2);
      await placed(room);
      const gone = await placed(other);
      const roundId = await opened({ location_ids: [room.id] });
      const before = await scopeOf(roundId);

      const [retirement, addition] = await behindRetirement(gone, () => addLate(roundId, { asset_id: gone, reason: 'พบภายหลังว่าตกหล่น' }));

      expect(retirement.statusCode).toBe(201);
      expect(addition.statusCode).toBe(409);
      expect(addition.json()).toMatchObject({ code: 'ASSET_RETIRED', asset: { asset_id: gone, retirement_id: retirement.json().retirement_id } });
      expect(await scopeOf(roundId)).toEqual(before);
    });
  });

  describe('Awaiting Action (#154 Q19)', () => {
    it('never filters a current result of a Retired Asset as Awaiting Action, by either half', async () => {
      const [room, seen] = await entries('locations', `ห้องรอ action ${crypto.randomUUID()}`, 2);
      const [goneDamaged, goneMoved, keptDamaged, keptMoved] = [await placed(room), await placed(room), await placed(room), await placed(room)];
      const roundId = await opened({ location_ids: [room.id] });
      for (const assetId of [goneDamaged, keptDamaged]) {
        await recorded(roundId, assetId, { condition: 'DAMAGED' });
      }
      for (const assetId of [goneMoved, keptMoved]) {
        await recorded(roundId, assetId, { observed_location_id: seen.id });
      }
      const awaiting = async () => (await entriesOf(roundId, 'awaiting_action=true')).items.map(({ asset_id }: any) => asset_id).sort();
      expect(await awaiting()).toEqual([goneDamaged, goneMoved, keptDamaged, keptMoved].sort());

      await retired(goneDamaged);
      await retired(goneMoved);

      expect(await awaiting()).toEqual([keptDamaged, keptMoved].sort());
      expect((await entriesOf(roundId, 'awaiting_action=true')).total_count).toBe(2);
    });
  });
});
