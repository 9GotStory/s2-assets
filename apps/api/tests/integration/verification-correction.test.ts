import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F006-T4 (#129): an Asset already checked in the open Round is checked again on purpose (Re-verification), and a
// result recorded by mistake is voided (Verification Correction); every revision stays readable.
describe('Re-verification and Verification Correction (Seam A - F006-T4)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-12T05:00:00Z');

  const { entry, detailOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { lent } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-06', dueDate: '2026-11-30', contactName: 'คุณผู้ยืม' });
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { opened, roundOf, entryOf, finding, record, recorded, closedStandIn } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // A registered Asset in `room`, placed there on 1 October 2026.
  const registeredIn = async (room: { id: string }): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2026-10-01' });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room, its Assets, and an open Round over that room alone.
  const roundOver = async (count = 1) => {
    const room = await entry('locations', `ห้องตรวจซ้ำ ${crypto.randomUUID()}`);
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      assetIds.push(await registeredIn(room));
    }
    return { room, assetIds, roundId: await opened({ location_ids: [room.id] }) };
  };

  // A Re-verification of an Asset that saw `seen` as its current revision.
  const reverify = (roundId: string, assetId: string, seen: string | null, payload: Record<string, unknown> = finding(), token: string = crypto.randomUUID(), actor: Actor = staff) =>
    record(roundId, assetId, { ...payload, expected_revision_id: seen }, token, actor);

  // A Reassignment of `assetId` to `room` from `effectiveDate`, against its latest assignment version.
  const reassigned = async (assetId: string, room: { id: string }, effectiveDate: string) => {
    const res = await api.post(
      custodian,
      `/assets/${assetId}/assignments`,
      { kind: 'REASSIGNMENT', expected_assignment_version: (await detailOf(assetId)).assignment_version, effective_date: effectiveDate, location_id: room.id, explicit_continuation: true },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  // A Verification Correction of an Asset's current revision.
  const voiding = (roundId: string, assetId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`, payload, { 'x-retry-token': token });

  // Every revision of an Asset in a Round, newest first.
  const revisionsOf = async (roundId: string, assetId: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/verification-rounds/${roundId}/assets/${assetId}/verifications`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_verification_correction', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_verification_correction', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_verification_correction', 'READ_ONLY');
    staff = await api.actor('staff_verification_correction', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    now = new Date('2026-11-12T05:00:00Z');
    await closedStandIn();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('Re-verification', () => {
    it('records a new current result over the one it saw, whoever recorded that, and keeps the earlier revision unchanged (AV-12, AV-13, Q20)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId, { note: 'ครั้งแรก' }, custodian);
      const earlier = (await entryOf(roundId, assetId)).current;

      const res = await reverify(roundId, assetId, first.verification_revision_id, { result: 'NOT_FOUND' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_revision_id: expect.stringMatching(UUID), revision_number: 2, version: 3 });
      const current = await entryOf(roundId, assetId);
      expect(current).toMatchObject({ result: 'NOT_FOUND', version: 3, current: { id: res.json().verification_revision_id, revision_number: 2, recorded_by: staff.id, note: null } });
      expect(await revisionsOf(roundId, assetId)).toEqual([
        { ...current.current, is_voided: false, correction: null },
        { ...earlier, is_voided: false, correction: null },
      ]);
      expect((await roundOf(roundId)).counts).toEqual({ in_scope: 1, found: 0, not_found: 1, not_yet_verified: 0, with_discrepancy: 0 });
    });

    it('refuses a Re-verification whose seen revision is no longer current, naming the latest result, and writes nothing (AV-23, Q20)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId, {}, custodian);
      const newer = (await reverify(roundId, assetId, first.verification_revision_id)).json();
      const before = await entryOf(roundId, assetId);

      const res = await reverify(roundId, assetId, first.verification_revision_id, { result: 'NOT_FOUND' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'VERIFICATION_RESULT_CHANGED', current: { id: newer.verification_revision_id, revision_number: 2, recorded_by: staff.id } });
      expect(await entryOf(roundId, assetId)).toEqual(before);
      expect(await revisionsOf(roundId, assetId)).toHaveLength(2);
    });

    it('refuses a Re-verification of an Asset Not Yet Verified, naming no result, and a first result once one exists', async () => {
      const { assetIds: [pending, verified], roundId } = await roundOver(2);
      await recorded(roundId, verified);

      const unseen = await reverify(roundId, pending, crypto.randomUUID());
      const firstAgain = await record(roundId, verified, finding({ condition: 'DAMAGED' }));

      expect(unseen.statusCode).toBe(409);
      expect(unseen.json()).toMatchObject({ code: 'VERIFICATION_RESULT_CHANGED', current: null });
      expect(firstAgain.statusCode).toBe(409);
      expect(firstAgain.json().code).toBe('ASSET_ALREADY_VERIFIED');
      expect(await revisionsOf(roundId, pending)).toEqual([]);
      expect(await revisionsOf(roundId, verified)).toHaveLength(1);
    });

    it('follows the rules of a first result, and derives the Location in effect and the context for its own Verification Date (Q26, Q14)', async () => {
      now = new Date('2026-11-02T05:00:00Z');
      const { room, assetIds: [assetId], roundId } = await roundOver();
      const newRoom = await entry('locations', `ห้องใหม่ ${crypto.randomUUID()}`);
      now = new Date('2026-11-12T05:00:00Z');
      const first = await recorded(roundId, assetId, { verification_date: '2026-11-05' });
      await reassigned(assetId, newRoom, '2026-11-08');
      const { itemOf } = await lent([assetId]);

      const refusals: [Record<string, unknown>, string][] = [
        [{ result: 'FOUND' }, 'condition must be'],
        [{ result: 'NOT_FOUND', observed_location_id: room.id }, 'observed_location_id must not be given'],
        [finding({ data_mismatch: true }), 'data_mismatch_note is required'],
        [finding({ verification_date: '2026-11-01' }), 'start date'],
        [finding({ verification_date: '2026-11-13' }), 'after today'],
      ];
      for (const [payload, message] of refusals) {
        const res = await reverify(roundId, assetId, first.verification_revision_id, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain(message);
      }
      expect(await revisionsOf(roundId, assetId)).toHaveLength(1);

      expect((await reverify(roundId, assetId, first.verification_revision_id, finding({ verification_date: '2026-11-09', observed_location_id: room.id }))).statusCode).toBe(201);

      const [latest, earlier] = await revisionsOf(roundId, assetId);
      expect(latest).toMatchObject({
        verification_date: '2026-11-09',
        assignment_in_effect: { location: { id: newRoom.id } },
        discrepancies: ['LOCATION_MISMATCH'],
        loan_context: { kind: 'ON_LOAN', loan_item_id: itemOf[assetId] },
      });
      expect(earlier).toMatchObject({ verification_date: '2026-11-05', assignment_in_effect: { location: { id: room.id } }, discrepancies: [], loan_context: null });
    });

    it('ends concurrent Re-verifications from the same seen revision, on independent connections, with exactly one new revision', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => reverify(roundId, assetId, first.verification_revision_id, i % 2 === 0 ? finding() : { result: 'NOT_FOUND' }, crypto.randomUUID(), i < 3 ? staff : custodian))
      );

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      const winner = results.find((res) => res.statusCode === 201)!.json();
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json()).toMatchObject({ code: 'VERIFICATION_RESULT_CHANGED', current: { id: winner.verification_revision_id } });
      }
      expect((await revisionsOf(roundId, assetId)).map((revision: any) => revision.revision_number)).toEqual([2, 1]);
    });
  });

  describe('Verification Correction', () => {
    it('voids the current revision with a reason: it stays listed as voided and the previous revision is current again; voiding that leaves the Asset Not Yet Verified, and a first result can be recorded again (Q18)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId, { result: 'NOT_FOUND', condition: null });
      const earlier = (await entryOf(roundId, assetId)).current;
      const second = (await reverify(roundId, assetId, first.verification_revision_id, finding({ condition: 'DAMAGED' }))).json();
      const voidedRevision = (await entryOf(roundId, assetId)).current;
      const before = Date.now();

      const res = await voiding(roundId, assetId, { verification_revision_id: second.verification_revision_id, reason: '  บันทึกผิดครุภัณฑ์\nควรเป็นอีกเครื่อง  ' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_correction_id: expect.stringMatching(UUID), version: 4 });
      expect(await entryOf(roundId, assetId)).toMatchObject({ result: 'NOT_FOUND', version: 4, current: earlier });
      expect((await roundOf(roundId)).counts).toEqual({ in_scope: 1, found: 0, not_found: 1, not_yet_verified: 0, with_discrepancy: 0 });
      const [listedVoided, listedEarlier] = await revisionsOf(roundId, assetId);
      expect(listedVoided).toEqual({
        ...voidedRevision,
        is_voided: true,
        correction: {
          id: res.json().verification_correction_id,
          reason: 'บันทึกผิดครุภัณฑ์\nควรเป็นอีกเครื่อง',
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_verification_correction',
          recorded_at: expect.any(String),
        },
      });
      expect(Date.parse(listedVoided.correction.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(listedEarlier).toEqual({ ...earlier, is_voided: false, correction: null });

      expect((await voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'ผิดทั้งคู่' }, crypto.randomUUID(), admin)).statusCode).toBe(201);
      expect(await entryOf(roundId, assetId)).toMatchObject({ result: 'NOT_YET_VERIFIED', current: null, version: 5 });
      expect((await roundOf(roundId)).counts).toEqual({ in_scope: 1, found: 0, not_found: 0, not_yet_verified: 1, with_discrepancy: 0 });
      expect((await revisionsOf(roundId, assetId)).map((revision: any) => revision.is_voided)).toEqual([true, true]);

      const again = await record(roundId, assetId, finding());
      expect(again.statusCode).toBe(201);
      expect(again.json().revision_number).toBe(3);
      expect((await entryOf(roundId, assetId)).result).toBe('FOUND');
    });

    it('refuses to void a revision that is not current, naming the latest result, and one voided already, and writes nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const second = (await reverify(roundId, assetId, first.verification_revision_id)).json();
      const third = (await reverify(roundId, assetId, second.verification_revision_id, { result: 'NOT_FOUND' })).json();
      expect((await voiding(roundId, assetId, { verification_revision_id: third.verification_revision_id, reason: 'ผิด' })).statusCode).toBe(201);
      const before = await revisionsOf(roundId, assetId);

      const notCurrent = await voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'ผิด' });
      const twice = await voiding(roundId, assetId, { verification_revision_id: third.verification_revision_id, reason: 'ผิดอีก' });

      expect(notCurrent.statusCode).toBe(409);
      expect(notCurrent.json()).toMatchObject({ code: 'VERIFICATION_RESULT_CHANGED', current: { id: second.verification_revision_id } });
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ code: 'VERIFICATION_REVISION_ALREADY_VOIDED', current: { id: second.verification_revision_id } });
      expect(await revisionsOf(roundId, assetId)).toEqual(before);
    });

    it('refuses a void in a Round that is not open, and of a revision of another Asset or none, and writes nothing (AV-24)', async () => {
      const { assetIds: [assetId, other], roundId } = await roundOver(2);
      const first = await recorded(roundId, assetId);
      const ofOther = await recorded(roundId, other);

      const elsewhere = await voiding(roundId, assetId, { verification_revision_id: ofOther.verification_revision_id, reason: 'ผิด' });
      const unknown = await voiding(roundId, assetId, { verification_revision_id: crypto.randomUUID(), reason: 'ผิด' });
      await closedStandIn();
      const closed = await voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'ผิด' });

      expect(elsewhere.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(closed.statusCode).toBe(409);
      expect(closed.json().code).toBe('VERIFICATION_ROUND_NOT_OPEN');
      expect((await revisionsOf(roundId, assetId)).map((revision: any) => revision.is_voided)).toEqual([false]);
      expect((await revisionsOf(roundId, other)).map((revision: any) => revision.is_voided)).toEqual([false]);
    });

    it('needs a nonblank reason, keeping tabs and line breaks inside it and refusing one too long or holding a control character', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const voidWith = (reason: unknown) => voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason });

      const refusals: [unknown, string][] = [
        ['   ', 'needs a reason'],
        ['ก'.repeat(2001), 'at most 2000'],
        ['ผิด\u0007เครื่อง', 'control characters'],
      ];
      for (const [reason, message] of refusals) {
        const res = await voidWith(reason);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain(message);
      }
      expect((await voidWith(undefined)).statusCode).toBe(400);
      expect((await voiding(roundId, assetId, { verification_revision_id: 'not-a-uuid', reason: 'ผิด' })).statusCode).toBe(400);
      expect((await revisionsOf(roundId, assetId))[0].is_voided).toBe(false);

      expect((await voidWith(`ผิด\tเครื่อง\n${'ก'.repeat(1988)}`)).statusCode).toBe(201);
      expect((await revisionsOf(roundId, assetId))[0].correction.reason).toBe(`ผิด\tเครื่อง\n${'ก'.repeat(1988)}`);
    });

    it('answers a Round or an Asset that does not exist with 404, and a malformed id with 400', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const payload = { verification_revision_id: first.verification_revision_id, reason: 'ผิด' };

      expect((await voiding(crypto.randomUUID(), assetId, payload)).statusCode).toBe(404);
      expect((await voiding(roundId, crypto.randomUUID(), payload)).statusCode).toBe(404);
      expect((await voiding('not-a-uuid', assetId, payload)).statusCode).toBe(400);
      expect((await voiding(roundId, 'not-a-uuid', payload)).statusCode).toBe(400);
      expect((await revisionsOf(roundId, assetId))[0].is_voided).toBe(false);
    });
  });

  describe('order and concurrency', () => {
    it('decides a void under the scope entry lock: a Re-verification queued first makes the void stale, and it names the new result', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const entryId = (await entryOf(roundId, assetId)).id;
      let voided: Promise<any> | undefined;

      const [reverified] = await whileHolding(
        'verification_scope_entries',
        entryId,
        () => [reverify(roundId, assetId, first.verification_revision_id, { result: 'NOT_FOUND' })],
        async () => {
          await untilWaiting('verification_scope_entries', 1);
          voided = voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'ผิด' });
          await untilWaiting('verification_scope_entries', 2);
        }
      );

      expect(reverified.statusCode).toBe(201);
      const refused = await voided!;
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'VERIFICATION_RESULT_CHANGED', current: { id: reverified.json().verification_revision_id } });
      expect((await revisionsOf(roundId, assetId)).map((revision: any) => revision.is_voided)).toEqual([false, false]);
    });

    it('decides a Re-verification under the scope entry lock: a void queued first makes it stale, and it names the result current again', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const second = (await reverify(roundId, assetId, first.verification_revision_id)).json();
      const entryId = (await entryOf(roundId, assetId)).id;
      let reverified: Promise<any> | undefined;

      const [voided] = await whileHolding(
        'verification_scope_entries',
        entryId,
        () => [voiding(roundId, assetId, { verification_revision_id: second.verification_revision_id, reason: 'ผิด' })],
        async () => {
          await untilWaiting('verification_scope_entries', 1);
          reverified = reverify(roundId, assetId, second.verification_revision_id, { result: 'NOT_FOUND' });
          await untilWaiting('verification_scope_entries', 2);
        }
      );

      expect(voided.statusCode).toBe(201);
      const refused = await reverified!;
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'VERIFICATION_RESULT_CHANGED', current: { id: first.verification_revision_id } });
      expect(await revisionsOf(roundId, assetId)).toHaveLength(2);
    });

    it('ends concurrent voids of one revision with exactly one Verification Correction', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: `ผิด ${i}` }, crypto.randomUUID(), i % 2 ? admin : custodian))
      );

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json()).toMatchObject({ code: 'VERIFICATION_REVISION_ALREADY_VOIDED', current: null });
      }
      expect((await revisionsOf(roundId, assetId))[0].correction.id).toBe(results.find((res) => res.statusCode === 201)!.json().verification_correction_id);
    });
  });

  describe('reading', () => {
    it("lists an entry's revisions, newest first, to every role with asset:view and no one else, and 404 for an Asset not in the Round", async () => {
      const { room, assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId, { note: 'ผลที่ทุกคนเห็น' });
      await voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'เหตุที่ทุกคนเห็น' });
      const maintainer = await api.actor('maintainer_verification_correction', 'SYSTEM_MAINTAINER');
      const outside = await registeredIn(room);

      for (const reader of [custodian, admin, readonly, staff]) {
        expect(await revisionsOf(roundId, assetId, reader)).toMatchObject([{ note: 'ผลที่ทุกคนเห็น', is_voided: true, correction: { reason: 'เหตุที่ทุกคนเห็น' } }]);
      }
      const denied = await api.get(maintainer, `/verification-rounds/${roundId}/assets/${assetId}/verifications`);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('เหตุที่ทุกคนเห็น');
      expect((await api.get(readonly, `/verification-rounds/${roundId}/assets/${outside}/verifications`)).statusCode).toBe(404);
      expect((await api.get(readonly, `/verification-rounds/${crypto.randomUUID()}/assets/${assetId}/verifications`)).statusCode).toBe(404);
      expect((await api.get(readonly, `/verification-rounds/not-a-uuid/assets/${assetId}/verifications`)).statusCode).toBe(400);
      expect((await api.get(readonly, `/verification-rounds/${roundId}/assets/not-a-uuid/verifications`)).statusCode).toBe(400);
    });

    it('counts every revision of an entry, voided ones too, on the Round page and on the Asset page', async () => {
      const { assetIds: [assetId, pending], roundId } = await roundOver(2);
      const first = await recorded(roundId, assetId);
      const second = (await reverify(roundId, assetId, first.verification_revision_id)).json();
      await voiding(roundId, assetId, { verification_revision_id: second.verification_revision_id, reason: 'ผิด' });

      expect(await entryOf(roundId, assetId)).toMatchObject({ revision_count: 2, current: { id: first.verification_revision_id } });
      expect(await entryOf(roundId, pending)).toMatchObject({ revision_count: 0, current: null });
      expect((await api.get(readonly, `/assets/${assetId}/verifications`)).json().items).toMatchObject([{ round: { id: roundId }, revision_count: 2 }]);
      expect((await api.get(readonly, `/assets/${pending}/verifications`)).json().items).toMatchObject([{ round: { id: roundId }, revision_count: 0 }]);
    });

    it("needs asset:view itself to read an entry's revisions: denying it alone, or failing to look it up, shows nothing", async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      await recorded(roundId, assetId, { note: 'ผลที่ไม่ควรเห็น' });
      const url = `/verification-rounds/${roundId}/assets/${assetId}/verifications`;

      const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, url));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('ผลที่ไม่ควรเห็น');
      const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, url));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('ผลที่ไม่ควรเห็น');
    });
  });

  describe('authorization', () => {
    it('refuses a void by every role without verification:correct, and a Re-verification by every role without verification:record, writing nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const maintainer = await api.actor('maintainer_verification_correction_writer', 'SYSTEM_MAINTAINER');

      for (const actor of [staff, readonly, maintainer]) {
        const res = await voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'ผิด' }, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      for (const actor of [readonly, admin, maintainer]) {
        const res = await reverify(roundId, assetId, first.verification_revision_id, finding(), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await revisionsOf(roundId, assetId)).toMatchObject([{ id: first.verification_revision_id, is_voided: false }]);
    });

    it('needs verification:correct itself for a void, and fails closed when the lookup fails, writing nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const voidOnce = () => voiding(roundId, assetId, { verification_revision_id: first.verification_revision_id, reason: 'ผิด' });

      expect((await withCapabilityAnswer(api.app, 'verification:correct', async () => false, voidOnce)).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'verification:correct', async () => { throw new Error('lookup failed'); }, voidOnce);
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect((await revisionsOf(roundId, assetId))[0].is_voided).toBe(false);
    });

    it('needs verification:record itself for a Re-verification, writing nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);

      expect((await withCapabilityAnswer(api.app, 'verification:record', async () => false, () => reverify(roundId, assetId, first.verification_revision_id))).statusCode).toBe(403);
      expect(await revisionsOf(roundId, assetId)).toHaveLength(1);
    });

    it('needs a session and the CSRF token for a void, and an inactive user is refused, writing nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const payload = { verification_revision_id: first.verification_revision_id, reason: 'ผิด' };
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload,
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('custodian_inactive_verification_correction', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await voiding(roundId, assetId, payload, crypto.randomUUID(), leaving)).statusCode);

      expect((await revisionsOf(roundId, assetId))[0].is_voided).toBe(false);
    });

    it('tells the Asset page whether the viewer may void a result, which follows verification:correct alone', async () => {
      const { assetIds: [assetId] } = await roundOver();

      for (const actor of [custodian, admin]) {
        expect((await api.get(actor, `/assets/${assetId}`)).json().can_correct_verification).toBe(true);
      }
      for (const actor of [staff, readonly]) {
        expect((await api.get(actor, `/assets/${assetId}`)).json().can_correct_verification).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'verification:correct', async () => false, () => api.get(custodian, `/assets/${assetId}`));
      expect(denied.json().can_correct_verification).toBe(false);
    });
  });

  describe('retry token', () => {
    it('answers an identical replay of a Re-verification or a void with the committed result, writing nothing more', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const [reverifyToken, voidToken] = [crypto.randomUUID(), crypto.randomUUID()];
      const reverified = await reverify(roundId, assetId, first.verification_revision_id, finding(), reverifyToken);
      const payload = { verification_revision_id: reverified.json().verification_revision_id, reason: 'ผิด' };
      const voided = await voiding(roundId, assetId, payload, voidToken);

      const replays = [await reverify(roundId, assetId, first.verification_revision_id, finding(), reverifyToken), await voiding(roundId, assetId, payload, voidToken)];

      expect(replays.map((res) => res.statusCode)).toEqual([201, 201]);
      expect(replays.map((res) => res.json())).toEqual([reverified.json(), voided.json()]);
      expect((await revisionsOf(roundId, assetId)).map((revision: any) => revision.is_voided)).toEqual([true, false]);
    });

    it('refuses the same token with a changed payload, writing nothing, and tells a first result from a Re-verification', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const [reverifyToken, voidToken] = [crypto.randomUUID(), crypto.randomUUID()];
      const second = (await reverify(roundId, assetId, first.verification_revision_id, finding(), reverifyToken)).json();
      expect((await voiding(roundId, assetId, { verification_revision_id: second.verification_revision_id, reason: 'ผิด' }, voidToken)).statusCode).toBe(201);

      const changed = [
        await reverify(roundId, assetId, first.verification_revision_id, finding({ condition: 'DAMAGED' }), reverifyToken),
        await reverify(roundId, assetId, null, finding(), reverifyToken),
        await voiding(roundId, assetId, { verification_revision_id: second.verification_revision_id, reason: 'ผิดเครื่อง' }, voidToken),
      ];

      for (const res of changed) {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await revisionsOf(roundId, assetId)).toHaveLength(2);
      expect((await revisionsOf(roundId, assetId))[0].correction.reason).toBe('ผิด');
    });

    it('needs a token for a void, and stores no receipt for a refused one', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const payload = { verification_revision_id: first.verification_revision_id, reason: 'ผิด' };
      const token = crypto.randomUUID();

      expect((await api.post(custodian, `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`, payload)).statusCode).toBe(400);
      await api.pool.query(`UPDATE verification_rounds SET state = 'CLOSED' WHERE id = $1`, [roundId]);
      expect((await voiding(roundId, assetId, payload, token)).statusCode).toBe(409);
      await api.pool.query(`UPDATE verification_rounds SET state = 'OPEN' WHERE id = $1`, [roundId]);

      expect((await voiding(roundId, assetId, payload, token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the correction, the voided state, the new version nor the receipt, and answers in the deterministic shape', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId);
      const payload = { verification_revision_id: first.verification_revision_id, reason: 'ผิด' };
      const token = 'verification-correction-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_verification_correction() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected verification correction failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_verification_correction BEFORE UPDATE ON verification_scope_entries
          FOR EACH ROW EXECUTE FUNCTION fail_verification_correction();
      `);
      try {
        const res = await voiding(roundId, assetId, payload, token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected verification correction failure');
        expect(await revisionsOf(roundId, assetId)).toMatchObject([{ is_voided: false, correction: null }]);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_verification_correction ON verification_scope_entries; DROP FUNCTION fail_verification_correction();');
      }
      expect((await entryOf(roundId, assetId)).version).toBe(2);
      expect((await voiding(roundId, assetId, payload, token)).statusCode).toBe(201);
    });
  });
});
