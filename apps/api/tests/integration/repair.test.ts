import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';

const TODAY = '2026-11-11';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F005-T1 (#99): sending an Asset for repair or maintenance, and reading that it is Under Repair.
describe('Repair Start (Seam A - F005-T1)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let now = new Date('2026-11-11T05:00:00Z');

  const { entries, detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { registered, loanOf, start: startLoan, lent, returned, closedNotReturned, whileHolding } = loanHelpers(
    () => ({ api, custodian, reader: readonly }),
    { loanDate: TODAY, dueDate: '2026-11-30' }
  );

  // A valid Repair Start of `assetId`, of kind ซ่อม by an internal Repairer, unless `overrides` says otherwise.
  const base = (assetId: string, overrides: Record<string, unknown> = {}) => ({
    asset_id: assetId,
    repair_kind: 'REPAIR',
    start_date: TODAY,
    repairer: { kind: 'INTERNAL' },
    symptom_or_work: 'เปิดไม่ติด',
    ...overrides,
  });

  const send = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, '/repairs', payload, { 'x-retry-token': token });

  // An Asset sent for repair, and its Repair Record's id.
  const sent = async (assetId: string, overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await send(base(assetId, overrides));
    expect(res.statusCode).toBe(201);
    return res.json().repair_record_id;
  };

  const recordOf = async (repairRecordId: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/repairs/${repairRecordId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const recordsOf = async (assetId: string) => {
    const res = await api.get(readonly, `/assets/${assetId}/repairs`);
    expect(res.statusCode).toBe(200);
    return res.json().records;
  };

  // F005-T1 records no Repair Outcome: this stands in for the one F005-T2 records, through its stored summary.
  const outcomeStandIn = (repairRecordId: string) => api.pool.query('UPDATE repair_records SET has_outcome = true WHERE id = $1', [repairRecordId]);

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_repair', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_repair', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('sending', () => {
    it('saves a Repair Record with every field, and the Repair Record page shows each of them', async () => {
      const assetId = await registered('เครื่องพิมพ์ส่งซ่อม');
      const before = Date.now();

      const res = await send(
        base(assetId, {
          repair_kind: 'MAINTENANCE',
          start_date: '2026-11-03',
          repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อมดี' },
          symptom_or_work: 'ล้างหัวพิมพ์\nเปลี่ยนลูกยาง',
          under_warranty: 'YES',
          warranty_end_date: '2025-12-31',
          cost: '1500.5',
          document_reference: 'ใบเสนอราคา 12/2569',
          remark: 'รับเครื่องคืนภายในสัปดาห์',
        })
      );

      expect(res.statusCode).toBe(201);
      const { repair_record_id: repairRecordId, version } = res.json();
      expect(repairRecordId).toMatch(UUID);
      expect(version).toBe(1);

      const record = await recordOf(repairRecordId);
      expect(record).toEqual({
        id: repairRecordId,
        asset: { id: assetId, name: 'เครื่องพิมพ์ส่งซ่อม', asset_number: null },
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-03',
        repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อมดี' },
        symptom_or_work: 'ล้างหัวพิมพ์\nเปลี่ยนลูกยาง',
        under_warranty: 'YES',
        warranty_end_date: '2025-12-31',
        cost: '1500.50',
        document_reference: 'ใบเสนอราคา 12/2569',
        remark: 'รับเครื่องคืนภายในสัปดาห์',
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_repair',
        recorded_at: expect.any(String),
        is_voided: false,
        version: 1,
      });
      expect(Date.parse(record.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(record.recorded_at)).toBeLessThanOrEqual(Date.now());
    });

    it('needs no optional field: Under Warranty is then ไม่ระบุ, and blank text is none', async () => {
      const assetId = await registered();

      const record = await recordOf(await sent(assetId, { repairer: { kind: 'EXTERNAL', name: '   ' }, cost: '', document_reference: ' ', remark: '' }));

      expect(record).toMatchObject({
        repairer: { kind: 'EXTERNAL', name: null },
        under_warranty: 'UNSPECIFIED',
        warranty_end_date: null,
        cost: null,
        document_reference: null,
        remark: null,
      });
    });

    it('needs the kind, the Repairer kind and the symptom or work, and saves nothing without them', async () => {
      const assetId = await registered();
      const { repair_kind: _kind, ...noKind } = base(assetId);
      const { repairer: _repairer, ...noRepairer } = base(assetId);
      const { symptom_or_work: _symptom, ...noSymptom } = base(assetId);

      for (const payload of [
        noKind,
        base(assetId, { repair_kind: 'CLEANING' }),
        noRepairer,
        base(assetId, { repairer: { kind: 'VENDOR' } }),
        base(assetId, { repairer: { name: 'ร้านซ่อมดี' } }),
        noSymptom,
        base(assetId, { symptom_or_work: '  \n ' }),
      ]) {
        const res = await send(payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('takes a cost in baht with at most two decimals, and refuses a negative one', async () => {
      for (const [cost, stored] of [
        ['0', '0.00'],
        ['12', '12.00'],
        ['12.5', '12.50'],
        ['9999999999.99', '9999999999.99'],
      ]) {
        expect((await recordOf(await sent(await registered(), { cost }))).cost).toBe(stored);
      }

      const assetId = await registered();
      for (const cost of ['-1', '-0.01', '1.234', '01', '1e3', '1,500', 'abc', '10000000000']) {
        const res = await send(base(assetId, { cost }));
        expect(res.statusCode).toBe(400);
      }
      expect((await send(base(assetId, { cost: 12 }))).statusCode).toBe(400);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('takes Under Warranty as ใช่, ไม่ใช่ or ไม่ระบุ, and a warranty end date in the past or future', async () => {
      for (const underWarranty of ['YES', 'NO', 'UNSPECIFIED']) {
        expect((await recordOf(await sent(await registered(), { under_warranty: underWarranty }))).under_warranty).toBe(underWarranty);
      }
      expect((await recordOf(await sent(await registered(), { warranty_end_date: '2001-01-01' }))).warranty_end_date).toBe('2001-01-01');
      expect((await recordOf(await sent(await registered(), { warranty_end_date: '2099-12-31' }))).warranty_end_date).toBe('2099-12-31');

      const assetId = await registered();
      expect((await send(base(assetId, { under_warranty: 'MAYBE' }))).statusCode).toBe(400);
      expect((await send(base(assetId, { warranty_end_date: '2026-02-30' }))).statusCode).toBe(400);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('bounds text, and takes text at its bounds', async () => {
      const assetId = await registered();
      for (const overrides of [
        { repairer: { kind: 'EXTERNAL', name: over(200) } },
        { symptom_or_work: over(2000) },
        { document_reference: over(500) },
        { remark: over(2000) },
      ]) {
        expect((await send(base(assetId, overrides))).statusCode).toBe(400);
      }
      expect(await recordsOf(assetId)).toEqual([]);

      const atBounds = await recordOf(
        await sent(assetId, {
          repairer: { kind: 'EXTERNAL', name: 'ก'.repeat(200) },
          symptom_or_work: 'ก'.repeat(2000),
          document_reference: 'ก'.repeat(500),
          remark: 'ก'.repeat(2000),
        })
      );
      expect(atBounds.repairer.name).toHaveLength(200);
      expect(atBounds.symptom_or_work).toHaveLength(2000);
    });

    it('refuses every control character in the Repairer name, even at its ends, and keeps line breaks and tabs inside free text', async () => {
      const assetId = await registered();
      for (const name of ['ร้าน\nซ่อม', 'ร้านซ่อม\n', 'ร้าน\tซ่อม', 'ร้าน\u0007ซ่อม']) {
        expect((await send(base(assetId, { repairer: { kind: 'EXTERNAL', name } }))).statusCode).toBe(400);
      }
      for (const field of ['symptom_or_work', 'document_reference', 'remark']) {
        expect((await send(base(assetId, { [field]: 'จอ\u0007ดับ' }))).statusCode).toBe(400);
      }
      expect(await recordsOf(assetId)).toEqual([]);

      const record = await recordOf(
        await sent(assetId, { symptom_or_work: 'จอดับ\r\nมีเสียง\tดัง', document_reference: 'ใบ\nที่ 1', remark: 'คืน\tวันศุกร์' })
      );
      expect(record).toMatchObject({ symptom_or_work: 'จอดับ\r\nมีเสียง\tดัง', document_reference: 'ใบ\nที่ 1', remark: 'คืน\tวันศุกร์' });
    });

    it('takes no file and no field it does not know', async () => {
      const assetId = await registered();

      expect((await send(base(assetId, { attachment: 'ใบเสร็จ.pdf' }))).statusCode).toBe(400);
      expect((await send(base(assetId, { repairer: { kind: 'INTERNAL', phone: '0812345678' } }))).statusCode).toBe(400);
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('answers an Asset that does not exist with 404, and a malformed id with 400, saving nothing', async () => {
      const missing = await send(base(crypto.randomUUID()));
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');

      expect((await send(base('not-a-uuid'))).statusCode).toBe(400);
      expect((await api.pool.query('SELECT count(*)::int AS n FROM repair_records WHERE asset_id NOT IN (SELECT id FROM assets)')).rows[0].n).toBe(0);
    });
  });

  describe('dates', () => {
    it('takes today as a Start Date and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      const assetId = await registered();
      try {
        // 23:59:59 in Bangkok on 11 November.
        now = new Date('2026-11-11T16:59:59Z');
        expect((await send(base(assetId, { start_date: '2026-11-12' }))).statusCode).toBe(400);
        expect(await recordsOf(assetId)).toEqual([]);

        // Midnight in Bangkok: 12 November is today.
        now = new Date('2026-11-11T17:00:00Z');
        expect((await send(base(assetId, { start_date: '2026-11-12' }))).statusCode).toBe(201);
      } finally {
        now = new Date('2026-11-11T05:00:00Z');
      }
    });

    it('has no lower bound, and may be before the Asset was registered', async () => {
      const record = await recordOf(await sent(await registered(), { start_date: '1990-01-01' }));

      expect(record.start_date).toBe('1990-01-01');
    });

    it('refuses a Start Date that is no calendar date, and needs one', async () => {
      const assetId = await registered();
      const { start_date: _date, ...noDate } = base(assetId);

      for (const payload of [noDate, base(assetId, { start_date: '2026-02-29' }), base(assetId, { start_date: '11/11/2026' })]) {
        expect((await send(payload)).statusCode).toBe(400);
      }
      expect(await recordsOf(assetId)).toEqual([]);
    });
  });

  describe('Under Repair', () => {
    it('shows on the Asset page while a record has no outcome, with its kind, Start Date and Repairer, and is empty before', async () => {
      const assetId = await registered();
      expect((await detailOf(assetId)).under_repair).toBeNull();

      const repairRecordId = await sent(assetId, { repair_kind: 'MAINTENANCE', start_date: '2026-11-02', repairer: { kind: 'EXTERNAL', name: 'ช่างสมศักดิ์' } });

      expect((await detailOf(assetId)).under_repair).toEqual({
        repair_record_id: repairRecordId,
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-02',
        repairer: { kind: 'EXTERNAL', name: 'ช่างสมศักดิ์' },
      });
    });

    it('is derived on read: a record with an outcome, or a voided one, leaves the Asset not Under Repair', async () => {
      const [ended, voided] = [await registered(), await registered()];
      await outcomeStandIn(await sent(ended));
      await api.pool.query('UPDATE repair_records SET is_voided = true WHERE id = $1', [await sent(voided)]);

      expect((await detailOf(ended)).under_repair).toBeNull();
      expect((await detailOf(voided)).under_repair).toBeNull();
    });

    it('stores no outcome on any record this ticket creates', async () => {
      const repairRecordId = await sent(await registered());

      const res = await api.pool.query('SELECT has_outcome FROM repair_records WHERE id = $1', [repairRecordId]);
      expect(res.rows).toEqual([{ has_outcome: false }]);
    });

    it("lists the Asset's Repair Records, newest Start Date first, and an Asset with none as empty", async () => {
      const assetId = await registered();
      expect(await recordsOf(assetId)).toEqual([]);

      const oldest = await sent(assetId, { start_date: '2024-03-01' });
      await outcomeStandIn(oldest);
      const newest = await sent(assetId, { start_date: '2026-10-01' });
      await outcomeStandIn(newest);
      const middle = await sent(assetId, { start_date: '2025-06-01', repair_kind: 'MAINTENANCE' });

      const records = await recordsOf(assetId);
      expect(records.map(({ id }: any) => id)).toEqual([newest, middle, oldest]);
      expect(records[1]).toEqual(await recordOf(middle));
    });

    it('answers the records of an Asset that does not exist with 404, and a malformed id with 400', async () => {
      expect((await api.get(readonly, `/assets/${crypto.randomUUID()}/repairs`)).statusCode).toBe(404);
      expect((await api.get(readonly, '/assets/not-a-uuid/repairs')).statusCode).toBe(400);
      expect((await api.get(readonly, `/repairs/${crypto.randomUUID()}`)).statusCode).toBe(404);
      expect((await api.get(readonly, '/repairs/not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('guards with Loans (RM-06, RM-07, LR-12)', () => {
    it('refuses a Repair Start while the Asset is On Loan, naming the Loan, and accepts it after the Loan Return', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      const refused = await send(base(assetId));

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'REPAIR_START_REFUSED', asset: { asset_id: assetId, reason: 'ON_LOAN', loan_id: loanId } });
      expect(await recordsOf(assetId)).toEqual([]);

      await returned(loanId, [itemOf[assetId]], TODAY, 'DAMAGED');
      expect((await send(base(assetId))).statusCode).toBe(201);
    });

    it('refuses a Repair Start while a LoanItem of the Asset ended Not Returned, naming the Loan, and accepts it after a Loan Return on that item', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], TODAY);

      const refused = await send(base(assetId));

      expect(refused.statusCode).toBe(409);
      expect(refused.json().asset).toMatchObject({ asset_id: assetId, reason: 'NOT_RETURNED', loan_id: loanId });
      expect(await recordsOf(assetId)).toEqual([]);

      await returned(loanId, [itemOf[assetId]], TODAY);
      expect((await send(base(assetId))).statusCode).toBe(201);
    });

    it('refuses a second Repair Start of either kind while the Asset is Under Repair, naming the Repair Record', async () => {
      const assetId = await registered('โปรเจกเตอร์ซ่อมซ้ำ');
      const repairRecordId = await sent(assetId);

      for (const repairKind of ['REPAIR', 'MAINTENANCE']) {
        const refused = await send(base(assetId, { repair_kind: repairKind, start_date: '2020-01-01' }));
        expect(refused.statusCode).toBe(409);
        expect(refused.json().asset).toEqual({
          asset_id: assetId,
          name: 'โปรเจกเตอร์ซ่อมซ้ำ',
          asset_number: null,
          reason: 'UNDER_REPAIR',
          repair_record_id: repairRecordId,
          repair_kind: 'REPAIR',
        });
      }
      expect(await recordsOf(assetId)).toHaveLength(1);
    });

    it('refuses a Loan of an Asset Under Repair, whatever the Loan Date and of either kind, naming the Repair Record', async () => {
      for (const repairKind of ['REPAIR', 'MAINTENANCE']) {
        const assetId = await registered();
        const repairRecordId = await sent(assetId, { repair_kind: repairKind, start_date: '2026-11-05' });

        for (const loanDate of [TODAY, '2026-11-01', '2020-01-01']) {
          const refused = await startLoan([assetId], { loan_date: loanDate });
          expect(refused.statusCode).toBe(409);
          expect(refused.json()).toMatchObject({
            code: 'ASSETS_NOT_LENDABLE',
            assets: [{ asset_id: assetId, reason: 'UNDER_REPAIR', repair_record_id: repairRecordId, repair_kind: repairKind }],
          });
        }
        expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toEqual([]);
      }
    });

    it('names the Under Repair Asset beside the On Loan one, and lends neither', async () => {
      const [repairing, lending, free] = [await registered(), await registered(), await registered()];
      const repairRecordId = await sent(repairing);
      const { loanId } = await lent([lending]);

      const refused = await startLoan([repairing, lending, free]);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ asset_id: repairing, reason: 'UNDER_REPAIR', repair_record_id: repairRecordId }),
          expect.objectContaining({ asset_id: lending, reason: 'ON_LOAN', loan_id: loanId }),
        ])
      );
      expect(refused.json().assets).toHaveLength(2);
      expect((await api.get(readonly, `/assets/${free}/loans`)).json().items).toEqual([]);
    });

    it('lends an Asset again once it is not Under Repair', async () => {
      const assetId = await registered();
      await outcomeStandIn(await sent(assetId));

      expect((await startLoan([assetId])).statusCode).toBe(201);
    });

    describe('a Loan Correction voiding a Loan Return (#98 Q19)', () => {
      const voidLoanReturn = async (loanId: string, actor: Actor = custodian) => {
        const loan = await loanOf(loanId);
        return api.post(
          actor,
          `/loans/${loanId}/corrections`,
          { expected_version: loan.version, action: 'VOID', target: { kind: 'LOAN_RETURN', id: loan.items[0].loan_return.id }, reason: 'บันทึกคืนผิดรายการ' },
          { 'x-retry-token': crypto.randomUUID() }
        );
      };

      // An Asset lent and returned ชำรุด, then sent for repair.
      const repairingAfterLoan = async (name: string) => {
        const assetId = await registered(name);
        const { loanId, itemOf } = await lent([assetId], { loan_date: '2026-11-01' });
        await returned(loanId, [itemOf[assetId]], '2026-11-04', 'DAMAGED');
        const repairRecordId = await sent(assetId, { start_date: '2026-11-05' });
        return { assetId, loanId, repairRecordId };
      };

      it('is refused while the Asset is Under Repair, naming the Repair Record, and changes nothing', async () => {
        const { assetId, loanId, repairRecordId } = await repairingAfterLoan('เครื่องคืนแล้วส่งซ่อม');
        const before = await loanOf(loanId);

        for (const actor of [custodian, admin]) {
          const refused = await voidLoanReturn(loanId, actor);
          expect(refused.statusCode).toBe(409);
          expect(refused.json()).toMatchObject({
            code: 'ASSET_UNDER_REPAIR',
            asset: { asset_id: assetId, name: 'เครื่องคืนแล้วส่งซ่อม', asset_number: null, repair_record_id: repairRecordId, repair_kind: 'REPAIR' },
          });
        }

        expect(await loanOf(loanId)).toEqual(before);
        expect((await detailOf(assetId)).on_loan).toBeNull();
      });

      it('is accepted once the Asset is not Under Repair', async () => {
        const { assetId, loanId, repairRecordId } = await repairingAfterLoan('เครื่องซ่อมจบแล้ว');
        await outcomeStandIn(repairRecordId);

        const res = await voidLoanReturn(loanId);

        expect(res.statusCode).toBe(201);
        expect((await detailOf(assetId)).on_loan).toMatchObject({ loan_id: loanId });
      });

      it('still voids the whole item or Loan while the Asset is Under Repair, which puts it on no Loan', async () => {
        const { assetId, loanId } = await repairingAfterLoan('เครื่องยกเลิกการยืมทั้งหมด');
        const loan = await loanOf(loanId);

        const res = await api.post(
          custodian,
          `/loans/${loanId}/corrections`,
          { expected_version: loan.version, action: 'VOID', target: { kind: 'LOAN' }, reason: 'ไม่เคยยืมจริง' },
          { 'x-retry-token': crypto.randomUUID() }
        );

        expect(res.statusCode).toBe(201);
        expect((await detailOf(assetId)).on_loan).toBeNull();
      });
    });
  });

  describe('concurrency', () => {
    const waitingOnAssetLock = async (): Promise<number> => {
      const res = await api.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM assets WHERE id = ANY%FOR UPDATE%'`
      );
      return res.rows[0].n;
    };

    it('ends concurrent Repair Starts for one Asset with exactly one Repair Record, and the others name it', async () => {
      const assetId = await registered();

      const results = await Promise.all(Array.from({ length: 8 }, () => send(base(assetId))));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(7).fill(409)]);
      const winner = results.find((res) => res.statusCode === 201)!.json().repair_record_id;
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json().asset).toMatchObject({ asset_id: assetId, reason: 'UNDER_REPAIR', repair_record_id: winner });
      }
      expect(await recordsOf(assetId)).toHaveLength(1);
    });

    it('locks the Asset row a Loan start locks, so a Repair Start and a Loan start of one Asset never both succeed', async () => {
      for (let round = 0; round < 5; round++) {
        const assetId = await registered();

        const writes = await whileHolding('assets', assetId, async () => {
          const pending = [send(base(assetId)), startLoan([assetId])];
          // Both wait on the Asset row, so neither has read the other's fact yet.
          await expect.poll(waitingOnAssetLock, { timeout: 10_000, interval: 50 }).toBe(2);
          return pending;
        });
        const [repair, loan] = await Promise.all(writes);

        expect([repair.statusCode, loan.statusCode].sort()).toEqual([201, 409]);
        if (repair.statusCode === 201) {
          expect(loan.json().assets).toMatchObject([{ asset_id: assetId, reason: 'UNDER_REPAIR', repair_record_id: repair.json().repair_record_id }]);
          expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toEqual([]);
        } else {
          expect(repair.json().asset).toMatchObject({ asset_id: assetId, reason: 'ON_LOAN', loan_id: loan.json().loan_id });
          expect(await recordsOf(assetId)).toEqual([]);
        }
      }
    }, 60_000);
  });

  describe('the Permanent Assignment (RM-05, MR-14 to MR-18)', () => {
    const placed = async (location: Entry): Promise<string> => {
      const res = await api.post(custodian, '/assets', { name: 'ของมีที่อยู่ส่งซ่อม', location_id: location.id, effective_date: '2024-01-01' });
      expect(res.statusCode).toBe(201);
      return res.json().asset.id;
    };

    const reassign = async (assetId: string, payload: Record<string, unknown>) => {
      const { assignment_version } = await detailOf(assetId);
      return api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: assignment_version, ...payload },
        { 'x-retry-token': crypto.randomUUID() }
      );
    };

    it('stays exactly as it was: a Repair Start writes no assignment fact and moves no version', async () => {
      const [room] = await entries('locations', 'ห้องไม่เปลี่ยนเมื่อส่งซ่อม', 1);
      const assetId = await placed(room);
      const before = await assignmentOf(assetId);

      await sent(assetId);

      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('changes only the Permanent Assignment on a Reassignment during a repair, or a backdated one overlapping it, with no conflict', async () => {
      const [roomA, roomB, roomC] = await entries('locations', 'ห้องย้ายระหว่างซ่อม', 3);
      const assetId = await placed(roomA);
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      const record = await recordOf(repairRecordId);

      // A Reassignment dated inside the repair's period, recorded during it, then one dated today.
      expect((await reassign(assetId, { effective_date: '2026-10-15', location_id: roomC.id })).statusCode).toBe(201);
      expect((await detailOf(assetId)).current_assignment.location).toMatchObject({ id: roomC.id });
      expect((await reassign(assetId, { effective_date: TODAY, location_id: roomB.id })).statusCode).toBe(201);

      const detail = await detailOf(assetId);
      expect(detail.current_assignment.location).toMatchObject({ id: roomB.id });
      expect(detail.has_assignment_conflict).toBe(false);
      expect(detail.under_repair).toMatchObject({ repair_record_id: repairRecordId });
      expect(await recordOf(repairRecordId)).toEqual(record);
    });

    it('does not gate on it: an Asset with none, with Legacy text, or with an unresolved Assignment Conflict can be sent', async () => {
      const none = await registered();
      const legacy = (await api.post(custodian, '/assets', { name: 'ของข้อความเดิมส่งซ่อม', legacy_location_text: 'ห้องตามทะเบียนเก่า', effective_date: null })).json().asset.id;
      const [roomA, roomB, roomC] = await entries('locations', 'ห้องขัดแย้งส่งซ่อม', 3);
      const contradicted = await placed(roomA);
      expect((await reassign(contradicted, { effective_date: '2024-06-01', location_id: roomC.id })).statusCode).toBe(201);
      expect((await reassign(contradicted, { effective_date: '2024-03-01', location_id: roomB.id, explicit_continuation: true })).statusCode).toBe(201);
      expect((await detailOf(contradicted)).has_assignment_conflict).toBe(true);

      for (const assetId of [none, legacy, contradicted]) {
        expect((await send(base(assetId))).statusCode).toBe(201);
      }
    });

    it("lets asset:correct correct the Asset's own details while it is Under Repair", async () => {
      const assetId = await registered('ชื่อเดิมระหว่างซ่อม');
      await sent(assetId);

      const res = await api.post(
        custodian,
        `/assets/${assetId}/correct`,
        { name: 'ชื่อที่ถูกต้อง', expected_name: 'ชื่อเดิมระหว่างซ่อม', expected_asset_number: null, expected_serial_number: null, reason: 'สะกดผิด' },
        { 'x-retry-token': crypto.randomUUID() }
      );

      expect(res.statusCode).toBe(200);
      expect((await detailOf(assetId)).asset.name).toBe('ชื่อที่ถูกต้อง');
      expect((await detailOf(assetId)).under_repair).not.toBeNull();
    });
  });

  describe('authorization', () => {
    it('refuses every role without repair:record, and saves nothing', async () => {
      const assetId = await registered();
      const maintainer = await api.actor('maintainer_repair', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, admin, maintainer]) {
        const res = await send(base(assetId), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('needs repair:record itself, and fails closed when the lookup fails, saving nothing', async () => {
      const assetId = await registered();

      expect((await withCapabilityAnswer(api.app, 'repair:record', async () => false, () => send(base(assetId)))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'repair:record', async () => { throw new Error('lookup failed'); }, () => send(base(assetId)));
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const assetId = await registered();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: '/repairs', headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload: base(assetId) });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_repair', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await send(base(assetId), crypto.randomUUID(), leaving)).statusCode);

      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('tells the Asset page whether the viewer may send it, which follows repair:record alone', async () => {
      const assetId = await registered();

      expect((await api.get(custodian, `/assets/${assetId}`)).json().can_record_repair).toBe(true);
      for (const actor of [admin, readonly]) {
        expect((await api.get(actor, `/assets/${assetId}`)).json().can_record_repair).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'repair:record', async () => false, () => api.get(custodian, `/assets/${assetId}`));
      expect(denied.json().can_record_repair).toBe(false);
    });

    it('lets every role with asset:view read Repair Records, cost and Repairer included, and no one else', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { repairer: { kind: 'EXTERNAL', name: 'ร้านอ่านได้ทุกคน' }, cost: '450' });
      const maintainer = await api.actor('maintainer_repair_reader', 'SYSTEM_MAINTAINER');

      for (const reader of [custodian, admin, readonly]) {
        expect(await recordOf(repairRecordId, reader)).toMatchObject({ cost: '450.00', repairer: { name: 'ร้านอ่านได้ทุกคน' } });
        expect((await api.get(reader, `/assets/${assetId}/repairs`)).json().records).toHaveLength(1);
        expect((await api.get(reader, `/assets/${assetId}`)).json().under_repair).toMatchObject({ repair_record_id: repairRecordId });
      }
      expect((await api.get(maintainer, `/repairs/${repairRecordId}`)).statusCode).toBe(403);
      expect((await api.get(maintainer, `/assets/${assetId}/repairs`)).statusCode).toBe(403);
    });

    it('needs asset:view itself to read: denying it alone, or failing to look it up, shows nothing', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { symptom_or_work: 'อาการที่ไม่ควรเห็น' });

      for (const url of [`/repairs/${repairRecordId}`, `/assets/${assetId}/repairs`, `/assets/${assetId}`]) {
        const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('อาการที่ไม่ควรเห็น');
        expect(denied.body).not.toContain(repairRecordId);

        const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('อาการที่ไม่ควรเห็น');
        expect(failed.body).not.toContain(repairRecordId);
      }
    });

    it('shows a deep link nothing without a session', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);

      for (const url of [`/repairs/${repairRecordId}`, `/assets/${assetId}/repairs`, `/assets/${assetId}`]) {
        const res = await api.app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain(repairRecordId);
      }
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const assetId = await registered();

      const res = await api.post(custodian, '/repairs', base(assetId));

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('answers an identical replay with the committed result and writes nothing', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();
      const first = await send(base(assetId), token);
      expect(first.statusCode).toBe(201);

      const replay = await send(base(assetId), token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await recordsOf(assetId)).toHaveLength(1);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const [assetId, other] = [await registered(), await registered()];
      const token = crypto.randomUUID();
      expect((await send(base(assetId), token)).statusCode).toBe(201);

      for (const changed of [base(other), base(assetId, { cost: '1.00' })]) {
        const res = await send(changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await recordsOf(other)).toEqual([]);
      expect(await recordsOf(assetId)).toHaveLength(1);
    });

    it('scopes a token to its actor and its operation', async () => {
      const otherCustodian = await api.actor('custodian_repair_two', 'ASSET_CUSTODIAN');
      const token = crypto.randomUUID();

      expect((await send(base(await registered()), token)).statusCode).toBe(201);
      expect((await send(base(await registered()), token, otherCustodian)).statusCode).toBe(201);
      const loanUnderToken = await api.post(
        custodian,
        '/loans',
        { assets: [{ asset_id: await registered(), condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณโทเค็น' }, loan_date: TODAY, due_date: '2026-11-30' },
        { 'x-retry-token': token }
      );
      expect(loanUnderToken.statusCode).toBe(201);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => send(base(assetId), token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().repair_record_id)).size).toBe(1);
      expect(await recordsOf(assetId)).toHaveLength(1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();

      expect((await send(base(assetId, { start_date: '2099-01-01' }), token)).statusCode).toBe(400);

      expect((await send(base(assetId), token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the Repair Record nor the receipt, and answers in the deterministic shape', async () => {
      const assetId = await registered();
      const token = 'repair-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_repair_record() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected repair failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_repair_record BEFORE INSERT ON repair_records
          FOR EACH ROW EXECUTE FUNCTION fail_repair_record();
      `);
      try {
        const res = await send(base(assetId), token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected repair failure');
        expect(await recordsOf(assetId)).toEqual([]);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_repair_record ON repair_records; DROP FUNCTION fail_repair_record();');
      }
      expect((await send(base(assetId), token)).statusCode).toBe(201);
    });

    it('commits the Repair Record and its receipt together, or neither', async () => {
      const assetId = await registered();
      const token = 'repair-receipt-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_repair_receipt() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'repair-receipt-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_repair_receipt BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_repair_receipt();
      `);
      try {
        expect((await send(base(assetId), token)).statusCode).toBe(500);
        expect(await recordsOf(assetId)).toEqual([]);
      } finally {
        await api.pool.query('DROP TRIGGER fail_repair_receipt ON registration_retry_tokens; DROP FUNCTION fail_repair_receipt();');
      }
      expect((await send(base(assetId), token)).statusCode).toBe(201);
    });
  });
});
