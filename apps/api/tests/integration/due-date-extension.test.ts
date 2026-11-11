import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';

const TODAY = '2026-11-10';
const LOAN_DATE = '2026-11-01';
const DUE = '2026-11-05';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F004-T5 (#79): moving the Due Date of Outstanding LoanItems later ("เลื่อนกำหนดคืน").
describe('Recording a Due Date Extension (Seam A - F004-T5)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  // 2026-11-10 in Asia/Bangkok: five days after DUE.
  let now = new Date('2026-11-10T05:00:00Z');
  const logLines: string[] = [];

  const { detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileHolding } = lockHelpers(() => ({ api }));
  const { registered, loanOf, lent, returned, closedNotReturned } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: LOAN_DATE,
    dueDate: DUE,
    contactName: 'คุณผู้ยืมขอเลื่อน',
  });

  const extend = (loanId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/loans/${loanId}/due-date-extensions`, payload, { 'x-retry-token': token });

  // A Due Date Extension of `itemIds`, against the Loan's latest version unless `overrides` says otherwise.
  const body = async (loanId: string, itemIds: string[], overrides: Record<string, unknown> = {}) => ({
    expected_version: (await loanOf(loanId)).version,
    new_due_date: '2026-11-20',
    items: itemIds.map((loan_item_id) => ({ loan_item_id })),
    ...overrides,
  });

  const extensionsOf = async (itemId: string) =>
    (await api.pool.query('SELECT id FROM loan_due_date_extensions WHERE loan_item_id = $1', [itemId])).rows;

  const itemsById = async (loanId: string) => Object.fromEntries((await loanOf(loanId)).items.map((item: any) => [item.id, item]));

  beforeAll(async () => {
    api = await startApiHarness({
      clock: () => now,
      logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } },
    });
    admin = await api.actor('admin_extension', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_extension', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_extension', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('recording', () => {
    it('records one extension per item, with its prior and new date, sharing one action reference and reason, and the Loan page shows each', async () => {
      const [first, second, kept] = [await registered('จอขอเลื่อน A'), await registered('จอขอเลื่อน B'), await registered()];
      const { loanId, version, itemOf } = await lent([first, second, kept]);
      const before = Date.now();

      const res = await extend(loanId, {
        expected_version: version,
        new_due_date: '2026-11-20',
        reason: 'ผู้ยืมขอใช้ต่อ\nมีหนังสือแจ้ง',
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

      const items = await itemsById(loanId);
      for (const assetId of [first, second]) {
        expect(items[itemOf[assetId]]).toMatchObject({
          due_date: '2026-11-20',
          is_overdue: false,
          due_date_extensions: [
            {
              id: expect.stringMatching(UUID),
              prior_due_date: DUE,
              new_due_date: '2026-11-20',
              reason: 'ผู้ยืมขอใช้ต่อ\nมีหนังสือแจ้ง',
              action_reference: recorded.action_reference,
              recorded_by: custodian.id,
              recorded_by_username: 'custodian_extension',
              recorded_at: expect.any(String),
              is_voided: false,
            },
          ],
        });
        expect(Date.parse(items[itemOf[assetId]].due_date_extensions[0].recorded_at)).toBeGreaterThanOrEqual(before);
      }
      expect(items[itemOf[first]].due_date_extensions[0].id).not.toBe(items[itemOf[second]].due_date_extensions[0].id);
      // The item narrowed out keeps its Due Date, and stays Overdue.
      expect(items[itemOf[kept]]).toMatchObject({ due_date: DUE, is_overdue: true, due_date_extensions: [] });
      expect((await loanOf(loanId)).is_overdue).toBe(true);
    });

    it('takes no reason, and stores a blank one as none', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      expect((await extend(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: '2026-11-21', reason: '   ' }))).statusCode).toBe(201);

      expect((await loanOf(loanId)).items[0].due_date_extensions.map(({ reason }: any) => reason)).toEqual([null, null]);
    });

    it('refuses an item that has ended or is voided, and one of another Loan, naming each, and writes nothing', async () => {
      const [free, back, closed, voided, elsewhere] = [await registered(), await registered('ของคืนแล้ว'), await registered('ของปิดแล้ว'), await registered(), await registered()];
      const { loanId, itemOf } = await lent([free, back, closed, voided]);
      const other = await lent([elsewhere]);
      await returned(loanId, [itemOf[back]], TODAY);
      await closedNotReturned(loanId, [itemOf[closed]], TODAY);
      await api.pool.query('UPDATE loan_items SET is_voided = true WHERE id = $1', [itemOf[voided]]);
      const missing = crypto.randomUUID();
      const before = await loanOf(loanId);

      const res = await extend(loanId, await body(loanId, [itemOf[free], itemOf[back], itemOf[closed], itemOf[voided], other.itemOf[elsewhere], missing]));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, code: 'LOAN_ITEMS_NOT_OUTSTANDING' });
      const byItem = Object.fromEntries(res.json().items.map((item: any) => [item.loan_item_id, item.reason]));
      expect(byItem).toEqual({
        [itemOf[back]]: 'ALREADY_RETURNED',
        [itemOf[closed]]: 'NOT_RETURNED',
        [itemOf[voided]]: 'VOIDED',
        [other.itemOf[elsewhere]]: 'NOT_FOUND',
        [missing]: 'NOT_FOUND',
      });
      expect(res.json().items.find(({ loan_item_id }: any) => loan_item_id === itemOf[back])).toMatchObject({ asset_id: back, name: 'ของคืนแล้ว' });
      expect(await loanOf(loanId)).toEqual(before);
      expect(await extensionsOf(itemOf[free])).toEqual([]);
    });

    it('names each item once, by a well-formed id, and 1 to 100 of them', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const itemId = itemOf[assetId];

      for (const items of [
        [],
        [{ loan_item_id: itemId }, { loan_item_id: itemId.toUpperCase() }],
        [{ loan_item_id: 'not-a-uuid' }],
        [{ loan_item_id: itemId, due_date: '2026-12-01' }],
        Array.from({ length: 101 }, () => ({ loan_item_id: crypto.randomUUID() })),
      ]) {
        const res = await extend(loanId, await body(loanId, [], { items }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await extensionsOf(itemId)).toEqual([]);
    });

    it('answers a Loan that does not exist with 404, and a malformed id with 400', async () => {
      const payload = { expected_version: 1, new_due_date: '2026-11-20', items: [{ loan_item_id: crypto.randomUUID() }] };
      expect((await extend(crypto.randomUUID(), payload)).statusCode).toBe(404);
      const malformed = await extend('not-a-uuid', payload);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('INVALID_ID');
    });

    it('bounds the reason, keeping line breaks and tabs and refusing any other control character', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      for (const reason of [over(2000), 'ก\u0007ข']) {
        const res = await extend(loanId, await body(loanId, [itemOf[assetId]], { reason }));
        expect(res.statusCode).toBe(400);
      }
      expect(await extensionsOf(itemOf[assetId])).toEqual([]);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { reason: `${'ก'.repeat(1996)}\tข\nค` }))).statusCode).toBe(201);
    });
  });

  describe('the new date (#74 Q28)', () => {
    it('must be later than each item\'s current Due Date, naming the Assets it is not later for', async () => {
      const [early, late] = [await registered('ของกำหนดเดิม'), await registered('ของเลื่อนไปแล้ว')];
      const { loanId, itemOf } = await lent([early, late]);
      expect((await extend(loanId, await body(loanId, [itemOf[late]], { new_due_date: '2026-11-25' }))).statusCode).toBe(201);
      const before = await loanOf(loanId);

      for (const newDate of [DUE, '2026-11-04', '2026-11-25', '2026-11-24']) {
        const res = await extend(loanId, await body(loanId, [itemOf[early], itemOf[late]], { new_due_date: newDate }));
        expect(res.statusCode, newDate).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      const named = await extend(loanId, await body(loanId, [itemOf[early], itemOf[late]], { new_due_date: '2026-11-24' }));
      expect(named.json().message).toContain('ของเลื่อนไปแล้ว');
      expect(named.json().message).not.toContain('ของกำหนดเดิม');
      expect(await loanOf(loanId)).toEqual(before);

      expect((await extend(loanId, await body(loanId, [itemOf[early], itemOf[late]], { new_due_date: '2026-11-26' }))).statusCode).toBe(201);
      const items = await itemsById(loanId);
      expect(items[itemOf[early]].due_date_extensions.map(({ prior_due_date, new_due_date }: any) => [prior_due_date, new_due_date])).toEqual([[DUE, '2026-11-26']]);
      expect(items[itemOf[late]].due_date_extensions.map(({ prior_due_date, new_due_date }: any) => [prior_due_date, new_due_date])).toEqual([
        [DUE, '2026-11-25'],
        ['2026-11-25', '2026-11-26'],
      ]);
    });

    it('may be recorded after the Due Date has passed, and is required and a calendar date', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      for (const newDate of ['2026-02-30', '20/11/2026', '', null]) {
        expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: newDate }))).statusCode).toBe(400);
      }
      const { new_due_date: _newDate, ...withoutDate } = await body(loanId, [itemOf[assetId]]);
      expect((await extend(loanId, withoutDate)).statusCode).toBe(400);

      // Past its Due Date, a later date that is still before today keeps the item Overdue.
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: '2026-11-08' }))).statusCode).toBe(201);
      expect((await loanOf(loanId)).items[0]).toMatchObject({ due_date: '2026-11-08', is_overdue: true });
    });
  });

  describe('the current Due Date', () => {
    const atClock = async (work: () => Promise<void>) => {
      const before = now;
      try {
        await work();
      } finally {
        now = before;
      }
    };

    it('stops an item being Overdue when the new date is today or later, on the Loan page, the list and the Asset page', async () => {
      await atClock(async () => {
        const assetId = await registered();
        const tag = `เลื่อน-${crypto.randomUUID().slice(0, 8)}`;
        const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: `คุณ ${tag}` } });
        const rowOf = async () => (await api.get(readonly, `/loans?borrower_name=${encodeURIComponent(tag)}`)).json().items[0];
        expect(await rowOf()).toMatchObject({ is_overdue: true });

        expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: TODAY }))).statusCode).toBe(201);

        expect((await loanOf(loanId)).items[0]).toMatchObject({ due_date: TODAY, is_overdue: false });
        expect(await rowOf()).toMatchObject({ is_overdue: false });
        expect((await api.get(readonly, `/loans?overdue=true&borrower_name=${encodeURIComponent(tag)}`)).json().items).toEqual([]);
        expect((await detailOf(assetId)).on_loan).toMatchObject({ loan_id: loanId, due_date: TODAY, is_overdue: false });
        expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items[0]).toMatchObject({ due_date: TODAY, is_overdue: false });

        // 00:00:00 on 11 November in Bangkok, still 10 November in UTC.
        now = new Date('2026-11-10T17:00:00Z');
        expect((await loanOf(loanId)).items[0].is_overdue).toBe(true);
      });
    });

    it('is the new date of the latest non-voided extension by Recorded At', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: '2026-11-20' }))).statusCode).toBe(201);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: '2026-11-30' }))).statusCode).toBe(201);
      expect((await loanOf(loanId)).items[0].due_date).toBe('2026-11-30');

      // A voided extension counts in nothing (T6 records the void; here it is set directly).
      await api.pool.query(`UPDATE loan_due_date_extensions SET is_voided = true WHERE loan_item_id = $1 AND new_due_date = '2026-11-30'`, [itemOf[assetId]]);
      expect((await loanOf(loanId)).items[0].due_date).toBe('2026-11-20');
      await api.pool.query(`UPDATE loan_due_date_extensions SET is_voided = true WHERE loan_item_id = $1`, [itemOf[assetId]]);
      expect((await loanOf(loanId)).items[0]).toMatchObject({ due_date: DUE, is_overdue: true });
    });

    it('leaves an item that has already come back its own Due Date, so "คืนเกินกำหนด" stays (#74 Q6)', async () => {
      const [backLate, stillOut] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([backLate, stillOut]);
      await returned(loanId, [itemOf[backLate]], '2026-11-07');
      expect((await itemsById(loanId))[itemOf[backLate]].loan_return.returned_after_due_date).toBe(true);

      expect((await extend(loanId, await body(loanId, [itemOf[stillOut]], { new_due_date: '2026-11-30' }))).statusCode).toBe(201);

      const items = await itemsById(loanId);
      expect(items[itemOf[backLate]]).toMatchObject({ due_date: DUE, due_date_extensions: [], loan_return: { returned_after_due_date: true } });
      expect(items[itemOf[stillOut]]).toMatchObject({ due_date: '2026-11-30', is_overdue: false });
      const [item] = (await api.get(readonly, `/assets/${backLate}/loans`)).json().items;
      expect(item.loan_return.returned_after_due_date).toBe(true);
    });

    it('decides "คืนเกินกำหนด" for an item returned after an extension, against the new date', async () => {
      const [onTime, late] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([onTime, late]);
      expect((await extend(loanId, await body(loanId, [itemOf[onTime], itemOf[late]], { new_due_date: '2026-11-08' }))).statusCode).toBe(201);

      await returned(loanId, [itemOf[onTime]], '2026-11-08');
      await returned(loanId, [itemOf[late]], '2026-11-09');

      const items = await itemsById(loanId);
      expect(items[itemOf[onTime]].loan_return.returned_after_due_date).toBe(false);
      expect(items[itemOf[late]].loan_return.returned_after_due_date).toBe(true);
    });

    it('touches no assignment fact and nothing on the Asset (LR-10)', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const { asset, history } = await detailOf(assetId);
      const assignment = await assignmentOf(assetId);

      expect((await extend(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);

      expect(await detailOf(assetId)).toMatchObject({ asset, history });
      expect(await assignmentOf(assetId)).toEqual(assignment);
    });
  });

  describe('concurrency', () => {
    it('refuses a stale version with the stale-before conflict, and writes nothing', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, version, itemOf } = await lent([first, second]);
      expect((await extend(loanId, await body(loanId, [itemOf[first]]))).statusCode).toBe(201);
      const before = await loanOf(loanId);

      const res = await extend(loanId, await body(loanId, [itemOf[second]], { expected_version: version }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: version + 1 }, expected_values: { version } });
      expect(await loanOf(loanId)).toEqual(before);
      expect(await extensionsOf(itemOf[second])).toEqual([]);
    });

    it('locks the Loan row first, then all of its Assets in identifier order', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);

      const [atLoan] = await whileHolding('loans', loanId, () => [extend(loanId, payload)]);
      expect(atLoan.statusCode).toBe(201);

      const later = await lent([await registered(), await registered()]);
      const [laterLow, laterHigh] = Object.keys(later.itemOf).sort();
      const laterPayload = await body(later.loanId, [later.itemOf[laterHigh]]);
      const [atAsset] = await whileHolding('assets', laterLow, () => [extend(later.loanId, laterPayload)]);
      expect(atAsset.statusCode).toBe(201);
    });

    it('ends concurrent extensions against one version with one write, and the rest refused', async () => {
      const assetId = await registered();
      const { loanId, version, itemOf } = await lent([assetId]);
      const payload = { expected_version: version, new_due_date: '2026-11-20', items: [{ loan_item_id: itemOf[assetId] }] };

      const results = await Promise.all(Array.from({ length: 6 }, () => extend(loanId, payload)));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(5).fill(409)]);
      expect(await extensionsOf(itemOf[assetId])).toHaveLength(1);
      expect((await loanOf(loanId)).version).toBe(version + 1);
    });
  });

  describe('retry token', () => {
    const PHONE = '089-444-1212';

    it('needs a token', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      expect((await api.post(custodian, `/loans/${loanId}/due-date-extensions`, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(400);
      expect(await extensionsOf(itemOf[assetId])).toEqual([]);
    });

    it('answers an identical replay with the committed result and writes nothing, and refuses a changed payload', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      const token = crypto.randomUUID();
      const payload = await body(loanId, [itemOf[first], itemOf[second]], { reason: 'ขอใช้ต่อ' });

      const recorded = await extend(loanId, payload, token);
      expect(recorded.statusCode).toBe(201);
      const replay = await extend(loanId, { ...payload, items: [...payload.items].reverse() }, token);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(recorded.json());
      expect(await extensionsOf(itemOf[first])).toHaveLength(1);

      const changed = await extend(loanId, { ...payload, new_due_date: '2026-11-21' }, token);
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const assetId = await registered();
      const { loanId, version, itemOf } = await lent([assetId]);
      const token = crypto.randomUUID();

      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { expected_version: version + 3 }), token)).statusCode).toBe(409);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]], { new_due_date: DUE }), token)).statusCode).toBe(400);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]]), token)).statusCode).toBe(201);
    });

    it('carries no phone number in the write response or its stored receipt', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์ขอเลื่อน', phone: PHONE } });
      const token = crypto.randomUUID();

      const res = await extend(loanId, await body(loanId, [itemOf[assetId]]), token);

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(PHONE);
      const receipts = await api.pool.query(`SELECT response_body::text AS body FROM registration_retry_tokens WHERE token = $1 AND operation = $2`, [
        token,
        `loan:due-date-extension:${loanId}`,
      ]);
      expect(receipts.rows).toHaveLength(1);
      expect(receipts.rows[0].body).not.toContain(PHONE);
    });
  });

  describe('a failure to persist', () => {
    it.each([
      ['an extension', 'fail_extension_fact', 'loan_due_date_extensions', 'INSERT'],
      ['the Loan\'s version', 'fail_extension_version', 'loans', 'UPDATE'],
    ] as const)('saves nothing when %s cannot be written', async (_what, name, table, event) => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const token = crypto.randomUUID();
      const before = await loanOf(loanId);
      await api.pool.query(`
        CREATE FUNCTION ${name}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected extension failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();
      `);
      try {
        const res = await extend(loanId, payload, token);
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('injected');
        expect(await loanOf(loanId)).toEqual(before);
        expect(await extensionsOf(itemOf[assetId])).toEqual([]);
      } finally {
        await api.pool.query(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`);
      }
      expect((await extend(loanId, payload, token)).statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('refuses every role without loan:record, and saves nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const maintainer = await api.actor('maintainer_extension', 'SYSTEM_MAINTAINER');
      const payload = await body(loanId, [itemOf[assetId]]);

      for (const actor of [readonly, admin, maintainer]) {
        expect((await extend(loanId, payload, crypto.randomUUID(), actor)).statusCode).toBe(403);
      }
      expect(await extensionsOf(itemOf[assetId])).toEqual([]);
    });

    it('needs loan:record itself, and fails closed when the lookup fails, saving nothing', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);

      expect((await withCapabilityAnswer(api.app, 'loan:record', async () => false, () => extend(loanId, payload))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'loan:record', async () => { throw new Error('lookup failed'); }, () => extend(loanId, payload));
      expect(failed.statusCode).toBe(500);
      expect(await extensionsOf(itemOf[assetId])).toEqual([]);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const payload = await body(loanId, [itemOf[assetId]]);
      const send = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: `/loans/${loanId}/due-date-extensions`, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

      expect([401, 403]).toContain((await send({})).statusCode);
      expect((await send({ cookie: custodian.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('custodian_inactive_extension', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await extend(loanId, payload, crypto.randomUUID(), leaving)).statusCode);
      expect(await extensionsOf(itemOf[assetId])).toEqual([]);
    });
  });

  describe('logs (LR-15)', () => {
    it('hold no Borrower details', async () => {
      const name = 'คุณไม่ลงบันทึกขอเลื่อน';
      const phone = '061-777-8888';
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: name, phone } });
      logLines.length = 0;

      expect((await extend(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(201);
      expect((await extend(loanId, await body(loanId, [itemOf[assetId]]))).statusCode).toBe(400);

      expect(logLines.length).toBeGreaterThan(0);
      const logged = logLines.join('');
      expect(logged).not.toContain(name);
      expect(logged).not.toContain(phone);
    });
  });
});
