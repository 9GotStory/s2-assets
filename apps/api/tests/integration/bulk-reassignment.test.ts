import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { NO_VALUE, assignmentHelpers, at, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';

const TODAY = '2026-11-05';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F003-T5 (#55): one action that records the same Reassignment for up to 100 Assets.
describe('Bulk Reassignment (Seam A - F003-T5)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;

  const { entries, detailOf, timelineOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));

  // An Asset whose Location starts at `location` on 2024-01-01.
  const registered = async (location: Entry, name: string = `ของ ${crypto.randomUUID()}`): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name, location_id: location.id, effective_date: '2024-01-01' });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // Each Asset of a batch with the assignment version an observer reads now.
  const selectionOf = (assetIds: string[]) =>
    Promise.all(
      assetIds.map(async (asset_id) => ({ asset_id, expected_assignment_version: (await detailOf(asset_id)).assignment_version }))
    );

  // Records a Bulk Reassignment against the versions read now, unless the payload names `assets`.
  const bulk = async (assetIds: string[], payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, '/assets/bulk-reassignments', { assets: await selectionOf(assetIds), ...payload }, { 'x-retry-token': token });

  const withReassignDenied = (check: () => Promise<void>) => withCapabilityAnswer(api.app, 'assignment:reassign', async () => false, check);

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => new Date('2026-11-05T05:00:00Z') });
    admin = await api.actor('admin_bulk', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_bulk', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_bulk', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('effect', () => {
    it('gives each Asset its own event with its own prior values, all under one bulk reference', async () => {
      const [roomA, roomB, target] = await entries('locations', 'ห้องทีละชิ้น', 3);
      const first = await registered(roomA);
      const second = await registered(roomB);

      const res = await bulk([first, second], { effective_date: TODAY, location_id: target.id });

      expect(res.statusCode).toBe(201);
      const [, firstEvent] = await timelineOf(first);
      const [, secondEvent] = await timelineOf(second);
      expect(firstEvent).toMatchObject({ kind: 'REASSIGNMENT', effective_date: TODAY, provenance: 'RECORDED', is_voided: false });
      expect(firstEvent.changes).toEqual([{ dimension: 'location', prior: at(roomA), new: at(target), conflict: null }]);
      expect(secondEvent.changes).toEqual([{ dimension: 'location', prior: at(roomB), new: at(target), conflict: null }]);
      expect(firstEvent.id).not.toBe(secondEvent.id);
      expect(firstEvent.bulk_reference).toMatch(UUID);
      expect(secondEvent.bulk_reference).toBe(firstEvent.bulk_reference);

      expect((await detailOf(first)).current_assignment.location.id).toBe(target.id);
      expect((await detailOf(first)).assignment_version).toBe(2);
    });

    it('records no event for an Asset that already holds the new values, and reports it as unchanged', async () => {
      const [roomA, target] = await entries('locations', 'ห้องไม่เปลี่ยน', 2);
      const moved = await registered(roomA);
      const holder = await registered(target);

      const res = await bulk([moved, holder], { effective_date: TODAY, location_id: target.id });

      expect(res.statusCode).toBe(201);
      expect(res.json().changed.map(({ asset_id }: any) => asset_id)).toEqual([moved]);
      expect(res.json().unchanged).toEqual([{ asset_id: holder, assignment_version: 1 }]);
      expect(await timelineOf(holder)).toHaveLength(1);
      expect((await detailOf(holder)).assignment_version).toBe(1);
    });

    it('records for each Asset only the dimensions that change for it, and copies the notes to every event', async () => {
      const [roomA, target] = await entries('locations', 'ห้องบางมิติ', 2);
      const [unitA, unitTarget] = await entries('organization-units', 'หน่วยบางมิติ', 2);
      const place = async (room: Entry) =>
        (await api.post(custodian, '/assets', { name: 'ของบางมิติ', location_id: room.id, organization_unit_id: unitA.id, effective_date: '2024-01-01' })).json().asset.id;
      const both = await place(roomA);
      const unitOnly = await place(target);

      const res = await bulk([both, unitOnly], {
        effective_date: TODAY,
        location_id: target.id,
        organization_unit_id: unitTarget.id,
        document_reference: 'บันทึกข้อความ 12/2569',
        remark: 'ย้ายทั้งสำนักงาน',
      });
      expect(res.statusCode).toBe(201);

      const [, bothEvent] = await timelineOf(both);
      const [, unitOnlyEvent] = await timelineOf(unitOnly);
      expect(bothEvent.changes.map(({ dimension }: any) => dimension)).toEqual(['location', 'organization_unit']);
      expect(unitOnlyEvent.changes.map(({ dimension }: any) => dimension)).toEqual(['organization_unit']);
      for (const event of [bothEvent, unitOnlyEvent]) {
        expect(event.document_reference).toBe('บันทึกข้อความ 12/2569');
        expect(event.remark).toBe('ย้ายทั้งสำนักงาน');
      }
    });

    it('keeps Legacy text as the prior value, and it leaves the Current Assignment (#50 Q14)', async () => {
      const [target] = await entries('locations', 'ห้องจากข้อความเดิม', 1);
      const registeredWithText = await api.post(custodian, '/assets', { name: 'ของข้อความเดิม', legacy_location_text: 'ห้องตามทะเบียนเก่า', effective_date: null });
      expect(registeredWithText.statusCode).toBe(201);
      const assetId = registeredWithText.json().asset.id;

      const res = await bulk([assetId], { effective_date: TODAY, location_id: target.id });

      expect(res.statusCode).toBe(201);
      const [, event] = await timelineOf(assetId);
      expect(event.changes).toEqual([
        { dimension: 'location', prior: { entry: null, legacy_text: 'ห้องตามทะเบียนเก่า' }, new: at(target), conflict: null },
      ]);
      const { current_assignment: current } = await detailOf(assetId);
      expect(current.location.id).toBe(target.id);
      expect(current.legacy_location_text).toBeNull();
    });

    it('takes prior values at the Effective Date, not today', async () => {
      const [roomA, roomB, target] = await entries('locations', 'ห้องย้อนหลัง', 3);
      const assetId = await registered(roomA);
      const moved = await api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2026-06-01', location_id: roomB.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(moved.statusCode).toBe(201);

      const res = await bulk([assetId], { effective_date: '2026-03-01', location_id: target.id, explicit_continuation: true });

      expect(res.statusCode).toBe(201);
      expect(res.json().changed[0].event.changes[0].prior).toEqual(at(roomA));
    });

    it('clears the OrganizationUnit and the Responsible Person', async () => {
      const room = (await entries('locations', 'ห้องล้างค่า', 1))[0];
      const [unit] = await entries('organization-units', 'หน่วยล้างค่า', 1);
      const [person] = await entries('persons', 'คนล้างค่า', 1);
      const assetId = (
        await api.post(custodian, '/assets', { name: 'ของล้างค่า', location_id: room.id, organization_unit_id: unit.id, responsible_person_id: person.id, effective_date: '2024-01-01' })
      ).json().asset.id;

      const res = await bulk([assetId], { effective_date: TODAY, organization_unit_id: null, responsible_person_id: null });

      expect(res.statusCode).toBe(201);
      const { current_assignment: current } = await detailOf(assetId);
      expect(current.organization_unit).toBeNull();
      expect(current.responsible_person).toBeNull();
      expect(res.json().changed[0].event.changes[0].new).toEqual(NO_VALUE);
    });
  });

  describe('request', () => {
    // Asserts the request is refused as invalid and the Asset's facts stay as they were.
    const expectRefused = async (assetId: string, payload: Record<string, unknown>, message: RegExp) => {
      const before = await assignmentOf(assetId);
      const res = await bulk([assetId], payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
      expect(res.json().message).toMatch(message);
      expect(await assignmentOf(assetId)).toEqual(before);
    };

    it('takes 100 Assets, and refuses none or 101', async () => {
      const [roomA, target] = await entries('locations', 'ห้องร้อย', 2);
      const assetIds = await Promise.all(Array.from({ length: 100 }, () => registered(roomA)));

      const none = await api.post(custodian, '/assets/bulk-reassignments', { assets: [], effective_date: TODAY, location_id: target.id }, { 'x-retry-token': crypto.randomUUID() });
      expect(none.statusCode).toBe(400);
      expect(none.json().code).toBe('VALIDATION_FAILED');
      expect(none.json().message).toContain('1 to 100');

      const tooMany = await bulk([...assetIds, await registered(roomA)], { effective_date: TODAY, location_id: target.id });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().code).toBe('VALIDATION_FAILED');
      expect(tooMany.json().message).toContain('100');

      const atLimit = await bulk(assetIds, { effective_date: TODAY, location_id: target.id });
      expect(atLimit.statusCode).toBe(201);
      expect(atLimit.json().changed).toHaveLength(100);
      expect(new Set(atLimit.json().changed.map(({ event }: any) => event.bulk_reference)).size).toBe(1);
    }, 60_000);

    it('refuses an Asset with no expected assignment version', async () => {
      const [roomA, target] = await entries('locations', 'ห้องไม่มีรุ่น', 2);
      const withVersion = await registered(roomA);
      const withoutVersion = await registered(roomA);
      const before = await assignmentOf(withVersion);

      const res = await bulk([], {
        assets: [...(await selectionOf([withVersion])), { asset_id: withoutVersion }],
        effective_date: TODAY,
        location_id: target.id,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(res.json().message).toContain('assets.1.expected_assignment_version');
      expect(await assignmentOf(withVersion)).toEqual(before);
    });

    it('refuses an Asset named twice, and an id that is not a UUID', async () => {
      const [roomA, target] = await entries('locations', 'ห้องซ้ำ', 2);
      const assetId = await registered(roomA);
      const twice = await bulk([assetId, assetId], { effective_date: TODAY, location_id: target.id });
      expect(twice.statusCode).toBe(400);
      expect(twice.json().code).toBe('VALIDATION_FAILED');

      const notAnId = await api.post(
        custodian,
        '/assets/bulk-reassignments',
        { assets: [{ asset_id: 'not-a-uuid', expected_assignment_version: 1 }], effective_date: TODAY, location_id: target.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(notAnId.statusCode).toBe(400);
      expect(notAnId.json().code).toBe('VALIDATION_FAILED');
      expect((await timelineOf(assetId))).toHaveLength(1);
    });

    it('refuses a request that names no new value', async () => {
      const [roomA] = await entries('locations', 'ห้องไม่เลือก', 1);
      await expectRefused(await registered(roomA), { effective_date: TODAY }, /at least one/);
    });

    it('refuses a batch in which no Asset would change, and saves nothing (MR-01)', async () => {
      const [target] = await entries('locations', 'ห้องไม่มีอะไรเปลี่ยน', 1);
      await expectRefused(await registered(target), { effective_date: TODAY, location_id: target.id }, /changes nothing/);
    });

    it('refuses clearing the Location and naming Legacy text', async () => {
      const [roomA] = await entries('locations', 'ห้องกฎ', 1);
      const assetId = await registered(roomA);
      await expectRefused(assetId, { effective_date: TODAY, location_id: null }, /cannot clear the Location/);
      await expectRefused(assetId, { effective_date: TODAY, legacy_location_text: 'ห้องเดิม' }, /never Legacy text/);
    });

    it('holds the Effective Date to the Reassignment rules: a real date, no later than today in Thai time', async () => {
      const [roomA, target] = await entries('locations', 'ห้องวันที่', 2);
      const assetId = await registered(roomA);
      await expectRefused(assetId, { effective_date: '2026-11-06', location_id: target.id }, /must not be after today/);
      await expectRefused(assetId, { effective_date: null, location_id: target.id }, /never unknown/);
      await expectRefused(assetId, { location_id: target.id }, /never unknown/);
    });

    it('offers a deactivated entry only for a past date', async () => {
      const [roomA, closed] = await entries('locations', 'ห้องปิด', 2);
      const assetId = await registered(roomA);
      const deactivated = await api.post(admin, `/references/locations/${closed.id}`, { expected_version: 1, is_active: false });
      expect(deactivated.statusCode).toBe(200);

      await expectRefused(assetId, { effective_date: TODAY, location_id: closed.id }, /must name an active entry/);
      expect((await bulk([assetId], { effective_date: '2026-11-04', location_id: closed.id })).statusCode).toBe(201);
    });
  });

  describe('refusal', () => {
    it('refuses by name an Asset with no Initial Assignment, and saves nothing', async () => {
      const [roomA, target] = await entries('locations', 'ห้องยังไม่กำหนด', 2);
      const placed = await registered(roomA);
      const unplaced = (await api.post(custodian, '/assets', { name: 'เก้าอี้ยังไม่กำหนด', asset_number: 'BULK-NO-INITIAL' })).json().asset.id;
      const before = await assignmentOf(placed);

      const res = await bulk([placed, unplaced], { effective_date: TODAY, location_id: target.id });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        statusCode: 400,
        code: 'INITIAL_ASSIGNMENT_REQUIRED',
        error: 'INITIAL_ASSIGNMENT_REQUIRED',
        assets: [{ asset_id: unplaced, name: 'เก้าอี้ยังไม่กำหนด', asset_number: 'BULK-NO-INITIAL' }],
      });
      expect(res.json().message).toContain('เก้าอี้ยังไม่กำหนด');
      expect(await assignmentOf(placed)).toEqual(before);
    });

    it('counts a voided Initial Assignment as none', async () => {
      const [roomA, target] = await entries('locations', 'ห้องยกเลิกครั้งแรก', 2);
      const assetId = await registered(roomA);
      const [initial] = await timelineOf(assetId);
      const voided = await api.post(
        custodian,
        `/assets/${assetId}/assignments/${initial.id}/corrections`,
        { action: 'VOID', reason: 'กำหนดผิด', expected_assignment_version: 1 },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(voided.statusCode).toBe(201);

      const res = await bulk([assetId], { effective_date: TODAY, location_id: target.id });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INITIAL_ASSIGNMENT_REQUIRED');
    });

    it('refuses the whole batch when one version is stale, names that Asset, and saves nothing', async () => {
      const [roomA, roomB, target] = await entries('locations', 'ห้องรุ่นเก่า', 3);
      const fresh = await registered(roomA);
      const stale = await registered(roomA);
      const selection = await selectionOf([fresh, stale]);
      const moved = await api.post(
        custodian,
        `/assets/${stale}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: TODAY, location_id: roomB.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(moved.statusCode).toBe(201);
      const before = await assignmentOf(fresh);

      const res = await api.post(
        custodian,
        '/assets/bulk-reassignments',
        { assets: selection, effective_date: TODAY, location_id: target.id },
        { 'x-retry-token': crypto.randomUUID() }
      );

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'STALE_BEFORE_CONFLICT',
        current_values: { [stale]: 2 },
        expected_values: { [stale]: 1 },
      });
      expect(res.json().current_values).not.toHaveProperty(fresh);
      expect(await assignmentOf(fresh)).toEqual(before);
    });

    it('answers 404 naming an Asset that does not exist, and saves nothing', async () => {
      const [roomA, target] = await entries('locations', 'ห้องไม่พบ', 2);
      const assetId = await registered(roomA);
      const missing = crypto.randomUUID();
      const before = await assignmentOf(assetId);

      const res = await api.post(
        custodian,
        '/assets/bulk-reassignments',
        {
          assets: [...(await selectionOf([assetId])), { asset_id: missing, expected_assignment_version: 1 }],
          effective_date: TODAY,
          location_id: target.id,
        },
        { 'x-retry-token': crypto.randomUUID() }
      );

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
      expect(res.json().message).toContain(missing);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('rolls every Asset back when the last one fails to save', async () => {
      const [roomA, target] = await entries('locations', 'ห้องล้มกลางชุด', 2);
      const assetIds = [await registered(roomA), await registered(roomA), await registered(roomA)].sort();
      const last = assetIds[2];
      const before = await Promise.all(assetIds.map(assignmentOf));
      await api.pool.query(`
        CREATE FUNCTION fail_bulk_event() RETURNS trigger AS $$
        BEGIN
          IF NEW.asset_id = '${last}' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_bulk_event BEFORE INSERT ON assignment_events
          FOR EACH ROW EXECUTE FUNCTION fail_bulk_event();
      `);
      try {
        const res = await bulk(assetIds, { effective_date: TODAY, location_id: target.id });
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('injected failure');
        expect(await Promise.all(assetIds.map(assignmentOf))).toEqual(before);
      } finally {
        await api.pool.query('DROP TRIGGER fail_bulk_event ON assignment_events; DROP FUNCTION fail_bulk_event();');
      }
    });
  });

  describe('conflicts', () => {
    // An Asset at `start` from 2024-01-01 and at `later` from 2024-06-01, so a batch dated between them would contradict the later fact.
    const movedLater = async (start: Entry, later: Entry) => {
      const assetId = await registered(start);
      const res = await api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2024-06-01', location_id: later.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(res.statusCode).toBe(201);
      return { assetId, later: res.json().event };
    };

    it('warns once, listing every new conflict across the batch, and saves nothing', async () => {
      const [start, later, target] = await entries('locations', 'ห้องเตือนทั้งชุด', 3);
      const one = await movedLater(start, later);
      const two = await movedLater(start, later);
      const clear = await registered(start);
      const before = await Promise.all([one.assetId, two.assetId, clear].map(assignmentOf));

      const res = await bulk([one.assetId, two.assetId, clear], { effective_date: '2024-03-01', location_id: target.id });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, code: 'ASSIGNMENT_CONFLICTS_FOUND' });
      const conflicts = res.json().conflicts;
      expect(conflicts).toHaveLength(2);
      expect(conflicts).toEqual(
        expect.arrayContaining(
          [one, two].map(({ assetId, later: event }) => ({
            asset_id: assetId,
            event_id: event.id,
            kind: 'REASSIGNMENT',
            effective_date: '2024-06-01',
            dimension: 'location',
            recorded_prior: at(start),
            value_just_before: at(target),
          }))
        )
      );
      expect(await Promise.all([one.assetId, two.assetId, clear].map(assignmentOf))).toEqual(before);
    });

    it('saves the whole batch on one confirmation, and marks the conflicts', async () => {
      const [start, later, target] = await entries('locations', 'ห้องยืนยันทั้งชุด', 3);
      const one = await movedLater(start, later);
      const clear = await registered(start);

      const res = await bulk([one.assetId, clear], { effective_date: '2024-03-01', location_id: target.id, explicit_continuation: true });

      expect(res.statusCode).toBe(201);
      expect(res.json().changed).toHaveLength(2);
      expect((await detailOf(one.assetId)).has_assignment_conflict).toBe(true);
      expect((await detailOf(clear)).has_assignment_conflict).toBe(false);
      const timeline = await timelineOf(one.assetId);
      expect(timeline[2].changes[0].conflict).toEqual({ value_just_before: at(target) });
    });

    it('does not warn about a contradiction that already stood', async () => {
      const [start, later, between] = await entries('locations', 'ห้องขัดแย้งเดิม', 3);
      const { assetId } = await movedLater(start, later);
      const confirmed = await api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 2, effective_date: '2024-03-01', location_id: between.id, explicit_continuation: true },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(confirmed.statusCode).toBe(201);
      const [unit] = await entries('organization-units', 'หน่วยขัดแย้งเดิม', 1);

      const res = await bulk([assetId], { effective_date: TODAY, organization_unit_id: unit.id });

      expect(res.statusCode).toBe(201);
    });

    it('stores no retry result for a warning, so the same token can confirm the batch', async () => {
      const [start, later, target] = await entries('locations', 'ห้องโทเคนยืนยัน', 3);
      const { assetId } = await movedLater(start, later);
      const assets = await selectionOf([assetId]);
      const token = crypto.randomUUID();
      const payload = { assets, effective_date: '2024-03-01', location_id: target.id };

      const warned = await api.post(custodian, '/assets/bulk-reassignments', payload, { 'x-retry-token': token });
      expect(warned.statusCode).toBe(409);
      const confirmed = await api.post(custodian, '/assets/bulk-reassignments', { ...payload, explicit_continuation: true }, { 'x-retry-token': token });
      expect(confirmed.statusCode).toBe(201);
      expect(await timelineOf(assetId)).toHaveLength(3);
    });
  });

  describe('preview', () => {
    const preview = async (assetIds: string[], payload: Record<string, unknown>, actor: Actor = custodian) =>
      api.post(actor, '/assets/bulk-reassignments/preview', { asset_ids: assetIds, ...payload });

    it('shows prior and new values for each Asset, the unchanged Assets and the conflicts, and saves nothing', async () => {
      const [start, later, target] = await entries('locations', 'ห้องดูก่อน', 3);
      const contradicted = await registered(start);
      const laterRes = await api.post(
        custodian,
        `/assets/${contradicted}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2024-06-01', location_id: later.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      const plain = await registered(start);
      const holder = await registered(start);
      const onDate = await api.post(
        custodian,
        `/assets/${holder}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2024-02-01', location_id: target.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(onDate.statusCode).toBe(201);
      const ids = [contradicted, plain, holder];
      const before = await Promise.all(ids.map(assignmentOf));

      const res = await preview(ids, { effective_date: '2024-03-01', location_id: target.id });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toHaveLength(2);
      expect(body.changed).toEqual(
        expect.arrayContaining(
          [
            { asset_id: contradicted, assignment_version: 2, changes: [{ dimension: 'location', prior: at(start), new: at(target) }] },
            { asset_id: plain, assignment_version: 1, changes: [{ dimension: 'location', prior: at(start), new: at(target) }] },
          ]
        )
      );
      expect(body.unchanged).toEqual([{ asset_id: holder, assignment_version: 2 }]);
      expect(body.conflicts).toEqual([
        {
          asset_id: contradicted,
          event_id: laterRes.json().event.id,
          kind: 'REASSIGNMENT',
          effective_date: '2024-06-01',
          dimension: 'location',
          recorded_prior: at(start),
          value_just_before: at(target),
        },
      ]);
      expect(await Promise.all(ids.map(assignmentOf))).toEqual(before);
    });

    it('reads the versions the write then expects, and leaves the Assets free for it', async () => {
      const [roomA, target] = await entries('locations', 'ห้องดูแล้วบันทึก', 2);
      const assetId = await registered(roomA);
      const facts = { effective_date: TODAY, location_id: target.id };

      const seen = await preview([assetId], facts);
      expect(seen.statusCode).toBe(200);
      const assets = seen.json().changed.map(({ asset_id, assignment_version }: any) => ({ asset_id, expected_assignment_version: assignment_version }));

      const saved = await api.post(custodian, '/assets/bulk-reassignments', { assets, ...facts }, { 'x-retry-token': crypto.randomUUID() });
      expect(saved.statusCode).toBe(201);
      expect(saved.json().changed[0].assignment_version).toBe(2);
    });

    it('ties the save to what it showed: a fact recorded after the preview makes the save stale', async () => {
      const [roomA, roomB, target] = await entries('locations', 'ห้องหลังดู', 3);
      const assetId = await registered(roomA);
      const facts = { effective_date: TODAY, location_id: target.id };
      const seen = (await preview([assetId], facts)).json();
      const moved = await api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: TODAY, location_id: roomB.id },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(moved.statusCode).toBe(201);

      const saved = await api.post(
        custodian,
        '/assets/bulk-reassignments',
        { assets: [{ asset_id: assetId, expected_assignment_version: seen.changed[0].assignment_version }], ...facts },
        { 'x-retry-token': crypto.randomUUID() }
      );

      expect(saved.statusCode).toBe(409);
      expect(saved.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { [assetId]: 2 }, expected_values: { [assetId]: 1 } });
    });

    it('previews a batch in which no Asset would change, with nothing to save', async () => {
      const [target] = await entries('locations', 'ห้องดูไม่เปลี่ยน', 1);
      const assetId = await registered(target);
      const res = await preview([assetId], { effective_date: TODAY, location_id: target.id });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ changed: [], unchanged: [{ asset_id: assetId, assignment_version: 1 }], conflicts: [] });
    });

    it('refuses what the write refuses: no Initial Assignment by name, too many Assets, a broken rule', async () => {
      const [roomA, target] = await entries('locations', 'ห้องดูแล้วติด', 2);
      const unplaced = (await api.post(custodian, '/assets', { name: 'ดูแล้วยังไม่กำหนด' })).json().asset.id;
      const noInitial = await preview([unplaced], { effective_date: TODAY, location_id: target.id });
      expect(noInitial.statusCode).toBe(400);
      expect(noInitial.json()).toMatchObject({ code: 'INITIAL_ASSIGNMENT_REQUIRED', assets: [{ asset_id: unplaced }] });

      const assetId = await registered(roomA);
      const tooMany = await preview(Array.from({ length: 101 }, () => crypto.randomUUID()), { effective_date: TODAY, location_id: target.id });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().message).toContain('1 to 100');

      const broken = await preview([assetId], { effective_date: TODAY, location_id: null });
      expect(broken.statusCode).toBe(400);
      expect(broken.json().code).toBe('VALIDATION_FAILED');
    });

    it('needs assignment:reassign itself, and takes no retry token', async () => {
      const [roomA, target] = await entries('locations', 'ห้องดูไม่มีสิทธิ์', 2);
      const assetId = await registered(roomA);
      expect((await preview([assetId], { effective_date: TODAY, location_id: target.id }, readonly)).statusCode).toBe(403);

      const before = await assignmentOf(assetId);
      await withReassignDenied(async () => {
        const res = await preview([assetId], { effective_date: TODAY, location_id: target.id });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      });
      expect(await assignmentOf(assetId)).toEqual(before);

      const withToken = await preview([assetId], { effective_date: TODAY, location_id: target.id, retry_token: 'x' });
      expect(withToken.statusCode).toBe(400);
    });
  });

  describe('asset list', () => {
    const rowsNamed = async (actor: Actor, name: string) => api.get(actor, `/assets/search?field=name&value=${encodeURIComponent(name)}`);

    it('offers the bulk action only to holders of assignment:reassign', async () => {
      const [roomA] = await entries('locations', 'ห้องรายการสิทธิ์', 1);
      await registered(roomA, 'ของรายการสิทธิ์');

      expect((await rowsNamed(custodian, 'ของรายการสิทธิ์')).json().can_reassign).toBe(true);
      expect((await rowsNamed(readonly, 'ของรายการสิทธิ์')).json().can_reassign).toBe(false);
      expect((await rowsNamed(admin, 'ของรายการสิทธิ์')).json().can_reassign).toBe(false);

      await withReassignDenied(async () => {
        expect((await rowsNamed(custodian, 'ของรายการสิทธิ์')).json().can_reassign).toBe(false);
      });
    });
  });

  describe('authorization', () => {
    it('refuses every role without assignment:reassign, and a request with no CSRF token, and saves nothing', async () => {
      const [roomA, target] = await entries('locations', 'ห้องสิทธิ์', 2);
      const assetId = await registered(roomA);
      const before = await assignmentOf(assetId);
      const maintainer = await api.actor('maintainer_bulk', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, admin, maintainer]) {
        const res = await bulk([assetId], { effective_date: TODAY, location_id: target.id }, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }

      const noCsrf = await api.app.inject({
        method: 'POST',
        url: '/assets/bulk-reassignments',
        headers: { cookie: custodian.cookie, 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID() },
        payload: { assets: await selectionOf([assetId]), effective_date: TODAY, location_id: target.id },
      });
      expect(noCsrf.statusCode).toBe(403);

      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('needs assignment:reassign itself: denying it alone refuses a Custodian and saves nothing', async () => {
      const [roomA, target] = await entries('locations', 'ห้องไม่มีสิทธิ์ย้าย', 2);
      const assetId = await registered(roomA);
      const before = await assignmentOf(assetId);
      await withReassignDenied(async () => {
        const res = await bulk([assetId], { effective_date: TODAY, location_id: target.id });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      });
      expect(await assignmentOf(assetId)).toEqual(before);
    });
  });

  describe('concurrency', () => {
    const isLocked = async (assetId: string): Promise<boolean> => {
      try {
        await api.pool.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE NOWAIT', [assetId]);
        return false;
      } catch (err: any) {
        expect(err.code).toBe('55P03');
        return true;
      }
    };

    it('locks its Assets in identifier order, however the request lists them', async () => {
      const [roomA, target] = await entries('locations', 'ห้องลำดับล็อก', 2);
      const [low, middle, high] = [await registered(roomA), await registered(roomA), await registered(roomA)].sort();

      const holder = await api.pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE', [middle]);

      const write = bulk([high, middle, low], { effective_date: TODAY, location_id: target.id });

      // The batch stops at the Asset held: the one before it is locked, the one after it is not.
      await expect.poll(() => isLocked(low), { timeout: 10_000, interval: 50 }).toBe(true);
      expect(await isLocked(high)).toBe(false);

      await holder.query('COMMIT');
      holder.release();
      expect((await write).statusCode).toBe(201);
    });

    it('serializes batches over the same Assets, listed in opposite orders: one commits, the other is stale and saves nothing', async () => {
      const [roomA, targetOne, targetTwo] = await entries('locations', 'ห้องชุดชนกัน', 3);
      const assetIds = await Promise.all(Array.from({ length: 30 }, () => registered(roomA)));
      const selection = await selectionOf(assetIds);
      const send = (assets: typeof selection, target: Entry) =>
        api.post(custodian, '/assets/bulk-reassignments', { assets, effective_date: TODAY, location_id: target.id }, { 'x-retry-token': crypto.randomUUID() });

      const results = await Promise.all([send(selection, targetOne), send([...selection].reverse(), targetTwo)]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((res) => res.statusCode === 409)!.json().code).toBe('STALE_BEFORE_CONFLICT');
      const timelines = await Promise.all(assetIds.map(timelineOf));
      expect(timelines.every((timeline) => timeline.length === 2)).toBe(true);
      expect(new Set(timelines.map((timeline) => timeline[1].bulk_reference)).size).toBe(1);
    }, 60_000);
  });

  describe('retry token', () => {
    const placedBatch = async (label: string) => {
      const [roomA, target, other] = await entries('locations', label, 3);
      const assetIds = [await registered(roomA), await registered(roomA)];
      const assets = await selectionOf(assetIds);
      return { assetIds, assets, target, other, payload: { assets, effective_date: TODAY, location_id: target.id } };
    };
    const send = (payload: Record<string, unknown>, headers: Record<string, string>) => api.post(custodian, '/assets/bulk-reassignments', payload, headers);
    const eventCount = async (assetIds: string[]) => (await Promise.all(assetIds.map(timelineOf))).flat().length;

    it('needs a token', async () => {
      const { assetIds, payload } = await placedBatch('ห้องไม่มีโทเคน');
      const res = await send(payload, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await eventCount(assetIds)).toBe(2);
    });

    it('covers the whole batch: a replay returns the committed result and writes nothing', async () => {
      const { assetIds, assets, payload } = await placedBatch('ห้องส่งซ้ำ');
      const token = crypto.randomUUID();
      const first = await send(payload, { 'x-retry-token': token });
      expect(first.statusCode).toBe(201);

      // The Assets listed in another order are the same request.
      const replay = await send({ ...payload, assets: [...assets].reverse() }, { 'x-retry-token': token });

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await eventCount(assetIds)).toBe(4);
    });

    it('refuses the same token with a changed payload, and saves nothing', async () => {
      const { assetIds, payload, other } = await placedBatch('ห้องโทเคนเดิม');
      const token = crypto.randomUUID();
      expect((await send(payload, { 'x-retry-token': token })).statusCode).toBe(201);

      const changed = await send({ ...payload, location_id: other.id }, { 'x-retry-token': token });

      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await eventCount(assetIds)).toBe(4);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { assetIds, payload } = await placedBatch('ห้องส่งพร้อมกัน');
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => send(payload, { 'x-retry-token': token })));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().bulk_reference)).size).toBe(1);
      expect(await eventCount(assetIds)).toBe(4);
    });

    it('commits the events, the versions and the token together, or none of them', async () => {
      const { assetIds, payload } = await placedBatch('ห้องโทเคนล้ม');
      const before = await Promise.all(assetIds.map(assignmentOf));
      await api.pool.query(`
        CREATE FUNCTION fail_bulk_token() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'bulk-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_bulk_token BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_bulk_token();
      `);
      try {
        expect((await send(payload, { 'x-retry-token': 'bulk-fail-token' })).statusCode).toBe(500);
        expect(await Promise.all(assetIds.map(assignmentOf))).toEqual(before);
      } finally {
        await api.pool.query('DROP TRIGGER fail_bulk_token ON registration_retry_tokens; DROP FUNCTION fail_bulk_token();');
      }
      expect((await send(payload, { 'x-retry-token': 'bulk-fail-token' })).statusCode).toBe(201);
    });
  });
});
