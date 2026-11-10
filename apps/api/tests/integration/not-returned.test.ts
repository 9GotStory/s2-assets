import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, at, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';

const TODAY = '2026-11-05';
const LOAN_DATE = '2026-11-01';
const DUE = '2026-11-03';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F004-T5 (#79): closing a LoanItem whose Asset did not come back ("ปิดโดยไม่ได้รับคืน").
describe('Recording Not Returned (Seam A - F004-T5)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let now = new Date('2026-11-05T05:00:00Z');
  const logLines: string[] = [];

  const { entries, detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { registered, loanOf, whileHolding, isWaitingOnLoanLock } = loanHelpers(() => ({ api, custodian, reader: readonly }));

  const start = (assetIds: string[], overrides: Record<string, unknown> = {}) =>
    api.post(
      custodian,
      '/loans',
      {
        assets: assetIds.map((asset_id) => ({ asset_id, condition: 'NORMAL' })),
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืมไม่คืน' },
        loan_date: LOAN_DATE,
        due_date: DUE,
        ...overrides,
      },
      { 'x-retry-token': crypto.randomUUID() }
    );

  // A started Loan of `assetIds`, with its LoanItem ids by Asset.
  const lent = async (assetIds: string[], overrides: Record<string, unknown> = {}) => {
    const res = await start(assetIds, overrides);
    expect(res.statusCode).toBe(201);
    const { loan_id: loanId, version, items } = res.json();
    return { loanId: loanId as string, version: version as number, itemOf: Object.fromEntries(items.map(({ id, asset_id }: any) => [asset_id, id])) as Record<string, string> };
  };

  const close = (loanId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/loans/${loanId}/not-returned`, payload, { 'x-retry-token': token });

  // Not Returned for `itemIds`, against the Loan's latest version unless `overrides` says otherwise.
  const body = async (loanId: string, itemIds: string[], overrides: Record<string, unknown> = {}) => ({
    expected_version: (await loanOf(loanId)).version,
    not_returned_date: TODAY,
    reason: 'ผู้ยืมแจ้งว่าทำหาย',
    items: itemIds.map((loan_item_id) => ({ loan_item_id })),
    ...overrides,
  });

  const endingsOf = async (itemId: string) =>
    (await api.pool.query('SELECT kind, is_voided FROM loan_item_endings WHERE loan_item_id = $1 ORDER BY recorded_at', [itemId])).rows;

  beforeAll(async () => {
    api = await startApiHarness({
      clock: () => now,
      logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } },
    });
    admin = await api.actor('admin_not_returned', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_not_returned', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_not_returned', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('records one Not Returned per item, sharing one action reference, date and reason', async () => {
      const [first, second, kept] = [await registered('โน้ตบุ๊กหาย A'), await registered('โน้ตบุ๊กหาย B'), await registered()];
      const { loanId, version, itemOf } = await lent([first, second, kept]);

      const res = await close(loanId, {
        expected_version: version,
        not_returned_date: '2026-11-04',
        reason: 'ผู้ยืมแจ้งว่าถูกขโมย\nมีบันทึกแจ้งความ',
        items: [{ loan_item_id: itemOf[first] }, { loan_item_id: itemOf[second] }],
      });

      expect(res.statusCode).toBe(201);
      const recorded = res.json();
      expect(recorded).toEqual({
        loan_id: loanId,
        version: version + 1,
        action_reference: expect.stringMatching(UUID),
        items: expect.arrayContaining([
          { id: itemOf[first], asset_id: first },
          { id: itemOf[second], asset_id: second },
        ]),
      });
      expect(recorded.items).toHaveLength(2);

      const loan = await loanOf(loanId);
      expect(loan.version).toBe(version + 1);
      const itemById = Object.fromEntries(loan.items.map((item: any) => [item.id, item]));
      for (const assetId of [first, second]) {
        expect(itemById[itemOf[assetId]]).toMatchObject({
          ending_kind: 'NOT_RETURNED',
          is_overdue: false,
          loan_return: null,
          not_returned: {
            id: expect.stringMatching(UUID),
            not_returned_date: '2026-11-04',
            reason: 'ผู้ยืมแจ้งว่าถูกขโมย\nมีบันทึกแจ้งความ',
            action_reference: recorded.action_reference,
            recorded_by: custodian.id,
            recorded_by_username: 'custodian_not_returned',
            recorded_at: expect.any(String),
          },
        });
      }
      // The item not named stays Outstanding, and Overdue.
      expect(itemById[itemOf[kept]]).toMatchObject({ ending_kind: 'NONE', is_overdue: true, not_returned: null });
    });
  
    it('refuses an item that has ended or is voided, and one of another Loan, naming each, and writes nothing', async () => {
      const [free, returned, closed, voided, elsewhere] = [await registered(), await registered('ของคืนแล้ว'), await registered('ของปิดแล้ว'), await registered(), await registered()];
      const { loanId, itemOf } = await lent([free, returned, closed, voided]);
      const other = await lent([elsewhere]);
      const returnRes = await api.post(
        custodian,
        `/loans/${loanId}/returns`,
        { expected_version: (await loanOf(loanId)).version, return_date: TODAY, items: [{ loan_item_id: itemOf[returned], condition: 'NORMAL' }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(returnRes.statusCode).toBe(201);
      expect((await close(loanId, await body(loanId, [itemOf[closed]]))).statusCode).toBe(201);
      await api.pool.query('UPDATE loan_items SET is_voided = true WHERE id = $1', [itemOf[voided]]);
      const missing = crypto.randomUUID();
      const before = await loanOf(loanId);

      const res = await close(loanId, await body(loanId, [itemOf[free], itemOf[returned], itemOf[closed], itemOf[voided], other.itemOf[elsewhere], missing]));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, code: 'LOAN_ITEMS_NOT_OUTSTANDING', error: 'LOAN_ITEMS_NOT_OUTSTANDING' });
      const byItem = Object.fromEntries(res.json().items.map((item: any) => [item.loan_item_id, item]));
      expect(Object.keys(byItem).sort()).toEqual([itemOf[returned], itemOf[closed], itemOf[voided], other.itemOf[elsewhere], missing].sort());
      expect(byItem[itemOf[returned]]).toEqual({ loan_item_id: itemOf[returned], asset_id: returned, name: 'ของคืนแล้ว', asset_number: null, reason: 'ALREADY_RETURNED' });
      expect(byItem[itemOf[closed]]).toEqual({ loan_item_id: itemOf[closed], asset_id: closed, name: 'ของปิดแล้ว', asset_number: null, reason: 'NOT_RETURNED' });
      expect(byItem[itemOf[voided]]).toMatchObject({ asset_id: voided, reason: 'VOIDED' });
      expect(byItem[other.itemOf[elsewhere]]).toEqual({ loan_item_id: other.itemOf[elsewhere], asset_id: null, name: null, asset_number: null, reason: 'NOT_FOUND' });
      expect(byItem[missing]).toMatchObject({ asset_id: null, reason: 'NOT_FOUND' });
      expect(await loanOf(loanId)).toEqual(before);
      expect(await endingsOf(itemOf[free])).toEqual([]);
      expect(await endingsOf(itemOf[closed])).toHaveLength(1);
    });

    it('names each item once, by a well-formed id, and 1 to 100 of them', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const itemId = itemOf[assetId];

      for (const items of [
        [],
        [{ loan_item_id: itemId }, { loan_item_id: itemId.toUpperCase() }],
        [{ loan_item_id: 'not-a-uuid' }],
        [{ loan_item_id: itemId, condition: 'NORMAL' }],
        Array.from({ length: 101 }, () => ({ loan_item_id: crypto.randomUUID() })),
      ]) {
        const res = await close(loanId, await body(loanId, [], { items }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await endingsOf(itemId)).toEqual([]);
    });

    it('answers a Loan that does not exist with 404, and a malformed id with 400', async () => {
      const payload = { expected_version: 1, not_returned_date: TODAY, reason: 'หาย', items: [{ loan_item_id: crypto.randomUUID() }] };
      expect((await close(crypto.randomUUID(), payload)).statusCode).toBe(404);
      const malformed = await close('not-a-uuid', payload);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('INVALID_ID');
    });

    it('is no Loan Return: the item counts in no Loan Return and has no Condition at return', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      const [item] = (await loanOf(loanId)).items;
      expect(item).toMatchObject({ ending_kind: 'NOT_RETURNED', loan_return: null });
      expect((await detailOf(assetId)).latest_loan_return_condition).toBeNull();
      const [row] = (await api.get(readonly, `/loans?borrower_name=${encodeURIComponent('คุณผู้ยืมไม่คืน')}&limit=100`)).json().items.filter(({ id }: any) => id === loanId);
      expect(row).toMatchObject({ returned_count: 0, not_returned_count: 1, item_count: 1 });
    });
  });

  describe('the date it became known and the reason', () => {
    const refused = async (overrides: Record<string, unknown>) => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const res = await close(loanId, await body(loanId, [itemOf[assetId]], overrides));
      expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    };

    it('takes today and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      const before = now;
      try {
        const assetId = await registered();
        const { loanId, itemOf } = await lent([assetId]);

        // 23:59:59 on 5 November in Bangkok.
        now = new Date('2026-11-05T16:59:59Z');
        expect((await close(loanId, await body(loanId, [itemOf[assetId]], { not_returned_date: '2026-11-06' }))).statusCode).toBe(400);

        // 00:00:00 on 6 November in Bangkok, still 5 November in UTC.
        now = new Date('2026-11-05T17:00:00Z');
        expect((await close(loanId, await body(loanId, [itemOf[assetId]], { not_returned_date: '2026-11-06' }))).statusCode).toBe(201);
      } finally {
        now = before;
      }
    });

    it('may be the Loan Date, and never before it', async () => {
      await refused({ not_returned_date: '2026-10-31' });

      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]], { not_returned_date: LOAN_DATE }))).statusCode).toBe(201);
      expect((await loanOf(loanId)).items[0].not_returned.not_returned_date).toBe(LOAN_DATE);
    });

    it('is required, and a calendar date', async () => {
      for (const date of ['2026-02-30', '05/11/2026', '', null]) {
        await refused({ not_returned_date: date });
      }
    });

    it('needs a nonblank reason of at most 2000 characters, keeping line breaks and tabs and refusing any other control character', async () => {
      for (const reason of [undefined, null, '', '   ', over(2000), 'ก\u0007ข']) {
        await refused({ reason });
      }

      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const reason = `${'ก'.repeat(1990)}\tข\r\nค`;
      expect((await close(loanId, await body(loanId, [itemOf[assetId]], { reason: `  ${reason}  ` }))).statusCode).toBe(201);
      expect((await loanOf(loanId)).items[0].not_returned.reason).toBe(reason);
    });
  });

  describe('the Loan\'s status (#74 Q22)', () => {
    it('is "ปิดแล้ว" once every item has ended and at least one is Not Returned, and the list filters on it', async () => {
      const tag = `ปิด-${crypto.randomUUID().slice(0, 8)}`;
      const borrower = { kind: 'EXTERNAL', contact_name: `คุณ ${tag}` };
      const [lost, back, gone] = [await registered(), await registered(), await registered()];
      const mixed = await lent([lost, back], { borrower });
      const allLost = await lent([gone], { borrower });
      const statusOf = async (loanId: string) => (await loanOf(loanId)).status;
      const listed = async (status: string) =>
        (await api.get(readonly, `/loans?status=${status}&borrower_name=${encodeURIComponent(tag)}`)).json().items.map(({ id }: any) => id).sort();

      expect((await close(mixed.loanId, await body(mixed.loanId, [mixed.itemOf[lost]]))).statusCode).toBe(201);
      // A Not Returned item is not a returned one, and the other item is still out.
      expect(await statusOf(mixed.loanId)).toBe('OUTSTANDING');

      const returnRes = await api.post(
        custodian,
        `/loans/${mixed.loanId}/returns`,
        { expected_version: (await loanOf(mixed.loanId)).version, return_date: TODAY, items: [{ loan_item_id: mixed.itemOf[back], condition: 'NORMAL' }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(returnRes.statusCode).toBe(201);
      expect(await statusOf(mixed.loanId)).toBe('CLOSED');

      expect((await close(allLost.loanId, await body(allLost.loanId, [allLost.itemOf[gone]]))).statusCode).toBe(201);
      expect(await statusOf(allLost.loanId)).toBe('CLOSED');

      expect(await listed('CLOSED')).toEqual([mixed.loanId, allLost.loanId].sort());
      expect(await listed('RETURNED')).toEqual([]);
      const rows = (await api.get(readonly, `/loans?borrower_name=${encodeURIComponent(tag)}`)).json().items;
      expect(Object.fromEntries(rows.map(({ id, returned_count, not_returned_count }: any) => [id, [returned_count, not_returned_count]]))).toEqual({
        [mixed.loanId]: [1, 1],
        [allLost.loanId]: [0, 1],
      });
    });

    it('takes the item out of Outstanding and Overdue, and the Asset is no longer On Loan', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await loanOf(loanId)).is_overdue).toBe(true);
      expect((await detailOf(assetId)).on_loan).not.toBeNull();

      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      expect((await loanOf(loanId)).is_overdue).toBe(false);
      expect((await detailOf(assetId)).on_loan).toBeNull();
      const [item] = (await api.get(readonly, `/assets/${assetId}/loans`)).json().items;
      expect(item).toMatchObject({ ending_kind: 'NOT_RETURNED', is_overdue: false, not_returned: { not_returned_date: TODAY, reason: 'ผู้ยืมแจ้งว่าทำหาย' } });
    });
  });

  describe('the guard on a new Loan (#74 Q21)', () => {
    it('refuses a new Loan of the Asset, whatever its Loan Date, naming the Asset, the reason and the Loan', async () => {
      const assetId = await registered('กล้องที่ไม่ได้คืน');
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      expect((await detailOf(assetId)).not_returned).toEqual({ loan_id: loanId, not_returned_date: TODAY });

      for (const loanDate of [TODAY, '2026-11-02', '2020-01-01']) {
        const res = await start([assetId], { loan_date: loanDate, due_date: '2026-12-31' });
        expect(res.statusCode, loanDate).toBe(409);
        expect(res.json().code).toBe('ASSETS_NOT_LENDABLE');
        expect(res.json().assets).toEqual([{ asset_id: assetId, name: 'กล้องที่ไม่ได้คืน', asset_number: null, reason: 'NOT_RETURNED', loan_id: loanId }]);
      }
      expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toHaveLength(1);
    });

    it('holds under concurrent starts: every one is refused', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      const results = await Promise.all(Array.from({ length: 6 }, () => start([assetId], { loan_date: TODAY, due_date: '2026-12-31' })));

      expect(results.map((res) => res.statusCode)).toEqual(Array(6).fill(409));
      expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toHaveLength(1);
    });

    it('is held by the database too: the partial unique index refuses a second LoanItem of the Asset', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      const other = await lent([await registered()]);

      await expect(
        api.pool.query(`INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-12-31', 'NORMAL')`, [other.loanId, assetId])
      ).rejects.toMatchObject({ code: '23505', constraint: 'loan_items_one_outstanding_or_not_returned_per_asset' });
    });

    it('is not on an Asset whose Not Returned item came back', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]], { not_returned_date: '2026-11-03' }))).statusCode).toBe(201);
      const returnRes = await api.post(
        custodian,
        `/loans/${loanId}/returns`,
        { expected_version: (await loanOf(loanId)).version, return_date: TODAY, items: [{ loan_item_id: itemOf[assetId], condition: 'NORMAL' }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(returnRes.statusCode).toBe(201);

      expect((await detailOf(assetId)).not_returned).toBeNull();
      expect((await start([assetId], { loan_date: TODAY, due_date: '2026-12-31' })).statusCode).toBe(201);
    });
  });

  describe('coming back later (#74 Q21)', () => {
    const recordReturn = async (loanId: string, itemId: string, returnDate: string) =>
      api.post(
        custodian,
        `/loans/${loanId}/returns`,
        { expected_version: (await loanOf(loanId)).version, return_date: returnDate, items: [{ loan_item_id: itemId, condition: 'DAMAGED', condition_note: 'พบในห้องเก็บของ' }] },
        { 'x-retry-token': crypto.randomUUID() }
      );

    it('accepts a Loan Return on a Not Returned item, which wins, and keeps the Not Returned in the history', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]], { not_returned_date: '2026-11-03' }))).statusCode).toBe(201);

      expect((await recordReturn(loanId, itemOf[assetId], '2026-11-03')).statusCode).toBe(201);

      const loan = await loanOf(loanId);
      expect(loan.status).toBe('RETURNED');
      expect(loan.items[0]).toMatchObject({
        ending_kind: 'LOAN_RETURN',
        loan_return: { return_date: '2026-11-03', condition: 'DAMAGED', condition_note: 'พบในห้องเก็บของ' },
        not_returned: { not_returned_date: '2026-11-03', reason: 'ผู้ยืมแจ้งว่าทำหาย' },
      });
      expect(await endingsOf(itemOf[assetId])).toEqual([
        { kind: 'NOT_RETURNED', is_voided: false },
        { kind: 'LOAN_RETURN', is_voided: false },
      ]);
      expect((await detailOf(assetId)).latest_loan_return_condition).toBe('DAMAGED');
    });

    it('refuses a Return Date before the Not Returned date, which takes a Loan Correction instead', async () => {
      const assetId = await registered('ของพบทีหลัง');
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]], { not_returned_date: '2026-11-04' }))).statusCode).toBe(201);
      const before = await loanOf(loanId);

      const res = await recordReturn(loanId, itemOf[assetId], '2026-11-03');

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(res.json().message).toContain('ของพบทีหลัง');
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('offers where the item goes back to on the Return Date, as for an Outstanding item', async () => {
      const [room] = await entries('locations', 'ห้องของที่ได้คืนภายหลัง', 1);
      const placed = await api.post(custodian, '/assets', { name: `ของมีที่อยู่ ${crypto.randomUUID()}`, location_id: room.id, effective_date: '2024-01-01' });
      const assetId = placed.json().asset.id;
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      const [item] = (await api.get(readonly, `/loans/${loanId}?return_date=${TODAY}`)).json().items;
      expect(item.assignment_on_return_date.location).toEqual(at(room).entry);
    });

    it('still refuses a second Loan Return', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      expect((await recordReturn(loanId, itemOf[assetId], TODAY)).statusCode).toBe(201);

      const res = await recordReturn(loanId, itemOf[assetId], TODAY);
      expect(res.statusCode).toBe(409);
      expect(res.json().items).toMatchObject([{ loan_item_id: itemOf[assetId], reason: 'ALREADY_RETURNED' }]);
    });
  });

  describe('the register stays as it is (#74 Q11, DR-03)', () => {
    it('changes nothing on the Asset, and a Reassignment is still accepted', async () => {
      const [roomA, roomB]: Entry[] = await entries('locations', 'ห้องของไม่ได้คืน', 2);
      const placed = await api.post(custodian, '/assets', { name: `ของมีที่อยู่ ${crypto.randomUUID()}`, location_id: roomA.id, effective_date: '2024-01-01' });
      const assetId = placed.json().asset.id;
      const { loanId, itemOf } = await lent([assetId]);
      const { asset, history } = await detailOf(assetId);
      const assignment = await assignmentOf(assetId);

      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      expect(await detailOf(assetId)).toMatchObject({ asset, history });
      expect(await assignmentOf(assetId)).toEqual(assignment);
      const reassigned = await api.post(
        custodian,
        `/assets/${assetId}/assignments`,
        { kind: 'REASSIGNMENT', expected_assignment_version: (await detailOf(assetId)).assignment_version, location_id: roomB.id, effective_date: TODAY },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(reassigned.statusCode).toBe(201);
      expect((await detailOf(assetId)).current_assignment.location).toEqual(at(roomB).entry);
      expect((await loanOf(loanId)).items[0].ending_kind).toBe('NOT_RETURNED');
    });
  });

  describe('concurrency', () => {
    it('refuses a stale version with the stale-before conflict, and writes nothing', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);
      expect((await close(loanId, await body(loanId, [itemOf[first]]))).statusCode).toBe(201);
      const before = await loanOf(loanId);

      const res = await close(loanId, await body(loanId, [itemOf[second]], { expected_version: version }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: version + 1 }, expected_values: { version } });
      expect(await loanOf(loanId)).toEqual(before);
      expect(await endingsOf(itemOf[second])).toEqual([]);
    });

    it('locks the Loan row first, then all of its Assets in identifier order', async () => {
      const [low, middle, high] = [await registered(), await registered(), await registered()].sort();
      const { loanId, itemOf } = await lent([high, middle, low]);
      const payload = await body(loanId, [itemOf[high]]);

      const { atLoan } = await whileHolding('loans', loanId, async () => {
        const pending = close(loanId, payload, crypto.randomUUID());
        await expect.poll(isWaitingOnLoanLock, { timeout: 10_000, interval: 50 }).toBe(true);
        return { atLoan: pending };
      });
      expect((await atLoan).statusCode).toBe(201);

      const later = await lent([await registered(), await registered()]);
      const [laterLow, laterHigh] = Object.keys(later.itemOf).sort();
      const { atAsset } = await whileHolding('assets', laterLow, async () => {
        const pending = close(later.loanId, await body(later.loanId, [later.itemOf[laterHigh]]));
        await expect.poll(async () => (await api.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM assets%FOR UPDATE%'`)).rows[0].n > 0, { timeout: 10_000, interval: 50 }).toBe(true);
        return { atAsset: pending };
      });
      expect((await atAsset).statusCode).toBe(201);
    });

    it('ends concurrent closures of one item with one fact, and the rest refused', async () => {
      const assetId = await registered();
      const { loanId, version, itemOf } = await lent([assetId]);
      const payload = { expected_version: version, not_returned_date: TODAY, reason: 'หาย', items: [{ loan_item_id: itemOf[assetId] }] };

      const results = await Promise.all(Array.from({ length: 6 }, () => close(loanId, payload)));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(5).fill(409)]);
      expect(await endingsOf(itemOf[assetId])).toHaveLength(1);
      expect((await loanOf(loanId)).version).toBe(version + 1);
    });
  });

  describe('retry token', () => {
    const PHONE = '089-555-7777';

    it('needs a token', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const res = await api.post(custodian, `/loans/${loanId}/not-returned`, await body(loanId, [itemOf[assetId]]));
      expect(res.statusCode).toBe(400);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('answers an identical replay with the committed result and writes nothing, and refuses a changed payload', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      const token = crypto.randomUUID();
      const payload = await body(loanId, [itemOf[first], itemOf[second]]);

      const recorded = await close(loanId, payload, token);
      expect(recorded.statusCode).toBe(201);
      const replay = await close(loanId, { ...payload, items: [...payload.items].reverse() }, token);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(recorded.json());
      expect(await endingsOf(itemOf[first])).toHaveLength(1);

      const changed = await close(loanId, { ...payload, reason: 'เหตุผลอื่น' }, token);
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });

    it('scopes a token to its operation: the same token carries a Loan Return of the same Loan', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      const token = crypto.randomUUID();
      expect((await close(loanId, await body(loanId, [itemOf[first]]), token)).statusCode).toBe(201);
      const returned = await api.post(
        custodian,
        `/loans/${loanId}/returns`,
        { expected_version: (await loanOf(loanId)).version, return_date: TODAY, items: [{ loan_item_id: itemOf[second], condition: 'NORMAL' }] },
        { 'x-retry-token': token }
      );
      expect(returned.statusCode).toBe(201);
    });

    it('carries no phone number in the write response or its stored receipt', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์ไม่คืน', phone: PHONE } });
      const token = crypto.randomUUID();

      const res = await close(loanId, await body(loanId, [itemOf[assetId]]), token);

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(PHONE);
      const receipts = await api.pool.query(`SELECT response_body::text AS body FROM registration_retry_tokens WHERE token = $1 AND operation = $2`, [token, `loan:not-returned:${loanId}`]);
      expect(receipts.rows).toHaveLength(1);
      expect(receipts.rows[0].body).not.toContain(PHONE);
    });
  });

  describe('a failure to persist', () => {
    it.each([
      ['an ending fact', 'fail_not_returned_ending', 'loan_item_endings', 'INSERT'],
      ['an item\'s ending kind', 'fail_not_returned_kind', 'loan_items', 'UPDATE'],
      ['the Loan\'s version', 'fail_not_returned_version', 'loans', 'UPDATE'],
    ] as const)('saves nothing when %s cannot be written', async (_what, name, table, event) => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const token = crypto.randomUUID();
      const before = await loanOf(loanId);
      await api.pool.query(`
        CREATE FUNCTION ${name}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected not returned failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();
      `);
      try {
        const res = await close(loanId, payload, token);
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('injected');
        expect(await loanOf(loanId)).toEqual(before);
        expect(await endingsOf(itemOf[assetId])).toEqual([]);
      } finally {
        await api.pool.query(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`);
      }
      expect((await close(loanId, payload, token)).statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('refuses every role without loan:record, and saves nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const maintainer = await api.actor('maintainer_not_returned', 'SYSTEM_MAINTAINER');
      const payload = await body(loanId, [itemOf[assetId]]);

      for (const actor of [readonly, admin, maintainer]) {
        const res = await close(loanId, payload, crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
      }
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('needs loan:record itself, and fails closed when the lookup fails, saving nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);

      expect((await withCapabilityAnswer(api.app, 'loan:record', async () => false, () => close(loanId, payload))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'loan:record', async () => { throw new Error('lookup failed'); }, () => close(loanId, payload));
      expect(failed.statusCode).toBe(500);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const send = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: `/loans/${loanId}/not-returned`, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

      expect([401, 403]).toContain((await send({})).statusCode);
      expect((await send({ cookie: custodian.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('custodian_inactive_not_returned', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await close(loanId, payload, crypto.randomUUID(), leaving)).statusCode);
      expect(await endingsOf(itemOf[assetId])).toEqual([]);
    });
  });

  describe('logs (LR-15)', () => {
    it('hold no Borrower details', async () => {
      const name = 'คุณไม่ลงบันทึกไม่คืน';
      const phone = '061-999-0000';
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: name, phone } });
      logLines.length = 0;

      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      expect((await close(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(409);
      expect((await start([assetId], { loan_date: TODAY, due_date: '2026-12-31' })).statusCode).toBe(409);

      expect(logLines.length).toBeGreaterThan(0);
      const logged = logLines.join('');
      expect(logged).not.toContain(name);
      expect(logged).not.toContain(phone);
    });
  });
});
