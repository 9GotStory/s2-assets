import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

// F006-T8 (#133): a Reassignment that moves a misplaced Asset from its result, citing the Verification Revision with
// "Location ไม่ตรงทะเบียน", and the result that shows "ย้ายแล้ว" while a Reassignment not voided cites it (#125 AV-15,
// MR-12, Q13, Q15, Q19, Q22, P1, P2).
describe('Reassignment from a result (Seam A - F006-T8)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok.
  const now = new Date('2026-11-12T05:00:00Z');

  const { entry, timelineOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));
  const { opened, roundOf, entriesOf, entryOf, recorded, closed, closeOpenRound } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // A registered Asset in `room`, placed there on 1 October 2026.
  const registeredIn = async (room: Entry): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2026-10-01' });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room with `count` Assets, another room they may be found in, and an open Round over the first room.
  const roundOver = async (count = 1) => {
    const room = await entry('locations', `ห้องทะเบียน ${crypto.randomUUID()}`);
    const elsewhere = await entry('locations', `ห้องที่พบ ${crypto.randomUUID()}`);
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      assetIds.push(await registeredIn(room));
    }
    return { room, elsewhere, assetIds, roundId: await opened({ location_ids: [room.id], name: `รอบย้าย ${crypto.randomUUID()}` }) };
  };

  // An Asset in a new open Round, Found in another room than the register's: "Location ไม่ตรงทะเบียน".
  const misplacedResult = async () => {
    const {
      room,
      elsewhere,
      assetIds: [assetId],
      roundId,
    } = await roundOver();
    const { verification_revision_id: revisionId } = await recorded(roundId, assetId, { observed_location_id: elsewhere.id });
    return { room, elsewhere, assetId, roundId, revisionId };
  };

  const reassign = (assetId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/assets/${assetId}/assignments`, { kind: 'REASSIGNMENT', ...payload }, { 'x-retry-token': token });

  // A Reassignment of `assetId` to `room` on 12 November 2026, against the version the Asset has now, citing `revisionId`.
  const movedFrom = async (assetId: string, room: Entry, revisionId: string | undefined, overrides: Record<string, unknown> = {}) =>
    reassign(assetId, {
      expected_assignment_version: (await assignmentOf(assetId)).version,
      effective_date: '2026-11-12',
      location_id: room.id,
      ...(revisionId ? { verification_revision_id: revisionId } : {}),
      ...overrides,
    });

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

  // An Assignment Correction voiding the fact `eventId` of `assetId`.
  const voidFact = async (assetId: string, eventId: string) => {
    const res = await api.post(
      custodian,
      `/assets/${assetId}/assignments/${eventId}/corrections`,
      { action: 'VOID', reason: 'บันทึกย้ายผิด', expected_assignment_version: (await assignmentOf(assetId)).version },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  // The Assets of a Round "ยังไม่มี action ต่อ" lists.
  const awaitingAction = async (roundId: string): Promise<string[]> => (await entriesOf(roundId, 'limit=100&awaiting_action=true')).items.map((item: any) => item.asset_id);

  // A Verification Correction's own write on the revision, held uncommitted while a citing write waits on its share lock.
  const whileVoiding = async <R>(revisionId: string, write: () => Promise<R>): Promise<R> => {
    const [result] = await whileWriting(
      { sql: 'UPDATE verification_revisions SET is_voided = true WHERE id = $1', params: [revisionId] },
      () => [write()],
      () => untilWaiting('verification_revisions', 1, 'FOR SHARE')
    );
    return result;
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_reassignment_verification', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_reassignment_verification', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_reassignment_verification', 'READ_ONLY');
    staff = await api.actor('staff_reassignment_verification', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    await closeOpenRound();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('moving from a result with "Location ไม่ตรงทะเบียน"', () => {
    it('cites the revision, which the timeline shows with its Round and Verification Date', async () => {
      const { elsewhere, assetId, roundId, revisionId } = await misplacedResult();

      const res = await movedFrom(assetId, elsewhere, revisionId);

      expect(res.statusCode).toBe(201);
      const source = { verification_revision_id: revisionId, verification_round: { id: roundId, name: (await roundOf(roundId)).name }, verification_date: '2026-11-12', is_voided: false };
      expect(res.json().event).toMatchObject({ kind: 'REASSIGNMENT', verification_revision: source });
      expect(res.json().current_assignment.location.id).toBe(elsewhere.id);
      const timeline = await timelineOf(assetId);
      expect(timeline.map((event: any) => event.verification_revision)).toEqual([null, source]);
    });

    it('moves from a result of a Closed Round', async () => {
      const { elsewhere, assetId, roundId, revisionId } = await misplacedResult();
      await closed(roundId);

      const res = await movedFrom(assetId, elsewhere, revisionId);

      expect(res.statusCode).toBe(201);
      expect(res.json().event.verification_revision).toMatchObject({ verification_revision_id: revisionId, is_voided: false });
    });

    it('lets the user change the prefilled Location and Effective Date (P2)', async () => {
      const { assetId, revisionId } = await misplacedResult();
      const third = await entry('locations', `ห้องที่สาม ${crypto.randomUUID()}`);

      const res = await movedFrom(assetId, third, revisionId, { effective_date: '2026-11-11' });

      expect(res.statusCode).toBe(201);
      expect(res.json().event).toMatchObject({ effective_date: '2026-11-11', verification_revision: { verification_revision_id: revisionId } });
      expect(res.json().current_assignment.location.id).toBe(third.id);
    });

    it('writes no Reassignment by recording a result with "Location ไม่ตรงทะเบียน" (AV-14)', async () => {
      const { room, assetId } = await misplacedResult();

      const { current, timeline } = await assignmentOf(assetId);
      expect(current.location.id).toBe(room.id);
      expect(timeline.map((event: any) => event.kind)).toEqual(['INITIAL']);
    });

    it('leaves the result as recorded: its values and "Location ไม่ตรงทะเบียน" stay (Q15)', async () => {
      const { elsewhere, assetId, roundId, revisionId } = await misplacedResult();
      const recordedFacts = ({ observed_location, assignment_in_effect, discrepancies, verification_date }: any) => ({ observed_location, assignment_in_effect, discrepancies, verification_date });
      const before = recordedFacts((await entryOf(roundId, assetId)).current);

      expect((await movedFrom(assetId, elsewhere, revisionId)).statusCode).toBe(201);

      const after = (await entryOf(roundId, assetId)).current;
      expect(after.id).toBe(revisionId);
      expect(recordedFacts(after)).toEqual(before);
      expect(after.discrepancies).toEqual(['LOCATION_MISMATCH']);
    });

    it('saves once for a repeated submission, and refuses the token for another citation', async () => {
      const { elsewhere, assetId, revisionId } = await misplacedResult();
      const payload = { expected_assignment_version: (await assignmentOf(assetId)).version, effective_date: '2026-11-12', location_id: elsewhere.id };
      const token = crypto.randomUUID();

      const first = await reassign(assetId, { ...payload, verification_revision_id: revisionId }, token);
      const again = await reassign(assetId, { ...payload, verification_revision_id: revisionId }, token);
      const uncited = await reassign(assetId, payload, token);

      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(201);
      expect(again.json()).toEqual(first.json());
      expect(uncited.statusCode).toBe(409);
      expect(uncited.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });
  });

  describe('what a Reassignment cannot cite', () => {
    // A Reassignment of `assetId` citing `revisionId` is refused for `reason`, and nothing is saved.
    const refusedFor = async (assetId: string, revisionId: string, reason: string) => {
      const before = await assignmentOf(assetId);
      const to = await entry('locations', `ห้องปลายทาง ${crypto.randomUUID()}`);
      const res = await movedFrom(assetId, to, revisionId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'CITED_VERIFICATION_REVISION_REFUSED', verification_revision: { verification_revision_id: revisionId, reason } });
      expect(await assignmentOf(assetId)).toEqual(before);
    };

    it('refuses a result without "Location ไม่ตรงทะเบียน": Found where the register says, Found with no Observed Location, or Not Found', async () => {
      const {
        room,
        assetIds: [same, unnoted, missing],
        roundId,
      } = await roundOver(3);

      await refusedFor(same, (await recorded(roundId, same, { observed_location_id: room.id })).verification_revision_id, 'NO_LOCATION_MISMATCH');
      await refusedFor(unnoted, (await recorded(roundId, unnoted, { condition: 'DAMAGED' })).verification_revision_id, 'NO_LOCATION_MISMATCH');
      await refusedFor(missing, (await recorded(roundId, missing, { result: 'NOT_FOUND', condition: null })).verification_revision_id, 'NO_LOCATION_MISMATCH');
    });

    it('refuses a result of another Asset', async () => {
      const {
        elsewhere,
        assetIds: [misplaced, other],
        roundId,
      } = await roundOver(2);
      const { verification_revision_id: revisionId } = await recorded(roundId, misplaced, { observed_location_id: elsewhere.id });

      await refusedFor(other, revisionId, 'OTHER_ASSET');
    });

    it('refuses a revision voided by a Verification Correction', async () => {
      const { assetId, roundId, revisionId } = await misplacedResult();
      await voidResult(roundId, assetId, revisionId);

      await refusedFor(assetId, revisionId, 'VOIDED');
    });

    it('refuses an id that names no Verification Revision', async () => {
      const { assetId } = await misplacedResult();

      await refusedFor(assetId, crypto.randomUUID(), 'NOT_VERIFICATION_REVISION');
    });

    it('refuses an id that is not a UUID, a citing Initial Assignment, and a citing Bulk Reassignment, as validation failures', async () => {
      const { elsewhere, assetId, revisionId } = await misplacedResult();
      const unassigned = (await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}` })).json().asset.id;
      const before = await assignmentOf(assetId);

      expect((await movedFrom(assetId, elsewhere, 'not-a-uuid')).statusCode).toBe(400);
      const initial = await api.post(
        custodian,
        `/assets/${unassigned}/assignments`,
        { kind: 'INITIAL', expected_assignment_version: 0, effective_date: '2026-11-12', location_id: elsewhere.id, verification_revision_id: revisionId },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(initial.statusCode).toBe(400);
      const bulk = await api.post(
        custodian,
        '/assets/bulk-reassignments',
        { assets: [{ asset_id: assetId, expected_assignment_version: before.version }], effective_date: '2026-11-12', location_id: elsewhere.id, verification_revision_id: revisionId },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(bulk.statusCode).toBe(400);
      expect(await assignmentOf(assetId)).toEqual(before);
      expect((await assignmentOf(unassigned)).timeline).toEqual([]);
    });

    it('reads the revision under a lock its void takes, so a Verification Correction voiding it first is seen', async () => {
      const { elsewhere, assetId, revisionId } = await misplacedResult();
      const before = await assignmentOf(assetId);
      const payload = { expected_assignment_version: before.version, effective_date: '2026-11-12', location_id: elsewhere.id, verification_revision_id: revisionId };

      const refused = await whileVoiding(revisionId, () => reassign(assetId, payload));

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'CITED_VERIFICATION_REVISION_REFUSED', verification_revision: { verification_revision_id: revisionId, reason: 'VOIDED' } });
      expect(await assignmentOf(assetId)).toEqual(before);
    });
  });

  describe('every Feature 003 rule, unchanged', () => {
    it('refuses a stale assignment version, and an Effective Date after today', async () => {
      const { elsewhere, assetId, revisionId } = await misplacedResult();
      const before = await assignmentOf(assetId);

      const stale = await movedFrom(assetId, elsewhere, revisionId, { expected_assignment_version: before.version - 1 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect((await movedFrom(assetId, elsewhere, revisionId, { effective_date: '2026-11-13' })).statusCode).toBe(400);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('warns of the Assignment Conflicts it would create until they are confirmed', async () => {
      const { elsewhere, assetId, revisionId } = await misplacedResult();
      const later = await entry('locations', `ห้องภายหลัง ${crypto.randomUUID()}`);
      expect((await movedFrom(assetId, later, undefined)).statusCode).toBe(201);

      const warned = await movedFrom(assetId, elsewhere, revisionId, { effective_date: '2026-11-11' });
      expect(warned.statusCode).toBe(409);
      expect(warned.json().code).toBe('ASSIGNMENT_CONFLICTS_FOUND');

      const confirmed = await movedFrom(assetId, elsewhere, revisionId, { effective_date: '2026-11-11', explicit_continuation: true });
      expect(confirmed.statusCode).toBe(201);
      expect(confirmed.json().event.verification_revision).toMatchObject({ verification_revision_id: revisionId });
    });
  });

  describe('"ย้ายแล้ว" (Q19)', () => {
    it('shows "ย้ายแล้ว" on the result, with the Reassignment, and takes it out of "ยังไม่มี action ต่อ"', async () => {
      const {
        elsewhere,
        assetIds: [moved, waiting, damaged],
        roundId,
      } = await roundOver(3);
      const { verification_revision_id: revisionId } = await recorded(roundId, moved, { observed_location_id: elsewhere.id });
      await recorded(roundId, waiting, { observed_location_id: elsewhere.id });
      await recorded(roundId, damaged, { condition: 'DAMAGED' });
      expect((await awaitingAction(roundId)).sort()).toEqual([moved, waiting, damaged].sort());

      const eventId = (await movedFrom(moved, elsewhere, revisionId)).json().event.id;

      expect((await entryOf(roundId, moved)).current).toMatchObject({ reassigned: true, reassignments: [{ id: eventId, effective_date: '2026-11-12', is_voided: false }] });
      expect((await entryOf(roundId, waiting)).current).toMatchObject({ reassigned: false, reassignments: [] });
      expect((await awaitingAction(roundId)).sort()).toEqual([waiting, damaged].sort());
      const verifications = (await api.get(readonly, `/assets/${moved}/verifications`)).json().items;
      expect(verifications[0].current).toMatchObject({ reassigned: true });
      const panel = (await api.get(readonly, `/assets/${moved}`)).json().verification;
      expect(panel.entry.current).toMatchObject({ reassigned: true, reassignments: [{ id: eventId }] });
    });

    it('takes "ย้ายแล้ว" from the result when the Reassignment is voided by an Assignment Correction', async () => {
      const { elsewhere, assetId, roundId, revisionId } = await misplacedResult();
      const eventId = (await movedFrom(assetId, elsewhere, revisionId)).json().event.id;
      expect(await awaitingAction(roundId)).toEqual([]);

      await voidFact(assetId, eventId);

      expect((await entryOf(roundId, assetId)).current).toMatchObject({ reassigned: false, reassignments: [{ id: eventId, is_voided: true }] });
      expect(await awaitingAction(roundId)).toEqual([assetId]);
    });

    it('takes "ย้ายแล้ว" from an Asset re-verified after it was moved, since its current revision changed', async () => {
      const { elsewhere, assetId, roundId, revisionId } = await misplacedResult();
      expect((await movedFrom(assetId, elsewhere, revisionId)).statusCode).toBe(201);
      const third = await entry('locations', `ห้องที่สาม ${crypto.randomUUID()}`);

      await recorded(roundId, assetId, { observed_location_id: third.id, expected_revision_id: revisionId });

      expect((await entryOf(roundId, assetId)).current.reassigned).toBe(false);
      expect(await awaitingAction(roundId)).toEqual([assetId]);
    });
  });

  describe('voiding a result a Reassignment cites (P1)', () => {
    it('keeps the Reassignment, shows its source ยกเลิกแล้ว, and the result is no longer "ย้ายแล้ว"', async () => {
      const {
        elsewhere,
        assetIds: [assetId],
        roundId,
      } = await roundOver();
      const earlier = (await recorded(roundId, assetId, { observed_location_id: elsewhere.id })).verification_revision_id;
      const reverified = (await recorded(roundId, assetId, { observed_location_id: elsewhere.id, expected_revision_id: earlier })).verification_revision_id;
      expect((await movedFrom(assetId, elsewhere, reverified)).statusCode).toBe(201);
      const before = await assignmentOf(assetId);

      await voidResult(roundId, assetId, reverified);

      const after = await assignmentOf(assetId);
      expect(after.current).toEqual(before.current);
      expect(after.timeline).toEqual(
        before.timeline.map((event: any) => (event.verification_revision ? { ...event, verification_revision: { ...event.verification_revision, is_voided: true } } : event))
      );
      expect((await entryOf(roundId, assetId)).current).toMatchObject({ id: earlier, reassigned: false, reassignments: [] });
      expect(await awaitingAction(roundId)).toEqual([assetId]);
    });
  });

  describe('authorization', () => {
    it('refuses a citing Reassignment without assignment:reassign, and fails closed', async () => {
      const { elsewhere, assetId, revisionId } = await misplacedResult();
      const before = await assignmentOf(assetId);
      const payload = { expected_assignment_version: before.version, effective_date: '2026-11-12', location_id: elsewhere.id, verification_revision_id: revisionId };

      expect((await reassign(assetId, payload, crypto.randomUUID(), staff)).statusCode).toBe(403);
      const denied = await withCapabilityAnswer(api.app, 'assignment:reassign', async () => false, () => reassign(assetId, payload));
      expect(denied.statusCode).toBe(403);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('tells the Round page whether the viewer may move an Asset, and fails closed (Q22)', async () => {
      const { roundId } = await misplacedResult();

      expect((await roundOf(roundId, custodian)).can_reassign).toBe(true);
      expect((await roundOf(roundId, staff)).can_reassign).toBe(false);
      const denied = await withCapabilityAnswer(api.app, 'assignment:reassign', async () => false, () => roundOf(roundId, custodian));
      expect(denied.can_reassign).toBe(false);
    });
  });
});
