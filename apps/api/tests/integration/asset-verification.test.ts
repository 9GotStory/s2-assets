import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F006-T2 (#127): Verification Staff record an Asset of the open Round as Found or Not Found, and everyone who
// can view Assets reads the results.
describe('Record an Asset Verification (Seam A - F006-T2)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-12T05:00:00Z');

  const { entry, detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { lent, loanOf, closedNotReturned } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-01', dueDate: '2026-11-30', contactName: 'คุณผู้ยืม' });
  const { sent, recordOf } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-11-03' });
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { opened, roundOf, entriesOf, finding, record, recorded, entryOf, closedStandIn } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // A registered Asset in `room`, placed there on 1 October 2026.
  const registeredIn = async (room: { id: string }, fields: Record<string, unknown> = {}): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2026-10-01', ...fields });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room, its Assets, and an open Round over that room alone.
  const roundOver = async (count = 1) => {
    const room = await entry('locations', `ห้องตรวจ ${crypto.randomUUID()}`);
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      assetIds.push(await registeredIn(room));
    }
    return { room, assetIds, roundId: await opened({ location_ids: [room.id] }) };
  };

  // A Reassignment of `assetId` to `room` from `effectiveDate`, against its latest assignment version, confirming
  // any Assignment Conflict a backdated one creates.
  const reassigned = async (assetId: string, room: { id: string }, effectiveDate: string) => {
    const res = await api.post(
      custodian,
      `/assets/${assetId}/assignments`,
      {
        kind: 'REASSIGNMENT',
        expected_assignment_version: (await detailOf(assetId)).assignment_version,
        effective_date: effectiveDate,
        location_id: room.id,
        explicit_continuation: true,
      },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  // How many revisions an Asset has in a Round, read where no API reads voided ones yet.
  const revisionCount = async (roundId: string, assetId: string): Promise<number> =>
    (
      await api.pool.query(
        `SELECT count(*)::int AS n FROM verification_revisions v JOIN verification_scope_entries e ON e.id = v.verification_scope_entry_id
         WHERE e.verification_round_id = $1 AND e.asset_id = $2`,
        [roundId, assetId]
      )
    ).rows[0].n;

  // What an observer reads of an Asset, apart from its Verification panel, to show that a result changed none of it.
  const assetFactsOf = async (assetId: string) => {
    const { verification: _verification, ...detail } = await detailOf(assetId);
    return { detail, assignment: await assignmentOf(assetId) };
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_asset_verification', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_asset_verification', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_asset_verification', 'READ_ONLY');
    staff = await api.actor('staff_asset_verification', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    now = new Date('2026-11-12T05:00:00Z');
    await closedStandIn();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('records an Asset of the open Round as Found ปกติ on today, and the Round counts it and lists it with its result', async () => {
      const { room, assetIds, roundId } = await roundOver(2);
      const [found, other] = assetIds;
      const before = Date.now();

      const res = await record(roundId, found, finding(), crypto.randomUUID(), staff);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_revision_id: expect.stringMatching(UUID), revision_number: 1, version: 2 });
      const entry = await entryOf(roundId, found);
      expect(entry.result).toBe('FOUND');
      expect(entry.version).toBe(2);
      expect(entry.current).toEqual({
        id: res.json().verification_revision_id,
        revision_number: 1,
        result: 'FOUND',
        condition: 'NORMAL',
        observed_location: null,
        label_missing_or_damaged: false,
        data_mismatch: false,
        data_mismatch_note: null,
        discrepancies: [],
        note: null,
        verification_date: '2026-11-12',
        assignment_in_effect: {
          location: { id: room.id, name: room.name, is_active: true },
          organization_unit: null,
          responsible_person: null,
          legacy_location_text: null,
          legacy_organization_unit_text: null,
          legacy_responsible_person_text: null,
        },
        loan_context: null,
        repair_context: null,
        recorded_by: staff.id,
        recorded_by_username: 'staff_asset_verification',
        recorded_at: expect.any(String),
      });
      expect(Date.parse(entry.current.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(await entryOf(roundId, other)).toMatchObject({ result: 'NOT_YET_VERIFIED', version: 1, current: null });
      expect((await roundOf(roundId)).counts).toEqual({ in_scope: 2, found: 1, not_found: 0, not_yet_verified: 1, with_discrepancy: 0 });
    });

    it('records Not Found with no Condition, and changes nothing about the Asset (DR-03, AV-14)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const before = await assetFactsOf(assetId);

      expect((await record(roundId, assetId, { result: 'NOT_FOUND' }, crypto.randomUUID(), staff)).statusCode).toBe(201);

      expect(await entryOf(roundId, assetId)).toMatchObject({ result: 'NOT_FOUND', current: { result: 'NOT_FOUND', condition: null } });
      expect(await assetFactsOf(assetId)).toEqual(before);
      expect((await roundOf(roundId)).counts).toEqual({ in_scope: 1, found: 0, not_found: 1, not_yet_verified: 0, with_discrepancy: 0 });
    });

    it('records Found ชำรุด with a note, keeping tabs and line breaks inside it, and changes nothing about the Asset (AV-14)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const before = await assetFactsOf(assetId);

      await recorded(roundId, assetId, { condition: 'DAMAGED', note: '  ขาหัก\nมุม\tซ้าย  ' });

      expect((await entryOf(roundId, assetId)).current).toMatchObject({ result: 'FOUND', condition: 'DAMAGED', note: 'ขาหัก\nมุม\tซ้าย' });
      expect(await assetFactsOf(assetId)).toEqual(before);
    });

    it('asks for no photo or location: a result alone is recorded, and a field the request does not know is refused', async () => {
      const { assetIds: [found, other], roundId } = await roundOver(2);

      expect((await record(roundId, found, { result: 'FOUND', condition: 'NORMAL' })).statusCode).toBe(201);
      const refused = await record(roundId, other, { ...finding(), photo: 'data:image/png;base64,AAAA' });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe('VALIDATION_FAILED');
      expect(await revisionCount(roundId, other)).toBe(0);
    });

    it('opening the Asset page records nothing (AV-04)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      expect((await api.get(staff, `/assets/${assetId}`)).statusCode).toBe(200);
      expect((await api.get(staff, `/assets/${assetId}/verifications`)).statusCode).toBe(200);

      expect(await revisionCount(roundId, assetId)).toBe(0);
      expect((await entryOf(roundId, assetId)).result).toBe('NOT_YET_VERIFIED');
    });
  });

  describe('rules', () => {
    it('needs a Condition when Found and refuses one when Not Found, saving nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      const refusals: [Record<string, unknown>, string][] = [
        [{ result: 'FOUND' }, 'condition must be'],
        [{ result: 'FOUND', condition: null }, 'condition must be'],
        [{ result: 'NOT_FOUND', condition: 'NORMAL' }, 'condition must not be given'],
      ];
      for (const [payload, message] of refusals) {
        const res = await record(roundId, assetId, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(message) });
      }
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('takes a Verification Date from the Round start date to today, and refuses one before or after, both boundaries set by the clock', async () => {
      now = new Date('2026-11-02T05:00:00Z');
      const { assetIds: [first, last, early, late], roundId } = await roundOver(4);
      now = new Date('2026-11-12T05:00:00Z');

      await recorded(roundId, first, { verification_date: '2026-11-02' });
      await recorded(roundId, last, { verification_date: '2026-11-12' });
      const before = await record(roundId, early, finding({ verification_date: '2026-11-01' }));
      const after = await record(roundId, late, finding({ verification_date: '2026-11-13' }));

      expect(before.statusCode).toBe(400);
      expect(before.json().message).toContain('start date');
      expect(after.statusCode).toBe(400);
      expect(after.json().message).toContain('after today');
      expect((await entryOf(roundId, first)).current.verification_date).toBe('2026-11-02');
      expect((await entryOf(roundId, last)).current.verification_date).toBe('2026-11-12');
      expect(await revisionCount(roundId, early)).toBe(0);
      expect(await revisionCount(roundId, late)).toBe(0);
    });

    it('takes today in Asia/Bangkok, from the clock, when no Verification Date is given', async () => {
      const { assetIds: [assetId, next], roundId } = await roundOver(2);
      now = new Date('2026-11-12T17:30:00Z');

      await recorded(roundId, assetId);
      expect((await entryOf(roundId, assetId)).current.verification_date).toBe('2026-11-13');
      expect((await record(roundId, next, finding({ verification_date: '2026-11-13' }))).statusCode).toBe(201);
    });

    it('refuses a Verification Date that is not a calendar date', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      const res = await record(roundId, assetId, finding({ verification_date: '2026-11-31' }));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('verification_date must be a date');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('takes a note at its bound, keeps no blank note, and refuses a note too long or holding a control character', async () => {
      const { assetIds: [bounded, blank, long, controlled], roundId } = await roundOver(4);

      await recorded(roundId, bounded, { note: 'ก'.repeat(2000) });
      await recorded(roundId, blank, { note: '   ' });
      const tooLong = await record(roundId, long, finding({ note: over(2000) }));
      const withControl = await record(roundId, controlled, finding({ note: 'ขา\u0007หัก' }));

      expect((await entryOf(roundId, bounded)).current.note).toHaveLength(2000);
      expect((await entryOf(roundId, blank)).current.note).toBeNull();
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().message).toContain('at most 2000');
      expect(withControl.statusCode).toBe(400);
      expect(withControl.json().message).toContain('control characters');
      expect(await revisionCount(roundId, long)).toBe(0);
      expect(await revisionCount(roundId, controlled)).toBe(0);
    });

    it('keeps the Permanent Assignment in effect on the Verification Date, and keeps it after a later backdated Reassignment (Q26, Q15)', async () => {
      now = new Date('2026-11-02T05:00:00Z');
      const { room, assetIds: [assetId, moved], roundId } = await roundOver(2);
      const [newRoom, laterRoom] = [await entry('locations', `ห้องใหม่ ${crypto.randomUUID()}`), await entry('locations', `ห้องหลัง ${crypto.randomUUID()}`)];
      now = new Date('2026-11-12T05:00:00Z');
      await reassigned(assetId, newRoom, '2026-11-10');
      await reassigned(moved, newRoom, '2026-11-10');

      await recorded(roundId, assetId, { verification_date: '2026-11-05' });
      await recorded(roundId, moved, { verification_date: '2026-11-11' });
      expect((await entryOf(roundId, assetId)).current.assignment_in_effect.location).toEqual({ id: room.id, name: room.name, is_active: true });
      expect((await entryOf(roundId, moved)).current.assignment_in_effect.location).toEqual({ id: newRoom.id, name: newRoom.name, is_active: true });

      await reassigned(assetId, laterRoom, '2026-11-03');
      expect((await entryOf(roundId, assetId)).current.assignment_in_effect.location).toEqual({ id: room.id, name: room.name, is_active: true });
    });
  });

  describe('Loan and Repair context (AV-09, LR-14)', () => {
    it('keeps the LoanItem that holds an On Loan Asset, with its Borrower and Due Date, records Not Found against it, and leaves the Loan unchanged', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม', organization_name: 'บริษัท ก' } });
      const loanBefore = await loanOf(loanId);

      await recorded(roundId, assetId, { result: 'NOT_FOUND', condition: null });

      expect((await entryOf(roundId, assetId)).current.loan_context).toEqual({ kind: 'ON_LOAN', loan_item_id: itemOf[assetId], borrower_display: 'คุณผู้ยืม (บริษัท ก)', due_date: '2026-11-30' });
      expect(await loanOf(loanId)).toEqual(loanBefore);
    });

    it('names an internal Borrower by the name the Person has at recording, and keeps that name after a rename', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const person = await entry('persons', `สมชาย ${crypto.randomUUID()}`);
      await lent([assetId], { borrower: { kind: 'INTERNAL', person_id: person.id } });

      await recorded(roundId, assetId);
      const renamed = await api.post(admin, `/references/persons/${person.id}`, { expected_version: 1, name: `สมชาย ใหม่ ${crypto.randomUUID()}` });

      expect(renamed.statusCode).toBe(200);
      expect((await entryOf(roundId, assetId)).current.loan_context.borrower_display).toBe(person.name);
    });

    it('keeps a Not Returned LoanItem as the context of an Asset that has not come back', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-05');

      await recorded(roundId, assetId);

      expect((await entryOf(roundId, assetId)).current.loan_context).toEqual({ kind: 'NOT_RETURNED', loan_item_id: itemOf[assetId], borrower_display: 'คุณผู้ยืม', due_date: '2026-11-30' });
    });

    it('keeps the Repair Record of an Asset Under Repair, records Found against it, and leaves the Repair Record unchanged', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const repairRecordId = await sent(assetId, { repair_kind: 'MAINTENANCE' });
      const repairBefore = await recordOf(repairRecordId);

      await recorded(roundId, assetId);

      expect((await entryOf(roundId, assetId)).current.repair_context).toEqual({ repair_record_id: repairRecordId, repair_kind: 'MAINTENANCE' });
      expect(await recordOf(repairRecordId)).toEqual(repairBefore);
    });

    it('keeps no context for an Asset whose Loan has come back', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const { loanId, itemOf } = await lent([assetId]);
      const res = await api.post(
        custodian,
        `/loans/${loanId}/returns`,
        { expected_version: (await loanOf(loanId)).version, return_date: '2026-11-05', items: [{ loan_item_id: itemOf[assetId], condition: 'NORMAL' }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(res.statusCode).toBe(201);

      await recorded(roundId, assetId);

      expect((await entryOf(roundId, assetId)).current).toMatchObject({ loan_context: null, repair_context: null });
    });
  });

  describe('refusals', () => {
    it('refuses a first result for an Asset that already has one, naming the latest result with its Verification Date, Recorded At and actor (AV-23)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      await recorded(roundId, assetId, { verification_date: '2026-11-12' }, staff);
      const before = await entryOf(roundId, assetId);

      const res = await record(roundId, assetId, { result: 'NOT_FOUND' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'ASSET_ALREADY_VERIFIED',
        current: { id: before.current.id, result: 'FOUND', verification_date: '2026-11-12', recorded_at: before.current.recorded_at, recorded_by: staff.id, recorded_by_username: 'staff_asset_verification' },
      });
      expect(await entryOf(roundId, assetId)).toEqual(before);
      expect(await revisionCount(roundId, assetId)).toBe(1);
    });

    it('refuses a result for an Asset outside the Scope Snapshot, and saves nothing', async () => {
      const { roundId } = await roundOver();
      const outside = await registeredIn(await entry('locations', `ห้องนอกรอบ ${crypto.randomUUID()}`));

      const revisionsOf = async (): Promise<number> => (await api.pool.query('SELECT count(*)::int AS n FROM verification_revisions')).rows[0].n;
      const before = await revisionsOf();
      const token = crypto.randomUUID();

      const res = await record(roundId, outside, finding(), token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ASSET_NOT_IN_VERIFICATION_SCOPE');
      expect(await revisionsOf()).toBe(before);
      expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
    });

    it('refuses a result for a Round that is not open, and saves nothing (AV-17)', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      await closedStandIn();

      const res = await record(roundId, assetId, finding());

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('VERIFICATION_ROUND_NOT_OPEN');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('answers a Round or an Asset that does not exist with 404, and a malformed id with 400', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      expect((await record(crypto.randomUUID(), assetId, finding())).statusCode).toBe(404);
      expect((await record(roundId, crypto.randomUUID(), finding())).statusCode).toBe(404);
      expect((await record('not-a-uuid', assetId, finding())).statusCode).toBe(400);
      expect((await record(roundId, 'not-a-uuid', finding())).statusCode).toBe(400);
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('ends concurrent first results for one Asset, on independent connections, with exactly one revision; the others name it', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const entryId = (await entryOf(roundId, assetId)).id;

      const results = await whileHolding(
        'verification_scope_entries',
        entryId,
        () => [record(roundId, assetId, finding(), crypto.randomUUID(), staff), record(roundId, assetId, { result: 'NOT_FOUND' }, crypto.randomUUID(), custodian)],
        () => untilWaiting('verification_scope_entries', 2)
      );

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      const winner = results.find((res) => res.statusCode === 201)!.json();
      expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({ code: 'ASSET_ALREADY_VERIFIED', current: { id: winner.verification_revision_id } });
      expect(await revisionCount(roundId, assetId)).toBe(1);
      expect((await entryOf(roundId, assetId)).version).toBe(2);
    });

    it('ends many concurrent first results for one Asset with exactly one revision', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      const results = await Promise.all(Array.from({ length: 8 }, () => record(roundId, assetId, finding(), crypto.randomUUID(), staff)));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(7).fill(409)]);
      expect(await revisionCount(roundId, assetId)).toBe(1);
    });
  });

  describe('reading', () => {
    it('filters the Round by current result, and refuses a result it does not know', async () => {
      const { assetIds: [found, notFound, pending], roundId } = await roundOver(3);
      await recorded(roundId, found);
      await recorded(roundId, notFound, { result: 'NOT_FOUND', condition: null });

      const idsOf = async (result: string) => (await entriesOf(roundId, `result=${result}`)).items.map((item: any) => item.asset_id);
      expect(await idsOf('FOUND')).toEqual([found]);
      expect(await idsOf('NOT_FOUND')).toEqual([notFound]);
      expect(await idsOf('NOT_YET_VERIFIED')).toEqual([pending]);
      expect((await entriesOf(roundId, 'result=FOUND')).total_count).toBe(1);
      expect((await api.get(readonly, `/verification-rounds/${roundId}/entries?result=LOST`)).statusCode).toBe(400);
    });

    it('counts each Round apart in the Round list', async () => {
      const { assetIds: [assetId], roundId } = await roundOver(2);
      await recorded(roundId, assetId, { result: 'NOT_FOUND', condition: null });

      const listed = (await api.get(readonly, '/verification-rounds')).json().items.find((round: any) => round.id === roundId);

      expect(listed.counts).toEqual({ in_scope: 2, found: 0, not_found: 1, not_yet_verified: 1, with_discrepancy: 0 });
    });

    it("shows the open Round's panel on the Asset page: the Asset's entry and its current result, or that it is not in the Round", async () => {
      const { assetIds: [assetId, other], roundId } = await roundOver(2);
      const outside = await registeredIn(await entry('locations', `ห้องนอกรอบ ${crypto.randomUUID()}`));
      const round = await roundOf(roundId);
      const openRound = { id: roundId, name: round.name, fiscal_year: round.fiscal_year, start_date: round.start_date };
      const entryId = (await entryOf(roundId, assetId)).id;

      const noContext = { loan_context: null, repair_context: null };

      expect((await detailOf(assetId)).verification).toEqual({ open_round: openRound, entry: { id: entryId, version: 1, result: 'NOT_YET_VERIFIED', current: null }, context: noContext });
      await recorded(roundId, assetId, {}, staff);
      expect((await detailOf(assetId)).verification).toEqual({
        open_round: openRound,
        entry: { id: entryId, version: 2, result: 'FOUND', current: (await entryOf(roundId, assetId)).current },
        context: noContext,
      });
      expect((await detailOf(other)).verification.entry.result).toBe('NOT_YET_VERIFIED');
      expect((await detailOf(outside)).verification).toEqual({ open_round: openRound, entry: null, context: noContext });

      await closedStandIn();
      expect((await detailOf(assetId)).verification).toBeNull();
    });

    it('shows on the panel the Loan and Repair context a result recorded now would keep, the Borrower and Due Date of a Not Returned item too', async () => {
      const { assetIds: [notReturned, repaired], roundId } = await roundOver(2);
      const { loanId, itemOf } = await lent([notReturned], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม', organization_name: 'บริษัท ก' } });
      await closedNotReturned(loanId, [itemOf[notReturned]], '2026-11-05');
      const repairRecordId = await sent(repaired);

      expect((await detailOf(notReturned)).verification.context).toEqual({
        loan_context: { kind: 'NOT_RETURNED', loan_item_id: itemOf[notReturned], borrower_display: 'คุณผู้ยืม (บริษัท ก)', due_date: '2026-11-30' },
        repair_context: null,
      });
      expect((await detailOf(repaired)).verification.context).toEqual({ loan_context: null, repair_context: { repair_record_id: repairRecordId, repair_kind: 'REPAIR' } });

      await recorded(roundId, notReturned, { result: 'NOT_FOUND', condition: null });
      expect((await entryOf(roundId, notReturned)).current.loan_context).toEqual((await detailOf(notReturned)).verification.context.loan_context);
    });

    it("lists the Asset's current result in every Round it belongs to, newest start date first", async () => {
      now = new Date('2026-11-02T05:00:00Z');
      const { room, assetIds: [assetId], roundId: earlier } = await roundOver();
      await recorded(earlier, assetId, { result: 'NOT_FOUND', condition: null });
      await closedStandIn();
      now = new Date('2026-11-12T05:00:00Z');
      const later = await opened({ name: 'รอบหลัง', location_ids: [room.id] });

      const res = await api.get(readonly, `/assets/${assetId}/verifications`);

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([
        { round: { id: later, name: 'รอบหลัง', fiscal_year: 2569, start_date: '2026-11-12', state: 'OPEN' }, entry_id: expect.stringMatching(UUID), joined_as: 'OPENING', result: 'NOT_YET_VERIFIED', current: null },
        {
          round: { id: earlier, name: 'ตรวจสอบพัสดุประจำปี', fiscal_year: 2569, start_date: '2026-11-02', state: 'CLOSED' },
          entry_id: expect.stringMatching(UUID),
          joined_as: 'OPENING',
          result: 'NOT_FOUND',
          current: expect.objectContaining({ result: 'NOT_FOUND', verification_date: '2026-11-02' }),
        },
      ]);
      expect((await api.get(readonly, `/assets/${await registeredIn(room)}/verifications`)).json().items).toEqual([]);
      expect((await api.get(readonly, `/assets/${crypto.randomUUID()}/verifications`)).statusCode).toBe(404);
      expect((await api.get(readonly, '/assets/not-a-uuid/verifications')).statusCode).toBe(400);
    });

    it('lets every role with asset:view read results, and no one else', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      await recorded(roundId, assetId, { note: 'ผลที่ทุกคนเห็น' });
      const maintainer = await api.actor('maintainer_asset_verification', 'SYSTEM_MAINTAINER');

      for (const reader of [custodian, admin, readonly, staff]) {
        expect((await entryOf(roundId, assetId, reader)).current.note).toBe('ผลที่ทุกคนเห็น');
        expect((await api.get(reader, `/assets/${assetId}`)).json().verification.entry.current.note).toBe('ผลที่ทุกคนเห็น');
        expect((await api.get(reader, `/assets/${assetId}/verifications`)).json().items[0].current.note).toBe('ผลที่ทุกคนเห็น');
      }
      for (const url of [`/assets/${assetId}`, `/assets/${assetId}/verifications`, `/verification-rounds/${roundId}/entries`]) {
        const res = await api.get(maintainer, url);
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain('ผลที่ทุกคนเห็น');
      }
    });

    it("needs asset:view itself to read an Asset's results: denying it alone, or failing to look it up, shows nothing", async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      await recorded(roundId, assetId, { note: 'ผลที่ไม่ควรเห็น' });

      const url = `/assets/${assetId}/verifications`;
      const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, url));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('ผลที่ไม่ควรเห็น');
      const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, url));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('ผลที่ไม่ควรเห็น');
    });
  });

  describe('authorization', () => {
    it('refuses a result by every role without verification:record, and saves nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const maintainer = await api.actor('maintainer_asset_verification_writer', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, admin, maintainer]) {
        const res = await record(roundId, assetId, finding(), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('needs verification:record itself, and fails closed when the lookup fails, saving nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      expect((await withCapabilityAnswer(api.app, 'verification:record', async () => false, () => record(roundId, assetId, finding(), crypto.randomUUID(), staff))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'verification:record', async () => { throw new Error('lookup failed'); }, () => record(roundId, assetId, finding(), crypto.randomUUID(), staff));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('needs a session and the CSRF token, and an inactive user is refused, saving nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/verification-rounds/${roundId}/assets/${assetId}/verifications`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: finding(),
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: staff.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('staff_inactive_asset_verification', 'VERIFICATION_STAFF');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await record(roundId, assetId, finding(), crypto.randomUUID(), leaving)).statusCode);

      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('grants nothing through the QR link: a Read-only User who opens the Asset page still cannot record', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      expect((await api.get(readonly, `/assets/${assetId}`)).statusCode).toBe(200);
      expect((await record(roundId, assetId, finding(), crypto.randomUUID(), readonly)).statusCode).toBe(403);
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('tells the Asset page whether the viewer may record a result, which follows verification:record alone', async () => {
      const { assetIds: [assetId] } = await roundOver();

      for (const actor of [staff, custodian]) {
        expect((await api.get(actor, `/assets/${assetId}`)).json().can_record_verification).toBe(true);
      }
      for (const actor of [readonly, admin]) {
        expect((await api.get(actor, `/assets/${assetId}`)).json().can_record_verification).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'verification:record', async () => false, () => api.get(staff, `/assets/${assetId}`));
      expect(denied.json().can_record_verification).toBe(false);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      const res = await api.post(staff, `/verification-rounds/${roundId}/assets/${assetId}/verifications`, finding());

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const token = crypto.randomUUID();
      const first = await record(roundId, assetId, finding(), token, staff);
      expect(first.statusCode).toBe(201);

      const replay = await record(roundId, assetId, finding(), token, staff);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await revisionCount(roundId, assetId)).toBe(1);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const { assetIds: [assetId, other], roundId } = await roundOver(2);
      const token = crypto.randomUUID();
      expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(201);

      for (const [target, changed] of [
        [assetId, finding({ condition: 'DAMAGED' })],
        [other, finding()],
      ] as const) {
        const res = await record(roundId, target, changed, token, staff);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await revisionCount(roundId, assetId)).toBe(1);
      expect(await revisionCount(roundId, other)).toBe(0);
    });

    it('scopes a token to its actor', async () => {
      const { assetIds: [assetId, other], roundId } = await roundOver(2);
      const token = crypto.randomUUID();

      expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(201);
      expect((await record(roundId, other, finding(), token, custodian)).statusCode).toBe(201);
      expect(await revisionCount(roundId, other)).toBe(1);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => record(roundId, assetId, finding(), token, staff)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().verification_revision_id)).size).toBe(1);
      expect(await revisionCount(roundId, assetId)).toBe(1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const token = crypto.randomUUID();
      await api.pool.query(`UPDATE verification_rounds SET state = 'CLOSED' WHERE id = $1`, [roundId]);

      expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(409);
      await api.pool.query(`UPDATE verification_rounds SET state = 'OPEN' WHERE id = $1`, [roundId]);

      expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the revision, the new version nor the receipt, and answers in the deterministic shape', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const token = 'asset-verification-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_verification_revision() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected verification failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_verification_revision BEFORE UPDATE ON verification_scope_entries
          FOR EACH ROW EXECUTE FUNCTION fail_verification_revision();
      `);
      try {
        const res = await record(roundId, assetId, finding(), token, staff);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected verification failure');
        expect(await revisionCount(roundId, assetId)).toBe(0);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_verification_revision ON verification_scope_entries; DROP FUNCTION fail_verification_revision();');
      }
      expect((await entryOf(roundId, assetId)).version).toBe(1);
      expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(201);
    });

    it('commits the revision and its receipt together, or neither', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const token = 'asset-verification-receipt-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_asset_verification_receipt() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'asset-verification-receipt-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_asset_verification_receipt BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_asset_verification_receipt();
      `);
      try {
        expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(500);
        expect(await revisionCount(roundId, assetId)).toBe(0);
        expect((await entryOf(roundId, assetId)).version).toBe(1);
      } finally {
        await api.pool.query('DROP TRIGGER fail_asset_verification_receipt ON registration_retry_tokens; DROP FUNCTION fail_asset_verification_receipt();');
      }
      expect((await record(roundId, assetId, finding(), token, staff)).statusCode).toBe(201);
    });
  });
});
