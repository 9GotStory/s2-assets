import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F006-T1 (#126): an Asset Custodian opens a Verification Round, and everyone who can view Assets sees its Scope Snapshot.
describe('Open a Verification Round (Seam A - F006-T1)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-12T05:00:00Z');

  const { entries, entry } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { opening, open, opened, roundOf, roundsOf, entriesOf, scopeOf, closedStandIn } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // A registered Asset, with an Initial Assignment when `fields` names dimension values.
  const registered = async (fields: Record<string, unknown> = {}): Promise<string> => {
    const assignment = Object.keys(fields).some((field) => field.endsWith('_id') || field.startsWith('legacy_')) ? { effective_date: '2026-10-01' } : {};
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, ...assignment, ...fields });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_verification', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_verification', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_verification', 'READ_ONLY');
    staff = await api.actor('staff_verification', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    now = new Date('2026-11-12T05:00:00Z');
    await closedStandIn();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('opening', () => {
    it('opens a Round with its name, fiscal year and notes, starting today, and its page shows them with the opening in its history', async () => {
      await registered();
      const before = Date.now();

      const res = await open(opening({ name: 'ตรวจสอบพัสดุประจำปี 2569', fiscal_year: 2569, notes: 'คณะกรรมการ:\nนาย ก\nนาง ข' }));

      expect(res.statusCode).toBe(201);
      const { verification_round_id: roundId, version } = res.json();
      expect(roundId).toMatch(UUID);
      expect(version).toBe(1);

      const round = await roundOf(roundId);
      expect(round).toEqual({
        id: roundId,
        name: 'ตรวจสอบพัสดุประจำปี 2569',
        fiscal_year: 2569,
        start_date: '2026-11-12',
        notes: 'คณะกรรมการ:\nนาย ก\nนาง ข',
        state: 'OPEN',
        filters: { organization_units: [], locations: [] },
        counts: { in_scope: expect.any(Number), not_yet_verified: expect.any(Number) },
        opened_by: custodian.id,
        opened_by_username: 'custodian_verification',
        recorded_at: expect.any(String),
        version: 1,
        history: [
          {
            id: expect.stringMatching(UUID),
            kind: 'OPENED',
            reason: null,
            changes: [],
            counts: null,
            recorded_by: custodian.id,
            recorded_by_username: 'custodian_verification',
            recorded_at: round.recorded_at,
          },
        ],
      });
      expect(round.counts.in_scope).toBeGreaterThan(0);
      expect(round.counts.not_yet_verified).toBe(round.counts.in_scope);
      expect(Date.parse(round.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(round.recorded_at)).toBeLessThanOrEqual(Date.now());
    });

    it('starts on today in Asia/Bangkok, from the clock, and takes no start date', async () => {
      await registered();
      now = new Date('2026-11-12T17:30:00Z');

      expect((await roundOf(await opened())).start_date).toBe('2026-11-13');
      await closedStandIn();
      expect((await open(opening({ start_date: '2026-11-01' }))).statusCode).toBe(400);
    });

    it('covers every registered Asset when no filter is given, each Not Yet Verified with its identity and Current Assignment', async () => {
      const [room, unit, person] = [await entry('locations', `ห้อง ${crypto.randomUUID()}`), await entry('organization-units', `งาน ${crypto.randomUUID()}`), await entry('persons', `คุณ ${crypto.randomUUID()}`)];
      const placed = await registered({ name: 'เครื่องถ่ายเอกสาร', asset_number: `VR-${crypto.randomUUID()}`, serial_number: 'SN-01', location_id: room.id, organization_unit_id: unit.id, responsible_person_id: person.id });
      const legacy = await registered({ legacy_location_text: 'ห้องเก่าชั้น 2' });
      const unplaced = await registered();
      const registeredCount = (await api.get(readonly, '/assets/search?limit=1')).json().total_count;

      const roundId = await opened();

      const scope = await scopeOf(roundId);
      expect(scope).toHaveLength(registeredCount);
      expect(scope).toEqual(expect.arrayContaining([placed, legacy, unplaced]));
      expect((await roundOf(roundId)).counts).toEqual({ in_scope: registeredCount, not_yet_verified: registeredCount });

      const items = (await entriesOf(roundId, `search=${encodeURIComponent('เครื่องถ่ายเอกสาร')}`)).items;
      const placedEntry = items.find((item: any) => item.asset_id === placed);
      expect(placedEntry).toEqual({
        id: expect.stringMatching(UUID),
        asset_id: placed,
        joined_as: 'OPENING',
        snapshot: {
          asset_number: expect.stringMatching(/^VR-/),
          serial_number: 'SN-01',
          name: 'เครื่องถ่ายเอกสาร',
          category: null,
          location: { id: room.id, name: room.name, is_active: true },
          organization_unit: { id: unit.id, name: unit.name, is_active: true },
          responsible_person: { id: person.id, name: person.name, is_active: true },
          legacy_location_text: null,
          legacy_organization_unit_text: null,
          legacy_responsible_person_text: null,
        },
        result: 'NOT_YET_VERIFIED',
      });
    });

    it('covers, with filters, only the Assets whose Current Assignment holds a selected OrganizationUnit and a selected Location (P3)', async () => {
      const [roomA, roomB, roomC] = await entries('locations', `ห้องตรวจ ${crypto.randomUUID()}`, 3);
      const [unitA, unitB] = await entries('organization-units', `งานตรวจ ${crypto.randomUUID()}`, 2);
      const inA = await registered({ location_id: roomA.id, organization_unit_id: unitA.id });
      const inB = await registered({ location_id: roomB.id, organization_unit_id: unitB.id });
      const inC = await registered({ location_id: roomC.id, organization_unit_id: unitA.id });
      const roomOnly = await registered({ location_id: roomA.id });
      const unitWithLegacyRoom = await registered({ organization_unit_id: unitA.id, legacy_location_text: 'ห้องเก่า' });
      const legacyUnitInRoom = await registered({ location_id: roomB.id, legacy_organization_unit_text: 'กองเดิม' });

      // Several entries of one dimension: any of them. An Asset with none, or with Legacy text, matches none.
      const byRooms = await opened({ location_ids: [roomA.id, roomB.id] });
      expect(await scopeOf(byRooms)).toEqual([inA, inB, roomOnly, legacyUnitInRoom].sort());
      expect((await roundOf(byRooms)).filters).toEqual({
        organization_units: [],
        locations: [roomA, roomB].map(({ id, name }) => ({ id, name, is_active: true })).sort((x, y) => x.name.localeCompare(y.name)),
      });
      await closedStandIn();

      const byUnit = await opened({ organization_unit_ids: [unitA.id] });
      expect(await scopeOf(byUnit)).toEqual([inA, inC, unitWithLegacyRoom].sort());
      await closedStandIn();

      // Both dimensions: the Asset must match each.
      const byBoth = await opened({ organization_unit_ids: [unitA.id, unitB.id], location_ids: [roomA.id, roomC.id] });
      expect(await scopeOf(byBoth)).toEqual([inA, inC].sort());
      expect((await roundOf(byBoth)).filters.organization_units.map(({ id }: any) => id).sort()).toEqual([unitA.id, unitB.id].sort());
    });

    it('reads the Current Assignment when the Round opens: an Asset moved out of a selected Location is left out, and one moved in joins', async () => {
      const [roomA, roomB] = await entries('locations', `ห้องย้าย ${crypto.randomUUID()}`, 2);
      const movedOut = await registered({ location_id: roomA.id });
      const movedIn = await registered({ location_id: roomB.id });
      for (const [assetId, to] of [
        [movedOut, roomB],
        [movedIn, roomA],
      ] as const) {
        const res = await api.post(
          custodian,
          `/assets/${assetId}/assignments`,
          { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2026-11-01', location_id: to.id },
          { 'x-retry-token': crypto.randomUUID() }
        );
        expect(res.statusCode).toBe(201);
      }

      expect(await scopeOf(await opened({ location_ids: [roomA.id] }))).toEqual([movedIn]);
    });

    it('names each filter entry once, however often it is given', async () => {
      const room = await entry('locations', `ห้องซ้ำ ${crypto.randomUUID()}`);
      await registered({ location_id: room.id });

      const roundId = await opened({ location_ids: [room.id, room.id.toUpperCase()] });

      expect((await roundOf(roundId)).filters.locations).toEqual([{ id: room.id, name: room.name, is_active: true }]);
    });
  });

  describe('refusals', () => {
    it('refuses an opening whose filters match no Asset, and saves nothing', async () => {
      const emptyRoom = await entry('locations', `ห้องว่าง ${crypto.randomUUID()}`);
      const before = (await roundsOf()).items.length;

      const res = await open(opening({ location_ids: [emptyRoom.id] }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'EMPTY_VERIFICATION_SCOPE' });
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('refuses an opening while another Round is open, naming it, and saves nothing', async () => {
      await registered();
      const openId = await opened({ name: 'รอบที่เปิดอยู่' });
      const before = (await roundsOf()).items.length;

      const res = await open(opening({ name: 'รอบที่สอง' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'ANOTHER_VERIFICATION_ROUND_OPEN',
        open_round: { id: openId, name: 'รอบที่เปิดอยู่', fiscal_year: 2569, start_date: '2026-11-12' },
      });
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('opens a Round again once no other is open', async () => {
      await registered();
      await opened();
      await closedStandIn();

      expect((await open(opening())).statusCode).toBe(201);
    });
  });

  describe('concurrency', () => {
    it('ends concurrent openings with exactly one open Round, and the others name it', async () => {
      await registered();

      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => open(opening({ name: `รอบพร้อมกัน ${i}` }))));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(7).fill(409)]);
      const winner = results.find((res) => res.statusCode === 201)!.json().verification_round_id;
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json()).toMatchObject({ code: 'ANOTHER_VERIFICATION_ROUND_OPEN', open_round: { id: winner } });
      }
      expect((await roundsOf()).items.filter((round: any) => round.state === 'OPEN')).toHaveLength(1);
    });

    it('meets an open Round still uncommitted on another connection at the one-open-Round index, and names it once it commits', async () => {
      await registered();
      const waitersOnRoundInsert = async (): Promise<number> =>
        (
          await api.pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO verification_rounds%'`
          )
        ).rows[0].n;
      const holder = await api.pool.connect();
      let pending: ReturnType<typeof open> | null = null;
      let heldId: string;
      try {
        await holder.query('BEGIN');
        heldId = (
          await holder.query(
            `INSERT INTO verification_rounds (name, fiscal_year, start_date, opened_by) VALUES ('รอบบนอีกการเชื่อมต่อ', 2569, '2026-11-12', $1) RETURNING id`,
            [custodian.id]
          )
        ).rows[0].id;
        pending = open(opening());
        await expect.poll(waitersOnRoundInsert, { timeout: 10_000, interval: 50 }).toBe(1);
        await holder.query('COMMIT');
      } catch (error) {
        await holder.query('ROLLBACK');
        await pending?.catch(() => {});
        throw error;
      } finally {
        holder.release();
      }

      const res = await pending!;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ANOTHER_VERIFICATION_ROUND_OPEN', open_round: { id: heldId!, name: 'รอบบนอีกการเชื่อมต่อ' } });
    });
  });

  describe('validation', () => {
    it('needs a one-line name, a four-digit fiscal year and free-text notes within bounds, and saves nothing otherwise', async () => {
      await registered();
      const unit = await entry('organization-units', `งานผิด ${crypto.randomUUID()}`);
      const room = await entry('locations', `ห้องผิด ${crypto.randomUUID()}`);
      const { name: _name, ...noName } = opening();
      const { fiscal_year: _year, ...noYear } = opening();
      const before = (await roundsOf()).items.length;

      for (const payload of [
        noName,
        opening({ name: '   ' }),
        opening({ name: 'ตรวจ\nประจำปี' }),
        opening({ name: 'ตรวจประจำปี\n' }),
        opening({ name: 'ตรวจ\tประจำปี' }),
        opening({ name: 'ก'.repeat(201) }),
        noYear,
        opening({ fiscal_year: '2569' }),
        opening({ fiscal_year: 999 }),
        opening({ fiscal_year: 10000 }),
        opening({ fiscal_year: 2569.5 }),
        opening({ notes: 'ก'.repeat(2001) }),
        opening({ notes: 'กรรมการ\u0007' }),
        opening({ organization_unit_ids: ['not-a-uuid'] }),
        opening({ organization_unit_ids: [room.id] }),
        opening({ location_ids: [unit.id] }),
        opening({ location_ids: [crypto.randomUUID()] }),
        opening({ location_ids: Array.from({ length: 101 }, () => crypto.randomUUID()) }),
        opening({ attachment: 'รายชื่อกรรมการ.pdf' }),
      ]) {
        const res = await open(payload);
        expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('takes text at its bounds, keeps line breaks and tabs inside notes, and keeps no blank notes', async () => {
      await registered();

      const atBounds = await roundOf(await opened({ name: ` ${'ก'.repeat(200)} `, notes: `${'ข'.repeat(1990)}\r\nค\tง` }));
      expect(atBounds.name).toBe('ก'.repeat(200));
      expect(atBounds.notes).toBe(`${'ข'.repeat(1990)}\r\nค\tง`);
      await closedStandIn();

      expect((await roundOf(await opened({ notes: '  ' }))).notes).toBeNull();
    });
  });

  describe('historical integrity (Q4, Q15)', () => {
    it('keeps the Scope Snapshot as it was taken after a Reassignment, an Assignment Correction or an Asset Correction of a covered Asset', async () => {
      const [roomA, roomB] = await entries('locations', `ห้องประวัติ ${crypto.randomUUID()}`, 2);
      const reassigned = await registered({ name: 'ตู้ที่ย้ายภายหลัง', location_id: roomA.id });
      const corrected = await registered({ name: 'ตู้ที่แก้การมอบหมาย', location_id: roomA.id });
      const renamed = await registered({ name: 'ตู้ชื่อเดิม', location_id: roomA.id });
      const late = await registered({ name: 'ตู้ที่ย้ายเข้ามาภายหลัง', location_id: roomB.id });
      const roundId = await opened({ location_ids: [roomA.id] });
      const before = await entriesOf(roundId);

      const moves = [
        api.post(custodian, `/assets/${reassigned}/assignments`, { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2026-11-12', location_id: roomB.id }, { 'x-retry-token': crypto.randomUUID() }),
        api.post(custodian, `/assets/${late}/assignments`, { kind: 'REASSIGNMENT', expected_assignment_version: 1, effective_date: '2026-11-12', location_id: roomA.id }, { 'x-retry-token': crypto.randomUUID() }),
      ];
      for (const res of await Promise.all(moves)) {
        expect(res.statusCode).toBe(201);
      }
      const [initial] = (await api.get(readonly, `/assets/${corrected}/assignments`)).json().items;
      const amended = await api.post(
        custodian,
        `/assets/${corrected}/assignments/${initial.id}/corrections`,
        { action: 'AMEND', expected_assignment_version: 1, reason: 'บันทึกห้องผิด', changes: { location: { new: { entry_id: roomB.id } } } },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(amended.statusCode).toBe(201);
      const correctedName = await api.post(
        custodian,
        `/assets/${renamed}/correct`,
        { name: 'ตู้ชื่อใหม่', expected_name: 'ตู้ชื่อเดิม', expected_asset_number: null, expected_serial_number: null, reason: 'สะกดผิด' },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(correctedName.statusCode).toBe(200);

      expect(await entriesOf(roundId)).toEqual(before);
      expect(before.items.map((item: any) => item.snapshot.location.id)).toEqual([roomA.id, roomA.id, roomA.id]);
      expect(before.items.map((item: any) => item.snapshot.name).sort()).toEqual(['ตู้ชื่อเดิม', 'ตู้ที่ย้ายภายหลัง', 'ตู้ที่แก้การมอบหมาย'].sort());
    });
  });

  describe('reading', () => {
    it('lists every Round, newest start date first, with its state and counts', async () => {
      const room = await entry('locations', `ห้องรายการ ${crypto.randomUUID()}`);
      await registered({ location_id: room.id });
      await registered({ location_id: room.id });
      const startedOn = async (instant: string, name: string) => {
        now = new Date(instant);
        const roundId = await opened({ name, location_ids: [room.id] });
        return roundId;
      };
      const middle = await startedOn('2026-11-11T05:00:00Z', 'รอบวันที่ 11');
      await closedStandIn();
      const earliest = await startedOn('2026-11-10T05:00:00Z', 'รอบวันที่ 10');
      await closedStandIn();
      const latest = await startedOn('2026-11-12T05:00:00Z', 'รอบวันที่ 12');

      const { items } = await roundsOf();
      const ours = items.filter((round: any) => [middle, earliest, latest].includes(round.id));
      expect(ours).toEqual([
        { id: latest, name: 'รอบวันที่ 12', fiscal_year: 2569, start_date: '2026-11-12', state: 'OPEN', counts: { in_scope: 2, not_yet_verified: 2 } },
        { id: middle, name: 'รอบวันที่ 11', fiscal_year: 2569, start_date: '2026-11-11', state: 'CLOSED', counts: { in_scope: 2, not_yet_verified: 2 } },
        { id: earliest, name: 'รอบวันที่ 10', fiscal_year: 2569, start_date: '2026-11-10', state: 'CLOSED', counts: { in_scope: 2, not_yet_verified: 2 } },
      ]);
      const startDates = items.map((round: any) => round.start_date);
      expect(startDates).toEqual([...startDates].sort().reverse());
    });

    it("searches the snapshot's Asset Number, Serial Number and name in any case, literally", async () => {
      const room = await entry('locations', `ห้องค้นหา ${crypto.randomUUID()}`);
      const tag = crypto.randomUUID().slice(0, 8);
      const byNumber = await registered({ location_id: room.id, asset_number: `KRU-${tag}-01` });
      const bySerial = await registered({ location_id: room.id, serial_number: `sn-${tag}-xy` });
      const byName = await registered({ location_id: room.id, name: `Printer ${tag} 50%_off` });
      const roundId = await opened({ location_ids: [room.id] });
      const found = async (search: string) => (await entriesOf(roundId, `search=${encodeURIComponent(search)}`)).items.map((item: any) => item.asset_id);

      expect(await found(`kru-${tag}`)).toEqual([byNumber]);
      expect(await found(`SN-${tag}-XY`)).toEqual([bySerial]);
      expect(await found(`printer ${tag}`)).toEqual([byName]);
      expect(await found(tag)).toEqual(expect.arrayContaining([byNumber, bySerial, byName]));
      expect(await found('50%_')).toEqual([byName]);
      expect(await found('_')).toEqual([byName]);
      expect(await found(`  ${tag}  `)).toHaveLength(3);
    });

    it('refuses a search that is blank, too long or holds control characters, and a malformed page', async () => {
      await registered();
      const roundId = await opened();

      for (const query of ['search=%20%20', `search=${'a'.repeat(4097)}`, 'search=a%07b', 'limit=0', 'limit=101', 'offset=-1', 'limit=1&limit=2', 'status=FOUND']) {
        const res = await api.get(readonly, `/verification-rounds/${roundId}/entries?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect((await api.get(readonly, `/verification-rounds/${roundId}/entries?search=${encodeURIComponent('a\tb\nc')}`)).statusCode).toBe(200);
    });

    it('pages the snapshot by Asset Number, then name, then Asset, as the Asset list pages', async () => {
      const room = await entry('locations', `ห้องแบ่งหน้า ${crypto.randomUUID()}`);
      const tag = crypto.randomUUID().slice(0, 8);
      const second = await registered({ location_id: room.id, asset_number: `${tag}-2` });
      const first = await registered({ location_id: room.id, asset_number: `${tag}-1` });
      // Three with no Asset Number and one name: the Asset breaks the tie, across a page break.
      const tied = [
        await registered({ location_id: room.id, name: 'โต๊ะไม่มีเลขครุภัณฑ์' }),
        await registered({ location_id: room.id, name: 'โต๊ะไม่มีเลขครุภัณฑ์' }),
        await registered({ location_id: room.id, name: 'โต๊ะไม่มีเลขครุภัณฑ์' }),
      ].sort();
      const roundId = await opened({ location_ids: [room.id] });

      const pages = [await entriesOf(roundId, 'limit=2'), await entriesOf(roundId, 'limit=2&offset=2'), await entriesOf(roundId, 'limit=2&offset=4')];

      expect(pages.flatMap((page) => page.items.map((item: any) => item.asset_id))).toEqual([first, second, ...tied]);
      expect(pages.map(({ limit, offset, total_count, has_more }) => ({ limit, offset, total_count, has_more }))).toEqual([
        { limit: 2, offset: 0, total_count: 5, has_more: true },
        { limit: 2, offset: 2, total_count: 5, has_more: true },
        { limit: 2, offset: 4, total_count: 5, has_more: false },
      ]);
      const past = await entriesOf(roundId, 'offset=10');
      expect(past).toEqual({ items: [], limit: 25, offset: 10, total_count: 5, has_more: false });
    });

    it('answers a Round that does not exist with 404, and a malformed id with 400', async () => {
      for (const url of [`/verification-rounds/${crypto.randomUUID()}`, `/verification-rounds/${crypto.randomUUID()}/entries`]) {
        const res = await api.get(readonly, url);
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
      }
      for (const url of ['/verification-rounds/not-a-uuid', '/verification-rounds/not-a-uuid/entries']) {
        expect((await api.get(readonly, url)).statusCode).toBe(400);
      }
    });
  });

  describe('authorization', () => {
    it('refuses an opening by every role without verification:manage, and saves nothing', async () => {
      await registered();
      const maintainer = await api.actor('maintainer_verification', 'SYSTEM_MAINTAINER');
      const before = (await roundsOf()).items.length;

      for (const actor of [staff, readonly, admin, maintainer]) {
        const res = await open(opening(), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('needs verification:manage itself, and fails closed when the lookup fails, saving nothing', async () => {
      await registered();
      const before = (await roundsOf()).items.length;

      expect((await withCapabilityAnswer(api.app, 'verification:manage', async () => false, () => open(opening()))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'verification:manage', async () => { throw new Error('lookup failed'); }, () => open(opening()));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      await registered();
      const before = (await roundsOf()).items.length;
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: '/verification-rounds', headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: opening() });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_verification', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await open(opening(), crypto.randomUUID(), leaving)).statusCode);

      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('tells the Round list whether the viewer may open a Round, which follows verification:manage alone', async () => {
      expect((await roundsOf(custodian)).can_manage_verification).toBe(true);
      for (const actor of [staff, admin, readonly]) {
        expect((await roundsOf(actor)).can_manage_verification).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'verification:manage', async () => false, () => api.get(custodian, '/verification-rounds'));
      expect(denied.json().can_manage_verification).toBe(false);
    });

    it('lets every role with asset:view read Rounds and their snapshots, and no one else', async () => {
      const room = await entry('locations', `ห้องสิทธิ์ ${crypto.randomUUID()}`);
      const assetId = await registered({ location_id: room.id, name: 'ของที่ทุกคนเห็น' });
      const roundId = await opened({ name: 'รอบที่ทุกคนเห็น', location_ids: [room.id] });
      const maintainer = await api.actor('maintainer_verification_reader', 'SYSTEM_MAINTAINER');

      for (const reader of [custodian, admin, readonly, staff]) {
        expect((await roundsOf(reader)).items.map(({ id }: any) => id)).toContain(roundId);
        expect((await roundOf(roundId, reader)).name).toBe('รอบที่ทุกคนเห็น');
        expect((await entriesOf(roundId, 'limit=25', reader)).items.map((item: any) => item.asset_id)).toEqual([assetId]);
      }
      for (const url of ['/verification-rounds', `/verification-rounds/${roundId}`, `/verification-rounds/${roundId}/entries`]) {
        const res = await api.get(maintainer, url);
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain(roundId);
      }
    });

    it('needs asset:view itself to read: denying it alone, or failing to look it up, shows nothing', async () => {
      const room = await entry('locations', `ห้องปิดบัง ${crypto.randomUUID()}`);
      await registered({ location_id: room.id, name: 'ของที่ไม่ควรเห็น' });
      const roundId = await opened({ name: 'รอบที่ไม่ควรเห็น', location_ids: [room.id] });

      for (const url of ['/verification-rounds', `/verification-rounds/${roundId}`, `/verification-rounds/${roundId}/entries`]) {
        const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('รอบที่ไม่ควรเห็น');
        expect(denied.body).not.toContain('ของที่ไม่ควรเห็น');

        const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('รอบที่ไม่ควรเห็น');
      }
    });

    it('shows nothing without a session', async () => {
      await registered();
      const roundId = await opened();

      for (const url of ['/verification-rounds', `/verification-rounds/${roundId}`, `/verification-rounds/${roundId}/entries`]) {
        const res = await api.app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain(roundId);
      }
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      await registered();
      const before = (await roundsOf()).items.length;

      const res = await api.post(custodian, '/verification-rounds', opening());

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('answers an identical replay with the committed Round and writes nothing', async () => {
      await registered();
      const token = crypto.randomUUID();
      const first = await open(opening(), token);
      expect(first.statusCode).toBe(201);
      const before = (await roundsOf()).items.length;

      const replay = await open(opening(), token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      await registered();
      const token = crypto.randomUUID();
      expect((await open(opening(), token)).statusCode).toBe(201);
      await closedStandIn();
      const before = (await roundsOf()).items.length;

      for (const changed of [opening({ name: 'ชื่ออื่น' }), opening({ notes: 'หมายเหตุ' })]) {
        const res = await open(changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect((await roundsOf()).items).toHaveLength(before);
    });

    it('scopes a token to its actor', async () => {
      await registered();
      const otherCustodian = await api.actor('custodian_verification_two', 'ASSET_CUSTODIAN');
      const token = crypto.randomUUID();

      const first = await open(opening(), token);
      expect(first.statusCode).toBe(201);
      await closedStandIn();
      const second = await open(opening(), token, otherCustodian);

      expect(second.statusCode).toBe(201);
      expect(second.json().verification_round_id).not.toBe(first.json().verification_round_id);
    });

    it('writes once for concurrent identical submissions, each answered with the committed Round', async () => {
      await registered();
      const token = crypto.randomUUID();
      const before = (await roundsOf()).items.length;

      const responses = await Promise.all(Array.from({ length: 8 }, () => open(opening(), token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().verification_round_id)).size).toBe(1);
      expect((await roundsOf()).items).toHaveLength(before + 1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      await registered();
      await opened();
      const token = crypto.randomUUID();

      expect((await open(opening(), token)).statusCode).toBe(409);
      await closedStandIn();

      expect((await open(opening(), token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the Round, its snapshot nor the receipt, and answers in the deterministic shape', async () => {
      await registered();
      const token = 'verification-fail-token';
      const before = (await roundsOf()).items.length;
      await api.pool.query(`
        CREATE FUNCTION fail_scope_entry() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected verification failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_scope_entry BEFORE INSERT ON verification_scope_entries
          FOR EACH ROW EXECUTE FUNCTION fail_scope_entry();
      `);
      try {
        const res = await open(opening(), token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected verification failure');
        expect((await roundsOf()).items).toHaveLength(before);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_scope_entry ON verification_scope_entries; DROP FUNCTION fail_scope_entry();');
      }
      expect((await open(opening(), token)).statusCode).toBe(201);
    });

    it('commits the Round and its receipt together, or neither', async () => {
      await registered();
      const token = 'verification-receipt-fail-token';
      const before = (await roundsOf()).items.length;
      await api.pool.query(`
        CREATE FUNCTION fail_verification_receipt() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'verification-receipt-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_verification_receipt BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_verification_receipt();
      `);
      try {
        expect((await open(opening(), token)).statusCode).toBe(500);
        expect((await roundsOf()).items).toHaveLength(before);
      } finally {
        await api.pool.query('DROP TRIGGER fail_verification_receipt ON registration_retry_tokens; DROP FUNCTION fail_verification_receipt();');
      }
      expect((await open(opening(), token)).statusCode).toBe(201);
    });
  });
});
