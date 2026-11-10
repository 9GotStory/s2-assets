import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, at, NO_VALUE, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';

const TODAY = '2026-11-05';
const LOAN_DATE = '2026-11-01';
const DUE = '2026-11-20';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F004-T2 (#76): recording that Assets came back from a Loan.
describe('Recording a Loan Return (Seam A - F004-T2)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let now = new Date('2026-11-05T05:00:00Z');
  const logLines: string[] = [];

  const { entry, entries, detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { registered, loanOf, start, lent, whileHolding, isWaitingOnLoanLock } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: LOAN_DATE,
    dueDate: DUE,
  });

  const normal = (itemId: string) => ({ loan_item_id: itemId, condition: 'NORMAL' });

  const record = (loanId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/loans/${loanId}/returns`, payload, { 'x-retry-token': token });

  // A Loan Return of `itemIds` as ปกติ, against the Loan's latest version unless `overrides` says otherwise.
  const body = async (loanId: string, itemIds: string[], overrides: Record<string, unknown> = {}) => ({
    expected_version: (await loanOf(loanId)).version,
    return_date: TODAY,
    items: itemIds.map(normal),
    ...overrides,
  });

  const endingsOf = async (itemId: string) =>
    (await api.pool.query('SELECT id, kind, is_voided FROM loan_item_endings WHERE loan_item_id = $1', [itemId])).rows;

  // What a refused or failed write must leave as it was.
  const expectUntouched = async (loanId: string, before: unknown, itemIds: string[]) => {
    expect(await loanOf(loanId)).toEqual(before);
    for (const itemId of itemIds) {
      expect(await endingsOf(itemId)).toEqual([]);
    }
  };

  beforeAll(async () => {
    api = await startApiHarness({
      clock: () => now,
      logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } },
    });
    admin = await api.actor('admin_return', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_return', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_return', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('records one ending fact per item, sharing one action reference, one Return Date, document reference and remark', async () => {
      const [first, second] = [await registered('โน้ตบุ๊ก A'), await registered('โน้ตบุ๊ก B')];
      const { loanId, version, itemOf } = await lent([first, second]);
      const before = Date.now();

      const res = await record(loanId, {
        expected_version: version,
        return_date: TODAY,
        document_reference: 'บันทึกคืน 3/2569',
        remark: 'คุณสมชายนำมาคืนแทน',
        items: [
          { loan_item_id: itemOf[first], condition: 'NORMAL' },
          { loan_item_id: itemOf[second], condition: 'DAMAGED', condition_note: 'จอแตก' },
        ],
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toEqual({
        loan_id: loanId,
        version: version + 1,
        action_reference: expect.stringMatching(UUID),
        items: expect.arrayContaining([
          { id: itemOf[first], asset_id: first },
          { id: itemOf[second], asset_id: second },
        ]),
      });
      expect(body.items).toHaveLength(2);

      const loan = await loanOf(loanId);
      expect(loan.version).toBe(version + 1);
      const shared = {
        return_date: TODAY,
        document_reference: 'บันทึกคืน 3/2569',
        remark: 'คุณสมชายนำมาคืนแทน',
        action_reference: body.action_reference,
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_return',
        returned_after_due_date: false,
      };
      expect(loan.items.map(({ ending_kind, loan_return }: any) => ({ ending_kind, loan_return }))).toEqual([
        { ending_kind: 'LOAN_RETURN', loan_return: { id: expect.stringMatching(UUID), condition: 'NORMAL', condition_note: null, recorded_at: expect.any(String), ...shared } },
        { ending_kind: 'LOAN_RETURN', loan_return: { id: expect.stringMatching(UUID), condition: 'DAMAGED', condition_note: 'จอแตก', recorded_at: expect.any(String), ...shared } },
      ]);
      expect(loan.items[0].loan_return.id).not.toBe(loan.items[1].loan_return.id);
      expect(Date.parse(loan.items[0].loan_return.recorded_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(loan.items[0].loan_return.recorded_at)).toBeLessThanOrEqual(Date.now());
    });

    it('refuses an item that already has a Loan Return, naming it, and writes nothing', async () => {
      const assetId = await registered('เครื่องฉายคืนแล้ว');
      const { loanId, itemOf } = await lent([assetId]);
      expect((await record(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      const before = await loanOf(loanId);

      const res = await record(loanId, await body(loanId, [itemOf[assetId]], { return_date: '2026-11-03' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, code: 'LOAN_ITEMS_NOT_RETURNABLE', error: 'LOAN_ITEMS_NOT_RETURNABLE' });
      expect(res.json().items).toEqual([{ loan_item_id: itemOf[assetId], asset_id: assetId, name: 'เครื่องฉายคืนแล้ว', asset_number: null, reason: 'ALREADY_RETURNED' }]);
      expect(await loanOf(loanId)).toEqual(before);
      expect(await endingsOf(itemOf[assetId])).toHaveLength(1);
    });

    it('saves nothing when any item cannot take a Loan Return, and names each such item and why', async () => {
      const [free, returned, elsewhere] = [await registered(), await registered('ของที่คืนแล้ว'), await registered()];
      const { loanId, itemOf } = await lent([free, returned]);
      const other = await lent([elsewhere]);
      expect((await record(loanId, await body(loanId, [itemOf[returned]]))).statusCode).toBe(201);
      const missing = crypto.randomUUID();
      const before = await loanOf(loanId);

      const res = await record(loanId, await body(loanId, [itemOf[free], itemOf[returned], other.itemOf[elsewhere], missing]));

      expect(res.statusCode).toBe(409);
      const byItem = Object.fromEntries(res.json().items.map((item: any) => [item.loan_item_id, item]));
      expect(Object.keys(byItem).sort()).toEqual([itemOf[returned], other.itemOf[elsewhere], missing].sort());
      expect(byItem[itemOf[returned]]).toMatchObject({ name: 'ของที่คืนแล้ว', reason: 'ALREADY_RETURNED' });
      expect(byItem[other.itemOf[elsewhere]]).toEqual({ loan_item_id: other.itemOf[elsewhere], asset_id: null, name: null, asset_number: null, reason: 'NOT_FOUND' });
      expect(byItem[missing]).toEqual({ loan_item_id: missing, asset_id: null, name: null, asset_number: null, reason: 'NOT_FOUND' });
      expect(await loanOf(loanId)).toEqual(before);
      expect(await endingsOf(itemOf[free])).toEqual([]);
      expect(await endingsOf(other.itemOf[elsewhere])).toEqual([]);
    });

    it('refuses a voided item', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await api.pool.query('UPDATE loan_items SET is_voided = true WHERE id = $1', [itemOf[assetId]]);

      const res = await record(loanId, await body(loanId, [itemOf[assetId]]));

      expect(res.statusCode).toBe(409);
      expect(res.json().items).toMatchObject([{ loan_item_id: itemOf[assetId], asset_id: assetId, reason: 'VOIDED' }]);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('takes the recorder from the session, and has no field for who brought the item back', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      for (const extra of [{ returned_by: 'คุณสมชาย' }, { recorded_by: admin.id }]) {
        const res = await record(loanId, await body(loanId, [itemOf[assetId]], extra));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      const onItem = await record(loanId, await body(loanId, [], { items: [{ ...normal(itemOf[assetId]), returned_by: 'คุณสมชาย' }] }));
      expect(onItem.statusCode).toBe(400);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('records ชำรุด and nothing else: the Asset, its assignment and its register entry stay as they were', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const { asset, history, current_assignment, assignment_version } = await detailOf(assetId);

      const res = await record(loanId, await body(loanId, [], { items: [{ loan_item_id: itemOf[assetId], condition: 'DAMAGED', condition_note: 'ปุ่มหลุด' }] }));

      expect(res.statusCode).toBe(201);
      expect(Object.keys(res.json()).sort()).toEqual(['action_reference', 'items', 'loan_id', 'version']);
      expect(await detailOf(assetId)).toMatchObject({ asset, history, current_assignment, assignment_version });
      expect((await loanOf(loanId)).items[0].loan_return).toMatchObject({ condition: 'DAMAGED', condition_note: 'ปุ่มหลุด' });
    });

    it('names each item once, by a well-formed id, and 1 to 100 of them', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const itemId = itemOf[assetId];

      for (const items of [
        [],
        [normal(itemId), normal(itemId)],
        [normal(itemId), normal(itemId.toUpperCase())],
        [normal('not-a-uuid')],
        Array.from({ length: 101 }, () => normal(crypto.randomUUID())),
      ]) {
        const res = await record(loanId, await body(loanId, [], { items }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await endingsOf(itemId)).toEqual([]);
    });

    it('answers a Loan that does not exist with 404, and a malformed id with 400', async () => {
      const missing = await record(crypto.randomUUID(), { expected_version: 1, return_date: TODAY, items: [normal(crypto.randomUUID())] });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

      const malformed = await record('not-a-uuid', { expected_version: 1, return_date: TODAY, items: [normal(crypto.randomUUID())] });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('INVALID_ID');
    });
  });

  describe('the Condition', () => {
    it('has no default: each item needs ปกติ or ชำรุด', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      for (const item of [{}, { condition: null }, { condition: '' }, { condition: 'BROKEN' }, { condition: 'ปกติ' }]) {
        const res = await record(loanId, await body(loanId, [], { items: [{ loan_item_id: itemOf[assetId], ...item }] }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });
  });

  describe('text', () => {
    const exactly = (length: number) => 'ก'.repeat(length);

    const refused = async (loanId: string, itemId: string, overrides: Record<string, unknown>) => {
      const res = await record(loanId, await body(loanId, [itemId], overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await endingsOf(itemId)).toEqual([]);
    };

    it('bounds the document reference, the remark and each Condition note, and takes them at their bounds', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const itemId = itemOf[assetId];

      await refused(loanId, itemId, { document_reference: over(500) });
      await refused(loanId, itemId, { remark: over(2000) });
      await refused(loanId, itemId, { items: [{ ...normal(itemId), condition_note: over(500) }] });

      const res = await record(loanId, await body(loanId, [], { document_reference: exactly(500), remark: exactly(2000), items: [{ ...normal(itemId), condition_note: exactly(500) }] }));
      expect(res.statusCode).toBe(201);
    });

    it('keeps line breaks and tabs inside free text, and refuses any other control character inside it', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const itemId = itemOf[assetId];
      const bell = 'ก\u0007ข';

      await refused(loanId, itemId, { document_reference: bell });
      await refused(loanId, itemId, { remark: bell });
      await refused(loanId, itemId, { items: [{ ...normal(itemId), condition_note: bell }] });

      const res = await record(loanId, await body(loanId, [], { document_reference: 'ก\nข', remark: 'ก\tข', items: [{ ...normal(itemId), condition_note: 'ก\r\nข' }] }));
      expect(res.statusCode).toBe(201);
      expect((await loanOf(loanId)).items[0].loan_return).toMatchObject({ document_reference: 'ก\nข', remark: 'ก\tข', condition_note: 'ก\r\nข' });
    });

    it('stores blank optional text as none', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      const res = await record(loanId, await body(loanId, [], { document_reference: '  ', remark: ' ', items: [{ ...normal(itemOf[assetId]), condition_note: '   ' }] }));

      expect(res.statusCode).toBe(201);
      expect((await loanOf(loanId)).items[0].loan_return).toMatchObject({ document_reference: null, remark: null, condition_note: null });
    });
  });

  describe('the Return Date', () => {
    const refused = async (loanId: string, itemId: string, overrides: Record<string, unknown>) => {
      const res = await record(loanId, await body(loanId, [itemId], overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await endingsOf(itemId)).toEqual([]);
    };

    const atClock = async (work: () => Promise<void>) => {
      const before = now;
      try {
        await work();
      } finally {
        now = before;
      }
    };

    it('takes today and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      await atClock(async () => {
        const assetId = await registered();
        const { loanId, itemOf } = await lent([assetId]);

        // 23:59:59 on 5 November in Bangkok.
        now = new Date('2026-11-05T16:59:59Z');
        await refused(loanId, itemOf[assetId], { return_date: '2026-11-06' });

        // 00:00:00 on 6 November in Bangkok, still 5 November in UTC.
        now = new Date('2026-11-05T17:00:00Z');
        expect((await record(loanId, await body(loanId, [itemOf[assetId]], { return_date: '2026-11-06' }))).statusCode).toBe(201);
      });
    });

    it('may be the Loan Date, and never before it', async () => {
      const [early, same] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([early, same]);

      await refused(loanId, itemOf[early], { return_date: '2026-10-31' });

      expect((await record(loanId, await body(loanId, [itemOf[same]], { return_date: LOAN_DATE }))).statusCode).toBe(201);
      expect((await loanOf(loanId)).items.find(({ id }: any) => id === itemOf[same]).loan_return.return_date).toBe(LOAN_DATE);
    });

    it('is required, and a calendar date', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      for (const returnDate of ['2026-02-30', '05/11/2026', '', 'soon']) {
        await refused(loanId, itemOf[assetId], { return_date: returnDate });
      }
      const { return_date: _returnDate, ...withoutDate } = await body(loanId, [itemOf[assetId]]);
      expect((await record(loanId, withoutDate)).statusCode).toBe(400);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });
  });

  describe('On Loan and status', () => {
    it('frees the returned Asset at once, while the rest of the Loan stays open', async () => {
      const [back, stillOut] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([back, stillOut]);
      expect((await detailOf(back)).on_loan).not.toBeNull();

      expect((await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[back])] })).statusCode).toBe(201);

      expect((await detailOf(back)).on_loan).toBeNull();
      expect((await detailOf(stillOut)).on_loan).toMatchObject({ loan_id: loanId });
      expect((await start([back], { loan_date: TODAY })).statusCode).toBe(201);
      expect((await detailOf(back)).on_loan).not.toBeNull();
    });

    it('derives the Loan\'s status from its items', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);
      expect((await loanOf(loanId)).status).toBe('OUTSTANDING');

      expect((await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[first])] })).statusCode).toBe(201);
      const partly = await loanOf(loanId);
      expect(partly.status).toBe('PARTIALLY_RETURNED');
      expect(partly.items.map(({ ending_kind }: any) => ending_kind).sort()).toEqual(['LOAN_RETURN', 'NONE']);

      expect((await record(loanId, { expected_version: partly.version, return_date: TODAY, items: [normal(itemOf[second])] })).statusCode).toBe(201);
      expect((await loanOf(loanId)).status).toBe('RETURNED');
    });

    it('shows a returned item in the Asset\'s Loans, with its Loan Return', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await record(loanId, await body(loanId, [], { items: [{ loan_item_id: itemOf[assetId], condition: 'DAMAGED' }] }));

      const { items } = (await api.get(readonly, `/assets/${assetId}/loans`)).json();

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ ending_kind: 'LOAN_RETURN', loan_return: { return_date: TODAY, condition: 'DAMAGED' } });
    });
  });

  describe('the latest Loan Return\'s Condition (#74 Q23)', () => {
    const returned = async (assetId: string, condition: string, returnDate: string, loanDate: string = LOAN_DATE) => {
      const { loanId, itemOf } = await lent([assetId], { loan_date: loanDate });
      const res = await record(loanId, await body(loanId, [], { return_date: returnDate, items: [{ loan_item_id: itemOf[assetId], condition }] }));
      expect(res.statusCode).toBe(201);
      return { loanId, itemId: itemOf[assetId] };
    };

    it('is on the Asset page: none before any Loan Return, then that of the latest', async () => {
      const assetId = await registered();
      expect((await detailOf(assetId)).latest_loan_return_condition).toBeNull();

      await returned(assetId, 'DAMAGED', '2026-11-03');
      expect((await detailOf(assetId)).latest_loan_return_condition).toBe('DAMAGED');

      await returned(assetId, 'NORMAL', '2026-11-04');
      expect((await detailOf(assetId)).latest_loan_return_condition).toBe('NORMAL');
    });

    it('goes by the Return Date, not by the order of recording', async () => {
      const assetId = await registered();

      await returned(assetId, 'NORMAL', '2026-11-04');
      await returned(assetId, 'DAMAGED', '2026-10-05', '2026-10-01');

      expect((await detailOf(assetId)).latest_loan_return_condition).toBe('NORMAL');
    });

    it('does not block a new Loan of the Asset', async () => {
      const assetId = await registered();
      await returned(assetId, 'DAMAGED', '2026-11-03');

      expect((await start([assetId], { loan_date: TODAY })).statusCode).toBe(201);
    });

    it('takes no voided Loan Return into account', async () => {
      const assetId = await registered();
      await returned(assetId, 'NORMAL', '2026-11-03');
      const later = await returned(assetId, 'DAMAGED', '2026-11-04');
      expect((await detailOf(assetId)).latest_loan_return_condition).toBe('DAMAGED');

      await api.pool.query(`UPDATE loan_item_endings SET is_voided = true WHERE loan_item_id = $1`, [later.itemId]);

      expect((await detailOf(assetId)).latest_loan_return_condition).toBe('NORMAL');
    });
  });

  describe('where an item goes back to (MR-16, #74 Q27)', () => {
    const placed = async (fields: Record<string, unknown>) => {
      const res = await api.post(custodian, '/assets', { name: `ของมีที่อยู่ ${crypto.randomUUID()}`, ...fields });
      expect(res.statusCode).toBe(201);
      return res.json().asset.id as string;
    };

    const reassign = async (assetId: string, payload: Record<string, unknown>) => {
      const { assignment_version } = await detailOf(assetId);
      const res = await api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: assignment_version, ...payload },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(res.statusCode).toBe(201);
      return res.json();
    };

    const assignmentOn = async (loanId: string, date: string, actor: Actor = readonly) => {
      const res = await api.get(actor, `/loans/${loanId}?return_date=${date}`);
      expect(res.statusCode).toBe(200);
      return res.json().items[0].assignment_on_return_date;
    };

    it('is each Outstanding item\'s Location, OrganizationUnit and Responsible Person in effect on the Return Date', async () => {
      const [roomA, roomB] = await entries('locations', 'ห้องคืน', 2);
      const unit = await entry('organization-units', 'งานพัสดุคืน');
      const person: Entry = await entry('persons', 'สมชาย รับผิดชอบคืน');
      const assetId = await placed({ location_id: roomA.id, organization_unit_id: unit.id, responsible_person_id: person.id, effective_date: '2024-01-01' });
      const { loanId } = await lent([assetId], { loan_date: '2026-10-01' });
      await reassign(assetId, { location_id: roomB.id, effective_date: '2026-11-03' });

      expect(await assignmentOn(loanId, '2026-11-02')).toEqual({
        location: at(roomA).entry,
        organization_unit: at(unit).entry,
        responsible_person: at(person).entry,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
      expect((await assignmentOn(loanId, '2026-11-03')).location).toEqual(at(roomB).entry);
      expect((await assignmentOn(loanId, TODAY)).organization_unit).toEqual(at(unit).entry);
    });

    it('follows the Feature 003 order: unknown first, then by Recorded At, and a voided fact takes no part', async () => {
      const [roomA, roomB, roomC] = await entries('locations', 'ห้องลำดับ', 3);
      const assetId = await placed({ location_id: roomA.id, effective_date: null });
      const { loanId } = await lent([assetId], { loan_date: '2026-10-01' });

      expect((await assignmentOn(loanId, '2020-01-01')).location).toEqual(at(roomA).entry);

      await reassign(assetId, { location_id: roomB.id, effective_date: '2026-11-02' });
      const later = await reassign(assetId, { location_id: roomC.id, effective_date: '2026-11-02' });
      expect((await assignmentOn(loanId, '2026-11-02')).location).toEqual(at(roomC).entry);

      const { assignment_version } = await detailOf(assetId);
      const voided = await api.post(
        custodian,
        `/assets/${assetId}/assignments/${later.event.id}/corrections`,
        { action: 'VOID', reason: 'บันทึกผิด', expected_assignment_version: assignment_version },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(voided.statusCode).toBe(201);
      expect((await assignmentOn(loanId, '2026-11-02')).location).toEqual(at(roomB).entry);
    });

    it('carries Legacy text, and is empty for an Asset with no Permanent Assignment', async () => {
      const legacy = await placed({ legacy_location_text: 'ห้องตามทะเบียนเก่า', effective_date: null });
      const none = await registered();
      const withLegacy = await lent([legacy]);
      const withNone = await lent([none]);

      expect(await assignmentOn(withLegacy.loanId, TODAY)).toMatchObject({ location: null, legacy_location_text: 'ห้องตามทะเบียนเก่า' });
      expect(await assignmentOn(withNone.loanId, TODAY)).toEqual({
        location: NO_VALUE.entry,
        organization_unit: NO_VALUE.entry,
        responsible_person: NO_VALUE.entry,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
      });
    });

    it('is on Outstanding items only, and only when a Return Date is asked for', async () => {
      const [room] = await entries('locations', 'ห้องเฉพาะยังไม่คืน', 1);
      const [back, stillOut] = [await placed({ location_id: room.id, effective_date: '2024-01-01' }), await placed({ location_id: room.id, effective_date: '2024-01-01' })];
      const { loanId, itemOf } = await lent([back, stillOut]);
      expect((await record(loanId, await body(loanId, [itemOf[back]]))).statusCode).toBe(201);

      const withDate = (await api.get(readonly, `/loans/${loanId}?return_date=${TODAY}`)).json();
      const carrying = withDate.items.filter(({ assignment_on_return_date }: any) => assignment_on_return_date);
      expect(carrying.map(({ id }: any) => id)).toEqual([itemOf[stillOut]]);
      expect(carrying[0].assignment_on_return_date.location).toEqual(at(room).entry);

      for (const item of (await loanOf(loanId)).items) {
        expect(item).not.toHaveProperty('assignment_on_return_date');
      }
    });

    it('refuses a Return Date that is no calendar date, and asks for no write capability', async () => {
      const assetId = await registered();
      const { loanId } = await lent([assetId]);

      for (const query of ['return_date=soon', 'return_date=2026-02-30', 'return_date=', `return_date=${TODAY}&return_date=${TODAY}`]) {
        const res = await api.get(readonly, `/loans/${loanId}?${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await assignmentOn(loanId, TODAY, readonly)).toBeDefined();
      expect(await assignmentOn(loanId, TODAY, admin)).toBeDefined();
    });
  });

  describe('the Permanent Assignment during a Loan (MR-14 to MR-19)', () => {
    const placed = async (room: Entry) => {
      const res = await api.post(custodian, '/assets', { name: `ของมีที่อยู่ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2024-01-01' });
      expect(res.statusCode).toBe(201);
      return res.json().asset.id as string;
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

    it('takes no change from a Loan Return: it writes no assignment fact and moves no version (MR-15)', async () => {
      const [room] = await entries('locations', 'ห้องไม่ถูกคืนเปลี่ยน', 1);
      const assetId = await placed(room);
      const { loanId, itemOf } = await lent([assetId]);
      const before = await assignmentOf(assetId);

      expect((await record(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('lets a Reassignment during a Loan change only the Permanent Assignment: the Borrower and the Loan stand (MR-14, MR-15, MR-19)', async () => {
      const [roomA, roomB] = await entries('locations', 'ห้องระหว่างยืม', 2);
      const assetId = await placed(roomA);
      const { loanId } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณถือของอยู่' } });
      const before = await loanOf(loanId);
      const heldBefore = (await detailOf(assetId)).on_loan;

      const res = await reassign(assetId, { location_id: roomB.id, effective_date: TODAY });

      expect(res.statusCode).toBe(201);
      expect((await detailOf(assetId)).current_assignment.location).toEqual(at(roomB).entry);
      expect(await loanOf(loanId)).toEqual(before);
      expect((await detailOf(assetId)).on_loan).toEqual(heldBefore);
    });

    it('leaves the Current Assignment on the latest effective fact at and after the Loan Return, never the values from the Loan\'s start (MR-16, MR-17)', async () => {
      const [roomA, roomB] = await entries('locations', 'ห้องหลังคืน', 2);
      const assetId = await placed(roomA);
      const { loanId, itemOf } = await lent([assetId], { loan_date: '2026-11-01' });
      expect((await reassign(assetId, { location_id: roomB.id, effective_date: '2026-11-03' })).statusCode).toBe(201);

      const atReturn = (await api.get(readonly, `/loans/${loanId}?return_date=${TODAY}`)).json();
      expect(atReturn.items[0].assignment_on_return_date.location).toEqual(at(roomB).entry);

      expect((await record(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      expect((await detailOf(assetId)).current_assignment.location).toEqual(at(roomB).entry);
    });

    it('accepts a backdated Reassignment overlapping a Loan, with no error and no Assignment Conflict from the Loan (MR-18)', async () => {
      const [roomA, roomB] = await entries('locations', 'ห้องย้อนหลังยืม', 2);
      const assetId = await placed(roomA);
      const { loanId } = await lent([assetId], { loan_date: '2026-11-01' });
      const before = await loanOf(loanId);

      const res = await reassign(assetId, { location_id: roomB.id, effective_date: '2026-11-02' });

      expect(res.statusCode).toBe(201);
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('accepts a Reassignment to the Borrower themselves (#74 Q26)', async () => {
      const [room] = await entries('locations', 'ห้องผู้ยืมรับผิดชอบ', 1);
      const borrower = await entry('persons', 'สมชาย ผู้ยืมและรับผิดชอบ');
      const assetId = await placed(room);
      const { loanId } = await lent([assetId], { borrower: { kind: 'INTERNAL', person_id: borrower.id } });
      const before = await loanOf(loanId);

      const res = await reassign(assetId, { responsible_person_id: borrower.id, effective_date: TODAY });

      expect(res.statusCode).toBe(201);
      expect((await detailOf(assetId)).has_assignment_conflict).toBe(false);
      expect(await loanOf(loanId)).toEqual(before);
    });
  });

  describe('concurrency', () => {
    const isLocked = async (table: 'loans' | 'assets', id: string): Promise<boolean> => {
      const client = await api.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
        return false;
      } catch (err: any) {
        expect(err.code).toBe('55P03');
        return true;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };

    it('refuses a stale version with the stale-before conflict, and writes nothing', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);
      expect((await record(loanId, await body(loanId, [itemOf[first]]))).statusCode).toBe(201);
      const before = await loanOf(loanId);

      const res = await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[second])] });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        statusCode: 409,
        code: 'STALE_BEFORE_CONFLICT',
        current_values: { version: version + 1 },
        expected_values: { version },
      });
      expect(await loanOf(loanId)).toEqual(before);
      expect(await endingsOf(itemOf[second])).toEqual([]);
    });

    it('increments the version on every write, and only then', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);

      expect((await record(loanId, await body(loanId, [itemOf[first]]))).json().version).toBe(version + 1);
      expect((await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[second])] })).statusCode).toBe(409);
      expect((await record(loanId, await body(loanId, [itemOf[second]]))).json().version).toBe(version + 2);
      expect((await loanOf(loanId)).version).toBe(version + 2);
    });

    it('locks the Loan row first: while it waits there, it holds no Asset', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);

      const { write } = await whileHolding('loans', loanId, async () => {
        const pending = record(loanId, payload);
        await expect.poll(isWaitingOnLoanLock, { timeout: 10_000, interval: 50 }).toBe(true);
        expect(await isLocked('assets', assetId)).toBe(false);
        return { write: pending };
      });

      expect((await write).statusCode).toBe(201);
    });

    it('then locks all of the Loan\'s Assets in identifier order, even those it does not return', async () => {
      const [low, middle, high] = [await registered(), await registered(), await registered()].sort();
      const { loanId, itemOf } = await lent([high, middle, low]);
      const payload = await body(loanId, [itemOf[high]]);

      const { write } = await whileHolding('assets', middle, async () => {
        const pending = record(loanId, payload);
        // The write stops at the Asset held: the Loan and the Asset before it are locked, the one after it is not.
        await expect.poll(() => isLocked('assets', low), { timeout: 10_000, interval: 50 }).toBe(true);
        expect(await isLocked('loans', loanId)).toBe(true);
        expect(await isLocked('assets', high)).toBe(false);
        return { write: pending };
      });

      expect((await write).statusCode).toBe(201);
    });

    it('ends concurrent Loan Returns of one item with one fact, and the rest refused', async () => {
      const assetId = await registered();
      const { loanId, version, itemOf } = await lent([assetId]);

      const results = await Promise.all(Array.from({ length: 6 }, () => record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[assetId])] })));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(5).fill(409)]);
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json().code).toBe('STALE_BEFORE_CONFLICT');
      }
      expect(await endingsOf(itemOf[assetId])).toHaveLength(1);
      expect((await loanOf(loanId)).version).toBe(version + 1);
    });
  });

  describe('retry token', () => {
    const PHONE = '089-777-1234';

    it('needs a token', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      const res = await api.post(custodian, `/loans/${loanId}/returns`, await body(loanId, [itemOf[assetId]]));

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('answers an identical replay with the committed result and writes nothing, even with the items listed in another order', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);
      const items = [normal(itemOf[first]), normal(itemOf[second])];
      const token = crypto.randomUUID();
      const payload = { expected_version: version, return_date: TODAY, items };

      const recorded = await record(loanId, payload, token);
      expect(recorded.statusCode).toBe(201);
      const replay = await record(loanId, { ...payload, items: [...items].reverse() }, token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(recorded.json());
      expect(await endingsOf(itemOf[first])).toHaveLength(1);
      expect((await loanOf(loanId)).version).toBe(version + 1);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);
      const token = crypto.randomUUID();
      expect((await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[first])] }, token)).statusCode).toBe(201);

      const changed = await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[second])] }, token);

      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await endingsOf(itemOf[second])).toEqual([]);
    });

    it('scopes a token to its actor and to its Loan', async () => {
      const otherCustodian = await api.actor('custodian_return_two', 'ASSET_CUSTODIAN');
      const [first, second, third] = [await registered(), await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      const other = await lent([third]);
      const token = crypto.randomUUID();

      expect((await record(loanId, await body(loanId, [itemOf[first]]), token)).statusCode).toBe(201);
      expect((await record(loanId, await body(loanId, [itemOf[second]]), token, otherCustodian)).statusCode).toBe(201);
      expect((await record(other.loanId, await body(other.loanId, [other.itemOf[third]]), token)).statusCode).toBe(201);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 6 }, () => record(loanId, payload, token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(6).fill(201));
      expect(new Set(responses.map((res) => res.json().action_reference)).size).toBe(1);
      expect(await endingsOf(itemOf[assetId])).toHaveLength(1);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const assetId = await registered();
      const { loanId, version, itemOf } = await lent([assetId]);
      const token = crypto.randomUUID();

      const stale = await record(loanId, { expected_version: version + 5, return_date: TODAY, items: [normal(itemOf[assetId])] }, token);
      expect(stale.statusCode).toBe(409);

      const refused = await record(loanId, { expected_version: version, return_date: '2026-10-01', items: [normal(itemOf[assetId])] }, token);
      expect(refused.statusCode).toBe(400);

      expect((await record(loanId, { expected_version: version, return_date: TODAY, items: [normal(itemOf[assetId])] }, token)).statusCode).toBe(201);
    });

    it('carries no phone number in the write response or its stored receipt', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์', phone: PHONE } });
      const token = crypto.randomUUID();

      const res = await record(loanId, await body(loanId, [itemOf[assetId]]), token);

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(PHONE);
      const receipts = await api.pool.query(`SELECT response_body::text AS body FROM registration_retry_tokens WHERE token = $1 AND operation = $2`, [token, `loan:return:${loanId}`]);
      expect(receipts.rows).toHaveLength(1);
      expect(receipts.rows[0].body).not.toContain(PHONE);
    });
  });

  describe('a failure to persist', () => {
    const failingOn = async (name: string, table: string, event: string, work: () => Promise<void>) => {
      await api.pool.query(`
        CREATE FUNCTION ${name}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected loan return failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${name}();
      `);
      try {
        await work();
      } finally {
        await api.pool.query(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`);
      }
    };

    const failureCases = [
      ['an ending fact', 'fail_return_ending', 'loan_item_endings', 'INSERT'],
      ['an item\'s ending kind, written with its ending fact', 'fail_return_kind', 'loan_items', 'UPDATE'],
      ['the Loan\'s version', 'fail_return_version', 'loans', 'UPDATE'],
    ] as const;

    it.each(failureCases)('saves nothing when %s cannot be written, and answers in the deterministic shape', async (_what, name, table, event) => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      const payload = await body(loanId, [itemOf[first], itemOf[second]]);
      const token = crypto.randomUUID();
      const before = await loanOf(loanId);

      await failingOn(name, table, event, async () => {
        const res = await record(loanId, payload, token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected');
        await expectUntouched(loanId, before, [itemOf[first], itemOf[second]]);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      });

      expect((await record(loanId, payload, token)).statusCode).toBe(201);
    });

    it('commits the facts and the receipt together, or neither', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const token = 'loan-return-receipt-fail-token';
      const before = await loanOf(loanId);
      await api.pool.query(`
        CREATE FUNCTION fail_return_receipt() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'loan-return-receipt-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_return_receipt BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_return_receipt();
      `);
      try {
        expect((await record(loanId, payload, token)).statusCode).toBe(500);
        await expectUntouched(loanId, before, [itemOf[assetId]]);
      } finally {
        await api.pool.query('DROP TRIGGER fail_return_receipt ON registration_retry_tokens; DROP FUNCTION fail_return_receipt();');
      }
      expect((await record(loanId, payload, token)).statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('refuses every role without loan:record, and saves nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const maintainer = await api.actor('maintainer_return', 'SYSTEM_MAINTAINER');
      const payload = await body(loanId, [itemOf[assetId]]);

      for (const actor of [readonly, admin, maintainer]) {
        const res = await record(loanId, payload, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('needs loan:record itself: denying it alone refuses a Custodian and saves nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);

      const res = await withCapabilityAnswer(api.app, 'loan:record', async () => false, () => record(loanId, payload));

      expect(res.statusCode).toBe(403);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('fails closed when the capability lookup fails, and saves nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);

      const res = await withCapabilityAnswer(api.app, 'loan:record', async () => { throw new Error('lookup failed'); }, () => record(loanId, payload));

      expect(res.statusCode).toBe(500);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const send = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/loans/${loanId}/returns`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload,
        });

      // The CSRF check answers first for a request with no session at all.
      expect([401, 403]).toContain((await send({})).statusCode);
      expect((await send({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_return', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await record(loanId, payload, crypto.randomUUID(), leaving)).statusCode);

      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('tells the Loan page whether the viewer may record a Loan Return', async () => {
      const assetId = await registered();
      const { loanId } = await lent([assetId]);

      expect((await loanOf(loanId, custodian)).can_record_loan).toBe(true);
      expect((await loanOf(loanId, readonly)).can_record_loan).toBe(false);
      expect((await loanOf(loanId, admin)).can_record_loan).toBe(false);
      await withCapabilityAnswer(api.app, 'loan:record', async () => false, async () => {
        expect((await loanOf(loanId, custodian)).can_record_loan).toBe(false);
      });
    });
  });

  describe('logs (LR-15)', () => {
    it('hold no Borrower details', async () => {
      const name = 'คุณไม่ลงบันทึกคืน';
      const phone = '061-222-3333';
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: name, phone } });
      logLines.length = 0;

      expect((await record(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      expect((await record(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(409);
      await api.get(custodian, `/loans/${loanId}?return_date=${TODAY}`);

      expect(logLines.length).toBeGreaterThan(0);
      const logged = logLines.join('');
      expect(logged).not.toContain(name);
      expect(logged).not.toContain(phone);
    });
  });
});
