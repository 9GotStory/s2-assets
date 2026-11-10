import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';

const LOAN_DATE = '2026-11-01';
const DUE = '2026-11-05';

// F004-T3 (#77): the Loan list, and Overdue derived on read.
describe('The Loan list and Overdue (Seam A - F004-T3)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  // 2026-11-05 in Asia/Bangkok: DUE itself.
  let now = new Date('2026-11-05T05:00:00Z');
  const logLines: string[] = [];

  const { entry } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { registered, loanOf } = loanHelpers(() => ({ api, custodian, reader: readonly }));

  // A started Loan of `count` new Assets, with its LoanItem ids in Asset order.
  const lent = async (count: number, overrides: Record<string, unknown> = {}) => {
    const assetIds = await Promise.all(Array.from({ length: count }, () => registered()));
    const res = await api.post(
      custodian,
      '/loans',
      {
        assets: assetIds.map((asset_id) => ({ asset_id, condition: 'NORMAL' })),
        borrower: { kind: 'EXTERNAL', contact_name: `คุณ ${crypto.randomUUID()}` },
        loan_date: LOAN_DATE,
        due_date: DUE,
        ...overrides,
      },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
    const { loan_id: loanId, items } = res.json();
    return { loanId: loanId as string, assetIds, itemIds: assetIds.map((assetId) => items.find(({ asset_id }: any) => asset_id === assetId).id as string) };
  };

  // A Loan Return of `itemIds` as ปกติ on `returnDate`.
  const returned = async (loanId: string, itemIds: string[], returnDate: string = '2026-11-05') => {
    const res = await api.post(
      custodian,
      `/loans/${loanId}/returns`,
      { expected_version: (await loanOf(loanId)).version, return_date: returnDate, items: itemIds.map((loan_item_id) => ({ loan_item_id, condition: 'NORMAL' })) },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  const list = async (query: string = '', actor: Actor = readonly) => {
    const res = await api.get(actor, `/loans${query ? `?${query}` : ''}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness({
      clock: () => now,
      logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } },
    });
    admin = await api.actor('admin_list', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_list', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_list', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  // Runs `work` at the clock it sets, and puts the clock back however `work` ends.
  const atClock = async (work: () => Promise<void>) => {
    const before = now;
    try {
      await work();
    } finally {
      now = before;
    }
  };

  const rowOf = async (loanId: string) => (await list('limit=100')).items.find(({ id }: any) => id === loanId);

  describe('Overdue (LR-06, #74 Q5)', () => {
    it('is not an item due today, and becomes one at Asia/Bangkok midnight', async () => {
      await atClock(async () => {
        const { loanId } = await lent(1);

        // 23:59:59 on 5 November in Bangkok, the Due Date.
        now = new Date('2026-11-05T16:59:59Z');
        expect((await rowOf(loanId)).is_overdue).toBe(false);

        // 00:00:00 on 6 November in Bangkok, still 5 November in UTC.
        now = new Date('2026-11-05T17:00:00Z');
        expect((await rowOf(loanId)).is_overdue).toBe(true);
      });
    });

    it('is a Loan any of whose items is, and no item that has come back', async () => {
      await atClock(async () => {
        const { loanId, itemIds } = await lent(2);
        now = new Date('2026-11-07T05:00:00Z');

        await returned(loanId, [itemIds[0]], '2026-11-06');
        expect(await rowOf(loanId)).toMatchObject({ status: 'PARTIALLY_RETURNED', is_overdue: true });

        await returned(loanId, [itemIds[1]], '2026-11-07');
        expect(await rowOf(loanId)).toMatchObject({ status: 'RETURNED', is_overdue: false });
      });
    });

    it('shows on the Loan page, for the Loan and each item', async () => {
      await atClock(async () => {
        const { loanId, itemIds } = await lent(2);
        now = new Date('2026-11-07T05:00:00Z');
        await returned(loanId, [itemIds[0]], '2026-11-06');

        const loan = await loanOf(loanId);

        expect(loan.is_overdue).toBe(true);
        expect(Object.fromEntries(loan.items.map(({ id, is_overdue }: any) => [id, is_overdue]))).toEqual({ [itemIds[0]]: false, [itemIds[1]]: true });
      });
    });

    it('shows on the Asset page while the Asset is On Loan, and on each of its Loans', async () => {
      await atClock(async () => {
        const { loanId, assetIds: [assetId] } = await lent(1);
        const onLoanOf = async () => (await api.get(readonly, `/assets/${assetId}`)).json().on_loan;
        const loansOf = async () => (await api.get(readonly, `/assets/${assetId}/loans`)).json().items;
        expect(await onLoanOf()).toMatchObject({ loan_id: loanId, due_date: DUE, is_overdue: false });
        expect((await loansOf()).map(({ is_overdue }: any) => is_overdue)).toEqual([false]);

        now = new Date('2026-11-06T05:00:00Z');
        expect(await onLoanOf()).toMatchObject({ loan_id: loanId, is_overdue: true });
        expect((await loansOf()).map(({ is_overdue }: any) => is_overdue)).toEqual([true]);
      });
    });

    it('has no field a write can set', async () => {
      const assetId = await registered();
      const res = await api.post(
        custodian,
        '/loans',
        { assets: [{ asset_id: assetId, condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณก' }, loan_date: LOAN_DATE, due_date: DUE, is_overdue: false },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(res.statusCode).toBe(400);
      expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toEqual([]);

      const { loanId, itemIds } = await lent(1);
      const itemRes = await api.post(
        custodian,
        `/loans/${loanId}/returns`,
        { expected_version: 1, return_date: DUE, items: [{ loan_item_id: itemIds[0], condition: 'NORMAL', is_overdue: false }] },
        { 'x-retry-token': crypto.randomUUID() }
      );
      expect(itemRes.statusCode).toBe(400);
      expect((await loanOf(loanId)).items[0].ending_kind).toBe('NONE');
    });
  });

  describe('"คืนเกินกำหนด" (#74 Q5)', () => {
    it('marks a Loan Return dated after the item\'s Due Date, and not one on it or before', async () => {
      await atClock(async () => {
        now = new Date('2026-11-09T05:00:00Z');
        const { loanId, assetIds, itemIds } = await lent(3);
        await returned(loanId, [itemIds[0]], '2026-11-04');
        await returned(loanId, [itemIds[1]], DUE);
        await returned(loanId, [itemIds[2]], '2026-11-06');

        const lateOf = async () =>
          Object.fromEntries((await loanOf(loanId)).items.map(({ id, loan_return }: any) => [id, loan_return.returned_after_due_date]));
        expect(await lateOf()).toEqual({ [itemIds[0]]: false, [itemIds[1]]: false, [itemIds[2]]: true });

        // It is derived on read, so it stays on the Loan page and the Asset's Loans, with no Overdue.
        now = new Date('2026-12-31T05:00:00Z');
        expect(await lateOf()).toEqual({ [itemIds[0]]: false, [itemIds[1]]: false, [itemIds[2]]: true });
        const [item] = (await api.get(readonly, `/assets/${assetIds[2]}/loans`)).json().items;
        expect(item).toMatchObject({ is_overdue: false, loan_return: { return_date: '2026-11-06', returned_after_due_date: true } });
        expect((await loanOf(loanId)).is_overdue).toBe(false);
      });
    });
  });

  describe('filters (#74 Q17)', () => {
    const external = (contact_name: string, more: Record<string, unknown> = {}) => ({ borrower: { kind: 'EXTERNAL', contact_name, ...more } });
    const idsOf = async (query: string) => (await list(`${query}&limit=100`)).items.map(({ id }: any) => id).sort();

    it('find an External Borrower by contact or organization name, in any case, and a name only literally', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const byContact = await lent(1, external(`คุณสมหญิง Contact-${tag}`));
      const byOrganization = await lent(1, external('คุณอื่น', { organization_name: `บริษัท Org-${tag} จำกัด` }));
      const literal = await lent(1, external(`คุณ 100%_${tag}`));
      await lent(1, external(`คุณ 1000_${tag}`));

      expect(await idsOf(`borrower_name=contact-${tag.toUpperCase()}`)).toEqual([byContact.loanId]);
      expect(await idsOf(`borrower_name=${encodeURIComponent(`org-${tag}`)}`)).toEqual([byOrganization.loanId]);
      expect(await idsOf(`borrower_name=${encodeURIComponent(`100%_${tag}`)}`)).toEqual([literal.loanId]);
      expect(await idsOf(`borrower_name=${encodeURIComponent(`  Contact-${tag}  `)}`)).toEqual([byContact.loanId]);
    });

    it('never match a phone number (LR-15, #74 Q24)', async () => {
      const phone = `08${crypto.randomInt(10_000_000, 99_999_999)}`;
      const organization = `บริษัทมีเบอร์ ${crypto.randomUUID().slice(0, 8)}`;
      const { loanId } = await lent(1, external('คุณมีเบอร์', { organization_name: organization, phone }));
      expect(await idsOf(`borrower_name=${encodeURIComponent(organization)}`)).toEqual([loanId]);

      expect(await idsOf(`borrower_name=${phone}`)).toEqual([]);
      expect(await idsOf(`borrower_name=${phone.slice(2)}`)).toEqual([]);
    });

    it('find an Internal Borrower by Person entry, and the name text finds no Internal Borrower', async () => {
      const person = await entry('persons', `สมปอง Person-${crypto.randomUUID().slice(0, 8)}`);
      const other = await entry('persons', `สมศรี ${crypto.randomUUID().slice(0, 8)}`);
      const { loanId } = await lent(1, { borrower: { kind: 'INTERNAL', person_id: person.id } });
      await lent(1, { borrower: { kind: 'INTERNAL', person_id: other.id } });

      expect(await idsOf(`borrower_person_id=${person.id.toUpperCase()}`)).toEqual([loanId]);
      expect(await idsOf(`borrower_name=${encodeURIComponent(person.name)}`)).toEqual([]);
    });

    it('narrow by Internal or External Borrower, by status and to Overdue Loans, each on its own and together', async () => {
      await atClock(async () => {
        const tag = `Filter-${crypto.randomUUID().slice(0, 8)}`;
        const person = await entry('persons', `สมใจ ${tag}`);
        const internal = await lent(1, { borrower: { kind: 'INTERNAL', person_id: person.id } });
        const outstanding = await lent(2, external(`คุณค้าง ${tag}`));
        const partial = await lent(2, external(`คุณบางส่วน ${tag}`));
        const done = await lent(1, external(`คุณครบ ${tag}`));
        now = new Date('2026-11-07T05:00:00Z');
        await returned(partial.loanId, [partial.itemIds[0]], '2026-11-06');
        await returned(done.loanId, done.itemIds, '2026-11-06');
        const mine = (ids: string[]) => ids.filter((id) => [internal, outstanding, partial, done].some(({ loanId }) => loanId === id));
        const sorted = (...loans: { loanId: string }[]) => loans.map(({ loanId }) => loanId).sort();

        expect(mine(await idsOf('borrower_kind=INTERNAL'))).toEqual(sorted(internal));
        expect(await idsOf(`borrower_kind=EXTERNAL&borrower_name=${tag}`)).toEqual(sorted(outstanding, partial, done));
        expect(await idsOf(`status=OUTSTANDING&borrower_name=${tag}`)).toEqual(sorted(outstanding));
        expect(await idsOf(`status=PARTIALLY_RETURNED&borrower_name=${tag}`)).toEqual(sorted(partial));
        expect(await idsOf(`status=RETURNED&borrower_name=${tag}`)).toEqual(sorted(done));
        expect(await idsOf(`overdue=true&borrower_name=${tag}`)).toEqual(sorted(outstanding, partial));
        expect(mine(await idsOf('overdue=true&borrower_kind=INTERNAL'))).toEqual(sorted(internal));
        expect(await idsOf(`overdue=true&status=PARTIALLY_RETURNED&borrower_name=${tag}`)).toEqual(sorted(partial));
        expect(await idsOf(`borrower_kind=INTERNAL&borrower_name=${tag}`)).toEqual([]);
      });
    });

    it('refuse a value they do not know, and a blank name', async () => {
      for (const query of [
        'status=CLOSED',
        'status=',
        'overdue=false',
        'overdue=1',
        'borrower_kind=OTHER',
        'borrower_person_id=not-a-uuid',
        'borrower_name=',
        'borrower_name=%20%20',
        'borrower_name=%00',
        'borrower_name=%E0%B8%81%0A',
        'borrower_name=%E0%B8%81%09%E0%B8%82',
        `borrower_name=${'a'.repeat(4097)}`,
      ]) {
        const res = await api.get(readonly, `/loans?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().code, query).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('pages (as on the Asset list)', () => {
    it('go latest Loan Date first, and say how many Loans pass the filters and whether more follow', async () => {
      const tag = `Page-${crypto.randomUUID().slice(0, 8)}`;
      const borrower = { kind: 'EXTERNAL', contact_name: `คุณ ${tag}` };
      const middle = await lent(1, { borrower, loan_date: '2026-10-02' });
      const latest = await lent(1, { borrower, loan_date: '2026-10-03' });
      const earliest = await lent(1, { borrower, loan_date: '2026-10-01' });
      // On the same Loan Date, the one recorded later goes first.
      const latestRecorded = await lent(1, { borrower, loan_date: '2026-10-02' });
      const page = (query: string) => list(`borrower_name=${tag}&${query}`);

      const first = await page('limit=3');
      expect(first.items.map(({ id }: any) => id)).toEqual([latest.loanId, latestRecorded.loanId, middle.loanId]);
      expect(first).toMatchObject({ limit: 3, offset: 0, total_count: 4, has_more: true });

      const last = await page('limit=3&offset=3');
      expect(last.items.map(({ id }: any) => id)).toEqual([earliest.loanId]);
      expect(last).toMatchObject({ limit: 3, offset: 3, total_count: 4, has_more: false });

      expect(await page('offset=10')).toEqual({ items: [], limit: 25, offset: 10, total_count: 4, has_more: false });
    });

    it('hold 25 Loans unless asked for 1 to 100', async () => {
      const tag = `Size-${crypto.randomUUID().slice(0, 8)}`;
      for (let i = 0; i < 26; i++) {
        await lent(1, { borrower: { kind: 'EXTERNAL', contact_name: `คุณ ${tag}` } });
      }
      const { items, limit, has_more: hasMore } = await list(`borrower_name=${tag}`);
      expect({ count: items.length, limit, hasMore }).toEqual({ count: 25, limit: 25, hasMore: true });
      expect((await list(`borrower_name=${tag}&limit=100`)).items).toHaveLength(26);
    });

    it('refuse a malformed or out-of-range page, a repeated parameter and an unknown one', async () => {
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=01',
        'limit=1.5',
        'limit=abc',
        'offset=-1',
        'offset=01',
        'offset=2147483648',
        'limit=1&limit=2',
        'status=OUTSTANDING&status=RETURNED',
        'borrower_phone=0812345678',
        'q=x',
      ]) {
        const res = await api.get(readonly, `/loans?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().code, query).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('reading it (#74 Q12)', () => {
    it('is for every role with asset:view, and no one else', async () => {
      const maintainer = await api.actor('maintainer_list', 'SYSTEM_MAINTAINER');
      for (const reader of [custodian, admin, readonly]) {
        expect((await api.get(reader, '/loans')).statusCode).toBe(200);
      }
      expect((await api.get(maintainer, '/loans')).statusCode).toBe(403);
    });

    it('needs asset:view itself: denying it alone, or failing to look it up, shows nothing', async () => {
      await lent(1, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณไม่ควรเห็นในรายการ' } });
      expect((await api.get(custodian, '/loans')).body).toContain('คุณไม่ควรเห็นในรายการ');

      const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, '/loans'));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('คุณไม่ควรเห็นในรายการ');

      const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, '/loans'));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('คุณไม่ควรเห็นในรายการ');
    });

    it('needs a session, and an inactive user is refused', async () => {
      expect((await api.app.inject({ method: 'GET', url: '/loans' })).statusCode).toBe(401);
      const leaving = await api.actor('readonly_inactive_list', 'READ_ONLY');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await api.get(leaving, '/loans')).statusCode);
    });

    it('carries no phone number, even to a holder of loan:record', async () => {
      const phone = '061-555-0123';
      const { loanId } = await lent(1, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณเบอร์ในรายการ', phone } });

      const res = await api.get(custodian, '/loans?limit=100');
      expect(res.body).not.toContain(phone);
      expect(res.json().items.find(({ id }: any) => id === loanId).borrower).toEqual({ kind: 'EXTERNAL', contact_name: 'คุณเบอร์ในรายการ', organization_name: null });
    });

    it('keeps a search by Borrower out of the logs (LR-15)', async () => {
      const name = 'คุณค้นไม่ลงบันทึก';
      await lent(1, { borrower: { kind: 'EXTERNAL', contact_name: name } });
      logLines.length = 0;

      expect((await list(`borrower_name=${encodeURIComponent(name)}`)).items).toHaveLength(1);
      expect((await api.get(readonly, `/loans?borrower_name=${encodeURIComponent(name)}&limit=0`)).statusCode).toBe(400);
      await api.get(readonly, `/loans/${crypto.randomUUID()}`);

      expect(logLines.length).toBeGreaterThan(0);
      const logged = logLines.join('');
      expect(logged).not.toContain(name);
      expect(logged).not.toContain(encodeURIComponent(name));
    });

    it('logs each request by its path, so a failed read reaches the logs without its search', async () => {
      const name = 'คุณค้นตอนระบบขัดข้อง';
      logLines.length = 0;

      const res = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () =>
        api.get(readonly, `/loans?borrower_name=${encodeURIComponent(name)}&status=OUTSTANDING`)
      );
      expect(res.statusCode).toBe(500);

      const lines = logLines.map((line) => JSON.parse(line));
      const incoming = lines.find(({ req }) => req?.url === '/loans');
      expect(incoming).toBeDefined();
      expect(lines.some(({ reqId, res: reply }) => reqId === incoming.reqId && reply?.statusCode === 500)).toBe(true);
      const logged = logLines.join('');
      expect(logged).not.toContain(name);
      expect(logged).not.toContain(encodeURIComponent(name));
      expect(logged).not.toContain('status=OUTSTANDING');
    });
  });

  describe('a row', () => {
    it('shows the Borrower, the Loan Date, the item counts, the status and whether the Loan is Overdue', async () => {
      const person = await entry('persons', 'สมชาย ผู้ยืมในรายการ');
      const { loanId, itemIds } = await lent(3, { borrower: { kind: 'INTERNAL', person_id: person.id } });
      await returned(loanId, [itemIds[0]]);

      const { items } = await list(`borrower_person_id=${person.id}`);

      expect(items).toEqual([
        {
          id: loanId,
          borrower: { kind: 'INTERNAL', person: { id: person.id, name: 'สมชาย ผู้ยืมในรายการ', is_active: true } },
          loan_date: LOAN_DATE,
          item_count: 3,
          returned_count: 1,
          status: 'PARTIALLY_RETURNED',
          is_overdue: false,
        },
      ]);
    });
  });
});
