import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';
import { retirementHelpers } from './support/retirement-helpers.ts';
import { verificationHelpers } from './support/verification-helpers.ts';

const TODAY = '2026-11-17';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METHODS = ['SALE', 'EXCHANGE', 'HANDOVER_TO_OTHER_AGENCY', 'CONVERSION_OR_DESTRUCTION', 'DECLARED_LOSS'];

// F007-T1 (#155): recording a Retirement, and reading that an Asset is Retired.
describe('Retirement (Seam A - F007-T1)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let staff: Actor;
  // 12:00 on 17 November 2026 in Bangkok, unless a test moves it.
  let now = new Date('2026-11-17T05:00:00Z');

  const { entry, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { registered, loanOf, lent, returned, closedNotReturned } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: '2026-11-01', dueDate: '2026-11-30' });
  const { sent, recordOf, recordOutcome, ended } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-11-03' });
  const { opened, record: recordVerification } = verificationHelpers(() => ({ api, custodian, reader: readonly }));

  const { base, retire, retired } = retirementHelpers(() => ({ api, custodian }), { retirementDate: TODAY });

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
  const NONE = { retired: false, retirement: null, retirements: [] };

  // The Asset list's rows whose name holds `tag`, with `query` added.
  const listed = async (tag: string, query = '', actor: Actor = readonly) => {
    const res = await api.get(actor, `/assets/search?field=name&value=${encodeURIComponent(tag)}&limit=100${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_retirement', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_retirement', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_retirement', 'READ_ONLY');
    staff = await api.actor('staff_retirement', 'VERIFICATION_STAFF');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('saves a Retirement with every field, and the Asset page shows the Asset Retired with it', async () => {
      const assetId = await registered('เครื่องพิมพ์ที่จำหน่าย');
      const before = Date.now();

      const res = await retire(
        assetId,
        base({ retirement_date: '2026-10-01', retirement_method: 'HANDOVER_TO_OTHER_AGENCY', retirement_reference: 'คำสั่ง 12/2569 ลงวันที่ 30 ก.ย. 2569', note: 'โอนให้โรงเรียนบ้านหนองบัว\nตามหนังสือขอรับ' })
      );

      expect(res.statusCode).toBe(201);
      const { retirement_id: retirementId, version } = res.json();
      expect(retirementId).toMatch(UUID);
      expect(version).toBe(1);

      const detail = await detailOf(assetId);
      const retirement = {
        id: retirementId,
        retirement_date: '2026-10-01',
        retirement_method: 'HANDOVER_TO_OTHER_AGENCY',
        retirement_reference: 'คำสั่ง 12/2569 ลงวันที่ 30 ก.ย. 2569',
        note: 'โอนให้โรงเรียนบ้านหนองบัว\nตามหนังสือขอรับ',
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_retirement',
        recorded_at: expect.any(String),
        is_voided: false,
        version: 1,
      };
      expect(detail).toMatchObject({ retired: true, retirement, retirements: [retirement] });
      expect(Date.parse(detail.retirement.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(detail.retirement.recorded_at)).toBeLessThanOrEqual(Date.now());
    });

    it('shows an Asset never retired as not Retired, with no Retirement', async () => {
      expect(await retirementsOf(await registered())).toEqual(NONE);
    });

    it('takes each of the five Retirement Methods', async () => {
      for (const method of METHODS) {
        const assetId = await registered();
        await retired(assetId, { retirement_method: method });
        expect((await detailOf(assetId)).retirement.retirement_method).toBe(method);
      }
    });

    it('needs a Retirement Date and a Retirement Method, takes no other method, and saves nothing without them', async () => {
      const assetId = await registered();
      const { retirement_date: _date, ...noDate } = base();
      const { retirement_method: _method, ...noMethod } = base();

      for (const [payload, field] of [
        [noDate, 'retirement_date'],
        [noMethod, 'retirement_method'],
        [base({ retirement_method: 'DONATION' }), 'retirement_method'],
        [base({ retirement_method: null }), 'retirement_method'],
      ] as const) {
        const res = await retire(assetId, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(`${field}:`) });
      }
      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    it('needs no Retirement Reference or note: blank text is none', async () => {
      const assetId = await registered();

      await retired(assetId, { retirement_reference: '  ', note: '' });

      expect((await detailOf(assetId)).retirement).toMatchObject({ retirement_reference: null, note: null });
    });

    it('bounds the Retirement Reference and the note, and takes text at its bounds', async () => {
      const assetId = await registered();
      expect((await retire(assetId, base({ retirement_reference: over(500) }))).statusCode).toBe(400);
      expect((await retire(assetId, base({ note: over(2000) }))).statusCode).toBe(400);
      expect(await retirementsOf(assetId)).toEqual(NONE);

      await retired(assetId, { retirement_reference: 'ก'.repeat(500), note: 'ก'.repeat(2000) });

      expect((await detailOf(assetId)).retirement).toMatchObject({ retirement_reference: 'ก'.repeat(500), note: 'ก'.repeat(2000) });
    });

    it('refuses control characters in the Retirement Reference and the note, and keeps line breaks and tabs inside them', async () => {
      const assetId = await registered();
      expect((await retire(assetId, base({ retirement_reference: 'คำสั่ง\u0007' }))).statusCode).toBe(400);
      expect((await retire(assetId, base({ note: 'หมาย\u001bเหตุ' }))).statusCode).toBe(400);
      expect(await retirementsOf(assetId)).toEqual(NONE);

      await retired(assetId, { retirement_reference: 'คำสั่ง 1/2569\nลงวันที่ 1 พ.ย.', note: 'ขาย\tทอดตลาด' });

      expect((await detailOf(assetId)).retirement).toMatchObject({ retirement_reference: 'คำสั่ง 1/2569\nลงวันที่ 1 พ.ย.', note: 'ขาย\tทอดตลาด' });
    });

    it('takes no file and no field it does not know', async () => {
      const assetId = await registered();

      for (const [payload, key] of [
        [base({ document: 'base64…' }), 'document'],
        [base({ asset_id: assetId }), 'asset_id'],
        [base({ status: 'RETIRED' }), 'status'],
      ] as const) {
        const res = await retire(assetId, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(`"${key}"`) });
      }
      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    it('answers an Asset that does not exist with 404, and a malformed id with 400, saving nothing', async () => {
      const count = async () => (await api.pool.query('SELECT count(*)::int AS n FROM retirements')).rows[0].n;
      const before = await count();

      const missing = await retire(crypto.randomUUID());
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');

      const malformed = await retire('not-a-uuid');
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('VALIDATION_FAILED');
      expect(await count()).toBe(before);
    });
  });

  describe('the Retirement Date', () => {
    it('takes today and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      const assetId = await registered();
      try {
        // 23:59:59 on 17 November in Bangkok.
        now = new Date('2026-11-17T16:59:59Z');
        const tomorrow = await retire(assetId, base({ retirement_date: '2026-11-18' }));
        expect(tomorrow.statusCode).toBe(400);
        expect(tomorrow.json().message).toContain('retirement_date');
        expect(await retirementsOf(assetId)).toEqual(NONE);

        // 00:00 on 18 November in Bangkok.
        now = new Date('2026-11-17T17:00:00Z');
        await retired(assetId, { retirement_date: '2026-11-18' });
      } finally {
        now = new Date('2026-11-17T05:00:00Z');
      }
    });

    it('has no lower bound, and may be before the Asset was registered', async () => {
      const assetId = await registered();

      await retired(assetId, { retirement_date: '1999-01-01' });

      expect((await detailOf(assetId)).retirement.retirement_date).toBe('1999-01-01');
    });

    it('refuses a Retirement Date that is no calendar date', async () => {
      const assetId = await registered();

      for (const date of ['2026-02-30', '17/11/2569', '', '2026-11-1']) {
        const res = await retire(assetId, base({ retirement_date: date }));
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'retirement_date must be a date (YYYY-MM-DD)' });
      }
      expect(await retirementsOf(assetId)).toEqual(NONE);
    });
  });

  describe('one Retirement per Asset (#154 P2)', () => {
    it('refuses a second Retirement, naming the one not voided, and saves nothing', async () => {
      const assetId = await registered('จอภาพที่จำหน่ายแล้ว');
      const retirementId = await retired(assetId);
      const before = await retirementsOf(assetId);

      const res = await retire(assetId, base({ retirement_method: 'EXCHANGE' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'RETIREMENT_REFUSED',
        asset: { asset_id: assetId, name: 'จอภาพที่จำหน่ายแล้ว', asset_number: null, reason: 'ALREADY_RETIRED', retirement_id: retirementId },
      });
      expect(await retirementsOf(assetId)).toEqual(before);
    });

    it('ends concurrent Retirements of one Asset with exactly one, and the others name it', async () => {
      const assetId = await registered();

      const results = await Promise.all(METHODS.map((method) => retire(assetId, base({ retirement_method: method }))));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
      const winner = results.find((res) => res.statusCode === 201)!.json().retirement_id;
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json().asset).toMatchObject({ reason: 'ALREADY_RETIRED', retirement_id: winner });
      }
      expect((await retirementsOf(assetId)).retirements).toHaveLength(1);
    });
  });

  describe('guards (DR-14 to DR-17, #154 Q3)', () => {
    it('refuses while the Asset is On Loan, naming its LoanItem and its Loan, and writes nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const loanBefore = await loanOf(loanId);

      const res = await retire(assetId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'RETIREMENT_REFUSED', asset: { asset_id: assetId, reason: 'ON_LOAN', loan_item_id: itemOf[assetId], loan_id: loanId } });
      expect(await retirementsOf(assetId)).toEqual(NONE);
      expect(await loanOf(loanId)).toEqual(loanBefore);
    });

    it('retires an Asset whose LoanItem ended Not Returned, and records no Loan Return for it', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-10');
      const loanBefore = await loanOf(loanId);

      await retired(assetId);

      expect((await loanOf(loanId)).items[0]).toMatchObject({ ending_kind: 'NOT_RETURNED', loan_return: null });
      // The Loan page reads the Asset Retired (F007-T2), and nothing else of the Loan changed.
      expect(await loanOf(loanId)).toEqual({ ...loanBefore, items: loanBefore.items.map((item: any) => ({ ...item, asset: { ...item.asset, retired: true } })) });
    });

    it('retires an Asset once its Loan Return is recorded', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-05');

      await retired(assetId);
    });

    it('refuses while the Asset is Under Repair, naming the Repair Record, and records no Repair Outcome', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { repair_kind: 'MAINTENANCE' });

      const res = await retire(assetId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'RETIREMENT_REFUSED',
        asset: { asset_id: assetId, reason: 'UNDER_REPAIR', repair_record_id: repairRecordId, repair_kind: 'MAINTENANCE' },
      });
      expect(await retirementsOf(assetId)).toEqual(NONE);
      expect((await recordOf(repairRecordId)).outcome).toBeNull();
    });

    it('retires an Asset whose last Repair Outcome is ซ่อมไม่ได้ or ใช้งานไม่ได้, or ใช้งานได้, and changes no Repair Record', async () => {
      for (const [repair_kind, outcome] of [
        ['REPAIR', 'NOT_USABLE'],
        ['MAINTENANCE', 'NOT_USABLE'],
        ['REPAIR', 'USABLE'],
      ] as const) {
        const assetId = await registered();
        const repairRecordId = await sent(assetId, { repair_kind });
        await ended(repairRecordId, { outcome, outcome_date: '2026-11-10' });
        const recordBefore = await recordOf(repairRecordId);

        await retired(assetId);

        expect(await recordOf(repairRecordId)).toEqual(recordBefore);
      }
    });

    it('never makes an Asset Retired from a Not Found result (DR-03)', async () => {
      const room = await entry('locations', `ห้องจำหน่าย ${crypto.randomUUID()}`);
      const res = await api.post(custodian, '/assets', { name: 'ของที่หาไม่พบ', location_id: room.id, effective_date: '2026-10-01' });
      const assetId = res.json().asset.id;
      const roundId = await opened({ location_ids: [room.id] });

      expect((await recordVerification(roundId, assetId, { result: 'NOT_FOUND' }, crypto.randomUUID(), staff)).statusCode).toBe(201);

      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    // CODING_STANDARDS, "A rule read under a lock has a test of its order": each other write queues at the
    // Asset row first, and the Retirement behind it sees what it wrote.
    it('reads Under Repair after locking the Asset, so a Repair Outcome queued first is seen', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);

      const [outcome, retirement] = await whileHolding(
        'assets',
        assetId,
        () => [recordOutcome(repairRecordId, { outcome: 'NOT_USABLE' }), untilWaiting('assets', 1).then(() => retire(assetId))],
        () => untilWaiting('assets', 2)
      );

      expect(outcome.statusCode).toBe(201);
      expect(retirement.statusCode).toBe(201);
    });

    it('reads On Loan after locking the Asset, so a Not Returned ending queued first is seen', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const ending = {
        expected_version: (await loanOf(loanId)).version,
        not_returned_date: '2026-11-10',
        reason: 'ผู้ยืมแจ้งว่าทำหาย',
        items: [{ loan_item_id: itemOf[assetId] }],
      };

      const [closed, retirement] = await whileHolding(
        'assets',
        assetId,
        () => [
          api.post(custodian, `/loans/${loanId}/not-returned`, ending, { 'x-retry-token': crypto.randomUUID() }),
          untilWaiting('assets', 1).then(() => retire(assetId)),
        ],
        () => untilWaiting('assets', 2)
      );

      expect(closed.statusCode).toBe(201);
      expect(retirement.statusCode).toBe(201);
    });
  });

  describe('a Retired Asset', () => {
    it('sets no new-event flag, while register correction and its own reading stay', async () => {
      const assetId = await registered();
      const offered = await detailOf(assetId, custodian);
      expect(offered).toMatchObject({ can_reassign: true, can_record_loan: true, can_record_repair: true, can_retire: true, can_correct: true });

      await retired(assetId);

      expect(await detailOf(assetId, custodian)).toMatchObject({
        retired: true,
        can_reassign: false,
        can_record_loan: false,
        can_record_repair: false,
        can_retire: false,
        can_correct: true,
        can_correct_assignment: true,
      });
      expect((await detailOf(assetId, admin)).can_correct).toBe(true);
    });

    it('keeps its Permanent Assignment, its history and its Asset record exactly as they were', async () => {
      const room = await entry('locations', `ห้องเดิม ${crypto.randomUUID()}`);
      const res = await api.post(custodian, '/assets', { name: 'ตู้ที่จำหน่าย', location_id: room.id, effective_date: '2026-10-01' });
      const assetId = res.json().asset.id;
      const before = await detailOf(assetId);
      const assignmentBefore = await assignmentOf(assetId);

      await retired(assetId);

      const after = await detailOf(assetId);
      expect(after.asset).toEqual(before.asset);
      expect(after.history).toEqual(before.history);
      expect(await assignmentOf(assetId)).toEqual(assignmentBefore);
    });

    it('can still have its register data corrected and Evidence linked to it (#154 Q7, Q16)', async () => {
      const assetId = await registered('ชื่อที่พิมพ์ผิด');
      await retired(assetId);

      const corrected = await api.post(
        custodian,
        `/assets/${assetId}/correct`,
        { name: 'ชื่อที่ถูกต้อง', expected_name: 'ชื่อที่พิมพ์ผิด', expected_asset_number: null, expected_serial_number: null, reason: 'พิมพ์ชื่อผิด' },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(corrected.statusCode).toBe(200);
      expect((await detailOf(assetId)).asset.name).toBe('ชื่อที่ถูกต้อง');

      const evidence = await api.post(custodian, '/evidence', { reference_text: 'บันทึกขออนุมัติจำหน่าย', acquisition_id: null, asset_ids: [assetId], retry_token: crypto.randomUUID() });
      expect(evidence.statusCode).toBe(201);
    });

    it('offers จำหน่าย to a Custodian while the Asset is On Loan or Under Repair, and the server refuses it there', async () => {
      const onLoan = await registered();
      await lent([onLoan]);
      const underRepair = await registered();
      await sent(underRepair);

      for (const assetId of [onLoan, underRepair]) {
        expect((await detailOf(assetId, custodian)).can_retire).toBe(true);
        expect((await retire(assetId)).statusCode).toBe(409);
      }
    });
  });

  describe('the Asset list (#154 Q10, P6)', () => {
    it('lists every Asset by default and marks the Retired ones', async () => {
      const tag = `รายการจำหน่าย-${crypto.randomUUID()}`;
      const kept = await registered(`${tag} ใช้อยู่`);
      const gone = await registered(`${tag} จำหน่ายแล้ว`);
      await retired(gone);

      const rows = await listed(tag);

      expect(rows.map(({ id, retired: isRetired }: any) => ({ id, retired: isRetired })).sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(
        [
          { id: kept, retired: false },
          { id: gone, retired: true },
        ].sort((a, b) => a.id.localeCompare(b.id))
      );
    });

    it('filters by Retirement status, apart from the other filters', async () => {
      const tag = `ตัวกรองจำหน่าย-${crypto.randomUUID()}`;
      const kept = await registered(`${tag} ใช้อยู่`);
      const gone = await registered(`${tag} จำหน่ายแล้ว`);
      const goneAfterRepair = await registered(`${tag} ซ่อมไม่ได้แล้วจำหน่าย`);
      const keptUnderRepair = await registered(`${tag} อยู่ระหว่างซ่อม`);
      await retired(gone);
      await ended(await sent(goneAfterRepair), { outcome: 'NOT_USABLE', outcome_date: '2026-11-10' });
      await retired(goneAfterRepair);
      await sent(keptUnderRepair);

      const ids = async (query: string) => (await listed(tag, query)).map(({ id }: any) => id).sort();

      expect(await ids('&retired=true')).toEqual([gone, goneAfterRepair].sort());
      expect(await ids('&retired=false')).toEqual([kept, keptUnderRepair].sort());
      expect(await ids('&retired=false&under_repair=true')).toEqual([keptUnderRepair]);
      expect(await ids('&retired=true&under_repair=true')).toEqual([]);
    });

    it('refuses any other Retirement status, and a repeated one', async () => {
      for (const query of ['&retired=yes', '&retired=']) {
        const res = await api.get(readonly, `/assets/search?field=name&value=x${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { retired: expect.any(String) } });
      }
      // A repeated one meets the list's rule for every parameter.
      const repeated = await api.get(readonly, '/assets/search?field=name&value=x&retired=true&retired=false');
      expect(repeated.statusCode).toBe(400);
      expect(repeated.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { query: 'Duplicate parameter not allowed' } });
    });
  });

  describe('authorization', () => {
    it('refuses every role without retirement:record, and saves nothing', async () => {
      const assetId = await registered();
      const maintainer = await api.actor('maintainer_retirement', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, admin, staff, maintainer]) {
        const res = await retire(assetId, base(), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    it('needs retirement:record itself, and fails closed when the lookup fails, saving nothing', async () => {
      const assetId = await registered();

      expect((await withCapabilityAnswer(api.app, 'retirement:record', async () => false, () => retire(assetId))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'retirement:record', async () => { throw new Error('lookup failed'); }, () => retire(assetId));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const assetId = await registered();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/assets/${assetId}/retirements`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: base(),
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_retirement', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await retire(assetId, base(), crypto.randomUUID(), leaving)).statusCode);

      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    it('tells the Asset page whether the viewer may retire it, which follows retirement:record alone', async () => {
      const assetId = await registered();

      expect((await detailOf(assetId, custodian)).can_retire).toBe(true);
      for (const actor of [admin, readonly, staff]) {
        expect((await detailOf(assetId, actor)).can_retire).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'retirement:record', async () => false, () => api.get(custodian, `/assets/${assetId}`));
      expect(denied.json().can_retire).toBe(false);
    });

    it('lets every role with asset:view read a Retirement, its Retirement Reference included, and no one else', async () => {
      const assetId = await registered();
      const retirementId = await retired(assetId, { retirement_reference: 'คำสั่งที่ทุกคนอ่านได้' });
      const maintainer = await api.actor('maintainer_retirement_reader', 'SYSTEM_MAINTAINER');

      for (const reader of [custodian, admin, readonly, staff]) {
        expect((await detailOf(assetId, reader)).retirement).toMatchObject({ id: retirementId, retirement_reference: 'คำสั่งที่ทุกคนอ่านได้' });
      }
      const refused = await api.get(maintainer, `/assets/${assetId}`);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).not.toContain(retirementId);
    });

    it('needs asset:view itself to read: denying it alone, or failing to look it up, shows nothing', async () => {
      const assetId = await registered();
      const retirementId = await retired(assetId, { note: 'หมายเหตุที่ไม่ควรเห็น' });

      const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, `/assets/${assetId}`));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('หมายเหตุที่ไม่ควรเห็น');
      expect(denied.body).not.toContain(retirementId);

      const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, `/assets/${assetId}`));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain(retirementId);

      const anonymous = await api.app.inject({ method: 'GET', url: `/assets/${assetId}` });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.body).not.toContain(retirementId);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const assetId = await registered();

      const res = await api.post(custodian, `/assets/${assetId}/retirements`, base());

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await retirementsOf(assetId)).toEqual(NONE);
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();
      const first = await retire(assetId, base(), token);
      expect(first.statusCode).toBe(201);

      const replay = await retire(assetId, base(), token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect((await retirementsOf(assetId)).retirements).toHaveLength(1);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();
      const first = await retire(assetId, base(), token);
      expect(first.statusCode).toBe(201);
      const after = await retirementsOf(assetId);

      for (const changed of [base({ retirement_method: 'EXCHANGE' }), base({ note: 'เพิ่มหมายเหตุ' }), base({ retirement_date: '2026-11-16' })]) {
        const res = await retire(assetId, changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await retirementsOf(assetId)).toEqual(after);
    });

    it('scopes a token to its actor and its operation, the Asset included', async () => {
      const otherCustodian = await api.actor('custodian_retirement_two', 'ASSET_CUSTODIAN');
      const token = crypto.randomUUID();

      expect((await retire(await registered(), base(), token)).statusCode).toBe(201);
      expect((await retire(await registered(), base(), token)).statusCode).toBe(201);
      expect((await retire(await registered(), base(), token, otherCustodian)).statusCode).toBe(201);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => retire(assetId, base(), token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().retirement_id)).size).toBe(1);
      expect((await retirementsOf(assetId)).retirements).toHaveLength(1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const token = crypto.randomUUID();

      expect((await retire(assetId, base(), token)).statusCode).toBe(409);
      await returned(loanId, [itemOf[assetId]], '2026-11-05');

      expect((await retire(assetId, base(), token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the Retirement nor the receipt, and answers in the deterministic shape', async () => {
      const assetId = await registered();
      const token = 'retirement-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_retirement() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected retirement failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_retirement BEFORE INSERT ON retirements
          FOR EACH ROW EXECUTE FUNCTION fail_retirement();
      `);
      try {
        const res = await retire(assetId, base(), token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected retirement failure');
        expect(await retirementsOf(assetId)).toEqual(NONE);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_retirement ON retirements; DROP FUNCTION fail_retirement();');
      }
      expect((await retire(assetId, base(), token)).statusCode).toBe(201);
    });

    it('commits the Retirement and its receipt together, or neither', async () => {
      const assetId = await registered();
      const token = 'retirement-receipt-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_retirement_receipt() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'retirement-receipt-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_retirement_receipt BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_retirement_receipt();
      `);
      try {
        expect((await retire(assetId, base(), token)).statusCode).toBe(500);
        expect(await retirementsOf(assetId)).toEqual(NONE);
      } finally {
        await api.pool.query('DROP TRIGGER fail_retirement_receipt ON registration_retry_tokens; DROP FUNCTION fail_retirement_receipt();');
      }
      expect((await retire(assetId, base(), token)).statusCode).toBe(201);
    });
  });
});
