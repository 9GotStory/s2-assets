import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { VerificationRoundService } from '../../src/services/verification-round.service.ts';
import { VerificationService } from '../../src/services/verification.service.ts';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clock = () => new Date('2026-11-12T05:00:00Z');

// F006-T6 (#131): a Verification Round is closed, reopened, edited and voided, and keeps its history.
describe('Close, Reopen, edit and void a Verification Round (Seam A - F006-T6)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;

  const { entry } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { open, opening, opened, roundOf, roundsOf, entryOf, scopeOf, finding, record, recorded, close, closed, reopen, reopened, voidRound, edit, closeOpenRound } =
    verificationHelpers(() => ({ api, custodian, reader: readonly }));

  // A registered Asset in `room`, placed there on 1 October 2026.
  const registeredIn = async (room: { id: string }): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: `ของ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2026-10-01' });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  // A new room, `count` Assets in it, and an open Round over that room alone.
  const roundOver = async (count = 1, overrides: Record<string, unknown> = {}) => {
    const room = await entry('locations', `ห้องปิดรอบ ${crypto.randomUUID()}`);
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      assetIds.push(await registeredIn(room));
    }
    return { room, assetIds, roundId: await opened({ location_ids: [room.id], ...overrides }) };
  };

  // A Round over a room of its own, closed.
  const closedRound = async (overrides: Record<string, unknown> = {}) => {
    const round = await roundOver(1, overrides);
    await closed(round.roundId);
    return round;
  };

  const refusedWith = async (res: { statusCode: number; json: () => any }, statusCode: number, code: string) => {
    expect(res.statusCode).toBe(statusCode);
    expect(res.json().code ?? res.json().error?.code).toBe(code);
  };

  // How many writes wait on a lock that `pattern` matches in their query text.
  const waitersOn = async (pattern: string): Promise<number> =>
    (await api.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [pattern])).rows[0].n;

  const lateAddition = (roundId: string, assetId: string, actor: Actor = custodian) =>
    api.post(actor, `/verification-rounds/${roundId}/late-additions`, { asset_id: assetId, reason: 'พบภายหลัง' }, { 'x-retry-token': crypto.randomUUID() });
  const voidResult = (roundId: string, assetId: string, revisionId: string) =>
    api.post(custodian, `/verification-rounds/${roundId}/assets/${assetId}/verification-corrections`, { verification_revision_id: revisionId, reason: 'บันทึกผิด' }, {
      'x-retry-token': crypto.randomUUID(),
    });
  const openRoundIds = async (): Promise<string[]> => (await roundsOf()).items.filter((round: any) => round.state === 'OPEN').map((round: any) => round.id);
  const eventsOf = async (roundId: string): Promise<string[]> => (await roundOf(roundId)).history.map((event: any) => event.kind);

  // The Round's stored row and history, to show that a refused write changed nothing.
  const storedOf = async (roundId: string) => {
    const { state, name, fiscal_year, notes, version, history } = await roundOf(roundId);
    return { state, name, fiscal_year, notes, version, history };
  };

  /**
   * A pool whose connections, once, run `between` just before a write that met the one-open-Round index rolls back
   * to name the open Round: the moment that Round may close (F006-T1 carry-over, #131).
   */
  const closingBeforeNaming = (between: () => Promise<unknown>) => {
    let pending = true;
    return {
      connect: async () => {
        const client: any = await api.pool.connect();
        const { query, release } = client;
        client.query = async (text: unknown, ...rest: unknown[]) => {
          if (pending && typeof text === 'string' && text.startsWith('ROLLBACK TO SAVEPOINT open_verification_round')) {
            pending = false;
            await between();
          }
          return query.call(client, text, ...rest);
        };
        client.release = (...args: unknown[]) => {
          client.query = query;
          client.release = release;
          return release.apply(client, args);
        };
        return client;
      },
    };
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock });
    admin = await api.actor('admin_round_lifecycle', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_round_lifecycle', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_round_lifecycle', 'READ_ONLY');
    staff = await api.actor('staff_round_lifecycle', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    await closeOpenRound();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('close', () => {
    it('closes an open Round with Assets still Not Yet Verified, which stay so, and stores the counts at that moment in its close event (AV-22, Q9, P4)', async () => {
      const { assetIds: [found, damaged, missing, unchecked], roundId } = await roundOver(4);
      await recorded(roundId, found, {}, staff);
      await recorded(roundId, damaged, { condition: 'DAMAGED' }, staff);
      await recorded(roundId, missing, { result: 'NOT_FOUND', condition: null }, staff);

      const res = await close(roundId, { expected_version: 1 });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_round_id: roundId, version: 2 });
      const round = await roundOf(roundId);
      expect(round.state).toBe('CLOSED');
      expect(round.version).toBe(2);
      expect(round.counts).toEqual({ in_scope: 4, found: 2, not_found: 1, not_yet_verified: 1, with_discrepancy: 1 });
      expect(round.history.map((event: any) => event.kind)).toEqual(['OPENED', 'CLOSED']);
      expect(round.history[1]).toEqual({
        id: expect.stringMatching(UUID),
        kind: 'CLOSED',
        reason: null,
        changes: [],
        counts: { found: 2, not_found: 1, not_yet_verified: 1, with_discrepancy: 1 },
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_round_lifecycle',
        recorded_at: expect.any(String),
      });
      expect((await entryOf(roundId, unchecked)).result).toBe('NOT_YET_VERIFIED');
      expect((await roundsOf()).items.find((item: any) => item.id === roundId).state).toBe('CLOSED');
    });

    it('takes no reason, and refuses a Round already closed or voided, writing nothing', async () => {
      const { roundId } = await roundOver();
      await refusedWith(await close(roundId, { expected_version: 1, reason: 'ไม่ต้องใช้' }), 400, 'VALIDATION_FAILED');
      const version = await closed(roundId);
      const before = await storedOf(roundId);

      await refusedWith(await close(roundId, { expected_version: version }), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      expect(await storedOf(roundId)).toEqual(before);

      const { roundId: voided } = await roundOver();
      expect((await voidRound(voided, { expected_version: 1, reason: 'เปิดผิด' })).statusCode).toBe(201);
      await refusedWith(await close(voided, { expected_version: 2 }), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      expect(await eventsOf(voided)).toEqual(['OPENED', 'VOIDED']);
    });
  });

  describe('a Closed Round (AV-17, AV-24, Q10)', () => {
    it('refuses a first result, a Re-verification, a Verification Correction, a Late Addition and an edit, writing nothing', async () => {
      const { assetIds: [verified, unchecked], roundId } = await roundOver(2);
      const first = await recorded(roundId, verified, {}, staff);
      const outside = await registeredIn(await entry('locations', `ห้องนอกรอบ ${crypto.randomUUID()}`));
      const version = await closed(roundId);
      const before = await storedOf(roundId);

      await refusedWith(await record(roundId, unchecked, finding(), crypto.randomUUID(), staff), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await record(roundId, verified, finding({ expected_revision_id: first.verification_revision_id }), crypto.randomUUID(), staff), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await voidResult(roundId, verified, first.verification_revision_id), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await lateAddition(roundId, outside), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await edit(roundId, { expected_version: version, name: 'ชื่อใหม่' }), 409, 'VERIFICATION_ROUND_NOT_OPEN');

      expect(await storedOf(roundId)).toEqual(before);
      expect((await entryOf(roundId, verified)).revision_count).toBe(1);
      expect((await entryOf(roundId, unchecked)).revision_count).toBe(0);
      expect(await entryOf(roundId, outside)).toBeUndefined();
    });

    it('decides a result under the Round lock: one queued first lands before the close and is counted in its close event', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const { id: entryId } = await entryOf(roundId, assetId);
      let closing: ReturnType<typeof close> | undefined;

      const [recording] = await whileHolding(
        'verification_scope_entries',
        entryId,
        () => [record(roundId, assetId, finding(), crypto.randomUUID(), staff)],
        async () => {
          await untilWaiting('verification_scope_entries');
          closing = close(roundId, { expected_version: 1 });
          await untilWaiting('verification_rounds');
        }
      );

      expect(recording.statusCode).toBe(201);
      expect((await closing!).statusCode).toBe(201);
      const round = await roundOf(roundId);
      expect(round.history[1].counts).toEqual({ found: 1, not_found: 0, not_yet_verified: 0, with_discrepancy: 0 });
      expect(round.counts.found).toBe(1);
    });

    it('decides a result under the Round lock: one queued behind a close in flight finds the Round closed, and lands nothing in it', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      // The holder keeps the close in flight after it closed the Round: its history event waits on the closing account's row.
      const holder = await api.pool.connect();
      let closing: ReturnType<typeof close> | undefined;
      let recording: ReturnType<typeof record> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [custodian.id]);
        closing = close(roundId, { expected_version: 1 });
        await expect.poll(() => waitersOn('%INSERT INTO verification_round_events%'), { timeout: 10_000, interval: 50 }).toBe(1);
        recording = record(roundId, assetId, finding(), crypto.randomUUID(), staff);
        await expect.poll(() => waitersOn('%FROM verification_rounds WHERE id%FOR SHARE%'), { timeout: 10_000, interval: 50 }).toBe(1);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }

      expect((await closing!).statusCode).toBe(201);
      await refusedWith(await recording!, 409, 'VERIFICATION_ROUND_NOT_OPEN');
      expect((await entryOf(roundId, assetId)).revision_count).toBe(0);
      expect((await roundOf(roundId)).history[1].counts).toEqual({ found: 0, not_found: 0, not_yet_verified: 1, with_discrepancy: 0 });
    });
  });

  describe('Reopen (Q10, Q25)', () => {
    it('reopens a Closed Round with a reason and its Scope Snapshot unchanged; results, Re-verification, Verification Correction and Late Addition work again, and closing again adds a new close event', async () => {
      const { assetIds: [verified, unchecked], roundId } = await roundOver(2);
      const first = await recorded(roundId, verified, {}, staff);
      await closed(roundId);
      const scope = await scopeOf(roundId);
      const snapshot = (await entryOf(roundId, verified)).snapshot;

      const res = await reopen(roundId, { expected_version: 2, reason: 'พบว่าบันทึกผิด\nต้องตรวจซ้ำ' }, crypto.randomUUID(), admin);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_round_id: roundId, version: 3 });
      const round = await roundOf(roundId);
      expect(round.state).toBe('OPEN');
      expect(round.history[2]).toEqual({
        id: expect.stringMatching(UUID),
        kind: 'REOPENED',
        reason: 'พบว่าบันทึกผิด\nต้องตรวจซ้ำ',
        changes: [],
        counts: null,
        recorded_by: admin.id,
        recorded_by_username: 'admin_round_lifecycle',
        recorded_at: expect.any(String),
      });
      expect(await scopeOf(roundId)).toEqual(scope);
      expect((await entryOf(roundId, verified)).snapshot).toEqual(snapshot);
      expect((await entryOf(roundId, verified)).current.id).toBe(first.verification_revision_id);

      const again = await recorded(roundId, verified, { expected_revision_id: first.verification_revision_id, result: 'NOT_FOUND', condition: null }, staff);
      expect((await voidResult(roundId, verified, again.verification_revision_id)).statusCode).toBe(201);
      await recorded(roundId, unchecked, {}, staff);
      const outside = await registeredIn(await entry('locations', `ห้องนอกรอบ ${crypto.randomUUID()}`));
      expect((await lateAddition(roundId, outside)).statusCode).toBe(201);

      await closed(roundId);
      const reclosed = await roundOf(roundId);
      expect(reclosed.history.map((event: any) => event.kind)).toEqual(['OPENED', 'CLOSED', 'REOPENED', 'CLOSED']);
      expect(reclosed.history[1].counts).toEqual({ found: 1, not_found: 0, not_yet_verified: 1, with_discrepancy: 0 });
      expect(reclosed.history[3].counts).toEqual({ found: 2, not_found: 0, not_yet_verified: 1, with_discrepancy: 0 });
    });

    it('refuses a Reopen while another Round is open, naming it, and reopens any Closed Round, an older one too, once none is', async () => {
      const { roundId: older } = await closedRound({ name: 'รอบเก่า' });
      const { roundId: newer } = await closedRound({ name: 'รอบใหม่' });
      const { roundId: current } = await roundOver(1, { name: 'รอบที่เปิดอยู่', fiscal_year: 2570 });
      const before = await storedOf(older);

      const refused = await reopen(older, { expected_version: 2, reason: 'แก้ผล' });

      await refusedWith(refused, 409, 'ANOTHER_VERIFICATION_ROUND_OPEN');
      expect(refused.json().open_round).toEqual({ id: current, name: 'รอบที่เปิดอยู่', fiscal_year: 2570, start_date: '2026-11-12' });
      expect(await storedOf(older)).toEqual(before);

      await closed(current);
      await reopened(older);
      expect(await openRoundIds()).toEqual([older]);
      expect((await roundOf(newer)).state).toBe('CLOSED');
    });

    it('refuses a Reopen of a Round that is open or voided, writing nothing', async () => {
      const { roundId } = await roundOver();
      await refusedWith(await reopen(roundId, { expected_version: 1, reason: 'แก้ผล' }), 409, 'VERIFICATION_ROUND_NOT_CLOSED');
      expect(await eventsOf(roundId)).toEqual(['OPENED']);

      expect((await voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' })).statusCode).toBe(201);
      await refusedWith(await reopen(roundId, { expected_version: 2, reason: 'แก้ผล' }), 409, 'VERIFICATION_ROUND_NOT_CLOSED');
      expect(await storedOf(roundId)).toMatchObject({ state: 'VOIDED', version: 2 });
    });

    it('ends concurrent Reopens of two Closed Rounds, on independent connections, with exactly one open Round, and the other names it', async () => {
      const { roundId: first } = await closedRound();
      const { roundId: second } = await closedRound();

      const responses = await Promise.all([reopen(first, { expected_version: 2, reason: 'แก้ผล' }), reopen(second, { expected_version: 2, reason: 'แก้ผล' })]);

      expect(responses.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      const winner = responses[0].statusCode === 201 ? first : second;
      expect(responses.find((res) => res.statusCode === 409)!.json().open_round.id).toBe(winner);
      expect(await openRoundIds()).toEqual([winner]);
    });

    it('ends a Reopen racing an opening, on independent connections, with exactly one open Round', async () => {
      const { roundId: closedId, room } = await closedRound();

      const [reopening, opening_] = await Promise.all([reopen(closedId, { expected_version: 2, reason: 'แก้ผล' }), open(opening({ location_ids: [room.id] }))]);

      expect([reopening.statusCode, opening_.statusCode].sort()).toEqual([201, 409]);
      expect(await openRoundIds()).toHaveLength(1);
      const loser = reopening.statusCode === 409 ? reopening : opening_;
      expect(loser.json().code).toBe('ANOTHER_VERIFICATION_ROUND_OPEN');
      expect(loser.json().open_round.id).toBe((await openRoundIds())[0]);
    });

    it('ends concurrent Reopens of one Round with exactly one REOPENED event; the other is stale', async () => {
      const { roundId } = await closedRound();

      const responses = await Promise.all([reopen(roundId, { expected_version: 2, reason: 'แก้ผล' }), reopen(roundId, { expected_version: 2, reason: 'แก้ผล' })]);

      expect(responses.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      expect(responses.find((res) => res.statusCode === 409)!.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect(await eventsOf(roundId)).toEqual(['OPENED', 'CLOSED', 'REOPENED']);
    });
  });

  describe('the one-open-Round index meeting a Round that closes before it is named (F006-T1 carry-over)', () => {
    it('opens a Round when the open Round it met closes before the refusal can name it', async () => {
      const { roundId: rival } = await roundOver();
      const room = await entry('locations', `ห้องรอบใหม่ ${crypto.randomUUID()}`);
      await registeredIn(room);
      const service = new VerificationService({ db: closingBeforeNaming(() => closed(rival)), clock });

      const round = await service.open(custodian.id, { name: 'รอบถัดไป', fiscal_year: 2569, location_ids: [room.id] }, { retryToken: crypto.randomUUID() });

      expect(await openRoundIds()).toEqual([round.verification_round_id]);
      expect((await roundOf(rival)).state).toBe('CLOSED');
    });

    it('reopens a Closed Round when the open Round it met closes before the refusal can name it', async () => {
      const { roundId: closedId } = await closedRound();
      const { roundId: rival } = await roundOver();
      const service = new VerificationRoundService({ db: closingBeforeNaming(() => closed(rival)) });

      await service.reopen(custodian.id, closedId, { expected_version: 2, reason: 'แก้ผล' }, { retryToken: crypto.randomUUID() });

      expect(await openRoundIds()).toEqual([closedId]);
      expect(await eventsOf(closedId)).toEqual(['OPENED', 'CLOSED', 'REOPENED']);
    });
  });

  describe('edit (Q27)', () => {
    it("changes an open Round's name, fiscal year and notes, and its edit event lists each changed field before and after", async () => {
      const { roundId } = await roundOver(1, { name: 'ตรวจพัสดุ 2569', fiscal_year: 2569, notes: 'คณะกรรมการ: นาย ก' });

      const res = await edit(roundId, { expected_version: 1, name: 'ตรวจสอบพัสดุประจำปี 2569', fiscal_year: 2570, notes: 'คณะกรรมการ:\nนาย ก\nนาง ข' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verification_round_id: roundId, version: 2 });
      const round = await roundOf(roundId);
      expect(round).toMatchObject({ name: 'ตรวจสอบพัสดุประจำปี 2569', fiscal_year: 2570, notes: 'คณะกรรมการ:\nนาย ก\nนาง ข', start_date: '2026-11-12', state: 'OPEN', version: 2 });
      expect(round.history[1]).toEqual({
        id: expect.stringMatching(UUID),
        kind: 'EDITED',
        reason: null,
        changes: [
          { field: 'name', before: 'ตรวจพัสดุ 2569', after: 'ตรวจสอบพัสดุประจำปี 2569' },
          { field: 'fiscal_year', before: 2569, after: 2570 },
          { field: 'notes', before: 'คณะกรรมการ: นาย ก', after: 'คณะกรรมการ:\nนาย ก\nนาง ข' },
        ],
        counts: null,
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_round_lifecycle',
        recorded_at: expect.any(String),
      });
    });

    it('lists only the fields that change, keeps a field left out, and clears notes with null', async () => {
      const { roundId } = await roundOver(1, { name: 'ตรวจพัสดุ', fiscal_year: 2569, notes: 'หมายเหตุเดิม' });

      expect((await edit(roundId, { expected_version: 1, name: 'ตรวจพัสดุ', notes: null })).statusCode).toBe(200);

      const round = await roundOf(roundId);
      expect(round).toMatchObject({ name: 'ตรวจพัสดุ', fiscal_year: 2569, notes: null });
      expect(round.history[1].changes).toEqual([{ field: 'notes', before: 'หมายเหตุเดิม', after: null }]);
    });

    it('refuses an edit that changes nothing, as the server stores it, and one of the start date or the Scope Snapshot, writing nothing', async () => {
      const { roundId } = await roundOver(1, { name: 'ตรวจพัสดุ', fiscal_year: 2569, notes: 'หมายเหตุ' });
      const before = await storedOf(roundId);

      await refusedWith(await edit(roundId, { expected_version: 1, name: '  ตรวจพัสดุ ', fiscal_year: 2569, notes: 'หมายเหตุ  ' }), 400, 'VALIDATION_FAILED');
      await refusedWith(await edit(roundId, { expected_version: 1 }), 400, 'VALIDATION_FAILED');
      // Each with a real change beside it, so that only the field it may not edit refuses it.
      await refusedWith(await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่', start_date: '2026-11-01' }), 400, 'VALIDATION_FAILED');
      await refusedWith(await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่', location_ids: [] }), 400, 'VALIDATION_FAILED');

      expect(await storedOf(roundId)).toEqual(before);
    });

    it('validates each field as an opening does: a nonblank one-line name and a four-digit fiscal year', async () => {
      const { roundId } = await roundOver();
      const before = await storedOf(roundId);

      await refusedWith(await edit(roundId, { expected_version: 1, name: '   ' }), 400, 'VALIDATION_FAILED');
      await refusedWith(await edit(roundId, { expected_version: 1, name: 'สองบรรทัด\nชื่อ' }), 400, 'VALIDATION_FAILED');
      await refusedWith(await edit(roundId, { expected_version: 1, fiscal_year: 256 }), 400, 'VALIDATION_FAILED');
      await refusedWith(await edit(roundId, { expected_version: 1, notes: 'x'.repeat(2001) }), 400, 'VALIDATION_FAILED');

      expect(await storedOf(roundId)).toEqual(before);
    });
  });

  describe('void a Round (Q28)', () => {
    it('voids an open Round with no result, with a reason: it stays listed as voided, is not open, and accepts nothing more', async () => {
      const { assetIds: [assetId], roundId, room } = await roundOver();
      const outside = await registeredIn(await entry('locations', `ห้องนอกรอบ ${crypto.randomUUID()}`));

      const res = await voidRound(roundId, { expected_version: 1, reason: 'เปิดรอบผิดสถานที่' }, crypto.randomUUID(), admin);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ verification_round_id: roundId, version: 2 });
      const round = await roundOf(roundId);
      expect(round.state).toBe('VOIDED');
      expect(round.history[1]).toMatchObject({ kind: 'VOIDED', reason: 'เปิดรอบผิดสถานที่', changes: [], counts: null, recorded_by: admin.id });
      expect((await roundsOf()).items.find((item: any) => item.id === roundId).state).toBe('VOIDED');
      expect(await openRoundIds()).toEqual([]);

      await refusedWith(await record(roundId, assetId, finding(), crypto.randomUUID(), staff), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await lateAddition(roundId, outside), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await edit(roundId, { expected_version: 2, name: 'ชื่อใหม่' }), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      await refusedWith(await voidRound(roundId, { expected_version: 2, reason: 'ซ้ำ' }), 409, 'VERIFICATION_ROUND_NOT_OPEN');
      expect(await storedOf(roundId)).toMatchObject({ state: 'VOIDED', version: 2 });
      expect((await entryOf(roundId, assetId)).revision_count).toBe(0);

      // A voided Round does not block the next one.
      expect((await open(opening({ location_ids: [room.id] }))).statusCode).toBe(201);
    });

    it('refuses to void a Round with a current result, and voids one whose every result is voided', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const first = await recorded(roundId, assetId, {}, staff);

      await refusedWith(await voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' }), 409, 'VERIFICATION_ROUND_HAS_RESULTS');
      expect(await storedOf(roundId)).toMatchObject({ state: 'OPEN', version: 1 });

      expect((await voidResult(roundId, assetId, first.verification_revision_id)).statusCode).toBe(201);
      expect((await voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' })).statusCode).toBe(201);
    });

    it('refuses to void a Closed Round, writing nothing', async () => {
      const { roundId } = await closedRound();
      const before = await storedOf(roundId);

      await refusedWith(await voidRound(roundId, { expected_version: 2, reason: 'เปิดผิด' }), 409, 'VERIFICATION_ROUND_NOT_OPEN');

      expect(await storedOf(roundId)).toEqual(before);
    });

    it('decides under the Round lock: a result queued first makes the void refused', async () => {
      const { assetIds: [assetId], roundId } = await roundOver();
      const { id: entryId } = await entryOf(roundId, assetId);
      let voiding: ReturnType<typeof voidRound> | undefined;

      const [recording] = await whileHolding(
        'verification_scope_entries',
        entryId,
        () => [record(roundId, assetId, finding(), crypto.randomUUID(), staff)],
        async () => {
          await untilWaiting('verification_scope_entries');
          voiding = voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' });
          await untilWaiting('verification_rounds');
        }
      );

      expect(recording.statusCode).toBe(201);
      await refusedWith(await voiding!, 409, 'VERIFICATION_ROUND_HAS_RESULTS');
      expect((await roundOf(roundId)).state).toBe('OPEN');
    });
  });

  describe('reasons', () => {
    it('needs a nonblank reason for a Reopen and a void, keeping tabs and line breaks inside it and refusing one too long or holding a control character', async () => {
      const { roundId: closedId } = await closedRound();
      const before = await storedOf(closedId);
      for (const reason of ['', '   ', 'x'.repeat(2001), 'มี\u0007อักขระ']) {
        await refusedWith(await reopen(closedId, { expected_version: 2, reason }), 400, 'VALIDATION_FAILED');
      }
      expect(await storedOf(closedId)).toEqual(before);
      await refusedWith(await reopen(closedId, { expected_version: 2 }), 400, 'VALIDATION_FAILED');

      const { roundId } = await roundOver();
      for (const reason of ['', '   ', 'x'.repeat(2001), 'มี\u0007อักขระ']) {
        await refusedWith(await voidRound(roundId, { expected_version: 1, reason }), 400, 'VALIDATION_FAILED');
      }
      expect((await roundOf(roundId)).state).toBe('OPEN');

      expect((await voidRound(roundId, { expected_version: 1, reason: ` ${'ก'.repeat(1997)}\t\nข ` })).statusCode).toBe(201);
      expect((await roundOf(roundId)).history[1].reason).toBe(`${'ก'.repeat(1997)}\t\nข`);
    });
  });

  describe('stale version', () => {
    it("refuses a close, Reopen, edit or void against a version the Round no longer has with Feature 003's stale-before conflict, writing nothing", async () => {
      const { roundId } = await roundOver(1, { name: 'ชื่อเดิม' });
      expect((await edit(roundId, { expected_version: 1, name: 'ชื่อที่สอง' })).statusCode).toBe(200);
      const before = await storedOf(roundId);

      for (const res of [
        await close(roundId, { expected_version: 1 }),
        await edit(roundId, { expected_version: 1, name: 'ชื่อที่สาม' }),
        await voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' }),
      ]) {
        await refusedWith(res, 409, 'STALE_BEFORE_CONFLICT');
        expect(res.json()).toMatchObject({ current_values: { version: 2 }, expected_values: { version: 1 } });
      }
      expect(await storedOf(roundId)).toEqual(before);

      await closed(roundId);
      const closedBefore = await storedOf(roundId);
      const stale = await reopen(roundId, { expected_version: 2, reason: 'แก้ผล' });
      await refusedWith(stale, 409, 'STALE_BEFORE_CONFLICT');
      expect(stale.json()).toMatchObject({ current_values: { version: 3 }, expected_values: { version: 2 } });
      expect(await storedOf(roundId)).toEqual(closedBefore);
    });

    it('answers a Round that does not exist with 404, and a malformed id or version with 400', async () => {
      const missing = crypto.randomUUID();
      await refusedWith(await close(missing, { expected_version: 1 }), 404, 'NOT_FOUND');
      await refusedWith(await reopen(missing, { expected_version: 1, reason: 'แก้ผล' }), 404, 'NOT_FOUND');
      await refusedWith(await edit(missing, { expected_version: 1, name: 'ชื่อ' }), 404, 'NOT_FOUND');
      await refusedWith(await voidRound(missing, { expected_version: 1, reason: 'เปิดผิด' }), 404, 'NOT_FOUND');
      await refusedWith(await close('not-a-uuid', { expected_version: 1 }), 400, 'INVALID_ID');
      await refusedWith(await edit('not-a-uuid', { expected_version: 1, name: 'ชื่อ' }), 400, 'INVALID_ID');

      const { roundId } = await roundOver();
      for (const expected of [0, 1.5, '1', null]) {
        await refusedWith(await close(roundId, { expected_version: expected }), 400, 'VALIDATION_FAILED');
      }
      await refusedWith(await close(roundId, {}), 400, 'VALIDATION_FAILED');
      expect((await roundOf(roundId)).state).toBe('OPEN');
    });
  });

  describe('reading', () => {
    it('shows the whole history in order, each event with its actor, Recorded At and reason, to every role with asset:view', async () => {
      const { roundId } = await roundOver(1, { name: 'ชื่อเดิม' });
      await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' });
      await closed(roundId);
      await reopened(roundId, 'ตรวจซ้ำ', admin);
      await closed(roundId);

      for (const actor of [readonly, staff, admin, custodian]) {
        const { history } = await roundOf(roundId, actor);
        expect(history.map(({ kind, reason, recorded_by }: any) => ({ kind, reason, recorded_by }))).toEqual([
          { kind: 'OPENED', reason: null, recorded_by: custodian.id },
          { kind: 'EDITED', reason: null, recorded_by: custodian.id },
          { kind: 'CLOSED', reason: null, recorded_by: custodian.id },
          { kind: 'REOPENED', reason: 'ตรวจซ้ำ', recorded_by: admin.id },
          { kind: 'CLOSED', reason: null, recorded_by: custodian.id },
        ]);
        expect(history.every((event: any) => typeof event.recorded_at === 'string')).toBe(true);
      }
    });

    it("tells the Round page whether the viewer may close and edit, which follows verification:manage, or reopen and void, which follows verification:correct", async () => {
      const { roundId } = await roundOver();
      const maintainer = await api.actor('maintainer_round_lifecycle_reader', 'SYSTEM_MAINTAINER');
      const flagsOf = async (actor: Actor) => {
        const { can_manage_verification, can_correct_verification } = await roundOf(roundId, actor);
        return { can_manage_verification, can_correct_verification };
      };

      expect(await flagsOf(custodian)).toEqual({ can_manage_verification: true, can_correct_verification: true });
      expect(await flagsOf(admin)).toEqual({ can_manage_verification: false, can_correct_verification: true });
      for (const actor of [staff, readonly]) {
        expect(await flagsOf(actor)).toEqual({ can_manage_verification: false, can_correct_verification: false });
      }
      expect((await api.get(maintainer, `/verification-rounds/${roundId}`)).statusCode).toBe(403);
      expect(await withCapabilityAnswer(api.app, 'verification:manage', async () => false, () => flagsOf(custodian))).toEqual({
        can_manage_verification: false,
        can_correct_verification: true,
      });
      expect(await withCapabilityAnswer(api.app, 'verification:correct', async () => false, () => flagsOf(custodian))).toEqual({
        can_manage_verification: true,
        can_correct_verification: false,
      });
    });
  });

  describe('authorization', () => {
    it('refuses a close and an edit by every role without verification:manage, an Administrator too, and a Reopen and a void by every role without verification:correct, writing nothing', async () => {
      const maintainer = await api.actor('maintainer_round_lifecycle', 'SYSTEM_MAINTAINER');
      const { roundId: closedId } = await closedRound();
      const { roundId } = await roundOver();
      const before = [await storedOf(roundId), await storedOf(closedId)];

      for (const actor of [admin, staff, readonly, maintainer]) {
        await refusedWith(await close(roundId, { expected_version: 1 }, crypto.randomUUID(), actor), 403, 'FORBIDDEN');
        await refusedWith(await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' }, crypto.randomUUID(), actor), 403, 'FORBIDDEN');
      }
      for (const actor of [staff, readonly, maintainer]) {
        await refusedWith(await voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' }, crypto.randomUUID(), actor), 403, 'FORBIDDEN');
      }
      await closed(roundId);
      for (const actor of [staff, readonly, maintainer]) {
        await refusedWith(await reopen(closedId, { expected_version: 2, reason: 'แก้ผล' }, crypto.randomUUID(), actor), 403, 'FORBIDDEN');
      }

      expect((await storedOf(roundId)).history.map((event: any) => event.kind)).toEqual(['OPENED', 'CLOSED']);
      expect((await storedOf(roundId)).name).toBe(before[0].name);
      expect(await storedOf(closedId)).toEqual(before[1]);
    });

    it('needs verification:manage itself to close and edit, failing closed when the lookup fails, writing nothing', async () => {
      const { roundId } = await roundOver(1, { name: 'ชื่อเดิม' });
      const before = await storedOf(roundId);
      const failing = async (): Promise<boolean> => {
        throw new Error('lookup failed');
      };

      for (const write of [() => close(roundId, { expected_version: 1 }), () => edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' })]) {
        expect((await withCapabilityAnswer(api.app, 'verification:manage', async () => false, write)).statusCode).toBe(403);
        expect((await withCapabilityAnswer(api.app, 'verification:manage', failing, write)).statusCode).toBe(500);
      }

      expect(await storedOf(roundId)).toEqual(before);
    });

    it('needs verification:correct itself to reopen and void, failing closed when the lookup fails, writing nothing', async () => {
      const { roundId: closedId } = await closedRound();
      const closedBefore = await storedOf(closedId);
      const { roundId } = await roundOver();
      const before = await storedOf(roundId);
      const failing = async (): Promise<boolean> => {
        throw new Error('lookup failed');
      };

      for (const write of [() => voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' })]) {
        expect((await withCapabilityAnswer(api.app, 'verification:correct', async () => false, write)).statusCode).toBe(403);
        expect((await withCapabilityAnswer(api.app, 'verification:correct', failing, write)).statusCode).toBe(500);
      }
      expect(await storedOf(roundId)).toEqual(before);

      await closed(roundId);
      const reopening = () => reopen(closedId, { expected_version: 2, reason: 'แก้ผล' });
      expect((await withCapabilityAnswer(api.app, 'verification:correct', async () => false, reopening)).statusCode).toBe(403);
      expect((await withCapabilityAnswer(api.app, 'verification:correct', failing, reopening)).statusCode).toBe(500);
      expect(await storedOf(closedId)).toEqual(closedBefore);
    });

    it('needs a session and the CSRF token, and an inactive user is refused, writing nothing', async () => {
      const { roundId } = await roundOver();
      const before = await storedOf(roundId);
      const inject = (method: 'POST' | 'PATCH', url: string, payload: unknown, headers: Record<string, string>) =>
        api.app.inject({ method, url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: payload as any });
      const leaving = await api.actor('custodian_inactive_round_lifecycle', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);

      for (const [method, url, payload] of [
        ['POST', `/verification-rounds/${roundId}/close`, { expected_version: 1 }],
        ['PATCH', `/verification-rounds/${roundId}`, { expected_version: 1, name: 'ชื่อใหม่' }],
        ['POST', `/verification-rounds/${roundId}/void`, { expected_version: 1, reason: 'เปิดผิด' }],
        ['POST', `/verification-rounds/${roundId}/reopen`, { expected_version: 1, reason: 'แก้ผล' }],
      ] as const) {
        expect([401, 403]).toContain((await inject(method, url, payload, {})).statusCode);
        expect((await inject(method, url, payload, { cookie: custodian.cookie })).statusCode).toBe(403);
        expect([401, 403]).toContain((await inject(method, url, payload, { cookie: leaving.cookie, 'x-csrf-token': leaving.csrf })).statusCode);
      }

      expect(await storedOf(roundId)).toEqual(before);
    });
  });

  describe('retry token', () => {
    it('answers an identical replay with the committed answer and writes nothing more, and refuses the same token with a changed payload', async () => {
      const { roundId } = await roundOver(1, { name: 'ชื่อเดิม' });
      const editToken = crypto.randomUUID();
      const edited = await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' }, editToken);
      expect((await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' }, editToken)).json()).toEqual(edited.json());
      await refusedWith(await edit(roundId, { expected_version: 1, name: 'ชื่ออื่น' }, editToken), 409, 'RETRY_TOKEN_PAYLOAD_MISMATCH');

      const closeToken = crypto.randomUUID();
      const first = await close(roundId, { expected_version: 2 }, closeToken);
      const replay = await close(roundId, { expected_version: 2 }, closeToken);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const reopenToken = crypto.randomUUID();
      const reopenedOnce = await reopen(roundId, { expected_version: 3, reason: 'แก้ผล' }, reopenToken);
      expect((await reopen(roundId, { expected_version: 3, reason: 'แก้ผล' }, reopenToken)).json()).toEqual(reopenedOnce.json());
      await refusedWith(await reopen(roundId, { expected_version: 3, reason: 'เหตุผลอื่น' }, reopenToken), 409, 'RETRY_TOKEN_PAYLOAD_MISMATCH');

      expect(await eventsOf(roundId)).toEqual(['OPENED', 'EDITED', 'CLOSED', 'REOPENED']);
      expect((await roundOf(roundId)).name).toBe('ชื่อใหม่');
    });

    it('needs a token, and stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const { roundId } = await roundOver();
      expect((await api.post(custodian, `/verification-rounds/${roundId}/void`, { expected_version: 1, reason: 'เปิดผิด' })).statusCode).toBe(400);
      expect((await api.post(custodian, `/verification-rounds/${roundId}/close`, { expected_version: 1 })).statusCode).toBe(400);

      const token = crypto.randomUUID();
      await refusedWith(await close(roundId, { expected_version: 2 }, token), 409, 'STALE_BEFORE_CONFLICT');
      expect((await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' })).statusCode).toBe(200);
      expect((await close(roundId, { expected_version: 2 }, token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the new state, the version, the event nor the receipt, and answers in the deterministic shape', async () => {
      const { roundId } = await roundOver();
      const before = await storedOf(roundId);
      const token = 'verification-round-close-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_verification_round_event() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected verification round failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_verification_round_event BEFORE INSERT ON verification_round_events
          FOR EACH ROW EXECUTE FUNCTION fail_verification_round_event();
      `);
      try {
        for (const res of [
          await close(roundId, { expected_version: 1 }, token),
          await edit(roundId, { expected_version: 1, name: 'ชื่อใหม่' }),
          await voidRound(roundId, { expected_version: 1, reason: 'เปิดผิด' }),
        ]) {
          expect(res.statusCode).toBe(500);
          expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
          expect(res.body).not.toContain('injected verification round failure');
        }
        expect(await storedOf(roundId)).toEqual(before);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_verification_round_event ON verification_round_events; DROP FUNCTION fail_verification_round_event();');
      }
      expect((await close(roundId, { expected_version: 1 }, token)).statusCode).toBe(201);
    });
  });
});
