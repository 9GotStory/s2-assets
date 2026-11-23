import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialRequestHelpers } from './support/material-request-helpers.ts';

// F009-T6 (#208): Supply Officers and Administrators see every Material Request in "คำขอเบิก", read-only, and open
// any Material Request's page, where only its Requester holding material-request:create is offered a Cancel (#202
// Q4, Q12, Q19, P5, P9; start decisions, #208 comment 7094323745; carry-overs from #206 and #207).
describe('Material Request view (Seam A - F009-T6)', () => {
  let api: ApiHarness;
  let requester: Actor;
  let otherRequester: Actor;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  let ream: string;

  const { unitNamed } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { offered, item, created, requestOf, cancelItem } = materialRequestHelpers(() => ({ api, requester, officer, reader: readonly, requestUnit: ream }));

  // "คำขอเบิก" as `actor` reads it for `query`.
  const all = async (query = '', actor: Actor = officer) => {
    const res = await api.get(actor, `/material-requests?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // "คำขอของฉัน" as `actor` reads it.
  const mine = async (actor: Actor) => {
    const res = await api.get(actor, '/my-material-requests');
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness();
    requester = await api.actor('requester_view', 'REQUESTER');
    otherRequester = await api.actor('requester_view_two', 'REQUESTER');
    officer = await api.actor('officer_view', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_view', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_view', 'READ_ONLY');
    custodian = await api.actor('custodian_view', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_view', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_view', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('"คำขอเบิก" (Q4, Q19)', () => {
    it("lists every person's Material Requests, newest first, each with its Request Number, Requester, Recorded At, state and Requested Item count", async () => {
      const paper = await offered();
      const pens = await offered();
      const older = await created([item(paper)]);
      const newer = await created([item(paper), item(pens)], {}, otherRequester);

      const list = await all();

      expect(list.items.slice(0, 2)).toEqual([
        { id: newer.material_request_id, request_number: newer.request_number, requested_by: otherRequester.id, requested_by_username: 'requester_view_two', recorded_at: expect.any(String), state: 'PENDING', requested_item_count: 2 },
        { id: older.material_request_id, request_number: older.request_number, requested_by: requester.id, requested_by_username: 'requester_view', recorded_at: expect.any(String), state: 'PENDING', requested_item_count: 1 },
      ]);
      expect(list).toMatchObject({ limit: 25, offset: 0, total_count: list.items.length, has_more: false });
      expect(list.items[0].recorded_at).toBe((await requestOf(newer.material_request_id, otherRequester)).recorded_at);
    });

    // The unique constraint on request_number makes the sort key unique, so Request Numbers cannot tie and need no
    // tiebreak (CODING_STANDARDS, "An order test of a paged list splits a tie across a page break").
    it('pages every Material Request by Request Number, newest first, whoever created it', async () => {
      const paper = await offered();
      const ids = [];
      for (const actor of [requester, otherRequester, requester]) {
        ids.push((await created([item(paper)], {}, actor)).material_request_id);
      }
      const total = (await all()).total_count;

      const first = await all('limit=2', admin);
      expect(first).toMatchObject({ total_count: total, has_more: true, limit: 2, offset: 0 });
      expect(first.items.map(({ id }: any) => id)).toEqual([ids[2], ids[1]]);
      const second = await all('limit=2&offset=2', admin);
      expect(second).toMatchObject({ total_count: total, has_more: total > 4, offset: 2 });
      expect(second.items.map(({ id }: any) => id)[0]).toBe(ids[0]);
      const past = await all(`offset=${total}`);
      expect(past).toMatchObject({ items: [], total_count: total, has_more: false });
    });

    it("filters every person's Material Requests by state, all by default, from the state its Requested Items derive (Q13, P10)", async () => {
      const paper = await offered();
      const pending = await created([item(paper)], {}, otherRequester);
      const cancelled = await created([item(paper)]);
      const page = await requestOf(cancelled.material_request_id);
      expect((await cancelItem(cancelled.material_request_id, page.requested_items[0].id, { version: page.version })).statusCode).toBe(200);

      const states = async (query: string) => {
        const list = await all(query);
        return Object.fromEntries(list.items.filter(({ id }: any) => [pending.material_request_id, cancelled.material_request_id].includes(id)).map(({ id, state }: any) => [id, state]));
      };
      expect(await states('')).toEqual({ [pending.material_request_id]: 'PENDING', [cancelled.material_request_id]: 'CANCELLED' });
      expect(await states('state=all')).toEqual(await states(''));
      expect(await states('state=pending')).toEqual({ [pending.material_request_id]: 'PENDING' });
      expect(await states('state=cancelled')).toEqual({ [cancelled.material_request_id]: 'CANCELLED' });
      const counts = await Promise.all(['', 'state=pending', 'state=cancelled'].map(async (query) => (await all(query)).total_count));
      expect(counts[1] + counts[2]).toBe(counts[0]);
      expect((await all('state=cancelled')).items.every(({ state }: any) => state === 'CANCELLED')).toBe(true);
      expect((await all('state=pending')).items.every(({ state }: any) => state === 'PENDING')).toBe(true);
    });

    it('refuses a state it does not know and an unknown parameter', async () => {
      for (const [query, part] of [
        ['state=issued', 'state:'],
        ['requested_by=me', 'requested_by'],
      ]) {
        const res = await api.get(officer, `/material-requests?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(part) });
      }
    });
  });

  describe('a person who is both a Requester and a Supply Officer (P5)', () => {
    it('sees only their own Material Requests in "คำขอของฉัน" and every one in "คำขอเบิก", each row naming its Requester', async () => {
      const both = await api.actor('requester_officer_lists', 'REQUESTER');
      await api.pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SUPPLY_OFFICER')`, [both.id]);
      const paper = await offered();
      const own = await created([item(paper)], {}, both);
      const others = await created([item(paper)], {}, otherRequester);

      const ownList = await mine(both);
      expect(ownList.items.map(({ id }: any) => id)).toEqual([own.material_request_id]);
      expect(ownList.items[0]).toMatchObject({ requested_by: both.id, requested_by_username: 'requester_officer_lists' });
      expect(ownList.total_count).toBe(1);

      const everyList = await all('', both);
      expect(everyList.items.slice(0, 2).map(({ id, requested_by_username }: any) => [id, requested_by_username])).toEqual([
        [others.material_request_id, 'requester_view_two'],
        [own.material_request_id, 'requester_officer_lists'],
      ]);
      expect(everyList.total_count).toBe((await all()).total_count);
    });

    it("reads another person's Pending Material Request with no Cancel offered, and is offered one on their own", async () => {
      const both = await api.actor('requester_officer_page', 'REQUESTER');
      await api.pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SUPPLY_OFFICER')`, [both.id]);
      const paper = await offered();
      const { material_request_id: others } = await created([item(paper)], {}, otherRequester);
      const { material_request_id: own } = await created([item(paper)], {}, both);

      const seen = await requestOf(others, both);
      expect(seen).toMatchObject({ requested_by: otherRequester.id, state: 'PENDING', can_cancel: false });
      expect(seen.requested_items.map(({ state, can_cancel }: any) => [state, can_cancel])).toEqual([['PENDING', false]]);
      const theirs = await requestOf(own, both);
      expect(theirs).toMatchObject({ state: 'PENDING', can_cancel: true });
      expect(theirs.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([true]);

      // The Cancel writes refuse what the page does not offer: another person's answers as if it did not exist.
      const res = await cancelItem(others, seen.requested_items[0].id, { version: seen.version, actor: both });
      expect(res.statusCode).toBe(404);
      expect((await requestOf(others, otherRequester)).state).toBe('PENDING');
    });
  });

  describe('a Cancel needs the Requester to hold material-request:create (P9; #207 start decision 2)', () => {
    it('offers no Cancel to the Requester of a Pending Material Request once they hold only material-request:view, nor while the lookup answers no, and offers it again with the role back', async () => {
      const former = await api.actor('requester_turned_officer', 'REQUESTER');
      const paper = await offered();
      const { material_request_id: id } = await created([item(paper)], {}, former);
      await api.pool.query(`UPDATE user_roles SET role_id = 'SUPPLY_OFFICER' WHERE user_id = $1 AND role_id = 'REQUESTER'`, [former.id]);

      const seen = await requestOf(id, former);
      expect(seen).toMatchObject({ requested_by: former.id, state: 'PENDING', can_cancel: false });
      expect(seen.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([false]);

      await api.pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'REQUESTER')`, [former.id]);
      expect((await requestOf(id, former)).can_cancel).toBe(true);
      const denied = await withCapabilityAnswer(api.app, 'material-request:create', async () => false, () => requestOf(id, former));
      expect(denied.can_cancel).toBe(false);
      expect(denied.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([false]);
    });
  });

  describe('not found (P5)', () => {
    it("answers another person's Material Request as if it did not exist to a Requester without material-request:view, and shows it to one who holds it", async () => {
      const paper = await offered();
      const { material_request_id: id } = await created([item(paper)], { note: 'คำขอของผู้ขอเบิกอีกคน' }, otherRequester);

      const hidden = await api.get(requester, `/material-requests/${id}`);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Request not found' });
      expect(hidden.body).not.toContain('คำขอของผู้ขอเบิกอีกคน');

      await api.pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SUPPLY_OFFICER')`, [requester.id]);
      try {
        expect((await requestOf(id)).note).toBe('คำขอของผู้ขอเบิกอีกคน');
        const denied = await withCapabilityAnswer(api.app, 'material-request:view', async () => false, () => api.get(requester, `/material-requests/${id}`));
        expect(denied.statusCode).toBe(404);
        expect(denied.body).not.toContain('คำขอของผู้ขอเบิกอีกคน');
      } finally {
        await api.pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'SUPPLY_OFFICER'`, [requester.id]);
      }
    });

    it('answers 404 to a Supply Officer for a Material Request that does not exist, and 400 for an id that is not a UUID', async () => {
      const missing = await api.get(officer, `/material-requests/${crypto.randomUUID()}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Request not found' });
      const invalid = await api.get(officer, '/material-requests/not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Material Request ID must be a valid UUID string' });
    });
  });

  describe('permissions (Q4, P5, P9)', () => {
    it('lets only the Supply Officer and the Administrator list "คำขอเบิก" and read any Material Request, the Requester read only their own, and refuses the four other roles and anyone without a session', async () => {
      const tag = `คำขอเบิกทุกคน${crypto.randomUUID().slice(0, 6)}`;
      const paper = await offered();
      const { material_request_id: own } = await created([item(paper)], { note: tag });
      const { material_request_id: others } = await created([item(paper)], { note: tag }, otherRequester);
      const pages = [`/material-requests/${own}`, `/material-requests/${others}`];

      for (const viewer of [officer, admin]) {
        const list = await api.get(viewer, '/material-requests');
        expect(list.statusCode).toBe(200);
        expect(list.body).toContain(own);
        expect(list.body).toContain(others);
        for (const url of pages) {
          const res = await api.get(viewer, url);
          expect(res.statusCode).toBe(200);
          expect(res.body).toContain(tag);
        }
      }

      const listed = await api.get(requester, '/material-requests');
      expect(listed.statusCode).toBe(403);
      expect(listed.json().error.code).toBe('FORBIDDEN');
      expect((await api.get(requester, pages[0])).statusCode).toBe(200);
      expect((await api.get(requester, pages[1])).statusCode).toBe(404);

      for (const other of [readonly, custodian, staff, maintainer]) {
        for (const url of ['/material-requests', ...pages]) {
          const res = await api.get(other, url);
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
          expect(res.body).not.toContain(tag);
          expect(res.body).not.toContain(own);
        }
      }
      for (const url of ['/material-requests', ...pages]) {
        const anonymous = await api.app.inject({ method: 'GET', url });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.body).not.toContain(tag);
      }
    });

    // The actor holds every role, so a gate on any other capability would let them through.
    it('needs material-request:view itself for "คำขอเบิก" and for another person\'s Material Request, and fails closed when either lookup fails', async () => {
      const everyone = await api.actor('officer_every_role', 'SUPPLY_OFFICER');
      for (const role of ['SYSTEM_MAINTAINER', 'ADMINISTRATOR', 'READ_ONLY', 'ASSET_CUSTODIAN', 'VERIFICATION_STAFF', 'REQUESTER']) {
        await api.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [everyone.id, role]);
      }
      const tag = `ปิดสิทธิ์คำขอเบิก${crypto.randomUUID().slice(0, 6)}`;
      const paper = await offered();
      const { material_request_id: others } = await created([item(paper)], { note: tag }, otherRequester);
      const { material_request_id: own } = await created([item(paper)], { note: tag }, everyone);
      const noView = <T>(work: () => Promise<T>) => withCapabilityAnswer(api.app, 'material-request:view', async () => false, work);
      const neither = <T>(work: () => Promise<T>) => withCapabilityAnswer(api.app, 'material-request:create', async () => false, () => noView(work));

      expect((await api.get(everyone, '/material-requests')).statusCode).toBe(200);
      const deniedList = await noView(() => api.get(everyone, '/material-requests'));
      expect(deniedList.statusCode).toBe(403);
      expect(deniedList.body).not.toContain(others);

      // Without material-request:view the Requester reads only their own; with neither capability nothing reads.
      expect((await noView(() => api.get(everyone, `/material-requests/${others}`))).statusCode).toBe(404);
      expect((await noView(() => api.get(everyone, `/material-requests/${own}`))).statusCode).toBe(200);
      for (const url of [`/material-requests/${others}`, `/material-requests/${own}`]) {
        const denied = await neither(() => api.get(everyone, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe('FORBIDDEN');
        expect(denied.body).not.toContain(tag);
      }

      // "คำขอเบิก" looks up material-request:view alone; the page looks up both.
      const lookups = [
        ['material-request:view', '/material-requests'],
        ['material-request:view', `/material-requests/${others}`],
        ['material-request:view', `/material-requests/${own}`],
        ['material-request:create', `/material-requests/${others}`],
        ['material-request:create', `/material-requests/${own}`],
      ];
      for (const [capability, url] of lookups) {
        const failed = await withCapabilityAnswer(api.app, capability, async () => { throw new Error('lookup failed'); }, () => api.get(everyone, url));
        expect(failed.statusCode, `${capability} ${url}`).toBe(500);
        expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(failed.body).not.toContain(tag);
      }
    });
  });

  describe('the Material Request page through "คำขอเบิก" (Q4, Q12, P9)', () => {
    it("shows a Supply Officer and an Administrator every field, Requested Item and history entry of another person's Material Request, offering no Cancel while it is Pending", async () => {
      const paper = await offered();
      const pens = await offered();
      const { material_request_id: id } = await created([item(paper, '3', { note: 'ใช้ที่ห้องประชุม' }), item(pens)], { note: 'งานประชุมประจำเดือน' });
      const page = await requestOf(id);
      expect((await cancelItem(id, page.requested_items[1].id, { version: page.version, note: 'ไม่ใช้แล้ว' })).statusCode).toBe(200);
      const owner = await requestOf(id);
      expect(owner.can_cancel).toBe(true);
      expect(owner.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([true, false]);

      for (const viewer of [officer, admin]) {
        const seen = await requestOf(id, viewer);
        expect(seen).toEqual({
          ...owner,
          can_cancel: false,
          requested_items: owner.requested_items.map((requested: any) => ({ ...requested, can_cancel: false })),
        });
        expect(seen).toMatchObject({ requested_by: requester.id, requested_by_username: 'requester_view', note: 'งานประชุมประจำเดือน', state: 'PENDING', version: 2 });
        expect(seen.requested_items[0]).toMatchObject({ requestable_material_id: paper, requested_quantity: '3', note: 'ใช้ที่ห้องประชุม', state: 'PENDING' });
        expect(seen.requested_items[1]).toMatchObject({ state: 'CANCELLED', cancelled_by: requester.id, cancel_note: 'ไม่ใช้แล้ว' });
        expect(seen.history.map(({ kind }: any) => kind)).toEqual(['CREATED', 'REQUESTED_ITEM_CANCELLED']);
      }
    });
  });
});
