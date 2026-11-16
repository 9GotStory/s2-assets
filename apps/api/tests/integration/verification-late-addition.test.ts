import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F006-T5 (#130): an Asset Custodian adds an Asset that is not in the open Round, from its Asset page, with a
// reason (Late Addition); it joins the Scope Snapshot as it is then and is verified like any other.
describe('Late Addition to the open Round (Seam A - F006-T5)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 12 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-12T05:00:00Z');

  const { entry, detailOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { opened, roundOf, entriesOf, entryOf, record, recorded, closedStandIn } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // A registered Asset in `room`, placed there on 1 October 2026, with `fields` besides.
  const registeredIn = async (room: { id: string }, fields: Record<string, unknown> = {}): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2026-10-01', ...fields });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room, an open Round over that room alone, and an Asset in another room, outside the Round.
  const roundBeside = async () => {
    const room = await entry('locations', `ห้องในรอบ ${crypto.randomUUID()}`);
    const elsewhere = await entry('locations', `ห้องนอกรอบ ${crypto.randomUUID()}`);
    const inRound = await registeredIn(room);
    const outside = await registeredIn(elsewhere);
    return { room, elsewhere, inRound, outside, roundId: await opened({ location_ids: [room.id] }) };
  };

  // A Late Addition of an Asset to a Round.
  const add = (roundId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/verification-rounds/${roundId}/late-additions`, payload, { 'x-retry-token': token });

  // A Late Addition that is saved, and its answer.
  const added = async (roundId: string, assetId: string, reason = 'พบภายหลัง') => {
    const res = await add(roundId, { asset_id: assetId, reason });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  // A refused Late Addition's answer, with its status and error code.
  const refusedWith = async (res: { statusCode: number; json: () => any }, statusCode: number, code: string) => {
    expect(res.statusCode).toBe(statusCode);
    expect(res.json().code ?? res.json().error?.code).toBe(code);
  };

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

  // How many writes wait on a lock that `pattern` matches in their query text.
  const waitersOn = async (pattern: string): Promise<number> =>
    (await api.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [pattern])).rows[0].n;

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_verification_late', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_verification_late', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_verification_late', 'READ_ONLY');
    staff = await api.actor('staff_verification_late', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    now = new Date('2026-11-12T05:00:00Z');
    await closedStandIn();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('adding', () => {
    it('adds an Asset outside the open Round with a reason, snapshotting its identity and Current Assignment then, with who added it and when (AV-21, Q11)', async () => {
      const { elsewhere, outside, roundId } = await roundBeside();
      const [unit, person] = [await entry('organization-units', `งาน ${crypto.randomUUID()}`), await entry('persons', `คุณ ${crypto.randomUUID()}`)];
      const asset = await registeredIn(elsewhere, { name: 'เครื่องพิมพ์ที่พบภายหลัง', asset_number: `LA-${crypto.randomUUID()}`, serial_number: 'SN-LA', organization_unit_id: unit.id, responsible_person_id: person.id });
      const before = Date.now();
      const inScope = (await roundOf(roundId)).counts.in_scope;

      const res = await add(roundId, { asset_id: asset, reason: 'ลงทะเบียนหลังเปิดรอบ\nพบที่ห้องประชุม' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_scope_entry_id: expect.stringMatching(UUID), version: 1 });
      const added = await entryOf(roundId, asset);
      expect(added).toEqual({
        id: res.json().verification_scope_entry_id,
        asset_id: asset,
        joined_as: 'LATE_ADDITION',
        late_addition: {
          reason: 'ลงทะเบียนหลังเปิดรอบ\nพบที่ห้องประชุม',
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_verification_late',
          recorded_at: expect.any(String),
        },
        snapshot: {
          asset_number: expect.stringMatching(/^LA-/),
          serial_number: 'SN-LA',
          name: 'เครื่องพิมพ์ที่พบภายหลัง',
          category: null,
          location: { id: elsewhere.id, name: elsewhere.name, is_active: true },
          organization_unit: { id: unit.id, name: unit.name, is_active: true },
          responsible_person: { id: person.id, name: person.name, is_active: true },
          legacy_location_text: null,
          legacy_organization_unit_text: null,
          legacy_responsible_person_text: null,
        },
        result: 'NOT_YET_VERIFIED',
        current: null,
        version: 1,
        revision_count: 0,
      });
      expect(Date.parse(added.late_addition.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(added.late_addition.recorded_at)).toBeLessThanOrEqual(Date.now());
      expect((await roundOf(roundId)).counts).toMatchObject({ in_scope: inScope + 1, not_yet_verified: inScope + 1 });
      expect((await entryOf(roundId, outside))).toBeUndefined();
    });

    it('snapshots the Asset as it is when added: a Reassignment after the Round opened shows, and one after the addition does not (Q4, Q15)', async () => {
      const { outside, roundId } = await roundBeside();
      const [moved, later] = [await entry('locations', `ห้องที่ย้ายไป ${crypto.randomUUID()}`), await entry('locations', `ห้องหลังเพิ่ม ${crypto.randomUUID()}`)];
      await reassigned(outside, moved, '2026-11-12');

      await added(roundId, outside);
      await reassigned(outside, later, '2026-11-12');

      expect((await entryOf(roundId, outside)).snapshot.location).toEqual({ id: moved.id, name: moved.name, is_active: true });
    });

    it('keeps a Legacy-text Current Assignment as Legacy text', async () => {
      const { roundId } = await roundBeside();
      const res = await api.post(custodian, '/assets', { name: `ของเดิม ${crypto.randomUUID()}`, legacy_location_text: 'ห้องเก่าชั้น 2', effective_date: '2026-10-01' });
      const asset = res.json().asset.id;

      await added(roundId, asset);

      expect((await entryOf(roundId, asset)).snapshot).toMatchObject({ location: null, legacy_location_text: 'ห้องเก่าชั้น 2' });
    });

    it('adds no Asset by itself: one registered while the Round is open, even in its filtered Location, stays outside it until added (AV-18)', async () => {
      const { room, roundId } = await roundBeside();
      const inScope = (await roundOf(roundId)).counts.in_scope;

      const fresh = await registeredIn(room);

      expect((await roundOf(roundId)).counts.in_scope).toBe(inScope);
      expect(await entryOf(roundId, fresh)).toBeUndefined();
      expect((await detailOf(fresh)).verification.entry).toBeNull();
      await added(roundId, fresh, 'ลงทะเบียนหลังเปิดรอบ');
      expect((await detailOf(fresh)).verification.entry).toMatchObject({ result: 'NOT_YET_VERIFIED', version: 1 });
    });

    it('offers no way to remove an Asset from a Scope Snapshot: no route but GET and POST names an entry or an Asset of a Round (Q11)', async () => {
      await api.app.ready();
      // The paths the API serves for `method`. Fastify 5.12.5 prints them as a tree, a segment a line, each child
      // four characters deeper than its parent, with the methods after a segment that is a route.
      const pathsServed = (method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'): string[] => {
        const segments: string[] = [];
        const paths: string[] = [];
        for (const line of api.app.printRoutes({ method, commonPrefix: false }).split('\n')) {
          const node = line.match(/^((?:[│ ] {3})*)[├└]── (\S+)( \(.*\))?$/);
          if (node) {
            segments.length = node[1].length / 4;
            segments.push(node[2]);
            if (node[3]) paths.push(segments.join(''));
          }
        }
        return paths;
      };
      // What a write that removes an Asset from a Round would address. A write on the Round itself, such as an
      // edit of its name (F006-T6), is outside this rule.
      const namesScope = (path: string) => /^\/verification-rounds\/:id\/(entries|assets|late-additions)/.test(path);

      expect(pathsServed('GET')).toContain('/verification-rounds/:id/entries');
      expect(pathsServed('POST')).toContain('/verification-rounds/:id/late-additions');
      for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
        expect(pathsServed(method).filter(namesScope)).toEqual([]);
      }
    });
  });

  describe('verifying an added Asset', () => {
    it('is Not Yet Verified, takes a first result like any other, and its Verification Date is still bounded by the Round start date (AV-18)', async () => {
      const { outside, roundId } = await roundBeside();
      now = new Date('2026-11-14T05:00:00Z');
      await added(roundId, outside);

      const early = await record(roundId, outside, { result: 'FOUND', condition: 'NORMAL', verification_date: '2026-11-11' });
      expect(early.statusCode).toBe(400);
      expect(early.json().message).toContain('must not be before the start date of the Verification Round (2026-11-12)');
      await recorded(roundId, outside, { verification_date: '2026-11-12' }, staff);

      expect(await entryOf(roundId, outside)).toMatchObject({ joined_as: 'LATE_ADDITION', result: 'FOUND', version: 2, current: { verification_date: '2026-11-12' } });
      expect((await roundOf(roundId)).counts.found).toBe(1);
      expect((await api.get(readonly, `/assets/${outside}/verifications`)).json().items).toMatchObject([{ round: { id: roundId }, joined_as: 'LATE_ADDITION', result: 'FOUND' }]);
    });
  });

  describe('refusals', () => {
    it('refuses an Asset already in the Round, whether it joined at opening or as a Late Addition, and saves nothing', async () => {
      const { inRound, outside, roundId } = await roundBeside();
      await added(roundId, outside, 'ครั้งแรก');

      await refusedWith(await add(roundId, { asset_id: inRound, reason: 'ซ้ำ' }), 409, 'ASSET_ALREADY_IN_VERIFICATION_SCOPE');
      await refusedWith(await add(roundId, { asset_id: outside, reason: 'ซ้ำ' }), 409, 'ASSET_ALREADY_IN_VERIFICATION_SCOPE');

      expect((await entryOf(roundId, inRound))).toMatchObject({ joined_as: 'OPENING', late_addition: null });
      expect((await entryOf(roundId, outside)).late_addition.reason).toBe('ครั้งแรก');
    });

    it('refuses a Late Addition to a Round that is not open, and saves nothing (AV-17)', async () => {
      const { outside, roundId } = await roundBeside();
      await closedStandIn();

      await refusedWith(await add(roundId, { asset_id: outside, reason: 'หลังปิดรอบ' }), 409, 'VERIFICATION_ROUND_NOT_OPEN');

      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('answers a Round or an Asset that does not exist with 404, and a malformed id with 400', async () => {
      const { outside, roundId } = await roundBeside();

      await refusedWith(await add(crypto.randomUUID(), { asset_id: outside, reason: 'พบ' }), 404, 'NOT_FOUND');
      await refusedWith(await add(roundId, { asset_id: crypto.randomUUID(), reason: 'พบ' }), 404, 'NOT_FOUND');
      await refusedWith(await add('not-a-uuid', { asset_id: outside, reason: 'พบ' }), 400, 'INVALID_ID');
      const malformed = await add(roundId, { asset_id: 'not-a-uuid', reason: 'พบ' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().message).toContain('asset_id must be a valid UUID');
      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('takes an Asset id in any case and with surrounding spaces', async () => {
      const { outside, roundId } = await roundBeside();

      await added(roundId, ` ${outside.toUpperCase()} `);

      expect((await entryOf(roundId, outside)).joined_as).toBe('LATE_ADDITION');
    });

    it('needs a nonblank reason, keeping tabs and line breaks inside it and refusing one too long or holding a control character', async () => {
      const { outside, roundId } = await roundBeside();
      const refusal = async (payload: Record<string, unknown>, message: string) => {
        const res = await add(roundId, { asset_id: outside, ...payload });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain(message);
      };

      await refusal({}, 'Invalid request payload: reason:');
      await refusal({ reason: ' \n ' }, 'A Late Addition needs a reason');
      await refusal({ reason: 'ก'.repeat(2001) }, 'reason must be at most 2000 characters');
      await refusal({ reason: 'พบ\u0007ภายหลัง' }, 'reason must not contain control characters');
      expect(await entryOf(roundId, outside)).toBeUndefined();

      await added(roundId, outside, ` ${'ก'.repeat(1990)}\tพบ\nห้อง `);
      expect((await entryOf(roundId, outside)).late_addition.reason).toBe(`${'ก'.repeat(1990)}\tพบ\nห้อง`);
    });
  });

  describe('order and concurrency', () => {
    it('ends concurrent Late Additions of one Asset, on independent connections, with exactly one scope entry; the others are refused', async () => {
      const { outside, roundId } = await roundBeside();

      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => add(roundId, { asset_id: outside, reason: `พบ ${i}` })));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json().code).toBe('ASSET_ALREADY_IN_VERIFICATION_SCOPE');
      }
      const winner = results.find((res) => res.statusCode === 201)!;
      expect((await entryOf(roundId, outside)).id).toBe(winner.json().verification_scope_entry_id);
    });

    it('meets a Late Addition still uncommitted on another connection at the unique scope entry, and is refused once it commits', async () => {
      const { outside, roundId } = await roundBeside();
      const holder = await api.pool.connect();
      let pending: ReturnType<typeof add> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO verification_scope_entries (verification_round_id, asset_id, joined_as, reason, recorded_by) VALUES ($1, $2, 'LATE_ADDITION', 'บนอีกการเชื่อมต่อ', $3)`,
          [roundId, outside, custodian.id]
        );
        pending = add(roundId, { asset_id: outside, reason: 'พบ' });
        await expect.poll(() => waitersOn('%INSERT INTO verification_scope_entries%'), { timeout: 10_000, interval: 50 }).toBe(1);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }

      await refusedWith(await pending!, 409, 'ASSET_ALREADY_IN_VERIFICATION_SCOPE');
      expect((await entryOf(roundId, outside)).late_addition.reason).toBe('บนอีกการเชื่อมต่อ');
    });

    it('reads the Round state under its row lock: a Round closed by a write the addition waits on is refused', async () => {
      const { outside, roundId } = await roundBeside();
      // The holder stands in for a close in flight: it has closed the Round and not yet committed.
      const holder = await api.pool.connect();
      let pending: ReturnType<typeof add> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE verification_rounds SET state = 'CLOSED', version = version + 1 WHERE id = $1`, [roundId]);
        pending = add(roundId, { asset_id: outside, reason: 'พบ' });
        await expect.poll(() => waitersOn('%FROM verification_rounds WHERE id%FOR SHARE%'), { timeout: 10_000, interval: 50 }).toBe(1);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }

      await refusedWith(await pending!, 409, 'VERIFICATION_ROUND_NOT_OPEN');
      expect(await entryOf(roundId, outside)).toBeUndefined();
    });
  });

  describe('reading', () => {
    it('filters the Round by how an Asset joined, and refuses a value it does not know (AV-19, AV-21)', async () => {
      const { inRound, outside, roundId } = await roundBeside();
      await added(roundId, outside);
      const idsOf = async (query: string) => (await entriesOf(roundId, `limit=100&${query}`)).items.map((item: any) => item.asset_id);

      expect(await idsOf('joined_as=LATE_ADDITION')).toEqual([outside]);
      expect(await idsOf('joined_as=OPENING')).toEqual([inRound]);
      expect((await entriesOf(roundId, 'joined_as=LATE_ADDITION')).total_count).toBe(1);
      expect((await api.get(readonly, `/verification-rounds/${roundId}/entries?joined_as=IMPORTED`)).statusCode).toBe(400);
    });

    it('shows who added a Late Addition, when and why, to every role with asset:view', async () => {
      const { outside, roundId } = await roundBeside();
      await added(roundId, outside, 'เหตุที่ทุกคนเห็น');

      for (const reader of [custodian, admin, readonly, staff]) {
        expect(await entryOf(roundId, outside, reader)).toMatchObject({ late_addition: { reason: 'เหตุที่ทุกคนเห็น', recorded_by: custodian.id } });
      }
    });
  });

  describe('authorization', () => {
    it('refuses a Late Addition by every role without verification:manage, and saves nothing', async () => {
      const { outside, roundId } = await roundBeside();
      const maintainer = await api.actor('maintainer_verification_late', 'SYSTEM_MAINTAINER');

      for (const actor of [staff, readonly, admin, maintainer]) {
        await refusedWith(await add(roundId, { asset_id: outside, reason: 'พบ' }, crypto.randomUUID(), actor), 403, 'FORBIDDEN');
      }
      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('needs verification:manage itself, and fails closed when the lookup fails, saving nothing', async () => {
      const { outside, roundId } = await roundBeside();
      const addOnce = () => add(roundId, { asset_id: outside, reason: 'พบ' });

      expect((await withCapabilityAnswer(api.app, 'verification:manage', async () => false, addOnce)).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'verification:manage', async () => { throw new Error('lookup failed'); }, addOnce);
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('needs a session and the CSRF token, and an inactive user is refused, saving nothing', async () => {
      const { outside, roundId } = await roundBeside();
      const payload = { asset_id: outside, reason: 'พบ' };
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/verification-rounds/${roundId}/late-additions`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload,
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('custodian_inactive_verification_late', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await add(roundId, payload, crypto.randomUUID(), leaving)).statusCode);

      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('tells the Asset page whether the viewer may add an Asset to the Round, which follows verification:manage alone', async () => {
      const { outside } = await roundBeside();

      expect((await api.get(custodian, `/assets/${outside}`)).json().can_manage_verification).toBe(true);
      for (const actor of [staff, readonly, admin]) {
        expect((await api.get(actor, `/assets/${outside}`)).json().can_manage_verification).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'verification:manage', async () => false, () => api.get(custodian, `/assets/${outside}`));
      expect(denied.json().can_manage_verification).toBe(false);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const { outside, roundId } = await roundBeside();

      expect((await api.post(custodian, `/verification-rounds/${roundId}/late-additions`, { asset_id: outside, reason: 'พบ' })).statusCode).toBe(400);
      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('answers an identical replay with the committed answer, and refuses the same token with a changed payload, writing nothing more', async () => {
      const { outside, roundId } = await roundBeside();
      const other = await registeredIn(await entry('locations', `ห้องอื่น ${crypto.randomUUID()}`));
      const token = crypto.randomUUID();
      const first = await add(roundId, { asset_id: outside, reason: 'พบ' }, token);

      const replay = await add(roundId, { asset_id: outside, reason: 'พบ' }, token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      await refusedWith(await add(roundId, { asset_id: outside, reason: 'พบที่อื่น' }, token), 409, 'RETRY_TOKEN_PAYLOAD_MISMATCH');
      await refusedWith(await add(roundId, { asset_id: other, reason: 'พบ' }, token), 409, 'RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect((await entryOf(roundId, outside)).late_addition.reason).toBe('พบ');
      expect(await entryOf(roundId, other)).toBeUndefined();
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const { outside, roundId } = await roundBeside();
      const token = crypto.randomUUID();
      await api.pool.query(`UPDATE verification_rounds SET state = 'CLOSED' WHERE id = $1`, [roundId]);
      await refusedWith(await add(roundId, { asset_id: outside, reason: 'พบ' }, token), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await api.pool.query(`UPDATE verification_rounds SET state = 'OPEN' WHERE id = $1`, [roundId]);

      expect((await add(roundId, { asset_id: outside, reason: 'พบ' }, token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the scope entry nor the receipt, and answers in the deterministic shape', async () => {
      const { outside, roundId } = await roundBeside();
      const token = 'verification-late-addition-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_verification_late_addition() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected late addition failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_verification_late_addition AFTER INSERT ON verification_scope_entries
          FOR EACH ROW EXECUTE FUNCTION fail_verification_late_addition();
      `);
      try {
        const res = await add(roundId, { asset_id: outside, reason: 'พบ' }, token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected late addition failure');
        expect(await entryOf(roundId, outside)).toBeUndefined();
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_verification_late_addition ON verification_scope_entries; DROP FUNCTION fail_verification_late_addition();');
      }
      expect((await add(roundId, { asset_id: outside, reason: 'พบ' }, token)).statusCode).toBe(201);
    });
  });
});
