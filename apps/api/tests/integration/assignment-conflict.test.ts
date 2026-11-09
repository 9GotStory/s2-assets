import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';

const NO_VALUE = { entry: null, legacy_text: null };

// F003-T4 (#54): when assignment facts disagree, the system says so.
describe('Assignment Conflicts (Seam A - F003-T4)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;

  type Entry = { id: string; name: string; is_active: boolean };

  const entry = async (kind: string, name: string): Promise<Entry> => (await api.post(admin, `/references/${kind}`, { name })).json();

  // `count` entries of one list, named after `prefix`.
  const entries = (kind: string, prefix: string, count: number): Promise<Entry[]> =>
    Promise.all(Array.from({ length: count }, (_, i) => entry(kind, `${prefix} ${i + 1}`)));

  // A dimension value as the API answers it, naming the entry `e`.
  const at = (e: Entry) => ({ entry: { id: e.id, name: e.name, is_active: true }, legacy_text: null });

  // An Asset whose Location starts at `location` on `effectiveDate`.
  const registered = async (location: Entry, effectiveDate: string | null = '2024-01-01'): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: location.id, effective_date: effectiveDate });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  const detailOf = async (assetId: string) => (await api.get(readonly, `/assets/${assetId}`)).json();

  const timelineOf = async (assetId: string) => {
    const res = await api.get(readonly, `/assets/${assetId}/assignments`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  // Records a fact against the Asset's current version unless the payload names one.
  const record = async (assetId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID()) =>
    api.post(
      custodian,
      `/assets/${assetId}/assignments`,
      { expected_assignment_version: (await detailOf(assetId)).assignment_version, ...payload },
      { 'x-retry-token': token }
    );

  const reassign = (assetId: string, payload: Record<string, unknown>, token?: string) =>
    record(assetId, { kind: 'REASSIGNMENT', ...payload }, token);

  // Records a Reassignment that must save with no warning, and returns its event.
  const reassigned = async (assetId: string, payload: Record<string, unknown>) => {
    const res = await reassign(assetId, payload);
    expect(res.statusCode).toBe(201);
    return res.json().event;
  };

  // Corrects a fact against the Asset's current version unless the payload names one.
  const correct = async (assetId: string, eventId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID()) =>
    api.post(
      custodian,
      `/assets/${assetId}/assignments/${eventId}/corrections`,
      { expected_assignment_version: (await detailOf(assetId)).assignment_version, ...payload },
      { 'x-retry-token': token }
    );

  // An Asset whose later fact contradicts a confirmed backdated one: 1 → 3 on 2024-06-01, with 1 → 2
  // backdated to 2024-03-01.
  const assetInConflict = async (label: string) => {
    const [a, b, c] = await entries('locations', `ห้องขัดแย้ง ${label}`, 3);
    const assetId = await registered(a);
    const later = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
    const backdated = await reassigned(assetId, { effective_date: '2024-03-01', location_id: b.id, explicit_continuation: true });
    return { assetId, later, backdated, b, c };
  };

  // What an observer reads of an Asset's assignment, to show that a refused write changed nothing.
  const assignmentOf = async (assetId: string) => {
    const detail = await detailOf(assetId);
    return { current: detail.current_assignment, version: detail.assignment_version, timeline: await timelineOf(assetId) };
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => new Date('2026-11-05T05:00:00Z') });
    admin = await api.actor('admin_conflict', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_conflict', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_conflict', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('warning and confirmation', () => {
    it('refuses a backdated Reassignment that would contradict a later fact, lists each new conflict, and saves nothing', async () => {
      const [a, b, c] = await entries('locations', 'ห้องเตือน', 3);
      const assetId = await registered(a);
      const later = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      const before = await assignmentOf(assetId);

      const res = await reassign(assetId, { effective_date: '2024-03-01', location_id: b.id });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, code: 'ASSIGNMENT_CONFLICTS_FOUND', error: 'ASSIGNMENT_CONFLICTS_FOUND' });
      expect(res.json().conflicts).toEqual([
        {
          asset_id: assetId,
          event_id: later.id,
          kind: 'REASSIGNMENT',
          effective_date: '2024-06-01',
          dimension: 'location',
          recorded_prior: at(a),
          value_just_before: at(b),
        },
      ]);
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('saves the same write once it carries explicit confirmation, and marks the conflict in the timeline and the Asset detail', async () => {
      const [a, b, c] = await entries('locations', 'ห้องยืนยัน', 3);
      const assetId = await registered(a);
      const later = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);

      const res = await reassign(assetId, { effective_date: '2024-03-01', location_id: b.id, explicit_continuation: true });
      expect(res.statusCode).toBe(201);

      const detail = await detailOf(assetId);
      expect(detail.has_assignment_conflict).toBe(true);
      // MR-03: the Current Assignment still follows the latest Effective Date.
      expect(detail.current_assignment.location.id).toBe(c.id);

      const timeline = await timelineOf(assetId);
      expect(timeline.map((event: any) => event.effective_date)).toEqual(['2024-01-01', '2024-03-01', '2024-06-01']);
      expect(timeline[0].changes[0].conflict).toBeNull();
      expect(timeline[1].changes[0].conflict).toBeNull();
      expect(timeline[2].id).toBe(later.id);
      expect(timeline[2].changes[0]).toEqual({
        dimension: 'location',
        prior: at(a),
        new: at(c),
        conflict: { value_just_before: at(b) },
      });
    });

    it('lists every new conflict in the order of facts, each fact in dimension order', async () => {
      const [roomA, roomB, roomC] = await entries('locations', 'ห้องหลายมิติ', 3);
      const [unitA, unitB, unitC] = await entries('organization-units', 'หน่วยหลายมิติ', 3);
      const res = await api.post(custodian, '/assets', { name: 'ของหลายมิติ', location_id: roomA.id, organization_unit_id: unitA.id, effective_date: '2024-01-01' });
      const assetId = res.json().asset.id;
      const unitMove = await reassigned(assetId, { effective_date: '2024-05-01', organization_unit_id: unitC.id });
      const roomMove = await reassigned(assetId, { effective_date: '2024-06-01', location_id: roomC.id });

      const refused = await reassign(assetId, { effective_date: '2024-03-01', location_id: roomB.id, organization_unit_id: unitB.id });

      expect(refused.statusCode).toBe(409);
      expect(refused.json().conflicts.map(({ event_id, dimension }: any) => [event_id, dimension])).toEqual([
        [unitMove.id, 'organization_unit'],
        [roomMove.id, 'location'],
      ]);
    });

    it('ties the confirmation to the timeline the user saw: a confirmation against an older version is refused as stale', async () => {
      const [a, b, c, d] = await entries('locations', 'ห้องรุ่น', 4);
      const assetId = await registered(a);
      await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      const { assignment_version: seen } = await detailOf(assetId);

      const payload = { effective_date: '2024-03-01', location_id: b.id, expected_assignment_version: seen };
      expect((await reassign(assetId, payload)).statusCode).toBe(409);

      // Someone else records a fact after the warning.
      await reassigned(assetId, { effective_date: '2026-11-05', location_id: d.id });
      const before = await assignmentOf(assetId);

      const confirmed = await reassign(assetId, { ...payload, explicit_continuation: true });
      expect(confirmed.statusCode).toBe(409);
      expect(confirmed.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('saves a confirmed write that creates no conflict as any other', async () => {
      const [a, b] = await entries('locations', 'ห้องไม่ต้องยืนยัน', 2);
      const assetId = await registered(a);

      expect((await reassign(assetId, { effective_date: '2024-06-01', location_id: b.id, explicit_continuation: true })).statusCode).toBe(201);
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);
    });

    it('refuses a confirmation that is not a boolean', async () => {
      const [a, b] = await entries('locations', 'ห้องชนิดผิด', 2);
      const assetId = await registered(a);

      const res = await reassign(assetId, { effective_date: '2024-06-01', location_id: b.id, explicit_continuation: 'yes' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    });

    it('does not warn again about a contradiction that already stands, and warns when its value just before changes', async () => {
      const [a, b, c, d] = await entries('locations', 'ห้องเดิมอยู่แล้ว', 4);
      const assetId = await registered(a);
      const later = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      await reassigned(assetId, { effective_date: '2024-03-01', location_id: b.id, explicit_continuation: true });

      // Another dimension: the standing contradiction is the same one the user has already confirmed.
      const unit = await entry('organization-units', 'หน่วยเดิมอยู่แล้ว');
      expect((await reassign(assetId, { effective_date: '2026-11-05', organization_unit_id: unit.id })).statusCode).toBe(201);

      // A nearer backdated fact leaves the later fact contradicting a different value.
      const refused = await reassign(assetId, { effective_date: '2024-04-01', location_id: d.id });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().conflicts).toMatchObject([{ event_id: later.id, recorded_prior: at(a), value_just_before: at(d) }]);
    });

    it('stores no retry result for a warning, so the same token can confirm; the replay returns the committed fact', async () => {
      const [a, b, c] = await entries('locations', 'ห้องโทเคน', 3);
      const assetId = await registered(a);
      await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      const { assignment_version: seen } = await detailOf(assetId);
      const payload = { effective_date: '2024-03-01', location_id: b.id, expected_assignment_version: seen };
      const token = crypto.randomUUID();
      const count = async () => (await timelineOf(assetId)).length;

      expect((await reassign(assetId, payload, token)).statusCode).toBe(409);
      const tokens = await api.pool.query('SELECT 1 FROM registration_retry_tokens WHERE token = $1', [token]);
      expect(tokens.rows).toHaveLength(0);

      const confirmed = await reassign(assetId, { ...payload, explicit_continuation: true }, token);
      expect(confirmed.statusCode).toBe(201);
      expect(await count()).toBe(3);

      const replay = await reassign(assetId, { ...payload, explicit_continuation: true }, token);
      expect(replay.statusCode).toBe(201);
      expect(replay.json().event.id).toBe(confirmed.json().event.id);
      expect(await count()).toBe(3);

      // The unconfirmed request is a different payload under the same token.
      const mismatch = await reassign(assetId, payload, token);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await count()).toBe(3);
    });
  });

  describe('corrections', () => {
    it('warns before an amendment that would create a conflict, and saves it with its correction record once confirmed', async () => {
      const [a, b, c] = await entries('locations', 'ห้องแก้ขัดแย้ง', 3);
      const assetId = await registered(a);
      const first = await reassigned(assetId, { effective_date: '2024-03-01', location_id: b.id });
      const second = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      const before = await assignmentOf(assetId);

      const payload = { action: 'AMEND', reason: 'ลงห้องผิด', changes: { location: { new: { entry_id: c.id } } } };
      const refused = await correct(assetId, first.id, payload);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('ASSIGNMENT_CONFLICTS_FOUND');
      expect(refused.json().conflicts).toMatchObject([{ asset_id: assetId, event_id: second.id, dimension: 'location', recorded_prior: at(b), value_just_before: at(c) }]);
      expect(await assignmentOf(assetId)).toEqual(before);

      const saved = await correct(assetId, first.id, { ...payload, explicit_continuation: true });
      expect(saved.statusCode).toBe(201);
      expect(saved.json().event.corrections).toHaveLength(1);
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(true);
    });

    it('warns an Administrator as it warns a Custodian', async () => {
      const [a, b, c] = await entries('locations', 'ห้องผู้ดูแล', 3);
      const assetId = await registered(a);
      const first = await reassigned(assetId, { effective_date: '2024-03-01', location_id: b.id });
      await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      const { assignment_version: version } = await detailOf(assetId);

      const refused = await api.post(
        admin,
        `/assets/${assetId}/assignments/${first.id}/corrections`,
        { action: 'VOID', reason: 'ไม่เคยย้าย', expected_assignment_version: version },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('ASSIGNMENT_CONFLICTS_FOUND');
    });
  });

  describe('resolution', () => {
    const IN_CONFLICT = '/assets/search?has_assignment_conflict=true&limit=100';

    const listed = async (assetId: string): Promise<boolean> =>
      (await api.get(readonly, IN_CONFLICT)).json().items.some((item: any) => item.id === assetId);

    const conflicted = async (label: string) => {
      const fixture = await assetInConflict(label);
      expect(await listed(fixture.assetId)).toBe(true);
      return fixture;
    };

    const expectResolved = async (assetId: string) => {
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);
      expect((await timelineOf(assetId)).flatMap((event: any) => event.changes.map((change: any) => change.conflict)).filter(Boolean)).toEqual([]);
      expect(await listed(assetId)).toBe(false);
    };

    it('disappears when an amendment makes the facts consistent, with no confirmation', async () => {
      const { assetId, later, b } = await conflicted('แก้');

      const res = await correct(assetId, later.id, { action: 'AMEND', reason: 'ค่าเดิมผิด', changes: { location: { prior: { entry_id: b.id } } } });

      expect(res.statusCode).toBe(201);
      await expectResolved(assetId);
    });

    it('disappears when the fact behind it is voided, with no confirmation', async () => {
      const { assetId, backdated } = await conflicted('ยกเลิก');

      const res = await correct(assetId, backdated.id, { action: 'VOID', reason: 'บันทึกซ้ำ' });

      expect(res.statusCode).toBe(201);
      await expectResolved(assetId);
    });

    it('disappears when the conflicting fact itself is voided', async () => {
      const { assetId, later } = await conflicted('ยกเลิกตัวเอง');

      expect((await correct(assetId, later.id, { action: 'VOID', reason: 'ไม่เคยย้าย' })).statusCode).toBe(201);

      await expectResolved(assetId);
    });

    it('disappears when the dimension is removed from a fact whose prior value cannot be amended to match (MR-01)', async () => {
      const [a, b] = await entries('locations', 'ห้องเอามิติออก', 2);
      const [unitA, unitB] = await entries('organization-units', 'หน่วยเอามิติออก', 2);
      const created = await api.post(custodian, '/assets', { name: 'ของเอามิติออก', location_id: a.id, organization_unit_id: unitA.id, effective_date: '2024-01-01' });
      const assetId = created.json().asset.id;
      const later = await reassigned(assetId, { effective_date: '2024-06-01', location_id: b.id, organization_unit_id: unitB.id });
      await reassigned(assetId, { effective_date: '2024-03-01', location_id: b.id, explicit_continuation: true });
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(true);

      // Amending the prior value to the value just before it would leave a change that changes nothing.
      const refused = await correct(assetId, later.id, { action: 'AMEND', reason: 'ค่าเดิมผิด', changes: { location: { prior: { entry_id: b.id } } } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe('VALIDATION_FAILED');

      expect((await correct(assetId, later.id, { action: 'AMEND', reason: 'ไม่ได้ย้ายห้องในรายการนี้', changes: { location: null } })).statusCode).toBe(201);
      await expectResolved(assetId);
    });
  });

  describe('what makes a conflict', () => {
    it('follows the order of facts: unknown first, then Effective Date, then Recorded At', async () => {
      const [a, b, c] = await entries('locations', 'ห้องลำดับ', 3);
      const assetId = await registered(a, null);
      await reassigned(assetId, { effective_date: '2024-06-01', location_id: b.id });
      await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });

      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);
      expect((await timelineOf(assetId)).flatMap((event: any) => event.changes.map((change: any) => change.conflict))).toEqual([null, null, null]);
    });

    it('sees a dimension that was cleared as empty', async () => {
      const room = await entry('locations', 'ห้องล้างค่า');
      const [unitA, unitB] = await entries('organization-units', 'หน่วยล้างค่า', 2);
      const assetId = await registered(room);
      await reassigned(assetId, { effective_date: '2024-02-01', organization_unit_id: unitA.id });
      await reassigned(assetId, { effective_date: '2024-03-01', organization_unit_id: null });
      await reassigned(assetId, { effective_date: '2024-04-01', organization_unit_id: unitB.id });

      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);
    });

    it('compares Legacy text as well as entries, and warns on a correction that makes them differ', async () => {
      const res = await api.post(custodian, '/assets', {
        name: 'ของมีข้อความเดิม',
        is_legacy: true,
        legacy_responsible_person_text: 'คุณเก่า',
        effective_date: null,
      });
      expect(res.statusCode).toBe(201);
      const assetId = res.json().asset.id;
      const person = await entry('persons', 'คุณใหม่');
      const later = await reassigned(assetId, { effective_date: '2024-06-01', responsible_person_id: person.id });
      expect(later.changes[0].prior).toEqual({ entry: null, legacy_text: 'คุณเก่า' });
      const [initial] = await timelineOf(assetId);

      const payload = { action: 'AMEND', reason: 'ชื่อพิมพ์ผิด', changes: { responsible_person: { new: { legacy_text: 'คุณเก่าแก่' } } } };
      const refused = await correct(assetId, initial.id, payload);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().conflicts).toMatchObject([
        {
          event_id: later.id,
          dimension: 'responsible_person',
          recorded_prior: { entry: null, legacy_text: 'คุณเก่า' },
          value_just_before: { entry: null, legacy_text: 'คุณเก่าแก่' },
        },
      ]);
    });

    it('leaves voided facts out, and a voided fact has no marker', async () => {
      const [a, b, c] = await entries('locations', 'ห้องยกเลิก', 3);
      const assetId = await registered(a);
      const first = await reassigned(assetId, { effective_date: '2024-03-01', location_id: b.id });
      const second = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });

      // Voiding the first leaves the second's prior (ข) with ก just before it.
      const payload = { action: 'VOID', reason: 'ไม่เคยย้าย' };
      const refused = await correct(assetId, first.id, payload);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().conflicts).toMatchObject([{ event_id: second.id, recorded_prior: at(b), value_just_before: at(a) }]);

      expect((await correct(assetId, first.id, { ...payload, explicit_continuation: true })).statusCode).toBe(201);
      const timeline = await timelineOf(assetId);
      expect(timeline[1].is_voided).toBe(true);
      expect(timeline[1].changes[0].conflict).toBeNull();
      expect(timeline[2].changes[0].conflict).toEqual({ value_just_before: at(a) });
    });

    it('appears for conflicts recorded before this ticket landed, which do not hold up a later write', async () => {
      const [a, b, c, d] = await entries('locations', 'ห้องก่อนหน้า', 4);
      const assetId = await registered(a);
      const later = await reassigned(assetId, { effective_date: '2024-06-01', location_id: c.id });
      // Facts written before this ticket went unchecked, so one is laid down here beneath the API.
      const earlier = await api.pool.query(
        `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
         VALUES ($1, 'REASSIGNMENT', '2024-03-01', $2, 'RECORDED') RETURNING id`,
        [assetId, custodian.id]
      );
      await api.pool.query(
        `INSERT INTO assignment_changes (event_id, event_kind, dimension, prior_location_id, new_location_id)
         VALUES ($1, 'REASSIGNMENT', 'LOCATION', $2, $3)`,
        [earlier.rows[0].id, a.id, b.id]
      );

      expect((await detailOf(assetId)).has_assignment_conflict).toBe(true);
      const timeline = await timelineOf(assetId);
      expect(timeline.at(-1).id).toBe(later.id);
      expect(timeline.at(-1).changes[0].conflict).toEqual({ value_just_before: at(b) });
      const found = await api.get(readonly, `/assets/search?has_assignment_conflict=true&location_id=${c.id}`);
      expect(found.json().items.map((item: any) => item.id)).toEqual([assetId]);

      // The write adds no contradiction of its own, so the existing one needs no confirmation.
      expect((await reassign(assetId, { effective_date: '2026-11-05', location_id: d.id })).statusCode).toBe(201);
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(true);
    });
  });

  describe('a dated Initial Assignment', () => {
    it('warns about the fact it would record, which has no id until it is saved, and saves once confirmed', async () => {
      const [a, b, c] = await entries('locations', 'ห้องกำหนดใหม่', 3);
      const assetId = await registered(a);
      await reassigned(assetId, { effective_date: '2024-06-01', location_id: b.id });
      const [initial] = await timelineOf(assetId);
      const voided = await correct(assetId, initial.id, { action: 'VOID', reason: 'กำหนดผิด', explicit_continuation: true });
      expect(voided.statusCode).toBe(201);
      const before = await assignmentOf(assetId);

      const payload = { kind: 'INITIAL', effective_date: '2025-01-01', location_id: c.id };
      const refused = await record(assetId, payload);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().conflicts).toEqual([
        {
          asset_id: assetId,
          event_id: null,
          kind: 'INITIAL',
          effective_date: '2025-01-01',
          dimension: 'location',
          recorded_prior: NO_VALUE,
          value_just_before: at(b),
        },
      ]);
      expect(await assignmentOf(assetId)).toEqual(before);

      const saved = await record(assetId, { ...payload, explicit_continuation: true });
      expect(saved.statusCode).toBe(201);
      expect(saved.json().event.changes[0].conflict).toEqual({ value_just_before: at(b) });
    });
  });

  describe('the asset-list filter', () => {
    const FILTER = '/assets/search?has_assignment_conflict=true';

    const search = async (url: string = FILTER, actor: Actor = readonly) => {
      const res = await api.get(actor, url);
      expect(res.statusCode).toBe(200);
      return res.json();
    };

    it('returns the Assets with at least one conflict, with the existing pagination, and combines with the other filters', async () => {
      const { total_count: already } = await search();
      const first = await assetInConflict('หนึ่ง');
      const second = await assetInConflict('สอง');
      const [a, b] = await entries('locations', 'ห้องกรองไม่ขัดแย้ง', 2);
      const consistent = await registered(a);
      await reassigned(consistent, { effective_date: '2024-06-01', location_id: b.id });

      const all = await search(`${FILTER}&limit=100`);
      expect(all.total_count).toBe(already + 2);
      const ids = all.items.map((item: any) => item.id);
      expect(ids).toEqual(expect.arrayContaining([first.assetId, second.assetId]));
      expect(ids).not.toContain(consistent);

      // Without the filter the consistent Asset is listed as before.
      expect((await search(`/assets/search?location_id=${b.id}`)).items.map((item: any) => item.id)).toEqual([consistent]);

      const page = await search(`${FILTER}&limit=1&offset=0`);
      expect(page).toMatchObject({ limit: 1, offset: 0, total_count: already + 2, has_more: true });
      expect(page.items).toHaveLength(1);
      const last = await search(`${FILTER}&limit=1&offset=${already + 1}`);
      expect(last).toMatchObject({ total_count: already + 2, has_more: false });

      const narrowed = await search(`${FILTER}&location_id=${second.c.id}`);
      expect(narrowed.items.map((item: any) => item.id)).toEqual([second.assetId]);
      expect((await search(`${FILTER}&location_id=${b.id}`)).total_count).toBe(0);
    });

    it("refuses any value but 'true'", async () => {
      for (const value of ['false', '1', '']) {
        const res = await api.get(readonly, `/assets/search?has_assignment_conflict=${value}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_FAILED');
      }
    });

    it("is refused without 'asset:search', and returns no Asset", async () => {
      const capabilities = api.app.capabilityService!;
      const original = capabilities.hasCapability;
      capabilities.hasCapability = async (userId: string, capability: string) =>
        capability === 'asset:search' ? false : original.call(capabilities, userId, capability);
      try {
        const res = await api.get(readonly, FILTER);
        expect(res.statusCode).toBe(403);
        expect(res.json().items).toBeUndefined();
      } finally {
        capabilities.hasCapability = original;
      }
    });
  });
});
