import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

// F006-T3 (#128): a result records where a Found Asset was seen and what differs from the register, and the
// Round sums up and filters its Discrepancies.
describe('Observed Location and Discrepancies (Seam A - F006-T3)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-12T05:00:00Z');

  const { entry } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { opened, roundOf, roundsOf, entriesOf, record, recorded, entryOf, closedStandIn } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  const room = (name: string) => entry('locations', `${name} ${crypto.randomUUID()}`);

  // A registered Asset in `place`, placed there on 1 October 2026.
  const registeredIn = async (place: { id: string }, fields: Record<string, unknown> = {}): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: place.id, effective_date: '2026-10-01', ...fields });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room, its Assets, and an open Round over that room alone.
  const roundOver = async (count = 1) => {
    const place = await room('ห้องตรวจ');
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      assetIds.push(await registeredIn(place));
    }
    return { place, assetIds, roundId: await opened({ location_ids: [place.id] }) };
  };

  const listed = (place: { id: string; name: string }) => ({ id: place.id, name: place.name, is_active: true });

  // A Reassignment of `assetId` to `place` from `effectiveDate`, against its latest assignment version, confirming
  // any Assignment Conflict a backdated one creates.
  const reassigned = async (assetId: string, place: { id: string }, effectiveDate: string) => {
    const res = await api.post(
      custodian,
      `/assets/${assetId}/assignments`,
      {
        kind: 'REASSIGNMENT',
        expected_assignment_version: (await api.get(readonly, `/assets/${assetId}`)).json().assignment_version,
        effective_date: effectiveDate,
        location_id: place.id,
        explicit_continuation: true,
      },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_verification_discrepancy', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_verification_discrepancy', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_verification_discrepancy', 'READ_ONLY');
    staff = await api.actor('staff_verification_discrepancy', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    now = new Date('2026-11-12T05:00:00Z');
    await closedStandIn();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('records Found at an Observed Location other than the register\'s, and the result shows "Location ไม่ตรงทะเบียน"', async () => {
      const { place, assetIds: [assetId], roundId } = await roundOver();
      const elsewhere = await room('ห้องที่พบ');

      const res = await record(roundId, assetId, { result: 'FOUND', condition: 'NORMAL', observed_location_id: elsewhere.id }, crypto.randomUUID(), staff);

      expect(res.statusCode).toBe(201);
      expect((await entryOf(roundId, assetId)).current).toMatchObject({
        observed_location: listed(elsewhere),
        assignment_in_effect: { location: listed(place) },
        label_missing_or_damaged: false,
        data_mismatch: false,
        data_mismatch_note: null,
        discrepancies: ['LOCATION_MISMATCH'],
      });
    });

    it('takes a left-out Observed Location, or the register\'s own, as matching', async () => {
      const { place, assetIds: [leftOut, same], roundId } = await roundOver(2);

      await recorded(roundId, leftOut, {}, staff);
      await recorded(roundId, same, { observed_location_id: place.id }, staff);

      expect((await entryOf(roundId, leftOut)).current).toMatchObject({ observed_location: null, discrepancies: [] });
      expect((await entryOf(roundId, same)).current).toMatchObject({ observed_location: listed(place), discrepancies: [] });
    });

    it('ticks "ป้าย/QR หายหรือชำรุด" and "ข้อมูลไม่ตรงทะเบียน" with its note, alone or together, and derives "ชำรุด" from the Condition', async () => {
      const { assetIds: [label, data, damaged, all], roundId } = await roundOver(4);
      const seen = await room('ห้องที่พบ');

      await recorded(roundId, label, { label_missing_or_damaged: true }, staff);
      await recorded(roundId, data, { data_mismatch: true, data_mismatch_note: '  Serial Number\nบนตัวเครื่องไม่ตรง  ' }, staff);
      await recorded(roundId, damaged, { condition: 'DAMAGED' }, staff);
      await recorded(
        roundId,
        all,
        { condition: 'DAMAGED', observed_location_id: seen.id, label_missing_or_damaged: true, data_mismatch: true, data_mismatch_note: 'ยี่ห้อไม่ตรง' },
        staff
      );

      expect((await entryOf(roundId, label)).current).toMatchObject({ label_missing_or_damaged: true, data_mismatch: false, discrepancies: ['LABEL_MISSING_OR_DAMAGED'] });
      expect((await entryOf(roundId, data)).current).toMatchObject({
        label_missing_or_damaged: false,
        data_mismatch: true,
        data_mismatch_note: 'Serial Number\nบนตัวเครื่องไม่ตรง',
        discrepancies: ['DATA_MISMATCH'],
      });
      expect((await entryOf(roundId, damaged)).current.discrepancies).toEqual(['DAMAGED']);
      expect((await entryOf(roundId, all)).current).toMatchObject({
        observed_location: listed(seen),
        data_mismatch_note: 'ยี่ห้อไม่ตรง',
        discrepancies: ['LOCATION_MISMATCH', 'DAMAGED', 'LABEL_MISSING_OR_DAMAGED', 'DATA_MISMATCH'],
      });
    });

    it('records Not Found with no Discrepancy, and takes unticked flags with it', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();

      await recorded(roundId, assetId, { result: 'NOT_FOUND', condition: null, observed_location_id: null, label_missing_or_damaged: false, data_mismatch: false, data_mismatch_note: null });

      expect((await entryOf(roundId, assetId)).current).toMatchObject({ result: 'NOT_FOUND', observed_location: null, label_missing_or_damaged: false, data_mismatch: false, discrepancies: [] });
    });
  });

  describe('rules', () => {
    // How many revisions an Asset has in a Round, read where no API reads voided ones yet.
    const revisionCount = async (roundId: string, assetId: string): Promise<number> =>
      (
        await api.pool.query(
          `SELECT count(*)::int AS n FROM verification_revisions v JOIN verification_scope_entries e ON e.id = v.verification_scope_entry_id
           WHERE e.verification_round_id = $1 AND e.asset_id = $2`,
          [roundId, assetId]
        )
      ).rows[0].n;

    const refusedWith = async (roundId: string, assetId: string, payload: Record<string, unknown>, message: string) => {
      const res = await record(roundId, assetId, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(message) });
    };

    it('refuses an Observed Location, or a ticked flag, when Not Found, saving nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const seen = await room('ห้องที่พบ');
      const notFound = { result: 'NOT_FOUND' };

      await refusedWith(roundId, assetId, { ...notFound, observed_location_id: seen.id }, 'observed_location_id must not be given when the Asset is Not Found');
      await refusedWith(roundId, assetId, { ...notFound, label_missing_or_damaged: true }, 'label_missing_or_damaged must not be given when the Asset is Not Found');
      await refusedWith(roundId, assetId, { ...notFound, data_mismatch: true, data_mismatch_note: 'ไม่ตรง' }, 'data_mismatch must not be given when the Asset is Not Found');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('needs a nonblank note for "ข้อมูลไม่ตรงทะเบียน", and refuses the note without the flag, saving nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const found = { result: 'FOUND', condition: 'NORMAL' };

      await refusedWith(roundId, assetId, { ...found, data_mismatch: true }, 'data_mismatch_note is required');
      await refusedWith(roundId, assetId, { ...found, data_mismatch: true, data_mismatch_note: ' \n ' }, 'data_mismatch_note is required');
      await refusedWith(roundId, assetId, { ...found, data_mismatch_note: 'ไม่ได้ติ๊ก' }, 'data_mismatch_note must not be given unless data_mismatch');
      await refusedWith(roundId, assetId, { ...found, data_mismatch: false, data_mismatch_note: 'ไม่ได้ติ๊ก' }, 'data_mismatch_note must not be given unless data_mismatch');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('bounds the data-mismatch note as a result note, refusing one too long or holding a control character', async () => {
      const { assetIds: [bounded, long, controlled], roundId } = await roundOver(3);
      const mismatch = (note: string) => ({ result: 'FOUND', condition: 'NORMAL', data_mismatch: true, data_mismatch_note: note });

      await recorded(roundId, bounded, mismatch('ก'.repeat(2000)));
      await refusedWith(roundId, long, mismatch('ก'.repeat(2001)), 'at most 2000');
      await refusedWith(roundId, controlled, mismatch('ไม่\u0007ตรง'), 'control characters');

      expect((await entryOf(roundId, bounded)).current.data_mismatch_note).toHaveLength(2000);
      expect(await revisionCount(roundId, long)).toBe(0);
      expect(await revisionCount(roundId, controlled)).toBe(0);
    });

    it('needs the Observed Location to be an active entry of the Location Reference List, saving nothing otherwise', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const unit = await entry('organization-units', `กอง ${crypto.randomUUID()}`);
      const closed = await room('ห้องปิดแล้ว');
      const deactivated = await api.post(admin, `/references/locations/${closed.id}`, { expected_version: 1, is_active: false });
      expect(deactivated.statusCode).toBe(200);
      const found = { result: 'FOUND', condition: 'NORMAL' };

      await refusedWith(roundId, assetId, { ...found, observed_location_id: crypto.randomUUID() }, 'observed_location_id must name an active entry');
      await refusedWith(roundId, assetId, { ...found, observed_location_id: unit.id }, 'observed_location_id must name an active entry');
      await refusedWith(roundId, assetId, { ...found, observed_location_id: closed.id }, 'observed_location_id must name an active entry');
      await refusedWith(roundId, assetId, { ...found, observed_location_id: 'ห้อง 101' }, 'observed_location_id must be a valid UUID');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('takes each flag as a boolean and the Observed Location as a string, refusing any other type', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const found = { result: 'FOUND', condition: 'NORMAL' };

      await refusedWith(roundId, assetId, { ...found, label_missing_or_damaged: 'yes' }, 'Invalid request payload: label_missing_or_damaged:');
      await refusedWith(roundId, assetId, { ...found, data_mismatch: 1, data_mismatch_note: 'ไม่ตรง' }, 'Invalid request payload: data_mismatch:');
      await refusedWith(roundId, assetId, { ...found, observed_location_id: 42 }, 'Invalid request payload: observed_location_id:');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('reads the Observed Location under its row lock: a Location closed by a write the result waits on is refused', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const closing = await room('ห้องที่กำลังปิด');
      // How many writes wait on a lock of a Location row, as the active-entry check takes it.
      const waitersOnLocation = async (): Promise<number> =>
        (await api.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM locations WHERE id%FOR SHARE%'`)).rows[0].n;

      // The holder stands in for a deactivation in flight: it has closed the Location and not yet committed.
      const holder = await api.pool.connect();
      let pending: Promise<any> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('UPDATE locations SET is_active = false, version = version + 1 WHERE id = $1', [closing.id]);
        pending = record(roundId, assetId, { result: 'FOUND', condition: 'NORMAL', observed_location_id: closing.id }, crypto.randomUUID(), staff);
        await expect.poll(waitersOnLocation, { timeout: 10_000, interval: 50 }).toBe(1);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
      const res = await pending!;

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('observed_location_id must name an active entry');
      expect(await revisionCount(roundId, assetId)).toBe(0);
    });

    it('takes an Observed Location id in any case and with surrounding spaces', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const seen = await room('ห้องที่พบ');

      await recorded(roundId, assetId, { observed_location_id: ` ${seen.id.toUpperCase()} ` });

      expect((await entryOf(roundId, assetId)).current.observed_location).toEqual(listed(seen));
    });
  });

  describe('reading (AV-19, P5)', () => {
    // The Assets a page of the Round's entries lists for `query`, sorted.
    const idsOf = async (roundId: string, query: string) => (await entriesOf(roundId, `limit=100&${query}`)).items.map((item: any) => item.asset_id).sort();

    // A Round over two rooms: one Asset with each Discrepancy, one with two, one Found with none, one Not Found
    // and one Not Yet Verified.
    const mixedRound = async () => {
      const [first, second, seen] = [await room('ห้องหนึ่ง'), await room('ห้องสอง'), await room('ห้องที่พบ')];
      const ids = {
        moved: await registeredIn(first),
        damaged: await registeredIn(first),
        label: await registeredIn(first),
        data: await registeredIn(second),
        both: await registeredIn(second),
        clean: await registeredIn(second),
        notFound: await registeredIn(second),
        pending: await registeredIn(first),
      };
      const roundId = await opened({ location_ids: [first.id, second.id] });
      await recorded(roundId, ids.moved, { observed_location_id: seen.id });
      await recorded(roundId, ids.damaged, { condition: 'DAMAGED' });
      await recorded(roundId, ids.label, { label_missing_or_damaged: true });
      await recorded(roundId, ids.data, { data_mismatch: true, data_mismatch_note: 'ไม่ตรง' });
      await recorded(roundId, ids.both, { condition: 'DAMAGED', observed_location_id: seen.id });
      await recorded(roundId, ids.clean, { observed_location_id: second.id });
      await recorded(roundId, ids.notFound, { result: 'NOT_FOUND', condition: null });
      return { roundId, ids, first, second, seen };
    };

    it('counts the current results that note a Discrepancy, in the Round and in the Round list', async () => {
      const { roundId } = await mixedRound();

      const counts = { in_scope: 8, found: 6, not_found: 1, not_yet_verified: 1, with_discrepancy: 5 };
      expect((await roundOf(roundId)).counts).toEqual(counts);
      expect((await roundsOf()).items.find((round: any) => round.id === roundId).counts).toEqual(counts);
    });

    it('filters the Round by each Discrepancy, alone or with a result and a search', async () => {
      const { roundId, ids } = await mixedRound();

      expect(await idsOf(roundId, 'discrepancy=LOCATION_MISMATCH')).toEqual([ids.moved, ids.both].sort());
      expect(await idsOf(roundId, 'discrepancy=DAMAGED')).toEqual([ids.damaged, ids.both].sort());
      expect(await idsOf(roundId, 'discrepancy=LABEL_MISSING_OR_DAMAGED')).toEqual([ids.label]);
      expect(await idsOf(roundId, 'discrepancy=DATA_MISMATCH')).toEqual([ids.data]);
      expect(await idsOf(roundId, 'discrepancy=DAMAGED&result=NOT_FOUND')).toEqual([]);
      expect((await entriesOf(roundId, 'discrepancy=DAMAGED')).total_count).toBe(2);
      const bothName = (await entryOf(roundId, ids.both)).snapshot.name;
      expect(await idsOf(roundId, `discrepancy=LOCATION_MISMATCH&search=${encodeURIComponent(bothName)}`)).toEqual([ids.both]);
      expect((await api.get(readonly, `/verification-rounds/${roundId}/entries?discrepancy=LOST`)).statusCode).toBe(400);
    });

    it('filters the Round by the Location its Scope Snapshot holds, which a later move does not change (P5)', async () => {
      const { roundId, ids, first, second, seen } = await mixedRound();
      await reassigned(ids.pending, second, '2026-11-12');

      expect(await idsOf(roundId, `location_id=${first.id}`)).toEqual([ids.moved, ids.damaged, ids.label, ids.pending].sort());
      expect(await idsOf(roundId, `location_id=${second.id}&result=FOUND`)).toEqual([ids.data, ids.both, ids.clean].sort());
      expect(await idsOf(roundId, `location_id=${first.id}&discrepancy=DAMAGED`)).toEqual([ids.damaged]);
      // An Observed Location is not the snapshot's: no Asset of the Round was in this room when it opened.
      expect(await idsOf(roundId, `location_id=${seen.id}`)).toEqual([]);
      expect((await api.get(readonly, `/verification-rounds/${roundId}/entries?location_id=not-a-uuid`)).statusCode).toBe(400);
    });

    it('names the Locations its Scope Snapshot holds, each by its current name, to filter by', async () => {
      const { roundId, first, second } = await mixedRound();
      const renamed = await api.post(admin, `/references/locations/${first.id}`, { expected_version: 1, name: `${first.name} ใหม่` });
      expect(renamed.statusCode).toBe(200);

      expect((await roundOf(roundId)).snapshot_locations).toEqual(
        [
          { id: first.id, name: `${first.name} ใหม่`, is_active: true },
          { id: second.id, name: second.name, is_active: true },
        ].sort((a, b) => a.name.localeCompare(b.name))
      );
    });

    it('shows the Observed Location and the Discrepancies on the Asset page panel and in its "ผลตรวจประจำปี" section', async () => {
      const { roundId, ids, seen } = await mixedRound();

      const fromRound = (await entryOf(roundId, ids.both)).current;
      expect(fromRound).toMatchObject({ observed_location: listed(seen), discrepancies: ['LOCATION_MISMATCH', 'DAMAGED'] });
      expect((await api.get(staff, `/assets/${ids.both}`)).json().verification.entry.current).toEqual(fromRound);
      expect((await api.get(readonly, `/assets/${ids.both}/verifications`)).json().items[0].current).toEqual(fromRound);
    });
  });

  describe('retry and refusal (T2 holds for the new fields)', () => {
    it('refuses the same token with a changed Observed Location or flag, and answers an identical replay with the committed result', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const [seen, other] = [await room('ห้องที่พบ'), await room('ห้องอื่น')];
      const token = crypto.randomUUID();
      const payload = { result: 'FOUND', condition: 'NORMAL', observed_location_id: seen.id };
      const first = await record(roundId, assetId, payload, token, staff);
      expect(first.statusCode).toBe(201);

      const replay = await record(roundId, assetId, payload, token, staff);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      for (const changed of [{ observed_location_id: other.id }, { label_missing_or_damaged: true }, { data_mismatch: true, data_mismatch_note: 'ไม่ตรง' }]) {
        const res = await record(roundId, assetId, { ...payload, ...changed }, token, staff);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
    });

    it('names the latest result with its Discrepancies when a first result meets one', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const seen = await room('ห้องที่พบ');
      await recorded(roundId, assetId, { observed_location_id: seen.id, label_missing_or_damaged: true }, staff);

      const res = await record(roundId, assetId, { result: 'NOT_FOUND' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ASSET_ALREADY_VERIFIED', current: { observed_location: listed(seen), discrepancies: ['LOCATION_MISMATCH', 'LABEL_MISSING_OR_DAMAGED'] } });
    });

    it('refuses the new fields from every role without verification:record, saving nothing', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const seen = await room('ห้องที่พบ');

      for (const actor of [readonly, admin]) {
        const res = await record(roundId, assetId, { result: 'FOUND', condition: 'DAMAGED', observed_location_id: seen.id, label_missing_or_damaged: true }, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
      }
      expect((await entryOf(roundId, assetId)).result).toBe('NOT_YET_VERIFIED');
    });
  });

  describe('"Location ไม่ตรงทะเบียน" (AV-07, Q26, Q15)', () => {
    it('counts an empty or Legacy-text Location in effect as different from an Observed Location, and as matching one left out', async () => {
      const unit = await entry('organization-units', `กองตรวจ ${crypto.randomUUID()}`);
      const register = async (fields: Record<string, unknown>) => {
        const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, organization_unit_id: unit.id, effective_date: '2026-10-01', ...fields });
        expect(res.statusCode).toBe(201);
        return res.json().asset.id;
      };
      const [legacy, empty, legacyLeftOut] = [await register({ legacy_location_text: 'ห้องเก่า' }), await register({}), await register({ legacy_location_text: 'ห้องเก่า' })];
      const roundId = await opened({ organization_unit_ids: [unit.id] });
      const seen = await room('ห้องที่พบ');

      await recorded(roundId, legacy, { observed_location_id: seen.id });
      await recorded(roundId, empty, { observed_location_id: seen.id });
      await recorded(roundId, legacyLeftOut);

      expect((await entryOf(roundId, legacy)).current).toMatchObject({ assignment_in_effect: { location: null, legacy_location_text: 'ห้องเก่า' }, discrepancies: ['LOCATION_MISMATCH'] });
      expect((await entryOf(roundId, empty)).current).toMatchObject({ assignment_in_effect: { location: null, legacy_location_text: null }, discrepancies: ['LOCATION_MISMATCH'] });
      expect((await entryOf(roundId, legacyLeftOut)).current.discrepancies).toEqual([]);
    });

    it('compares with the Location in effect on the Verification Date: a paper count of day 1, recorded on day 5 after a move on day 3, matches the old room', async () => {
      now = new Date('2026-11-01T05:00:00Z');
      const { place: oldRoom, assetIds: [paper, movedEarly], roundId } = await roundOver(2);
      const newRoom = await room('ห้องใหม่');
      now = new Date('2026-11-03T05:00:00Z');
      await reassigned(paper, newRoom, '2026-11-03');
      await reassigned(movedEarly, newRoom, '2026-11-03');
      now = new Date('2026-11-05T05:00:00Z');

      await recorded(roundId, paper, { verification_date: '2026-11-01', observed_location_id: oldRoom.id });
      await recorded(roundId, movedEarly, { verification_date: '2026-11-01', observed_location_id: newRoom.id });

      expect((await entryOf(roundId, paper)).current).toMatchObject({ assignment_in_effect: { location: listed(oldRoom) }, discrepancies: [] });
      expect((await entryOf(roundId, movedEarly)).current).toMatchObject({ assignment_in_effect: { location: listed(oldRoom) }, discrepancies: ['LOCATION_MISMATCH'] });
    });

    it('keeps the stored values and the Discrepancies of a result after a backdated Reassignment or an Assignment Correction changes the Location in effect on its Verification Date', async () => {
      const { place, assetIds: [backdated, corrected], roundId } = await roundOver(2);
      const [other, seen] = [await room('ห้องอื่น'), await room('ห้องที่พบ')];
      await recorded(roundId, backdated, { verification_date: '2026-11-12' });
      await recorded(roundId, corrected, { verification_date: '2026-11-12', observed_location_id: seen.id });
      const before = { backdated: (await entryOf(roundId, backdated)).current, corrected: (await entryOf(roundId, corrected)).current };

      await reassigned(backdated, other, '2026-11-05');
      const [initial] = (await api.get(readonly, `/assets/${corrected}/assignments`)).json().items;
      const amended = await api.post(
        custodian,
        `/assets/${corrected}/assignments/${initial.id}/corrections`,
        { action: 'AMEND', expected_assignment_version: 1, reason: 'ลงห้องผิด', changes: { location: { new: { entry_id: seen.id, legacy_text: null } } } },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(amended.statusCode).toBe(201);
      expect((await api.get(readonly, `/assets/${corrected}`)).json().current_assignment.location.id).toBe(seen.id);

      expect((await entryOf(roundId, backdated)).current).toEqual(before.backdated);
      expect(before.backdated).toMatchObject({ assignment_in_effect: { location: listed(place) }, discrepancies: [] });
      expect((await entryOf(roundId, corrected)).current).toEqual(before.corrected);
      expect(before.corrected).toMatchObject({ assignment_in_effect: { location: listed(place) }, discrepancies: ['LOCATION_MISMATCH'] });
    });
  });
});
