import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers } from './support/loan-helpers.ts';
import { repairHelpers } from './support/repair-helpers.ts';

const TODAY = '2026-11-11';

// F005-T3 (#101): the Repair list ("รายการซ่อม/บำรุงรักษา").
describe('The Repair list (Seam A - F005-T3)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-11T05:00:00Z');

  const { registered } = loanHelpers(() => ({ api, custodian, reader: readonly }), { loanDate: TODAY, dueDate: '2026-11-30' });
  const { sent, ended } = repairHelpers(() => ({ api, custodian, reader: readonly }), { startDate: '2026-11-02' });

  const list = async (query: string = '', actor: Actor = readonly) => {
    const res = await api.get(actor, `/repairs${query ? `?${query}` : ''}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    admin = await api.actor('admin_repair_list', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_repair_list', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_repair_list', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a row', () => {
    it('shows the Asset, the kind, the Start Date, the Repairer, and the outcome with its Outcome Date when there is one', async () => {
      const tag = `Row-${crypto.randomUUID().slice(0, 8)}`;
      const assetId = await registered();
      const away = await sent(assetId, {
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-03',
        repairer: { kind: 'EXTERNAL', name: `ร้านซ่อมดี ${tag}` },
        symptom_or_work: 'ล้างเครื่อง',
      });
      const otherAssetId = await registered();
      const back = await sent(otherAssetId, { start_date: '2026-11-01', repairer: { kind: 'INTERNAL' }, symptom_or_work: `จอดับ ${tag}` });
      await ended(back, { outcome: 'NOT_USABLE', outcome_date: '2026-11-04' });

      const { items } = await list(`search=${tag}`);

      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        id: away,
        asset: { id: assetId },
        repair_kind: 'MAINTENANCE',
        start_date: '2026-11-03',
        repairer: { kind: 'EXTERNAL', name: `ร้านซ่อมดี ${tag}` },
        symptom_or_work: 'ล้างเครื่อง',
        is_voided: false,
        outcome: null,
      });
      expect(items[1]).toMatchObject({
        id: back,
        asset: { id: otherAssetId },
        repair_kind: 'REPAIR',
        start_date: '2026-11-01',
        repairer: { kind: 'INTERNAL', name: null },
        outcome: { outcome: 'NOT_USABLE', outcome_date: '2026-11-04' },
      });
    });
  });

  describe('filters (#98 Q21)', () => {
    const idsOf = async (query: string) => (await list(`${query}&limit=100`)).items.map(({ id }: any) => id).sort();
    const sorted = (...ids: string[]) => [...ids].sort();

    // Five records of known kind, Repairer kind and outcome, each of its own Asset, found by `tag`.
    const known = async (tag: string) => {
      const record = async (overrides: Record<string, unknown>, outcome?: 'USABLE' | 'NOT_USABLE') => {
        const id = await sent(await registered(), { start_date: TODAY, symptom_or_work: `อาการ ${tag}`, ...overrides });
        if (outcome) {
          await ended(id, { outcome, outcome_date: TODAY });
        }
        return id;
      };
      return {
        repairAway: await record({ repair_kind: 'REPAIR', repairer: { kind: 'INTERNAL' } }),
        maintenanceAway: await record({ repair_kind: 'MAINTENANCE', repairer: { kind: 'EXTERNAL', name: 'ร้านภายนอก' } }),
        repairUsable: await record({ repair_kind: 'REPAIR', repairer: { kind: 'EXTERNAL' } }, 'USABLE'),
        repairNotUsable: await record({ repair_kind: 'REPAIR', repairer: { kind: 'INTERNAL' } }, 'NOT_USABLE'),
        maintenanceNotUsable: await record({ repair_kind: 'MAINTENANCE', repairer: { kind: 'INTERNAL' } }, 'NOT_USABLE'),
      };
    };

    it('narrow to records with or without a Repair Outcome, by kind, by outcome and by Repairer kind', async () => {
      const tag = `Filter-${crypto.randomUUID().slice(0, 8)}`;
      const r = await known(tag);

      expect(await idsOf(`search=${tag}`)).toEqual(sorted(...Object.values(r)));
      expect(await idsOf(`has_outcome=false&search=${tag}`)).toEqual(sorted(r.repairAway, r.maintenanceAway));
      expect(await idsOf(`has_outcome=true&search=${tag}`)).toEqual(sorted(r.repairUsable, r.repairNotUsable, r.maintenanceNotUsable));
      expect(await idsOf(`repair_kind=REPAIR&search=${tag}`)).toEqual(sorted(r.repairAway, r.repairUsable, r.repairNotUsable));
      expect(await idsOf(`repair_kind=MAINTENANCE&search=${tag}`)).toEqual(sorted(r.maintenanceAway, r.maintenanceNotUsable));
      expect(await idsOf(`outcome=USABLE&search=${tag}`)).toEqual(sorted(r.repairUsable));
      expect(await idsOf(`outcome=NOT_USABLE&search=${tag}`)).toEqual(sorted(r.repairNotUsable, r.maintenanceNotUsable));
      expect(await idsOf(`repairer_kind=EXTERNAL&search=${tag}`)).toEqual(sorted(r.maintenanceAway, r.repairUsable));
      expect(await idsOf(`repairer_kind=INTERNAL&search=${tag}`)).toEqual(sorted(r.repairAway, r.repairNotUsable, r.maintenanceNotUsable));
    });

    it('each narrow the whole list on its own', async () => {
      const tag = `Alone-${crypto.randomUUID().slice(0, 8)}`;
      const r = await known(tag);
      const cases: [string, (row: any) => boolean, string[]][] = [
        ['has_outcome=false', (row) => row.outcome === null, [r.repairAway, r.maintenanceAway]],
        ['has_outcome=true', (row) => row.outcome !== null, [r.repairUsable, r.repairNotUsable, r.maintenanceNotUsable]],
        ['repair_kind=MAINTENANCE', (row) => row.repair_kind === 'MAINTENANCE', [r.maintenanceAway, r.maintenanceNotUsable]],
        ['outcome=NOT_USABLE', (row) => row.outcome?.outcome === 'NOT_USABLE', [r.repairNotUsable, r.maintenanceNotUsable]],
        ['repairer_kind=EXTERNAL', (row) => row.repairer.kind === 'EXTERNAL', [r.maintenanceAway, r.repairUsable]],
      ];
      for (const [query, passes, mine] of cases) {
        const { items } = await list(`${query}&limit=100`);
        expect(items.every(passes), query).toBe(true);
        expect(items.map(({ id }: any) => id), query).toEqual(expect.arrayContaining(mine));
      }
    });

    it('combine with AND', async () => {
      const tag = `And-${crypto.randomUUID().slice(0, 8)}`;
      const r = await known(tag);

      expect(await idsOf(`has_outcome=false&repair_kind=MAINTENANCE&search=${tag}`)).toEqual([r.maintenanceAway]);
      expect(await idsOf(`repair_kind=REPAIR&outcome=NOT_USABLE&search=${tag}`)).toEqual([r.repairNotUsable]);
      expect(await idsOf(`repair_kind=REPAIR&repairer_kind=INTERNAL&has_outcome=true&search=${tag}`)).toEqual([r.repairNotUsable]);
      expect(await idsOf(`outcome=USABLE&repairer_kind=INTERNAL&search=${tag}`)).toEqual([]);
      expect(await idsOf(`has_outcome=false&outcome=USABLE&search=${tag}`)).toEqual([]);
    });

    it('find a Repairer name or a symptom or work, in any case, a term only literally, and no other field', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const byName = await sent(await registered(), { repairer: { kind: 'EXTERNAL', name: `ร้าน Shop-${tag}` } });
      const bySymptom = await sent(await registered(), { symptom_or_work: `เปลี่ยนสายพาน\nแล้ว Belt-${tag} ยังดัง` });
      const literal = await sent(await registered(), { symptom_or_work: `ผงหมึก 100%_${tag}` });
      await sent(await registered(), { symptom_or_work: `ผงหมึก 1000_${tag}` });
      // A remark, a document reference and an outcome note are not searched.
      const elsewhere = await sent(await registered(), { remark: `Other-${tag}`, document_reference: `Other-${tag}` });
      await ended(elsewhere, { note: `Other-${tag}`, document_reference: `Other-${tag}` });

      expect(await idsOf(`search=shop-${tag.toUpperCase()}`)).toEqual([byName]);
      expect(await idsOf(`search=${encodeURIComponent(`belt-${tag}`)}`)).toEqual([bySymptom]);
      expect(await idsOf(`search=${encodeURIComponent(`100%_${tag}`)}`)).toEqual([literal]);
      expect(await idsOf(`search=${encodeURIComponent(`  Shop-${tag}  `)}`)).toEqual([byName]);
      expect(await idsOf(`search=Other-${tag}`)).toEqual([]);
    });

    it('refuse a value they do not know, and a blank or multi-line search', async () => {
      for (const query of [
        'has_outcome=',
        'has_outcome=1',
        'has_outcome=TRUE',
        'repair_kind=OTHER',
        'repair_kind=repair',
        'outcome=BROKEN',
        'outcome=',
        'repairer_kind=VENDOR',
        'search=',
        'search=%20%20',
        'search=%00',
        'search=%E0%B8%81%0A',
        'search=%E0%B8%81%09%E0%B8%82',
        `search=${'a'.repeat(4097)}`,
      ]) {
        const res = await api.get(readonly, `/repairs?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json(), query).toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
      }
    });
  });

  describe('pages (as on the Asset list)', () => {
    it('go newest Start Date first, and say how many records pass the filters and whether more follow', async () => {
      const tag = `Page-${crypto.randomUUID().slice(0, 8)}`;
      const startedOn = async (start_date: string) => sent(await registered(), { start_date, symptom_or_work: `งาน ${tag}` });
      const middle = await startedOn('2026-10-02');
      const newest = await startedOn('2026-10-03');
      const oldest = await startedOn('2026-10-01');
      // On the same Start Date, the one recorded later goes first.
      const middleRecordedLater = await startedOn('2026-10-02');
      const page = (query: string) => list(`search=${tag}&${query}`);

      // The two of 2026-10-02 fall on either side of a page break.
      const first = await page('limit=2');
      expect(first.items.map(({ id }: any) => id)).toEqual([newest, middleRecordedLater]);
      expect(first).toMatchObject({ limit: 2, offset: 0, total_count: 4, has_more: true });

      const last = await page('limit=2&offset=2');
      expect(last.items.map(({ id }: any) => id)).toEqual([middle, oldest]);
      expect(last).toMatchObject({ limit: 2, offset: 2, total_count: 4, has_more: false });

      expect(await page('offset=10')).toEqual({ items: [], limit: 25, offset: 10, total_count: 4, has_more: false });
    });

    it('hold 25 records unless asked for 1 to 100', async () => {
      const tag = `Size-${crypto.randomUUID().slice(0, 8)}`;
      for (let i = 0; i < 26; i++) {
        await sent(await registered(), { symptom_or_work: `งาน ${tag}` });
      }
      const { items, limit, has_more: hasMore } = await list(`search=${tag}`);
      expect({ count: items.length, limit, hasMore }).toEqual({ count: 25, limit: 25, hasMore: true });
      expect((await list(`search=${tag}&limit=100`)).items).toHaveLength(26);
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
        'repair_kind=REPAIR&repair_kind=MAINTENANCE',
        'has_conflict=true',
        'q=x',
      ]) {
        const res = await api.get(readonly, `/repairs?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().code, query).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('reading it (#98 Q2)', () => {
    it('is for every role with asset:view, and no one else', async () => {
      const maintainer = await api.actor('maintainer_repair_list', 'SYSTEM_MAINTAINER');
      for (const reader of [custodian, admin, readonly]) {
        expect((await api.get(reader, '/repairs')).statusCode).toBe(200);
      }
      expect((await api.get(maintainer, '/repairs')).statusCode).toBe(403);
    });

    it('needs asset:view itself: denying it alone, or failing to look it up, shows nothing', async () => {
      const symptom = `อาการที่ไม่ควรเห็นในรายการ ${crypto.randomUUID()}`;
      await sent(await registered(), { symptom_or_work: symptom });
      const url = `/repairs?search=${encodeURIComponent(symptom)}`;
      expect((await api.get(custodian, url)).body).toContain(symptom);

      const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, url));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain(symptom);

      const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, url));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain(symptom);
    });

    it('needs a session, and an inactive user is refused', async () => {
      expect((await api.app.inject({ method: 'GET', url: '/repairs' })).statusCode).toBe(401);
      const leaving = await api.actor('readonly_inactive_repair_list', 'READ_ONLY');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await api.get(leaving, '/repairs')).statusCode);
    });

    it('is never cached', async () => {
      expect((await api.get(readonly, '/repairs')).headers['cache-control']).toBe('no-store');
    });
  });
});
