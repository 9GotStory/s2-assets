import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

// F006-T7 (#132): a Repair Record sent from a result Found ชำรุด, which it cites as its Repair Source, and the
// result that shows "ส่งซ่อมแล้ว" while a Repair Record not voided cites it (#125 AV-16, RM-08, Q12, Q19, Q22, P1).
describe('Repair Source of a result (Seam A - F006-T7)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok.
  const now = new Date('2026-11-12T05:00:00Z');

  const { entry } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { lent, loanOf, returned } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-12', dueDate: '2026-11-30' });
  const { opened, roundOf, entriesOf, entryOf, recorded, closed, closeOpenRound } = verificationHelpers(() => ({ api, custodian, reader: readonly }));
  const { base, send, sent, recordOf, recordsOf, ended, correct, amendment, amended, voided } = repairHelpers(() => ({ api, custodian, reader: readonly }), {
    startDate: '2026-11-12',
  });

  // A registered Asset in `room`, placed there on 1 October 2026.
  const registeredIn = async (room: { id: string }): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2026-10-01' });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room, its Assets, and an open Round over that room alone.
  const roundOver = async (count = 1) => {
    const room = await entry('locations', `ห้องส่งซ่อม ${crypto.randomUUID()}`);
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      assetIds.push(await registeredIn(room));
    }
    return { assetIds, roundId: await opened({ location_ids: [room.id], name: `รอบส่งซ่อม ${crypto.randomUUID()}` }) };
  };

  // A result of `assetId` recorded Found ชำรุด unless `overrides` says otherwise, and its revision's id.
  const resultOf = async (roundId: string, assetId: string, overrides: Record<string, unknown> = { condition: 'DAMAGED' }): Promise<string> =>
    (await recorded(roundId, assetId, overrides)).verification_revision_id;

  // An Asset in a new open Round with a result Found ชำรุด.
  const damagedResult = async () => {
    const {
      assetIds: [assetId],
      roundId,
    } = await roundOver();
    return { assetId, roundId, revisionId: await resultOf(roundId, assetId) };
  };

  const fromResult = (revisionId: string) => ({ repair_source: { verification_revision_id: revisionId } });

  // A Verification Correction of an Asset's current revision.
  const voidResult = async (roundId: string, assetId: string, revisionId: string) => {
    const res = await api.post(
      custodian,
      `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`,
      { verification_revision_id: revisionId, reason: 'บันทึกผิดครุภัณฑ์' },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  // The Assets of a Round "ยังไม่มี action ต่อ" lists.
  const awaitingAction = async (roundId: string): Promise<string[]> => (await entriesOf(roundId, 'limit=100&awaiting_action=true')).items.map((item: any) => item.asset_id);

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_repair_source_verification', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_repair_source_verification', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair_source_verification', 'READ_ONLY');
    staff = await api.actor('staff_repair_source_verification', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    await closeOpenRound();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('sending from a result Found ชำรุด', () => {
    it('cites the revision as its Repair Source, which the record shows with its Round and Verification Date', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();

      const repairRecordId = await sent(assetId, fromResult(revisionId));

      const source = { verification_revision_id: revisionId, verification_round: { id: roundId, name: (await roundOf(roundId)).name }, verification_date: '2026-11-12', is_voided: false };
      expect((await recordOf(repairRecordId)).repair_source).toEqual(source);
      expect((await recordsOf(assetId))[0].repair_source).toEqual(source);
    });

    it('shows "ส่งซ่อมแล้ว" on the result, with the Repair Record, and takes it out of "ยังไม่มี action ต่อ" (Q19)', async () => {
      const {
        assetIds: [sentOne, waiting],
        roundId,
      } = await roundOver(2);
      const revisionId = await resultOf(roundId, sentOne);
      await resultOf(roundId, waiting);
      expect((await awaitingAction(roundId)).sort()).toEqual([sentOne, waiting].sort());

      const repairRecordId = await sent(sentOne, fromResult(revisionId));

      expect((await entryOf(roundId, sentOne)).current).toMatchObject({
        sent_for_repair: true,
        repair_records: [{ id: repairRecordId, repair_kind: 'REPAIR', start_date: '2026-11-12', is_voided: false }],
      });
      expect((await entryOf(roundId, waiting)).current).toMatchObject({ sent_for_repair: false, repair_records: [] });
      expect(await awaitingAction(roundId)).toEqual([waiting]);
      expect((await entriesOf(roundId, 'limit=100&awaiting_action=true')).total_count).toBe(1);
      const panel = (await api.get(readonly, `/assets/${sentOne}`)).json().verification;
      expect(panel.entry.current).toMatchObject({ sent_for_repair: true, repair_records: [{ id: repairRecordId }] });
      const verifications = (await api.get(readonly, `/assets/${sentOne}/verifications`)).json().items;
      expect(verifications[0].current).toMatchObject({ sent_for_repair: true });
    });

    it('sends from a result of a Closed Round', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      await closed(roundId);

      const repairRecordId = await sent(assetId, fromResult(revisionId));

      expect((await recordOf(repairRecordId)).repair_source).toMatchObject({ verification_revision_id: revisionId, is_voided: false });
      expect((await entryOf(roundId, assetId)).current.sent_for_repair).toBe(true);
    });

    it('creates no Repair Record by recording a result Found ชำรุด (AV-14)', async () => {
      const { assetId } = await damagedResult();

      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('saves once for a repeated submission, and refuses the token for another Repair Source', async () => {
      const { assetId, revisionId } = await damagedResult();
      const token = crypto.randomUUID();

      const first = await send(base(assetId, fromResult(revisionId)), token);
      const again = await send(base(assetId, fromResult(revisionId)), token);
      const changed = await send(base(assetId), token);

      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(201);
      expect(again.json()).toEqual(first.json());
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });
  });

  describe('what cannot be a Repair Source', () => {
    // A Repair Start of `assetId` citing `revisionId` is refused for `reason`, and nothing is saved.
    const refusedFor = async (assetId: string, revisionId: string, reason: string) => {
      const res = await send(base(assetId, fromResult(revisionId)));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { verification_revision_id: revisionId, reason } });
      expect(await recordsOf(assetId)).toEqual([]);
    };

    it('refuses a result Found ปกติ, and a result Not Found', async () => {
      const {
        assetIds: [normal, missing],
        roundId,
      } = await roundOver(2);

      await refusedFor(normal, await resultOf(roundId, normal, { condition: 'NORMAL' }), 'NOT_DAMAGED');
      await refusedFor(missing, await resultOf(roundId, missing, { result: 'NOT_FOUND', condition: null }), 'NOT_DAMAGED');
    });

    it('refuses a result of another Asset', async () => {
      const {
        assetIds: [damaged, other],
        roundId,
      } = await roundOver(2);

      await refusedFor(other, await resultOf(roundId, damaged), 'OTHER_ASSET');
    });

    it('refuses a revision voided by a Verification Correction', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      await voidResult(roundId, assetId, revisionId);

      await refusedFor(assetId, revisionId, 'VOIDED');
    });

    it('refuses an id that names no Verification Revision', async () => {
      const { assetId } = await damagedResult();

      await refusedFor(assetId, crypto.randomUUID(), 'NOT_VERIFICATION_REVISION');
    });

    it('refuses an id that is not a UUID, and two Repair Sources at once, as validation failures', async () => {
      const { assetId, revisionId } = await damagedResult();
      const loanReturnId = crypto.randomUUID();

      expect((await send(base(assetId, fromResult('not-a-uuid')))).statusCode).toBe(400);
      expect((await send(base(assetId, { repair_source: { verification_revision_id: revisionId, loan_return_id: loanReturnId } }))).statusCode).toBe(400);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('reads the revision under a lock its void takes, so a Verification Correction voiding it first is seen', async () => {
      const { assetId, revisionId } = await damagedResult();
      const holder = await api.pool.connect();
      let pending: ReturnType<typeof send> | undefined;
      try {
        // The void's own write on the revision, not yet committed.
        await holder.query('BEGIN');
        await holder.query('UPDATE verification_revisions SET is_voided = true WHERE id = $1', [revisionId]);
        pending = send(base(assetId, fromResult(revisionId)));
        await expect
          .poll(
            async () =>
              (
                await api.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM verification_revisions%FOR SHARE%'`)
              ).rows[0].n,
            { timeout: 10_000, interval: 50 }
          )
          .toBe(1);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }

      const refused = await pending!;
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { verification_revision_id: revisionId, reason: 'VOIDED' } });
      expect(await recordsOf(assetId)).toEqual([]);
    });
  });

  describe('every Feature 005 rule, unchanged', () => {
    it('refuses an Asset On Loan, or already Under Repair', async () => {
      const { assetId, revisionId } = await damagedResult();
      const { loanId } = await lent([assetId]);

      const onLoan = await send(base(assetId, fromResult(revisionId)));
      expect(onLoan.statusCode).toBe(409);
      expect(onLoan.json()).toMatchObject({ code: 'REPAIR_START_REFUSED', asset: { asset_id: assetId, reason: 'ON_LOAN', loan_id: loanId } });

      // One Round is open at a time (#125 Q17); a result of a Closed Round may still be sent.
      await closeOpenRound();
      const repairing = await damagedResult();
      const repairRecordId = await sent(repairing.assetId, fromResult(repairing.revisionId));
      const underRepair = await send(base(repairing.assetId, fromResult(repairing.revisionId)));
      expect(underRepair.statusCode).toBe(409);
      expect(underRepair.json()).toMatchObject({ code: 'REPAIR_START_REFUSED', asset: { reason: 'UNDER_REPAIR', repair_record_id: repairRecordId } });
    });

    it('refuses a Start Date after today', async () => {
      const { assetId, revisionId } = await damagedResult();

      expect((await send(base(assetId, { ...fromResult(revisionId), start_date: '2026-11-13' }))).statusCode).toBe(400);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('warns of a Repair Conflict until it is confirmed', async () => {
      const { assetId, revisionId } = await damagedResult();
      const earlier = await sent(assetId, { start_date: '2026-11-01' });
      await ended(earlier, { outcome_date: '2026-11-10' });

      const warned = await send(base(assetId, { ...fromResult(revisionId), start_date: '2026-11-05' }));
      expect(warned.statusCode).toBe(409);
      expect(warned.json().code).toBe('REPAIR_CONFLICTS_FOUND');

      const confirmed = await send(base(assetId, { ...fromResult(revisionId), start_date: '2026-11-05', confirmed_conflicts: [{ conflicting_repair_record_id: earlier }] }));
      expect(confirmed.statusCode).toBe(201);
    });
  });

  describe('Repair Correction', () => {
    const RECORD = { kind: 'REPAIR_RECORD' };

    it('takes "ส่งซ่อมแล้ว" from the result when the Repair Record is voided (Q19)', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      const repairRecordId = await sent(assetId, fromResult(revisionId));
      expect(await awaitingAction(roundId)).toEqual([]);

      await voided(repairRecordId, RECORD);

      expect((await entryOf(roundId, assetId)).current).toMatchObject({ sent_for_repair: false, repair_records: [{ id: repairRecordId, is_voided: true }] });
      expect(await awaitingAction(roundId)).toEqual([assetId]);
    });

    it('amends a Repair Source to a result, to a Loan Return, and to none, listing each before and after', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      const repairRecordId = await sent(assetId);

      await amended(repairRecordId, RECORD, fromResult(revisionId));
      expect((await recordOf(repairRecordId)).repair_source).toMatchObject({ verification_revision_id: revisionId });
      expect((await entryOf(roundId, assetId)).current.sent_for_repair).toBe(true);
      await amended(repairRecordId, RECORD, { repair_source: null });

      const record = await recordOf(repairRecordId);
      expect(record.repair_source).toBeNull();
      expect((await entryOf(roundId, assetId)).current.sent_for_repair).toBe(false);
      const source = { verification_revision_id: revisionId, verification_round: { id: roundId, name: (await roundOf(roundId)).name }, verification_date: '2026-11-12', is_voided: false };
      expect(record.corrections.map((c: any) => c.changes)).toEqual([
        [{ field: 'repair_source_verification_revision_id', before: null, after: source }],
        [{ field: 'repair_source_verification_revision_id', before: source, after: null }],
      ]);
    });

    it('replaces a result with a Loan Return as the one Repair Source', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      const repairRecordId = await sent(assetId, fromResult(revisionId));
      await ended(repairRecordId, { outcome_date: '2026-11-12' });
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-12', 'DAMAGED');
      const loanReturnId: string = (await loanOf(loanId)).items[0].loan_return.id;

      await amended(repairRecordId, RECORD, { repair_source: { loan_return_id: loanReturnId } });

      const record = await recordOf(repairRecordId);
      expect(record.repair_source).toMatchObject({ loan_return_id: loanReturnId, loan_id: loanId });
      expect(record.corrections.at(-1).changes.map((c: any) => [c.field, c.before === null, c.after === null])).toEqual([
        ['repair_source_loan_return_id', true, false],
        ['repair_source_verification_revision_id', false, true],
      ]);
      expect((await entryOf(roundId, assetId)).current.sent_for_repair).toBe(false);
    });

    it('refuses an amendment to a result that cannot be a Repair Source, and changes nothing', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      const repairRecordId = await sent(assetId);
      await voidResult(roundId, assetId, revisionId);
      const before = await recordOf(repairRecordId);

      const res = await correct(repairRecordId, await amendment(repairRecordId, RECORD, fromResult(revisionId)));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_SOURCE_REFUSED', repair_source: { verification_revision_id: revisionId, reason: 'VOIDED' } });
      expect(await recordOf(repairRecordId)).toEqual(before);
    });
  });

  describe('voiding a result a Repair Record cites (P1)', () => {
    it('keeps the Repair Record, shows its source ยกเลิกแล้ว, and the result is no longer "ส่งซ่อมแล้ว"', async () => {
      const {
        assetIds: [assetId],
        roundId,
      } = await roundOver();
      const earlier = await resultOf(roundId, assetId);
      const reverified = await recorded(roundId, assetId, { condition: 'DAMAGED', expected_revision_id: earlier });
      const repairRecordId = await sent(assetId, fromResult(reverified.verification_revision_id));
      const before = await recordOf(repairRecordId);

      await voidResult(roundId, assetId, reverified.verification_revision_id);

      expect(await recordOf(repairRecordId)).toEqual({ ...before, repair_source: { ...before.repair_source, is_voided: true } });
      // The earlier revision is the current result again, and no Repair Record cites it.
      expect((await entryOf(roundId, assetId)).current).toMatchObject({ id: earlier, sent_for_repair: false, repair_records: [] });
      expect(await awaitingAction(roundId)).toEqual([assetId]);
    });

    it('takes "ส่งซ่อมแล้ว" from an Asset re-verified after it was sent, since its current revision changed', async () => {
      const { assetId, roundId, revisionId } = await damagedResult();
      await sent(assetId, fromResult(revisionId));

      await recorded(roundId, assetId, { condition: 'DAMAGED', expected_revision_id: revisionId });

      expect((await entryOf(roundId, assetId)).current.sent_for_repair).toBe(false);
      expect(await awaitingAction(roundId)).toEqual([assetId]);
    });
  });

  describe('"ยังไม่มี action ต่อ"', () => {
    it('lists only current results ชำรุด without "ส่งซ่อมแล้ว", and refuses a value it does not know', async () => {
      const {
        assetIds: [damaged, normal, missing, unchecked],
        roundId,
      } = await roundOver(4);
      await resultOf(roundId, damaged);
      await resultOf(roundId, normal, { condition: 'NORMAL', label_missing_or_damaged: true });
      await resultOf(roundId, missing, { result: 'NOT_FOUND', condition: null });

      expect(await awaitingAction(roundId)).toEqual([damaged]);
      expect(unchecked).toBeDefined();
      expect((await api.get(readonly, `/verification-rounds/${roundId}/entries?awaiting_action=false`)).statusCode).toBe(400);
    });
  });

  describe('authorization', () => {
    it('refuses a Repair Start from a result without repair:record, and fails closed', async () => {
      const { assetId, revisionId } = await damagedResult();

      expect((await send(base(assetId, fromResult(revisionId)), crypto.randomUUID(), staff)).statusCode).toBe(403);
      expect((await send(base(assetId, fromResult(revisionId)), crypto.randomUUID(), readonly)).statusCode).toBe(403);
      const denied = await withCapabilityAnswer(api.app, 'repair:record', async () => false, () => send(base(assetId, fromResult(revisionId))));
      expect(denied.statusCode).toBe(403);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('tells the Round page whether the viewer may send for repair, and fails closed (Q22)', async () => {
      const { roundId } = await damagedResult();

      expect((await roundOf(roundId, custodian)).can_record_repair).toBe(true);
      expect((await roundOf(roundId, staff)).can_record_repair).toBe(false);
      expect((await roundOf(roundId, readonly)).can_record_repair).toBe(false);
      const denied = await withCapabilityAnswer(api.app, 'repair:record', async () => false, () => api.get(custodian, `/verification-rounds/${roundId}`));
      expect(denied.json().can_record_repair).toBe(false);
    });
  });
});
