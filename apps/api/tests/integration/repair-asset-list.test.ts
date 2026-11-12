import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

const START = '2026-11-02';

// F005-T4 (#102): the Asset list knows about Repair Records (#98 stories 8, 55; RM-04, Q21).
describe('Under Repair on the Asset list (Seam A - F005-T4)', () => {
  let api: ApiHarness;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-11T05:00:00Z');

  const { registered } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: START, dueDate: '2026-11-30' });
  const { sent, ended, recordOf, voided } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: START });

  const search = async (query: string, actor: Actor = readonly) => {
    const res = await api.get(actor, `/assets/search?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The search row of one Asset, found by its Stable ID.
  const rowOf = async (assetId: string) => {
    const { items } = await search(`field=stable_id&value=${assetId}`);
    expect(items).toHaveLength(1);
    return items[0];
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    custodian = await api.actor('custodian_asset_list_repair', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_asset_list_repair', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('each row says whether the Asset is Under Repair', () => {
    it('names the kind, the Start Date, the Repairer and the Repair Record of an Asset Under Repair', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId, { repair_kind: 'MAINTENANCE', start_date: '2026-11-03', repairer: { kind: 'EXTERNAL', name: 'ร้านแอร์เย็นดี' } });

      expect((await rowOf(assetId)).under_repair).toEqual({
        repair_record_id: repairRecordId,
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-03',
        repairer: { kind: 'EXTERNAL', name: 'ร้านแอร์เย็นดี' },
      });
    });

    it('is null for an Asset never sent', async () => {
      expect((await rowOf(await registered())).under_repair).toBeNull();
    });

    it('follows the records: ends with the Repair Outcome, returns when it is voided, and ends when the record is voided (#98 story 9)', async () => {
      const assetId = await registered();
      const repairRecordId = await sent(assetId);
      await ended(repairRecordId, { outcome_date: '2026-11-04' });
      expect((await rowOf(assetId)).under_repair).toBeNull();

      const { outcome } = await recordOf(repairRecordId);
      await voided(repairRecordId, { kind: 'REPAIR_OUTCOME', id: outcome.id });
      expect((await rowOf(assetId)).under_repair).toMatchObject({ repair_record_id: repairRecordId, repair_kind: 'REPAIR' });

      await voided(repairRecordId, { kind: 'REPAIR_RECORD' });
      expect((await rowOf(assetId)).under_repair).toBeNull();
    });
  });

  describe('the Under Repair filter', () => {
    it('returns only Assets Under Repair, combined with the other criteria', async () => {
      const tag = crypto.randomUUID();
      const [awayNamed, backNamed, idleNamed, awayElsewhere] = [
        await registered(`พัดลม ${tag} ก`),
        await registered(`พัดลม ${tag} ข`),
        await registered(`พัดลม ${tag} ค`),
        await registered(),
      ];
      await sent(awayNamed, { repair_kind: 'MAINTENANCE' });
      await ended(await sent(backNamed));
      await sent(awayElsewhere);

      const { items, total_count: totalCount } = await search(`field=name&value=${encodeURIComponent(tag)}&under_repair=true`);

      expect(items.map(({ id }: any) => id)).toEqual([awayNamed]);
      expect(totalCount).toBe(1);
      expect((await search(`field=name&value=${encodeURIComponent(tag)}`)).items.map(({ id }: any) => id).sort()).toEqual([awayNamed, backNamed, idleNamed].sort());
    });

    it('agrees with every row: a row is in the filter exactly when it says Under Repair', async () => {
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
      const filtered = await everyRow('under_repair=true&');

      // The states this file builds: never sent, Under Repair, ended, outcome voided and record voided.
      expect(all.some(({ under_repair }) => under_repair === null)).toBe(true);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every(({ under_repair }) => under_repair !== null)).toBe(true);
      expect(filtered.map(({ id }) => id).sort()).toEqual(all.filter(({ under_repair }) => under_repair !== null).map(({ id }) => id).sort());
    });

    it("takes only 'true'", async () => {
      for (const value of ['false', '1', '']) {
        expect((await api.get(readonly, `/assets/search?under_repair=${value}`)).statusCode).toBe(400);
      }
      expect((await api.get(readonly, '/assets/search?under_repair=true&under_repair=true')).statusCode).toBe(400);
    });

    it('needs asset:search, as the On Loan filter does', async () => {
      await sent(await registered('ไม่ควรเห็นในผลค้นหาซ่อม'), { repairer: { kind: 'EXTERNAL', name: 'ร้านที่ไม่ควรเห็น' } });
      const query = `/assets/search?field=name&value=${encodeURIComponent('ไม่ควรเห็นในผลค้นหาซ่อม')}&under_repair=true`;
      // The same request with the capability does answer both.
      const allowed = await api.get(readonly, query);
      expect(allowed.body).toContain('ไม่ควรเห็นในผลค้นหาซ่อม');
      expect(allowed.body).toContain('ร้านที่ไม่ควรเห็น');

      const denied = await withCapabilityAnswer(api.app, 'asset:search', async () => false, () => api.get(readonly, query));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('ไม่ควรเห็นในผลค้นหาซ่อม');
      expect(denied.body).not.toContain('ร้านที่ไม่ควรเห็น');
    });
  });
});
