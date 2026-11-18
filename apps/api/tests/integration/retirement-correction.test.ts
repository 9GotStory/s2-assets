import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, assignmentWriteHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';
import { retirementHelpers } from './support/retirement-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const TODAY = '2026-11-17';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F007-T5 (#159): amending and voiding a Retirement recorded wrong, with a reason (DR-12, #154 Q9, P2, P3).
describe('Retirement Correction (Seam A - F007-T5)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 17 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-17T05:00:00Z');

  const { whileHolding, whileWriting, untilWaiting } = lockHelpers(() => ({ api }));
  const { registered, lent, start } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-01', dueDate: '2026-11-30' });
  const { sent, recordsOf } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-11-03' });
  const { entries, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { placed, reassign } = assignmentWriteHelpers(() => ({ api, custodian, reader: readonly }), { effectiveDate: '2026-01-05' });
  const { opened, scopeOf, entryOf, recorded, closeOpenRound } = verificationHelpers(() => ({ api, custodian, reader: readonly }));
  const { base, retire, retired, correct, voided } = retirementHelpers(() => ({ api, custodian }), { retirementDate: '2026-11-10' });

  const detailOf = async (assetId: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/assets/${assetId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // What the Asset page reads of an Asset's Retirements, to show that a refused write saved nothing.
  const retirementsOf = async (assetId: string) => {
    const { retired: isRetired, retirement, retirements } = await detailOf(assetId);
    return { retired: isRetired, retirement, retirements };
  };

  // An amendment of the Retirement against `expectedVersion`, with a reason.
  const amendment = (changes: Record<string, unknown>, expectedVersion = 1, reason = 'บันทึกผิด') => ({ expected_version: expectedVersion, action: 'AMEND', reason, changes });
  // A void of the Retirement against `expectedVersion`, with a reason.
  const voiding = (expectedVersion = 1, reason = 'ไม่ได้จำหน่ายจริง') => ({ expected_version: expectedVersion, action: 'VOID', reason });

  // A refusal that saved nothing: the Asset's Retirements read as they did before it.
  const refused = async (res: { statusCode: number; json: () => any }, statusCode: number, body: Record<string, unknown>, assetId: string, before: unknown) => {
    expect(res.statusCode).toBe(statusCode);
    expect(res.json()).toMatchObject(body);
    expect(await retirementsOf(assetId)).toEqual(before);
  };

  // A Retired Asset, its Retirement, and what the Asset page reads of its Retirements.
  const retiredAsset = async (overrides: Record<string, unknown> = {}) => {
    const assetId = await registered();
    const retirementId = await retired(assetId, overrides);
    return { assetId, retirementId, before: await retirementsOf(assetId) };
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_retirement_correction', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_retirement_correction', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_retirement_correction', 'READ_ONLY');
    staff = await api.actor('staff_retirement_correction', 'VERIFICATION_STAFF');
  }, 120_000);

  afterEach(async () => {
    await closeOpenRound();
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('amending', () => {
    it('leaves the corrected values on the Retirement, and keeps the reason, the actor and the before and after of each changed field', async () => {
      const assetId = await registered();
      const retirementId = await retired(assetId, { retirement_method: 'SALE', retirement_reference: 'คำสั่ง 1/2569' });
      const before = Date.now();

      const res = await correct(
        retirementId,
        amendment({ retirement_date: '2026-11-03', retirement_method: 'EXCHANGE', retirement_reference: 'คำสั่ง 2/2569', note: 'แลกกับเครื่องใหม่' }, 1, 'เลือกวิธีผิด\nและพิมพ์คำสั่งผิด'),
        crypto.randomUUID(),
        admin
      );

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ retirement_id: retirementId, version: 2, correction_id: expect.stringMatching(UUID) });
      const { retired: isRetired, retirement, retirements } = await retirementsOf(assetId);
      expect(isRetired).toBe(true);
      expect(retirement).toMatchObject({
        id: retirementId,
        retirement_date: '2026-11-03',
        retirement_method: 'EXCHANGE',
        retirement_reference: 'คำสั่ง 2/2569',
        note: 'แลกกับเครื่องใหม่',
        recorded_by: custodian.id,
        is_voided: false,
        version: 2,
      });
      expect(retirement.corrections).toEqual([
        {
          id: res.json().correction_id,
          action: 'AMENDED',
          reason: 'เลือกวิธีผิด\nและพิมพ์คำสั่งผิด',
          changes: [
            { field: 'retirement_date', before: '2026-11-10', after: '2026-11-03' },
            { field: 'retirement_method', before: 'SALE', after: 'EXCHANGE' },
            { field: 'retirement_reference', before: 'คำสั่ง 1/2569', after: 'คำสั่ง 2/2569' },
            { field: 'note', before: null, after: 'แลกกับเครื่องใหม่' },
          ],
          recorded_by: admin.id,
          recorded_by_username: 'admin_retirement_correction',
          recorded_at: expect.any(String),
        },
      ]);
      expect(Date.parse(retirement.corrections[0].recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(retirements).toEqual([retirement]);
    });

    it('changes only the fields it names, keeps the before and after of those alone, and clears optional text left blank', async () => {
      const { assetId, retirementId } = await retiredAsset({ retirement_reference: 'คำสั่ง 1/2569', note: 'ขายทอดตลาด' });

      const res = await correct(retirementId, amendment({ retirement_reference: '  ', retirement_method: 'SALE' }));

      expect(res.statusCode).toBe(201);
      const { retirement } = await retirementsOf(assetId);
      expect(retirement).toMatchObject({ retirement_date: '2026-11-10', retirement_method: 'SALE', retirement_reference: null, note: 'ขายทอดตลาด', version: 2 });
      expect(retirement.corrections.map(({ changes }: any) => changes)).toEqual([[{ field: 'retirement_reference', before: 'คำสั่ง 1/2569', after: null }]]);
    });

    it('keeps every amendment in order, each against the version the one before it left', async () => {
      const { assetId, retirementId } = await retiredAsset();

      expect((await correct(retirementId, amendment({ retirement_method: 'EXCHANGE' }, 1, 'ครั้งแรก'))).json().version).toBe(2);
      expect((await correct(retirementId, amendment({ retirement_method: 'DECLARED_LOSS' }, 2, 'ครั้งที่สอง'))).json().version).toBe(3);

      const { retirement } = await retirementsOf(assetId);
      expect(retirement.corrections.map(({ reason, changes }: any) => [reason, changes])).toEqual([
        ['ครั้งแรก', [{ field: 'retirement_method', before: 'SALE', after: 'EXCHANGE' }]],
        ['ครั้งที่สอง', [{ field: 'retirement_method', before: 'EXCHANGE', after: 'DECLARED_LOSS' }]],
      ]);
    });

    it('refuses an amendment that changes nothing, text compared as it is stored, and saves nothing', async () => {
      const { assetId, retirementId, before } = await retiredAsset({ note: 'ขายทอดตลาด' });

      await refused(await correct(retirementId, amendment({ retirement_method: 'SALE', note: '  ขายทอดตลาด ' })), 400, { code: 'VALIDATION_FAILED', message: 'This amendment changes nothing' }, assetId, before);
      await refused(await correct(retirementId, amendment({})), 400, { code: 'VALIDATION_FAILED', message: 'This amendment changes nothing' }, assetId, before);
    });

    it('needs a reason that is not blank, and saves nothing without one', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, amendment({ retirement_method: 'EXCHANGE' }, 1, ' \n ')), 400, { message: 'A correction needs a reason' }, assetId, before);
      const { reason: _reason, ...noReason } = amendment({ retirement_method: 'EXCHANGE' });
      await refused(await correct(retirementId, noReason), 400, { message: expect.stringContaining('reason:') }, assetId, before);
    });

    it('takes a new Retirement Date of today and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      const { assetId, retirementId, before } = await retiredAsset();
      // 23:59:59 on 17 November in Bangkok.
      now = new Date('2026-11-17T16:59:59Z');
      try {
        await refused(await correct(retirementId, amendment({ retirement_date: '2026-11-18' })), 400, { message: expect.stringContaining('retirement_date must not be after today') }, assetId, before);
        expect((await correct(retirementId, amendment({ retirement_date: '2026-11-17' }))).statusCode).toBe(201);
        // 00:00 on 18 November in Bangkok.
        now = new Date('2026-11-17T17:00:00Z');
        expect((await correct(retirementId, amendment({ retirement_date: '2026-11-18' }, 2))).statusCode).toBe(201);
      } finally {
        now = new Date('2026-11-17T05:00:00Z');
      }
      expect((await retirementsOf(assetId)).retirement.retirement_date).toBe('2026-11-18');
    });

    it('refuses a new Retirement Date that is no calendar date, and keeps no lower bound', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, amendment({ retirement_date: '2026-02-30' })), 400, { message: expect.stringContaining('retirement_date must be a date') }, assetId, before);
      expect((await correct(retirementId, amendment({ retirement_date: '1999-01-01' }))).statusCode).toBe(201);
    });

    it('keeps the Retirement Method to one of the five values', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, amendment({ retirement_method: 'DONATION' })), 400, { message: expect.stringContaining('changes.retirement_method:') }, assetId, before);
      await refused(await correct(retirementId, amendment({ retirement_method: null })), 400, { message: expect.stringContaining('changes.retirement_method:') }, assetId, before);
    });

    it('bounds the Retirement Reference, the note and the reason, and takes text at its bounds', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, amendment({ retirement_reference: over(500) })), 400, { message: expect.stringContaining('retirement_reference must be at most 500') }, assetId, before);
      await refused(await correct(retirementId, amendment({ note: over(2000) })), 400, { message: expect.stringContaining('note must be at most 2000') }, assetId, before);
      await refused(await correct(retirementId, amendment({ note: 'ขาย' }, 1, over(2000))), 400, { message: expect.stringContaining('reason must be at most 2000') }, assetId, before);
      const res = await correct(retirementId, amendment({ retirement_reference: 'ร'.repeat(500), note: 'น'.repeat(2000) }, 1, 'เ'.repeat(2000)));
      expect(res.statusCode).toBe(201);
    });

    it('refuses control characters in its text, and keeps line breaks and tabs inside them', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, amendment({ retirement_reference: 'คำสั่ง\u0007' })), 400, { message: expect.stringContaining('retirement_reference must not contain control characters') }, assetId, before);
      await refused(await correct(retirementId, amendment({ note: 'ขาย\u0000' })), 400, { message: expect.stringContaining('note must not contain control characters') }, assetId, before);
      await refused(await correct(retirementId, amendment({ note: 'ขาย' }, 1, 'เหตุผล\u001b')), 400, { message: expect.stringContaining('reason must not contain control characters') }, assetId, before);

      expect((await correct(retirementId, amendment({ note: 'บรรทัดแรก\n\tบรรทัดสอง' }, 1, 'เหตุ\tผล\nต่อ'))).statusCode).toBe(201);
      const { retirement } = await retirementsOf(assetId);
      expect(retirement.note).toBe('บรรทัดแรก\n\tบรรทัดสอง');
      expect(retirement.corrections[0].reason).toBe('เหตุ\tผล\nต่อ');
    });

    it('never moves a Retirement to another Asset, and takes no field it does not know', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, amendment({ asset_id: await registered() })), 400, { message: expect.stringContaining('changes: Unrecognized key: "asset_id"') }, assetId, before);
      await refused(await correct(retirementId, { ...amendment({ note: 'ขาย' }), retirement_method: 'EXCHANGE' }), 400, { message: expect.stringContaining(': Unrecognized key: "retirement_method"') }, assetId, before);
    });
  });

  describe('voiding', () => {
    it('keeps the Retirement shown as voided with its correction, and the Asset is no longer Retired', async () => {
      const { assetId, retirementId } = await retiredAsset({ retirement_reference: 'คำสั่ง 1/2569' });

      const res = await correct(retirementId, voiding(1, 'บันทึกผิดครุภัณฑ์'), crypto.randomUUID(), admin);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ retirement_id: retirementId, version: 2, correction_id: expect.stringMatching(UUID) });
      const { retired: isRetired, retirement, retirements } = await retirementsOf(assetId);
      expect(isRetired).toBe(false);
      expect(retirement).toBeNull();
      expect(retirements).toEqual([
        expect.objectContaining({
          id: retirementId,
          retirement_date: '2026-11-10',
          retirement_method: 'SALE',
          retirement_reference: 'คำสั่ง 1/2569',
          is_voided: true,
          version: 2,
          corrections: [
            {
              id: res.json().correction_id,
              action: 'VOIDED',
              reason: 'บันทึกผิดครุภัณฑ์',
              changes: [],
              recorded_by: admin.id,
              recorded_by_username: 'admin_retirement_correction',
              recorded_at: expect.any(String),
            },
          ],
        }),
      ]);
    });

    it('offers the new-event actions on the Asset page again', async () => {
      const { assetId, retirementId } = await retiredAsset();
      expect(await detailOf(assetId, custodian)).toMatchObject({ can_retire: false, can_reassign: false, can_record_loan: false, can_record_repair: false, can_record_verification: false, can_manage_verification: false });

      await voided(retirementId);

      expect(await detailOf(assetId, custodian)).toMatchObject({ can_retire: true, can_reassign: true, can_record_loan: true, can_record_repair: true, can_record_verification: true, can_manage_verification: true });
    });

    it('lets the guards of a Loan start, a Repair Start and a Reassignment through again', async () => {
      const [room, other] = await entries('locations', `ห้องหลังยกเลิกการจำหน่าย ${crypto.randomUUID()}`, 2);
      const [lending, repairing, moving] = [await placed(room), await placed(room), await placed(room)];
      for (const assetId of [lending, repairing, moving]) {
        await voided(await retired(assetId));
      }

      expect((await start([lending])).statusCode).toBe(201);
      expect((await sent(repairing)) as string).toMatch(UUID);
      expect((await reassign(moving, { effective_date: '2026-11-12', location_id: other.id })).statusCode).toBe(201);
    });

    it('changes no other record: the Asset, its history, its assignment, Loans and Repair Records stay as they were', async () => {
      const [room] = await entries('locations', `ห้องไม่เปลี่ยน ${crypto.randomUUID()}`, 1);
      const assetId = await placed(room);
      const retirementId = await retired(assetId);
      const { asset, history } = await detailOf(assetId);
      const assignment = await assignmentOf(assetId);
      const repairs = await recordsOf(assetId);

      await voided(retirementId);

      const after = await detailOf(assetId);
      expect(after.asset).toEqual(asset);
      expect(after.history).toEqual(history);
      expect(await assignmentOf(assetId)).toEqual(assignment);
      expect(await recordsOf(assetId)).toEqual(repairs);
      expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toEqual([]);
    });

    it('puts no Asset back into a Verification Round: only a Late Addition brings it in, and a result can then be recorded', async () => {
      const [room] = await entries('locations', `ห้องรอบตรวจ ${crypto.randomUUID()}`, 1);
      const [kept, gone] = [await placed(room), await placed(room)];
      const retirementId = await retired(gone);
      const roundId = await opened({ location_ids: [room.id] });
      expect(await scopeOf(roundId)).toEqual([kept]);

      await voided(retirementId);

      expect(await scopeOf(roundId)).toEqual([kept]);
      const addition = await api.post(custodian, `/verification-rounds/${roundId}/late-additions`, { asset_id: gone, reason: 'ยกเลิกการจำหน่ายที่บันทึกผิด' }, { 'x-retry-token': crypto.randomUUID() });
      expect(addition.statusCode).toBe(201);
      await recorded(roundId, gone);
      expect(await entryOf(roundId, gone)).toMatchObject({ result: 'FOUND', retired: false });
    });

    it('lets a new Retirement be recorded after it, and shows both, the voided one first', async () => {
      const { assetId, retirementId } = await retiredAsset();
      await voided(retirementId);

      const res = await retire(assetId, base({ retirement_method: 'CONVERSION_OR_DESTRUCTION' }));

      expect(res.statusCode).toBe(201);
      const { retired: isRetired, retirement, retirements } = await retirementsOf(assetId);
      expect(isRetired).toBe(true);
      expect(retirement).toMatchObject({ id: res.json().retirement_id, retirement_method: 'CONVERSION_OR_DESTRUCTION', is_voided: false, corrections: [] });
      expect(retirements.map(({ id, is_voided }: any) => [id, is_voided])).toEqual([
        [retirementId, true],
        [res.json().retirement_id, false],
      ]);
    });

    it('takes no changes', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, { ...voiding(), changes: { note: 'ขาย' } }), 400, { message: 'A void changes no field: leave changes out' }, assetId, before);
    });

    it('needs a reason that is not blank', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await correct(retirementId, voiding(1, '   ')), 400, { message: 'A correction needs a reason' }, assetId, before);
    });
  });

  describe('a Retirement that cannot be corrected', () => {
    it('refuses to amend or void a voided Retirement, and saves nothing', async () => {
      const { assetId, retirementId } = await retiredAsset();
      await voided(retirementId);
      const before = await retirementsOf(assetId);

      await refused(await correct(retirementId, amendment({ retirement_method: 'EXCHANGE' }, 2)), 400, { message: 'This Retirement is voided: it can no longer be corrected' }, assetId, before);
      await refused(await correct(retirementId, voiding(2)), 400, { message: 'This Retirement is voided: it can no longer be corrected' }, assetId, before);
    });

    it('answers a stale expected version with the stale-before conflict, for an amendment and a void, and saves nothing', async () => {
      const { assetId, retirementId } = await retiredAsset();
      expect((await correct(retirementId, amendment({ note: 'แก้ครั้งแรก' }))).statusCode).toBe(201);
      const before = await retirementsOf(assetId);
      const stale = { code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } };

      await refused(await correct(retirementId, amendment({ retirement_method: 'EXCHANGE' })), 409, stale, assetId, before);
      await refused(await correct(retirementId, voiding()), 409, stale, assetId, before);
    });

    it('answers a Retirement that does not exist with 404, and a malformed id with 400', async () => {
      const missing = await correct(crypto.randomUUID(), voiding());
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Retirement not found' });

      const malformed = await correct('not-a-uuid', voiding());
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('INVALID_ID');
    });
  });

  // CODING_STANDARDS, "A rule read under a lock has a test of its order": a correction locks the Asset row
  // exclusively, the lock a Retirement and every guarded write take (#154 Q24).
  describe('locking the Asset', () => {
    it('reads the Retirement for a new one after a void queued first at the Asset row, so the new one is recorded', async () => {
      const { assetId, retirementId } = await retiredAsset();

      const [voidRes, retirement] = await whileHolding(
        'assets',
        assetId,
        () => [correct(retirementId, voiding()), untilWaiting('assets', 1).then(() => retire(assetId))],
        () => untilWaiting('assets', 2)
      );

      expect(voidRes.statusCode).toBe(201);
      expect(retirement.statusCode).toBe(201);
    });

    it('lets a Loan start queued behind a void at the Asset row through', async () => {
      const { assetId, retirementId } = await retiredAsset();

      const [voidRes, loan] = await whileHolding(
        'assets',
        assetId,
        () => [correct(retirementId, voiding()), untilWaiting('assets', 1).then(() => start([assetId]))],
        () => untilWaiting('assets', 2)
      );

      expect(voidRes.statusCode).toBe(201);
      expect(loan.statusCode).toBe(201);
    });

    it('waits for a write that holds the Asset in share mode, as recording an Asset Verification does', async () => {
      const { assetId, retirementId } = await retiredAsset();

      const [amended] = await whileWriting(
        { sql: 'SELECT 1 FROM assets WHERE id = $1 FOR SHARE', params: [assetId] },
        () => [correct(retirementId, amendment({ note: 'รอคิว' }))],
        () => untilWaiting('assets', 1)
      );

      expect(amended.statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('refuses every role without retirement:correct, and saves nothing', async () => {
      const { assetId, retirementId, before } = await retiredAsset();
      const maintainer = await api.actor('maintainer_retirement_correction', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, staff, maintainer]) {
        await refused(await correct(retirementId, voiding(), crypto.randomUUID(), actor), 403, { error: { code: 'FORBIDDEN' } }, assetId, before);
      }
    });

    it('needs retirement:correct itself, and fails closed when the lookup fails, saving nothing', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      const denied = await withCapabilityAnswer(api.app, 'retirement:correct', async () => false, () => correct(retirementId, voiding()));
      await refused(denied, 403, { error: { code: 'FORBIDDEN' } }, assetId, before);
      const failed = await withCapabilityAnswer(api.app, 'retirement:correct', async () => { throw new Error('lookup failed'); }, () => correct(retirementId, voiding()));
      await refused(failed, 500, { error: { code: 'INTERNAL_SERVER_ERROR' } }, assetId, before);
    });

    it('lets an Administrator amend and void a Retirement, though not record one', async () => {
      const { assetId, retirementId } = await retiredAsset();

      expect((await correct(retirementId, amendment({ note: 'ผู้ดูแลระบบแก้' }), crypto.randomUUID(), admin)).statusCode).toBe(201);
      expect((await correct(retirementId, voiding(2), crypto.randomUUID(), admin)).statusCode).toBe(201);
      expect((await retire(assetId, base(), crypto.randomUUID(), admin)).statusCode).toBe(403);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const { assetId, retirementId, before } = await retiredAsset();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/retirements/${retirementId}/corrections`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: voiding(),
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_retirement_correction', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await correct(retirementId, voiding(), crypto.randomUUID(), leaving)).statusCode);

      expect(await retirementsOf(assetId)).toEqual(before);
    });

    it('tells the Asset page whether the viewer may correct a Retirement, which follows retirement:correct alone', async () => {
      const { assetId } = await retiredAsset();

      for (const actor of [custodian, admin]) {
        expect((await detailOf(assetId, actor)).can_correct_retirement).toBe(true);
      }
      for (const actor of [readonly, staff]) {
        expect((await detailOf(assetId, actor)).can_correct_retirement).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'retirement:correct', async () => false, () => api.get(custodian, `/assets/${assetId}`));
      expect(denied.json().can_correct_retirement).toBe(false);
    });

    it('lets every role with asset:view read the corrections of a Retirement', async () => {
      const { assetId, retirementId } = await retiredAsset();
      await correct(retirementId, amendment({ note: 'ทุกคนอ่านได้' }, 1, 'เหตุผลที่ทุกคนอ่านได้'));

      for (const reader of [custodian, admin, readonly, staff]) {
        expect((await detailOf(assetId, reader)).retirement.corrections).toEqual([expect.objectContaining({ reason: 'เหตุผลที่ทุกคนอ่านได้' })]);
      }
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const { assetId, retirementId, before } = await retiredAsset();

      await refused(await api.post(custodian, `/retirements/${retirementId}/corrections`, voiding()), 400, { code: 'VALIDATION_FAILED' }, assetId, before);
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const { assetId, retirementId } = await retiredAsset();
      const token = crypto.randomUUID();
      const first = await correct(retirementId, amendment({ note: 'ครั้งเดียว' }), token);
      expect(first.statusCode).toBe(201);
      const after = await retirementsOf(assetId);

      const replay = await correct(retirementId, amendment({ note: 'ครั้งเดียว' }), token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await retirementsOf(assetId)).toEqual(after);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const { assetId, retirementId } = await retiredAsset();
      const token = crypto.randomUUID();
      expect((await correct(retirementId, amendment({ note: 'ครั้งเดียว' }), token)).statusCode).toBe(201);
      const after = await retirementsOf(assetId);
      const mismatch = { code: 'RETRY_TOKEN_PAYLOAD_MISMATCH' };

      await refused(await correct(retirementId, amendment({ note: 'อีกค่า' }), token), 409, mismatch, assetId, after);
      await refused(await correct(retirementId, amendment({ note: 'ครั้งเดียว' }, 1, 'อีกเหตุผล'), token), 409, mismatch, assetId, after);
      await refused(await correct(retirementId, voiding(), token), 409, mismatch, assetId, after);
    });

    it('scopes a token to its actor and its operation, the Retirement included', async () => {
      const token = crypto.randomUUID();
      const [first, second] = [await retiredAsset(), await retiredAsset()];

      expect((await correct(first.retirementId, voiding(), token)).statusCode).toBe(201);
      const other = await correct(second.retirementId, voiding(), token);
      expect(other.statusCode).toBe(201);
      expect(other.json().retirement_id).toBe(second.retirementId);
      expect((await retirementsOf(second.assetId)).retired).toBe(false);
      expect((await correct(first.retirementId, amendment({ note: 'โดยผู้ดูแลระบบ' }, 2), token, admin)).statusCode).toBe(400);
      expect((await retire(first.assetId, base(), token)).statusCode).toBe(201);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { assetId, retirementId } = await retiredAsset();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => correct(retirementId, voiding(), token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().correction_id)).size).toBe(1);
      expect((await retirementsOf(assetId)).retirements[0].corrections).toHaveLength(1);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the correction, the change nor the receipt, and answers in the deterministic shape', async () => {
      const { assetId, retirementId, before } = await retiredAsset();
      const token = 'retirement-correction-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_retirement_correction() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected retirement correction failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_retirement_correction BEFORE INSERT ON retirement_corrections
          FOR EACH ROW EXECUTE FUNCTION fail_retirement_correction();
      `);
      try {
        const res = await correct(retirementId, voiding(), token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected retirement correction failure');
        expect(await retirementsOf(assetId)).toEqual(before);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_retirement_correction ON retirement_corrections; DROP FUNCTION fail_retirement_correction();');
      }
      expect((await correct(retirementId, voiding(), token)).statusCode).toBe(201);
    });
  });
});
