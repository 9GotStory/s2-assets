import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';

const LOAN_DATE = '2026-11-01';
const DUE = '2026-11-05';

// F004-T4 (#78): the Asset list knows about Loans.
describe('On Loan on the Asset list (Seam A - F004-T4)', () => {
  let api: ApiHarness;
  let custodian: Actor;
  let readonly: Actor;
  // 2026-11-05 in Asia/Bangkok: DUE itself.
  let now = new Date('2026-11-05T05:00:00Z');

  const { registered, lent, returned, closedNotReturned } = loanHelpers(() => ({ api, custodian, reader: readonly }), {
    loanDate: LOAN_DATE,
    dueDate: DUE,
    contactName: 'คุณผู้ยืมจากรายการ',
  });

  const search = async (query: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/assets/search?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The search row of one Asset, found by its Stable ID.
  const rowOf = async (assetId: string, actor: Actor = readonly) => {
    const { items } = await search(`field=stable_id&value=${assetId}`, actor);
    expect(items).toHaveLength(1);
    return items[0];
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    custodian = await api.actor('custodian_asset_list_loan', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_asset_list_loan', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('each row says whether the Asset is On Loan', () => {
    it('names who holds an On Loan Asset, its Due Date and its Loan, and no phone number', async () => {
      const assetId = await registered();
      const { loanId } = await lent([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมานี', organization_name: 'บริษัทยืม', phone: '081-000-0000' } });

      const row = await rowOf(assetId, custodian);

      expect(row.on_loan).toEqual({
        loan_id: loanId,
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณมานี', organization_name: 'บริษัทยืม' },
        due_date: DUE,
        is_overdue: false,
      });
      expect(JSON.stringify(row)).not.toContain('081-000-0000');
    });

    it('is null for an Asset never lent', async () => {
      expect((await rowOf(await registered())).on_loan).toBeNull();
    });

    it('ends for the Asset that came back from a partly returned Loan, and not for the one still out', async () => {
      const [back, out] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([back, out]);

      await returned(loanId, [itemOf[back]], '2026-11-05', 'DAMAGED');

      expect((await rowOf(back)).on_loan).toBeNull();
      expect((await rowOf(out)).on_loan).toMatchObject({ loan_id: loanId });
    });

    it('ends when the item is closed as Not Returned', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);

      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-05');

      expect((await rowOf(assetId)).on_loan).toBeNull();
    });

    it('says Overdue from Asia/Bangkok midnight after the Due Date, as the Asset page does', async () => {
      const assetId = await registered();
      await lent([assetId]);
      const before = now;
      try {
        now = new Date('2026-11-05T16:59:59Z');
        expect((await rowOf(assetId)).on_loan.is_overdue).toBe(false);

        now = new Date('2026-11-05T17:00:00Z');
        expect((await rowOf(assetId)).on_loan.is_overdue).toBe(true);
        expect((await api.get(readonly, `/assets/${assetId}`)).json().on_loan.is_overdue).toBe(true);
      } finally {
        now = before;
      }
    });
  });

  describe('the "กำลังถูกยืม" filter', () => {
    it('returns only On Loan Assets, combined with the other criteria', async () => {
      const tag = crypto.randomUUID();
      const [lentNamed, idleNamed, lentElsewhere] = [await registered(`โต๊ะ ${tag} ก`), await registered(`โต๊ะ ${tag} ข`), await registered()];
      await lent([lentNamed, lentElsewhere]);

      const { items, total_count: totalCount } = await search(`field=name&value=${encodeURIComponent(tag)}&on_loan=true`);

      expect(items.map(({ id }: any) => id)).toEqual([lentNamed]);
      expect(totalCount).toBe(1);
      expect((await search(`field=name&value=${encodeURIComponent(tag)}`)).items.map(({ id }: any) => id).sort()).toEqual([lentNamed, idleNamed].sort());
    });

    it('agrees with every row: a row is in the filter exactly when it says On Loan', async () => {
      const everyRow = async (query: string) => {
        const rows: any[] = [];
        for (let offset = 0; ; offset += 100) {
          const page = await search(`${query}limit=100&offset=${offset}`);
          rows.push(...page.items);
          if (!page.has_more) {
            return rows;
          }
        }
      };
      const all = await everyRow('');
      const filtered = await everyRow('on_loan=true&');

      // The states this file builds: never lent, On Loan, returned, partly returned and Not Returned.
      expect(all.some(({ on_loan }) => on_loan === null)).toBe(true);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every(({ on_loan }) => on_loan !== null)).toBe(true);
      expect(filtered.map(({ id }) => id).sort()).toEqual(all.filter(({ on_loan }) => on_loan !== null).map(({ id }) => id).sort());
    });

    it("takes only 'true'", async () => {
      for (const value of ['false', '1', '']) {
        const res = await api.get(readonly, `/assets/search?on_loan=${value}`);
        expect(res.statusCode).toBe(400);
      }
      expect((await api.get(readonly, '/assets/search?on_loan=true&on_loan=true')).statusCode).toBe(400);
    });

    it('needs asset:search, as the Assignment Conflict filter does', async () => {
      const assetId = await registered('ไม่ควรเห็นในผลค้นหา');
      await lent([assetId]);

      const denied = await withCapabilityAnswer(api.app, 'asset:search', async () => false, () => api.get(readonly, '/assets/search?on_loan=true'));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('ไม่ควรเห็นในผลค้นหา');
      expect(denied.body).not.toContain('คุณผู้ยืมจากรายการ');
    });
  });

  describe('the Loan action on the list', () => {
    it('is offered to a holder of loan:record, and to nobody else', async () => {
      expect((await search('limit=1', custodian)).can_record_loan).toBe(true);
      expect((await search('limit=1', readonly)).can_record_loan).toBe(false);

      const denied = await withCapabilityAnswer(api.app, 'loan:record', async () => false, () => search('limit=1', custodian));
      expect(denied.can_record_loan).toBe(false);
      // The Reassignment selection is decided apart from it.
      expect(denied.can_reassign).toBe(true);
    });
  });

  describe('each row carries the Condition of its latest Loan Return (#76 decision 4, #78)', () => {
    it('is that of the latest Loan Return by Return Date, and null before any', async () => {
      const assetId = await registered();
      expect((await rowOf(assetId)).latest_loan_return_condition).toBeNull();

      const first = await lent([assetId]);
      await returned(first.loanId, [first.itemOf[assetId]], '2026-11-02', 'DAMAGED');
      expect((await rowOf(assetId)).latest_loan_return_condition).toBe('DAMAGED');

      // From the day of that Loan Return, so the two periods do not overlap (#74 Q20).
      const second = await lent([assetId], { loan_date: '2026-11-02' });
      await returned(second.loanId, [second.itemOf[assetId]], '2026-11-03');
      expect((await rowOf(assetId)).latest_loan_return_condition).toBe('NORMAL');
      expect((await api.get(readonly, `/assets/${assetId}`)).json().latest_loan_return_condition).toBe('NORMAL');
    });
  });
});
