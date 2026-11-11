import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, at } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

const TODAY = '2026-11-11';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F005-T2 (#100): how a repair or maintenance ended, and what follows from it.
describe('Repair Outcome (Seam A - F005-T2)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let now = new Date('2026-11-11T05:00:00Z');

  const { entry, entries, detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileHolding, untilWaiting } = lockHelpers(() => ({ api }));
  const { registered, start: startLoan, lent, returned } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: TODAY,
    dueDate: '2026-11-30',
  });
  const { base, send, sent, recordOf, recordsOf, recordOutcome, ended } = repairHelpers(() => ({ api, custodian, reader: readonly }), {
    startDate: '2026-11-02',
  });

  // How many Repair Outcome facts the record has, voided ones included.
  const outcomeFactsOf = async (repairRecordId: string): Promise<number> =>
    (await api.pool.query('SELECT count(*)::int AS n FROM repair_outcomes WHERE repair_record_id = $1', [repairRecordId])).rows[0].n;

  // An Asset placed in a Location from 2024-01-01, and its id.
  const placed = async (fields: Record<string, unknown>): Promise<string> => {
    const res = await api.post(custodian, '/assets', { name: 'ของมีที่อยู่ผลการซ่อม', effective_date: '2024-01-01', ...fields });
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

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_repair_outcome', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_repair_outcome', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair_outcome', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('records ใช้งานได้ on a record Under Repair, after which the Asset is not Under Repair and a Loan of it is accepted', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);

      const res = await recordOutcome(repairRecordId, { outcome: 'USABLE', outcome_date: '2026-11-09' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ repair_record_id: repairRecordId, version: 2 });
      expect((await detailOf(assetId)).under_repair).toBeNull();
      expect((await startLoan([assetId])).statusCode).toBe(201);
    });

    it('shows the outcome with its date, note, document reference and Next Recommended Maintenance Date on the record page and in the Asset\'s records', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { repair_kind: 'MAINTENANCE' });
      const before = Date.now();

      await ended(repairRecordId, {
        outcome: 'NOT_USABLE',
        outcome_date: '2026-11-04',
        note: 'มอเตอร์เสีย\nต้องเปลี่ยนเครื่อง',
        document_reference: 'ใบรายงาน 7/2569',
        next_recommended_maintenance_date: '2027-05-04',
      });

      const record = await recordOf(repairRecordId);
      expect(record.outcome).toEqual({
        id: expect.stringMatching(UUID),
        outcome: 'NOT_USABLE',
        outcome_date: '2026-11-04',
        note: 'มอเตอร์เสีย\nต้องเปลี่ยนเครื่อง',
        document_reference: 'ใบรายงาน 7/2569',
        next_recommended_maintenance_date: '2027-05-04',
        cost_before: null,
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_repair_outcome',
        recorded_at: expect.any(String),
      });
      expect(Date.parse(record.outcome.recorded_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(record.version).toBe(2);
      const { can_record_repair: _canRecordRepair, ...shown } = record;
      expect((await recordsOf(assetId))[0]).toEqual(shown);
    });

    it('shows no outcome on a record without one', async () => {
      expect((await recordOf(await sent(await registered()))).outcome).toBeNull();
    });

    it('needs no optional field, and blank text is none', async () => {
      const repairRecordId = await sent(await registered());

      await ended(repairRecordId, { note: '  ', document_reference: '', next_recommended_maintenance_date: null });

      expect((await recordOf(repairRecordId)).outcome).toMatchObject({ note: null, document_reference: null, next_recommended_maintenance_date: null });
    });

    it('needs the outcome and its date, takes only usable or not usable, and saves nothing otherwise', async () => {
      const repairRecordId = await sent(await registered());
      const { version } = await recordOf(repairRecordId);
      const post = (payload: Record<string, unknown>) =>
        api.post(custodian, `/repairs/${repairRecordId}/outcome`, { expected_version: version, ...payload }, { 'x-retry-token': crypto.randomUUID() });

      for (const payload of [
        { outcome_date: TODAY },
        { outcome: 'USABLE' },
        { outcome: 'RETIRED', outcome_date: TODAY },
        { outcome: 'USABLE', outcome_date: TODAY, condition: 'NORMAL' },
        { outcome: 'USABLE', outcome_date: TODAY, attachment: 'scan.pdf' },
      ]) {
        const res = await post(payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect((await post({ outcome: 'USABLE', outcome_date: TODAY, expected_version: undefined })).statusCode).toBe(400);
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('bounds the note and document reference, and refuses a control character in them', async () => {
      const repairRecordId = await sent(await registered());

      for (const fields of [{ note: over(2000) }, { document_reference: over(500) }, { note: 'ok\u0007' }]) {
        const res = await recordOutcome(repairRecordId, fields);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);

      await ended(repairRecordId, { note: 'ก'.repeat(2000), document_reference: 'ข'.repeat(500) });
    });

    it('refuses a second outcome, naming the record, and changes nothing', async () => {
      const repairRecordId = await sent(await registered());
      await ended(repairRecordId, { outcome: 'USABLE' });
      const record = await recordOf(repairRecordId);

      const res = await recordOutcome(repairRecordId, { outcome: 'NOT_USABLE' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPAIR_OUTCOME_REFUSED', record: { repair_record_id: repairRecordId, reason: 'HAS_OUTCOME' } });
      expect(await recordOf(repairRecordId)).toEqual(record);
    });

    it('refuses an outcome on a voided record', async () => {
      const repairRecordId = await sent(await registered());
      // F005-T6 voids records; this stands in for it.
      await api.pool.query('UPDATE repair_records SET is_voided = true WHERE id = $1', [repairRecordId]);

      const res = await recordOutcome(repairRecordId);

      expect(res.statusCode).toBe(409);
      expect(res.json().record).toEqual({ repair_record_id: repairRecordId, reason: 'VOIDED' });
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('answers a record that does not exist with 404, and a malformed id with 400', async () => {
      const post = (id: string) =>
        api.post(custodian, `/repairs/${id}/outcome`, { expected_version: 1, outcome: 'USABLE', outcome_date: TODAY }, { 'x-retry-token': crypto.randomUUID() });

      expect((await post(crypto.randomUUID())).statusCode).toBe(404);
      expect((await post('not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('dates', () => {
    it('takes today as an Outcome Date and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      const repairRecordId = await sent(await registered());
      now = new Date('2026-11-11T16:59:59Z');
      try {
        expect((await recordOutcome(repairRecordId, { outcome_date: '2026-11-12' })).statusCode).toBe(400);
        now = new Date('2026-11-11T17:00:00Z');
        expect((await recordOutcome(repairRecordId, { outcome_date: '2026-11-12' })).statusCode).toBe(201);
      } finally {
        now = new Date('2026-11-11T05:00:00Z');
      }
    });

    it('takes the Start Date as an Outcome Date and refuses one before it', async () => {
      const repairRecordId = await sent(await registered(), { start_date: '2026-11-05' });

      const early = await recordOutcome(repairRecordId, { outcome_date: '2026-11-04' });
      expect(early.statusCode).toBe(400);
      expect(early.json().message).toContain('Start Date');
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);

      expect((await recordOutcome(repairRecordId, { outcome_date: '2026-11-05' })).statusCode).toBe(201);
    });

    it('refuses an Outcome Date or Next Recommended Maintenance Date that is no calendar date', async () => {
      const repairRecordId = await sent(await registered());

      for (const fields of [{ outcome_date: '2026-02-30' }, { outcome_date: '' }, { next_recommended_maintenance_date: 'soon' }]) {
        expect((await recordOutcome(repairRecordId, fields)).statusCode).toBe(400);
      }
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('takes a Next Recommended Maintenance Date only after the Outcome Date, on either kind', async () => {
      for (const repairKind of ['REPAIR', 'MAINTENANCE']) {
        const repairRecordId = await sent(await registered(), { repair_kind: repairKind });

        for (const nextDate of ['2026-11-02', '2026-11-01']) {
          const res = await recordOutcome(repairRecordId, { outcome_date: '2026-11-02', next_recommended_maintenance_date: nextDate });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toContain('next_recommended_maintenance_date');
        }
        await ended(repairRecordId, { outcome_date: '2026-11-02', next_recommended_maintenance_date: '2026-11-03' });
      }
    });
  });

  describe('cost (RM-09, #98 Q22)', () => {
    it('keeps the record\'s cost when the outcome leaves it out, and the outcome keeps the cost it replaced', async () => {
      const repairRecordId = await sent(await registered(), { cost: '800' });

      await ended(repairRecordId);

      const record = await recordOf(repairRecordId);
      expect(record.cost).toBe('800.00');
      expect(record.outcome.cost_before).toBe('800.00');
    });

    it('sets the record\'s one cost from the outcome, and the outcome keeps the cost it replaced', async () => {
      const changed = await sent(await registered(), { cost: '800' });
      const added = await sent(await registered());
      const cleared = await sent(await registered(), { cost: '50.5' });

      await ended(changed, { cost: '1250.75' });
      await ended(added, { cost: '300' });
      await ended(cleared, { cost: null });

      expect(await recordOf(changed)).toMatchObject({ cost: '1250.75', outcome: { cost_before: '800.00' } });
      expect(await recordOf(added)).toMatchObject({ cost: '300.00', outcome: { cost_before: null } });
      expect(await recordOf(cleared)).toMatchObject({ cost: null, outcome: { cost_before: '50.50' } });
    });

    it('refuses a cost that is not baht with at most two decimals, and saves nothing', async () => {
      const repairRecordId = await sent(await registered(), { cost: '800' });

      for (const cost of ['-1', '1.234', 'abc', '10000000000']) {
        expect((await recordOutcome(repairRecordId, { cost })).statusCode).toBe(400);
      }
      expect(await recordOf(repairRecordId)).toMatchObject({ cost: '800.00', outcome: null, version: 1 });
    });
  });

  describe('a Repair Start with its outcome in one write (#98 Q1, Q22)', () => {
    it('saves the record with its outcome, so that the Asset is never Under Repair', async () => {
      const assetId = await registered();

      const res = await send(
        base(assetId, {
          repair_kind: 'MAINTENANCE',
          start_date: '2026-11-06',
          cost: '400',
          outcome: { outcome: 'USABLE', outcome_date: '2026-11-06', note: 'ล้างเครื่องแล้ว', document_reference: 'ใบงาน 3', next_recommended_maintenance_date: '2027-05-06' },
        })
      );

      expect(res.statusCode).toBe(201);
      const { repair_record_id: repairRecordId, version } = res.json();
      expect(version).toBe(1);
      expect(await recordOf(repairRecordId)).toMatchObject({
        repair_kind: 'MAINTENANCE',
        cost: '400.00',
        version: 1,
        outcome: {
          outcome: 'USABLE',
          outcome_date: '2026-11-06',
          note: 'ล้างเครื่องแล้ว',
          document_reference: 'ใบงาน 3',
          next_recommended_maintenance_date: '2027-05-06',
          cost_before: '400.00',
        },
      });
      expect((await detailOf(assetId)).under_repair).toBeNull();
      expect((await detailOf(assetId)).next_recommended_maintenance_date).toBe('2027-05-06');
      expect((await startLoan([assetId])).statusCode).toBe(201);
    });

    it('holds the outcome rules, and saves neither the record nor its outcome when one fails', async () => {
      const assetId = await registered();

      for (const outcome of [
        { outcome: 'USABLE', outcome_date: '2026-11-01' },
        { outcome: 'USABLE', outcome_date: '2026-11-12' },
        { outcome: 'USABLE', outcome_date: '2026-11-03', next_recommended_maintenance_date: '2026-11-03' },
        { outcome: 'BROKEN', outcome_date: '2026-11-03' },
        { outcome_date: '2026-11-03' },
        { outcome: 'USABLE', outcome_date: '2026-11-03', cost: '5' },
      ]) {
        const res = await send(base(assetId, { start_date: '2026-11-02', outcome }));
        expect(res.statusCode).toBe(400);
      }
      expect(await recordsOf(assetId)).toEqual([]);
    });

    it('is refused as a Repair Start is, and saves nothing', async () => {
      const lentAsset = await registered();
      await lent([lentAsset]);
      const repairing = await registered();
      await sent(repairing);

      for (const assetId of [lentAsset, repairing]) {
        const res = await send(base(assetId, { outcome: { outcome: 'USABLE', outcome_date: TODAY } }));
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('REPAIR_START_REFUSED');
      }
      expect(await recordsOf(lentAsset)).toEqual([]);
      expect(await recordsOf(repairing)).toHaveLength(1);
    });

    it('saves neither the record nor its outcome when the outcome cannot be persisted', async () => {
      const assetId = await registered();
      await api.pool.query(`
        CREATE FUNCTION fail_repair_outcome() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected repair outcome failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_repair_outcome BEFORE INSERT ON repair_outcomes
          FOR EACH ROW EXECUTE FUNCTION fail_repair_outcome();
      `);
      try {
        const res = await send(base(assetId, { outcome: { outcome: 'USABLE', outcome_date: TODAY } }));

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected repair outcome failure');
      } finally {
        await api.pool.query('DROP TRIGGER fail_repair_outcome ON repair_outcomes; DROP FUNCTION fail_repair_outcome();');
      }
      expect(await recordsOf(assetId)).toEqual([]);
      expect((await detailOf(assetId)).under_repair).toBeNull();
    });
  });

  describe('after the outcome (RM-06, RM-11, DR-04, DR-17)', () => {
    it('leaves an Asset ended ซ่อมไม่ได้ in the register, where a Loan and a Reassignment are accepted', async () => {
      const [roomA, roomB] = await entries('locations', 'ห้องหลังซ่อมไม่ได้', 2);
      const assetId = await placed({ location_id: roomA.id });
      await ended(await sent(assetId), { outcome: 'NOT_USABLE', note: 'ร้านเก็บเครื่องไว้' });

      const detail = await detailOf(assetId);
      expect(detail.asset.id).toBe(assetId);
      expect(detail.under_repair).toBeNull();
      expect((await reassign(assetId, { effective_date: TODAY, location_id: roomB.id })).statusCode).toBe(201);
      expect((await startLoan([assetId])).statusCode).toBe(201);
    });

    it('lets maintenance that found a fault end ใช้งานไม่ได้, and a ซ่อม record start the same day', async () => {
      const assetId = await registered();
      const maintenance = await sent(assetId, { repair_kind: 'MAINTENANCE', start_date: '2026-11-07' });
      await ended(maintenance, { outcome: 'NOT_USABLE', outcome_date: '2026-11-07' });

      const repair = await sent(assetId, { repair_kind: 'REPAIR', start_date: '2026-11-07' });

      expect((await recordOf(maintenance)).repair_kind).toBe('MAINTENANCE');
      expect((await detailOf(assetId)).under_repair).toMatchObject({ repair_record_id: repair, repair_kind: 'REPAIR' });
    });

    it('writes no assignment fact', async () => {
      const [room] = await entries('locations', 'ห้องไม่เปลี่ยนเมื่อบันทึกผล', 1);
      const assetId = await placed({ location_id: room.id });
      const repairRecordId = await sent(assetId);
      const before = await assignmentOf(assetId);

      await ended(repairRecordId);

      expect(await assignmentOf(assetId)).toEqual(before);
    });
  });

  describe('where the Asset goes back to (MR-16, MR-17)', () => {
    const assignmentOn = async (repairRecordId: string, date: string, actor: Actor = readonly) => {
      const res = await api.get(actor, `/repairs/${repairRecordId}?outcome_date=${date}`);
      expect(res.statusCode).toBe(200);
      return res.json().assignment_on_outcome_date;
    };

    it('is the Location, OrganizationUnit and Responsible Person in effect on the Outcome Date, as Feature 003 derives them', async () => {
      const [roomA, roomB] = await entries('locations', 'ห้องผลการซ่อม', 2);
      const unit = await entry('organization-units', 'งานพัสดุผลการซ่อม');
      const person = await entry('persons', 'สมหญิง รับผิดชอบผลการซ่อม');
      const assetId = await placed({ location_id: roomA.id, organization_unit_id: unit.id, responsible_person_id: person.id });
      const repairRecordId = await sent(assetId, { start_date: '2026-10-01' });
      expect((await reassign(assetId, { effective_date: '2026-11-05', location_id: roomB.id })).statusCode).toBe(201);

      expect(await assignmentOn(repairRecordId, '2026-11-04')).toEqual({
        location: at(roomA).entry,
        organization_unit: at(unit).entry,
        responsible_person: at(person).entry,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
      expect((await assignmentOn(repairRecordId, '2026-11-05')).location).toEqual(at(roomB).entry);
    });

    it('is shown only when an Outcome Date is asked for, and stored nowhere', async () => {
      const [room] = await entries('locations', 'ห้องไม่เก็บผลการซ่อม', 1);
      const assetId = await placed({ location_id: room.id });
      const repairRecordId = await sent(assetId);

      expect(await recordOf(repairRecordId)).not.toHaveProperty('assignment_on_outcome_date');
      await ended(repairRecordId);
      expect(await recordOf(repairRecordId)).not.toHaveProperty('assignment_on_outcome_date');
    });

    it('refuses an Outcome Date that is no calendar date', async () => {
      const repairRecordId = await sent(await registered());

      for (const query of ['outcome_date=soon', 'outcome_date=2026-02-30', 'outcome_date=']) {
        expect((await api.get(readonly, `/repairs/${repairRecordId}?${query}`)).statusCode).toBe(400);
      }
    });
  });

  describe('the Next Recommended Maintenance Date (RM-15, #98 Q7)', () => {
    it('is that of the latest outcome by Outcome Date, then Recorded At, that has one, and null before any', async () => {
      const assetId = await registered();
      expect((await detailOf(assetId)).next_recommended_maintenance_date).toBeNull();

      await ended(await sent(assetId, { start_date: '2026-10-01' }), { outcome_date: '2026-10-02', next_recommended_maintenance_date: '2027-01-01' });
      expect((await detailOf(assetId)).next_recommended_maintenance_date).toBe('2027-01-01');

      // A later outcome without one leaves it; an older one recorded later does not take over.
      await ended(await sent(assetId, { start_date: '2026-10-05' }), { outcome_date: '2026-10-06' });
      await send(base(assetId, { start_date: '2026-09-01', outcome: { outcome: 'USABLE', outcome_date: '2026-09-02', next_recommended_maintenance_date: '2027-06-01' } }));
      expect((await detailOf(assetId)).next_recommended_maintenance_date).toBe('2027-01-01');

      // On one Outcome Date, the one recorded later counts.
      await send(base(assetId, { start_date: '2026-10-02', outcome: { outcome: 'USABLE', outcome_date: '2026-10-02', next_recommended_maintenance_date: '2027-02-01' } }));
      expect((await detailOf(assetId)).next_recommended_maintenance_date).toBe('2027-02-01');
    });

    it('counts no voided outcome', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      await ended(repairRecordId, { next_recommended_maintenance_date: '2027-01-01' });

      // F005-T6 voids outcomes; this stands in for it.
      await api.pool.query('UPDATE repair_outcomes SET is_voided = true WHERE repair_record_id = $1', [repairRecordId]);

      expect((await detailOf(assetId)).next_recommended_maintenance_date).toBeNull();
    });
  });

  describe('the Start Loan warning (#98 Q20)', () => {
    const warningOf = async (assetId: string) => (await detailOf(assetId)).start_loan_warning;

    // An Asset lent from `loanDate` and back on `returnDate` in `condition`.
    const lentAndReturned = async (assetId: string, loanDate: string, returnDate: string, condition: 'NORMAL' | 'DAMAGED') => {
      const { loanId, itemOf } = await lent([assetId], { loan_date: loanDate });
      await returned(loanId, [itemOf[assetId]], returnDate, condition);
    };

    it('is null before any Loan Return or Repair Outcome', async () => {
      expect(await warningOf(await registered())).toBeNull();
    });

    it('warns with the date of a ชำรุด Loan Return, as before, and not of a ปกติ one', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-11-01', '2026-11-03', 'DAMAGED');
      expect(await warningOf(assetId)).toEqual({ source: 'LOAN_RETURN', date: '2026-11-03' });

      await lentAndReturned(assetId, '2026-11-03', '2026-11-04', 'NORMAL');
      expect(await warningOf(assetId)).toBeNull();
    });

    it('is cleared by a later ใช้งานได้, and warns with the date of ซ่อมไม่ได้ or ใช้งานไม่ได้', async () => {
      for (const repairKind of ['REPAIR', 'MAINTENANCE']) {
        const assetId = await registered();
        await lentAndReturned(assetId, '2026-11-01', '2026-11-02', 'DAMAGED');

        const usable = await sent(assetId, { repair_kind: repairKind, start_date: '2026-11-03' });
        await ended(usable, { outcome: 'USABLE', outcome_date: '2026-11-04' });
        expect(await warningOf(assetId)).toBeNull();

        const unusable = await sent(assetId, { repair_kind: repairKind, start_date: '2026-11-05' });
        await ended(unusable, { outcome: 'NOT_USABLE', outcome_date: '2026-11-06' });
        expect(await warningOf(assetId)).toEqual({ source: 'REPAIR_OUTCOME', date: '2026-11-06', repair_record_id: unusable, repair_kind: repairKind });
      }
    });

    it('follows a Loan Return dated after the outcome', async () => {
      const assetId = await registered();
      await ended(await sent(assetId, { start_date: '2026-11-01' }), { outcome: 'NOT_USABLE', outcome_date: '2026-11-02' });

      await lentAndReturned(assetId, '2026-11-03', '2026-11-04', 'NORMAL');

      expect(await warningOf(assetId)).toBeNull();
    });

    it('goes by date, not by when facts were recorded', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-11-08', '2026-11-09', 'DAMAGED');

      // A Repair Outcome dated before that Loan Return, recorded after it.
      await send(base(assetId, { start_date: '2026-11-01', outcome: { outcome: 'USABLE', outcome_date: '2026-11-02' } }));

      expect(await warningOf(assetId)).toEqual({ source: 'LOAN_RETURN', date: '2026-11-09' });
    });

    it('counts the Repair Outcome as later on the same date, whichever was recorded first', async () => {
      const outcomeFirst = await registered();
      await send(base(outcomeFirst, { start_date: '2026-11-03', outcome: { outcome: 'USABLE', outcome_date: '2026-11-05' } }));
      await lentAndReturned(outcomeFirst, '2026-11-05', '2026-11-05', 'DAMAGED');
      expect(await warningOf(outcomeFirst)).toBeNull();

      const returnFirst = await registered();
      await lentAndReturned(returnFirst, '2026-11-01', '2026-11-05', 'NORMAL');
      const repairRecordId = await sent(returnFirst, { start_date: '2026-11-05' });
      await ended(repairRecordId, { outcome: 'NOT_USABLE', outcome_date: '2026-11-05' });
      expect(await warningOf(returnFirst)).toEqual({ source: 'REPAIR_OUTCOME', date: '2026-11-05', repair_record_id: repairRecordId, repair_kind: 'REPAIR' });
    });

    it('counts no voided outcome', async () => {
      const assetId = await registered();
      await lentAndReturned(assetId, '2026-11-01', '2026-11-02', 'DAMAGED');
      const repairRecordId = await sent(assetId, { start_date: '2026-11-03' });
      await ended(repairRecordId, { outcome: 'USABLE', outcome_date: '2026-11-04' });

      await api.pool.query('UPDATE repair_outcomes SET is_voided = true WHERE repair_record_id = $1', [repairRecordId]);

      expect(await warningOf(assetId)).toEqual({ source: 'LOAN_RETURN', date: '2026-11-02' });
    });

    it('is carried by each row of the Asset search, and blocks no Loan', async () => {
      const assetId = await registered();
      await ended(await sent(assetId), { outcome: 'NOT_USABLE' });

      const { items } = (await api.get(readonly, `/assets/search?field=stable_id&value=${assetId}`)).json();
      expect(items).toHaveLength(1);
      expect(items[0].start_loan_warning).toMatchObject({ source: 'REPAIR_OUTCOME', date: '2026-11-02' });
      expect(items[0]).not.toHaveProperty('latest_loan_return_condition');
      expect((await startLoan([assetId])).statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('refuses every role without repair:record, and saves nothing', async () => {
      const repairRecordId = await sent(await registered());
      const maintainer = await api.actor('maintainer_repair_outcome', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, admin, maintainer]) {
        const res = await recordOutcome(repairRecordId, {}, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('needs repair:record itself, and fails closed when the lookup fails, saving nothing', async () => {
      const repairRecordId = await sent(await registered());
      const { version } = await recordOf(repairRecordId);
      const post = () =>
        api.post(custodian, `/repairs/${repairRecordId}/outcome`, { expected_version: version, outcome: 'USABLE', outcome_date: TODAY }, { 'x-retry-token': crypto.randomUUID() });

      expect((await withCapabilityAnswer(api.app, 'repair:record', async () => false, post)).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'repair:record', async () => { throw new Error('lookup failed'); }, post);
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const repairRecordId = await sent(await registered());
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/repairs/${repairRecordId}/outcome`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: { expected_version: 1, outcome: 'USABLE', outcome_date: TODAY },
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_repair_outcome', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await recordOutcome(repairRecordId, {}, crypto.randomUUID(), leaving)).statusCode);

      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('tells the Repair Record page whether the viewer may record its outcome, which follows repair:record alone', async () => {
      const repairRecordId = await sent(await registered());

      expect((await recordOf(repairRecordId, custodian)).can_record_repair).toBe(true);
      for (const actor of [admin, readonly]) {
        expect((await recordOf(repairRecordId, actor)).can_record_repair).toBe(false);
      }
      const denied = await withCapabilityAnswer(api.app, 'repair:record', async () => false, () => api.get(custodian, `/repairs/${repairRecordId}`));
      expect(denied.json().can_record_repair).toBe(false);
    });
  });

  describe('expected version and retry token', () => {
    it('refuses a client that read another version, and changes nothing', async () => {
      const repairRecordId = await sent(await registered());

      const res = await api.post(
        custodian,
        `/repairs/${repairRecordId}/outcome`,
        { expected_version: 7, outcome: 'USABLE', outcome_date: TODAY },
        { 'x-retry-token': crypto.randomUUID() }
      );

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 1 }, expected_values: { version: 7 } });
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('needs a token', async () => {
      const repairRecordId = await sent(await registered());

      const res = await api.post(custodian, `/repairs/${repairRecordId}/outcome`, { expected_version: 1, outcome: 'USABLE', outcome_date: TODAY });

      expect(res.statusCode).toBe(400);
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
    });

    it('answers an identical replay with the committed result, and refuses the token with a changed payload, writing nothing', async () => {
      const repairRecordId = await sent(await registered());
      const token = crypto.randomUUID();
      const payload = { expected_version: 1, outcome: 'USABLE', outcome_date: TODAY };
      const post = (body: Record<string, unknown>) => api.post(custodian, `/repairs/${repairRecordId}/outcome`, body, { 'x-retry-token': token });
      const first = await post(payload);
      expect(first.statusCode).toBe(201);

      const replay = await post(payload);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const changed = await post({ ...payload, outcome: 'NOT_USABLE' });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await outcomeFactsOf(repairRecordId)).toBe(1);
      expect((await recordOf(repairRecordId)).outcome.outcome).toBe('USABLE');
    });

    it('scopes a token to its record, so one token may end two records', async () => {
      const [first, second] = [await sent(await registered()), await sent(await registered())];
      const token = crypto.randomUUID();

      expect((await recordOutcome(first, {}, token)).statusCode).toBe(201);
      expect((await recordOutcome(second, {}, token)).statusCode).toBe(201);
    });

    it('takes a token on the one-step write, whose replay saves one record', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();
      const payload = base(assetId, { outcome: { outcome: 'USABLE', outcome_date: TODAY } });

      const first = await send(payload, token);
      const replay = await send(payload, token);

      expect(replay.json()).toEqual(first.json());
      expect(await recordsOf(assetId)).toHaveLength(1);
      expect((await send(base(assetId, { outcome: { outcome: 'NOT_USABLE', outcome_date: TODAY } }), token)).statusCode).toBe(409);
    });
  });

  describe('concurrency', () => {
    it('ends concurrent outcomes of one record with exactly one Repair Outcome', async () => {
      const repairRecordId = await sent(await registered());
      const body = { expected_version: 1, outcome: 'USABLE', outcome_date: TODAY };

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => api.post(custodian, `/repairs/${repairRecordId}/outcome`, body, { 'x-retry-token': crypto.randomUUID() }))
      );

      expect(responses.filter((res) => res.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((res) => res.statusCode === 409)).toHaveLength(5);
      expect(await outcomeFactsOf(repairRecordId)).toBe(1);
      expect((await recordOf(repairRecordId)).version).toBe(2);
    });

    it('locks the Repair Record, then its Asset, the lock a Loan start takes', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      const recordIsLocked = async (): Promise<boolean> => {
        const client = await api.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT 1 FROM repair_records WHERE id = $1 FOR UPDATE NOWAIT', [repairRecordId]);
          return false;
        } catch (err: any) {
          if (err.code === '55P03') {
            return true;
          }
          throw err;
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };

      // Held on the Asset, the write waits there with the record already locked.
      const [res] = await whileHolding('assets', assetId, () => [recordOutcome(repairRecordId)], async () => {
        await untilWaiting('assets');
        expect(await recordIsLocked()).toBe(true);
      });

      expect(res.statusCode).toBe(201);
      expect(await recordIsLocked()).toBe(false);
    });

    it('waits on a Repair Record another write holds', async () => {
      const repairRecordId = await sent(await registered());

      const [res] = await whileHolding('repair_records', repairRecordId, () => [recordOutcome(repairRecordId)]);

      expect(res.statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    it('saves neither the outcome, the record\'s change, nor the receipt, and answers in the deterministic shape', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { cost: '10' });
      const token = 'repair-outcome-fail-token';
      await api.pool.query(`
        CREATE FUNCTION fail_repair_record_update() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected repair record failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_repair_record_update BEFORE UPDATE ON repair_records
          FOR EACH ROW EXECUTE FUNCTION fail_repair_record_update();
      `);
      try {
        const res = await recordOutcome(repairRecordId, { cost: '99' }, token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected repair record failure');
      } finally {
        await api.pool.query('DROP TRIGGER fail_repair_record_update ON repair_records; DROP FUNCTION fail_repair_record_update();');
      }
      expect(await outcomeFactsOf(repairRecordId)).toBe(0);
      expect(await recordOf(repairRecordId)).toMatchObject({ cost: '10.00', outcome: null, version: 1 });
      expect((await detailOf(assetId)).under_repair).toMatchObject({ repair_record_id: repairRecordId });
      expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);

      expect((await recordOutcome(repairRecordId, { cost: '99' }, token)).statusCode).toBe(201);
    });
  });
});
