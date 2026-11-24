import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialRequestHelpers } from './support/material-request-helpers.ts';
import { requestableMaterialHelpers } from './support/requestable-material-helpers.ts';

// F009-T7 (#209): making a Requestable Material Inactive (หยุดใช้) and reactivating it (เปิดใช้อีกครั้ง) as the same
// record, the Pending Requested Items that use it, and finding it by status (#202 MC-14, Q6, Q16, Q17, P6).
describe('Inactive and reactivate a Requestable Material (Seam A - F009-T7)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  let requester: Actor;
  // The Unit the Requestable Materials here are asked for in.
  let ream: string;

  const { unitNamed } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { requestableIn, requestableOf, end, inactivate, reactivate } = requestableMaterialHelpers(() => ({ api, officer, reader: readonly }));
  const { offeredIn, offered, createRequest, item, created, requestOf, cancelItem } = materialRequestHelpers(() => ({
    api,
    requester,
    officer,
    reader: readonly,
    requestUnit: ream,
  }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A Requestable Material named uniquely, with `tag` in its name when given.
  const fresh = async (tag = crypto.randomUUID().slice(0, 8)) => requestableIn(ream, `กระดาษหยุดใช้ ${tag}`);

  // A Requestable Material made Inactive through the API, at version 2.
  const madeInactive = async (id?: string): Promise<string> => {
    const target = id ?? (await fresh());
    expect((await inactivate(target)).statusCode).toBe(200);
    return target;
  };

  // The page without what a status change moves: its status, version and history.
  const unchangedOf = ({ is_active: _a, is_offered: _o, version: _v, history: _h, ...rest }: any) => rest;

  // What another write of the Requestable Material commits, held uncommitted: one moving it to its next version, as
  // adding a Compatible Stock Material does, or one making it Inactive or active.
  const versionHeld = (id: string) => ({ sql: 'UPDATE requestable_materials SET version = version + 1 WHERE id = $1', params: [id] });
  const statusHeld = (id: string, isActive: boolean) => ({ sql: 'UPDATE requestable_materials SET is_active = $2, version = version + 1 WHERE id = $1', params: [id, isActive] });

  // The ids of the rows a reader gets for `query`, sorted.
  const idsListed = async (query: string, actor: Actor = readonly): Promise<string[]> => {
    const res = await api.get(actor, `/requestable-materials?${query}&limit=100`);
    expect(res.statusCode).toBe(200);
    return res.json().items.map(({ id }: { id: string }) => id).sort();
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_rm_inactive', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_rm_inactive', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_rm_inactive', 'READ_ONLY');
    custodian = await api.actor('custodian_rm_inactive', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_rm_inactive', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_rm_inactive', 'SYSTEM_MAINTAINER');
    requester = await api.actor('requester_rm_inactive', 'REQUESTER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('making Inactive and reactivating (MC-14, Q6, Q17)', () => {
    it('makes the Requestable Material Inactive at its next version, with a history entry, changing nothing else', async () => {
      const id = await fresh();
      const before = await requestableOf(id);

      const res = await inactivate(id, { version: before.version });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: id, version: before.version + 1 });
      const after = await requestableOf(id);
      expect(after.is_active).toBe(false);
      expect(after.version).toBe(before.version + 1);
      expect(unchangedOf(after)).toEqual(unchangedOf(before));
      expect(after.history.slice(0, -1)).toEqual(before.history);
      expect(after.history.at(-1)).toMatchObject({
        version: before.version + 1,
        kind: 'INACTIVATED',
        changes: [{ field: 'is_active', before: true, after: false }],
        recorded_by: officer.id,
        recorded_by_username: 'officer_rm_inactive',
      });
    });

    it('reactivates it as the same record at its next version, with a history entry, changing nothing else', async () => {
      const id = await madeInactive();
      const before = await requestableOf(id);

      const res = await reactivate(id, { version: before.version });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: id, version: before.version + 1 });
      const after = await requestableOf(id);
      expect(after.is_active).toBe(true);
      expect(unchangedOf(after)).toEqual(unchangedOf(before));
      expect(after.history.map(({ kind }: { kind: string }) => kind)).toEqual(['CREATED', 'INACTIVATED', 'REACTIVATED']);
      expect(after.history.at(-1)).toMatchObject({ version: before.version + 1, changes: [{ field: 'is_active', before: false, after: true }], recorded_by: officer.id });
    });

    it('refuses making Inactive one already Inactive, and reactivating one already active, writing nothing', async () => {
      const active = await requestableOf(await fresh());
      const inactive = await requestableOf(await madeInactive());

      for (const [res, message] of [
        [await inactivate(inactive.id, { version: inactive.version }), 'The Requestable Material is already Inactive'],
        [await reactivate(active.id, { version: active.version }), 'The Requestable Material is already active'],
      ] as const) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
      }
      expect(await requestableOf(active.id)).toEqual(active);
      expect(await requestableOf(inactive.id)).toEqual(inactive);
    });

    it('refuses a stale version with the version the Requestable Material is at, writing nothing', async () => {
      const active = await requestableOf(await fresh());
      const inactive = await requestableOf(await madeInactive());

      for (const [res, page] of [
        [await inactivate(active.id, { version: active.version + 1 }), active],
        [await reactivate(inactive.id, { version: inactive.version - 1 }), inactive],
      ] as const) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read', current_values: { version: page.version } });
      }
      expect(await requestableOf(active.id)).toEqual(active);
      expect(await requestableOf(inactive.id)).toEqual(inactive);
    });

    it('needs the expected version as a positive whole number, and nothing else', async () => {
      const page = await requestableOf(await fresh());

      // Each payload with the start of the message that names the field it breaks.
      const payloads: [Record<string, unknown>, string][] = [
        [{}, 'Invalid request payload: expected_version: '],
        [{ expected_version: 0 }, 'Invalid request payload: expected_version: '],
        [{ expected_version: '1' }, 'Invalid request payload: expected_version: '],
        [{ expected_version: 1.5 }, 'Invalid request payload: expected_version: '],
        [{ expected_version: 1, note: 'x' }, 'Invalid request payload: : Unrecognized key: "note"'],
      ];
      for (const [payload, message] of payloads) {
        for (const action of ['inactivate', 'reactivate']) {
          const res = await api.post(officer, `/requestable-materials/${page.id}/${action}`, payload, { 'x-retry-token': crypto.randomUUID() });
          expect(res.statusCode).toBe(400);
          expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(message) });
        }
      }
      expect(await requestableOf(page.id)).toEqual(page);
    });

    it('answers 404 for a Requestable Material that does not exist, and 400 for an id that is not one', async () => {
      for (const write of [inactivate, reactivate]) {
        const missing = await write(crypto.randomUUID(), { version: 1 });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Requestable Material not found' });
        const invalid = await write('not-an-id', { version: 1 });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Requestable Material ID must be a valid UUID string' });
      }
    });

    it('makes Inactive and reactivates again and again, each an entry of its own', async () => {
      const id = await fresh();
      for (const write of [inactivate, reactivate, inactivate, reactivate]) {
        expect((await write(id)).statusCode).toBe(200);
      }
      const page = await requestableOf(id);
      expect(page.version).toBe(5);
      expect(page.history.map(({ version, kind }: any) => [version, kind])).toEqual([
        [1, 'CREATED'],
        [2, 'INACTIVATED'],
        [3, 'REACTIVATED'],
        [4, 'INACTIVATED'],
        [5, 'REACTIVATED'],
      ]);
    });
  });

  describe('Pending Requested Items (Q16, P6)', () => {
    it('keeps the Pending Requested Items that use it Pending, deleting nothing', async () => {
      const requestable = await offered();
      const request = await created([item(requestable)]);
      const before = await requestOf(request.material_request_id);

      expect((await inactivate(requestable)).statusCode).toBe(200);

      expect(await requestOf(request.material_request_id)).toEqual(before);
      expect(before.requested_items[0]).toMatchObject({ requestable_material_id: requestable, state: 'PENDING' });
    });

    it('counts on its page the Pending Requested Items that use it, of every Requester, and no Cancelled one', async () => {
      const otherRequester = await api.actor('requester_rm_inactive_two', 'REQUESTER');
      const requestable = await offered();
      const other = await offered();
      expect((await requestableOf(requestable)).pending_requested_item_count).toBe(0);

      await created([item(requestable), item(other)]);
      await created([item(requestable)], {}, otherRequester);
      const cancelled = await created([item(requestable)]);
      const page = await requestOf(cancelled.material_request_id);
      expect((await cancelItem(cancelled.material_request_id, page.requested_items[0].id, { version: page.version })).statusCode).toBe(200);

      expect((await requestableOf(requestable)).pending_requested_item_count).toBe(2);
      expect((await requestableOf(other)).pending_requested_item_count).toBe(1);

      // The count stays once it is Inactive: those Requested Items stay Pending.
      expect((await inactivate(requestable)).statusCode).toBe(200);
      expect((await requestableOf(requestable)).pending_requested_item_count).toBe(2);
    });

    it('counts the Pending Requested Items when the last Compatible Stock Material is ended too', async () => {
      const { requestable, stockMaterial } = await offeredIn();
      await created([item(requestable)]);

      expect((await end(requestable, stockMaterial)).statusCode).toBe(200);

      expect(await requestableOf(requestable)).toMatchObject({ is_offered: false, pending_requested_item_count: 1 });
    });
  });

  describe('offered (Q9, MC-14)', () => {
    it('is no longer offered once Inactive and is refused at creation, and is offered again once reactivated', async () => {
      const paper = await offered();
      const tag = crypto.randomUUID().slice(0, 8);
      const requestable = await offered({ name: `ขอเบิกหยุดใช้ ${tag}` });
      const offeredIds = async () => {
        const res = await api.get(requester, `/offered-requestable-materials?search=${encodeURIComponent(tag)}`);
        expect(res.statusCode).toBe(200);
        return res.json().items.map(({ id }: { id: string }) => id);
      };
      expect(await offeredIds()).toEqual([requestable]);

      expect((await inactivate(requestable)).statusCode).toBe(200);

      expect(await offeredIds()).toEqual([]);
      expect(await requestableOf(requestable)).toMatchObject({ is_active: false, is_offered: false });
      const refused = await createRequest({ requested_items: [item(paper), item(requestable)] });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'NOT_OFFERED', position: 1, message: expect.stringContaining('requested_items[1]') });

      expect((await reactivate(requestable)).statusCode).toBe(200);

      expect(await offeredIds()).toEqual([requestable]);
      expect((await createRequest({ requested_items: [item(paper), item(requestable)] })).statusCode).toBe(201);
    });
  });

  describe('the list (Q19)', () => {
    it('shows the active Requestable Materials by default, the Inactive ones with the status filter, and all of them with "all"', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const active = await fresh(`${tag} ก`);
      const inactive = await madeInactive(await fresh(`${tag} ข`));
      const reactivated = await madeInactive(await fresh(`${tag} ค`));
      expect((await reactivate(reactivated)).statusCode).toBe(200);
      const search = `search=${encodeURIComponent(tag)}`;

      expect(await idsListed(search)).toEqual([active, reactivated].sort());
      expect(await idsListed(`${search}&status=active`)).toEqual([active, reactivated].sort());
      expect(await idsListed(`${search}&status=inactive`)).toEqual([inactive]);
      expect(await idsListed(`${search}&status=all`)).toEqual([active, inactive, reactivated].sort());

      const res = await api.get(readonly, `/requestable-materials?${search}&status=inactive`);
      expect(res.json()).toMatchObject({ total_count: 1, has_more: false, items: [{ id: inactive, is_active: false, is_offered: false }] });
    });

    it('refuses a status it does not know', async () => {
      for (const status of ['', 'Inactive', 'deleted']) {
        const res = await api.get(readonly, `/requestable-materials?status=${status}`);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('status') });
      }
    });
  });

  describe('a name that matches an Inactive one (Q6)', () => {
    it('refuses the create with that Inactive Requestable Material, ignoring case and repeated spaces, so it can be reactivated', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const id = await madeInactive(await requestableIn(ream, `Paper Inactive ${tag}`));
      const counted = async () => (await api.pool.query('SELECT count(*)::int AS n FROM requestable_materials')).rows[0].n;
      const before = await counted();

      const res = await api.post(officer, '/requestable-materials', { name: `  paper   INACTIVE ${tag} `, request_unit_id: ream }, { 'x-retry-token': crypto.randomUUID() });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: expect.any(String), entry: { id, name: `Paper Inactive ${tag}`, is_active: false, version: 2 } });
      expect(await counted()).toBe(before);
    });
  });

  describe('permissions (Q4, Q18, P9)', () => {
    it('lets only the Supply Officer make a Requestable Material Inactive or reactivate it', async () => {
      const active = await requestableOf(await fresh());
      const inactive = await requestableOf(await madeInactive());

      for (const other of [admin, readonly, custodian, staff, maintainer, requester]) {
        for (const res of [await inactivate(active.id, { version: active.version, actor: other }), await reactivate(inactive.id, { version: inactive.version, actor: other })]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: expect.any(String) });
        }
      }
      expect(await requestableOf(active.id)).toEqual(active);
      expect(await requestableOf(inactive.id)).toEqual(inactive);
    });

    it('lets the holders of material:view filter the list by status and read the Pending count, and no one else', async () => {
      const id = await madeInactive();
      for (const viewer of [officer, admin, readonly]) {
        expect((await api.get(viewer, '/requestable-materials?status=inactive')).statusCode).toBe(200);
        expect(await requestableOf(id, viewer)).toMatchObject({ is_active: false, pending_requested_item_count: 0 });
      }
      for (const other of [custodian, staff, maintainer, requester]) {
        for (const res of [await api.get(other, '/requestable-materials?status=inactive'), await api.get(other, `/requestable-materials/${id}`)]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: expect.any(String) });
        }
      }
    });

    it('needs material:manage itself, and fails closed when the lookup fails, writing nothing', async () => {
      const active = await requestableOf(await fresh());
      const inactive = await requestableOf(await madeInactive());
      const writes = [() => inactivate(active.id, { version: active.version }), () => reactivate(inactive.id, { version: inactive.version })];

      for (const write of writes) {
        expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, write)).statusCode).toBe(403);
        const failed = await withCapabilityAnswer(
          api.app,
          'material:manage',
          async () => {
            throw new Error('lookup failed');
          },
          write
        );
        expect(failed.statusCode).toBe(500);
      }
      expect(await requestableOf(active.id)).toEqual(active);
      expect(await requestableOf(inactive.id)).toEqual(inactive);
    });

    it('needs a session and the CSRF token', async () => {
      const active = await requestableOf(await fresh());
      const inactive = await requestableOf(await madeInactive());
      for (const [url, payload] of [
        [`/requestable-materials/${active.id}/inactivate`, { expected_version: active.version }],
        [`/requestable-materials/${inactive.id}/reactivate`, { expected_version: inactive.version }],
      ] as const) {
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      }
      expect(await requestableOf(active.id)).toEqual(active);
      expect(await requestableOf(inactive.id)).toEqual(inactive);
    });
  });

  describe('retry token', () => {
    it('needs a token for each write', async () => {
      const active = await requestableOf(await fresh());
      const inactive = await requestableOf(await madeInactive());

      for (const [url, payload] of [
        [`/requestable-materials/${active.id}/inactivate`, { expected_version: active.version }],
        [`/requestable-materials/${inactive.id}/reactivate`, { expected_version: inactive.version }],
      ] as const) {
        const res = await api.post(officer, url, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      }
      expect(await requestableOf(active.id)).toEqual(active);
      expect(await requestableOf(inactive.id)).toEqual(inactive);
    });

    it('answers an identical replay with the committed result and writes nothing, even after the Requestable Material changed again', async () => {
      const id = await fresh();
      const token = crypto.randomUUID();
      const first = await inactivate(id, { version: 1, token });
      expect(first.statusCode).toBe(200);
      const reactivateToken = crypto.randomUUID();
      const reactivated = await reactivate(id, { version: 2, token: reactivateToken });
      expect(reactivated.statusCode).toBe(200);
      const before = await requestableOf(id);

      const replays = [await inactivate(id, { version: 1, token }), await reactivate(id, { version: 2, token: reactivateToken })];

      expect(replays.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(replays.map((res) => res.json())).toEqual([first.json(), reactivated.json()]);
      expect(await requestableOf(id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const id = await fresh();
      const other = await fresh();
      const token = crypto.randomUUID();
      expect((await inactivate(id, { version: 1, token })).statusCode).toBe(200);
      const before = await requestableOf(id);

      for (const res of [await inactivate(id, { version: 2, token }), await inactivate(other, { version: 1, token })]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect(await requestableOf(id)).toEqual(before);
      expect((await requestableOf(other)).is_active).toBe(true);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_rm_inactive_two', 'SUPPLY_OFFICER');
      const id = await fresh();
      const token = crypto.randomUUID();
      expect((await inactivate(id, { version: 1, token })).statusCode).toBe(200);

      // Their request under the same token is their own write, refused at the version the first one moved.
      const theirs = await inactivate(id, { version: 1, token, actor: otherOfficer });

      expect(theirs.statusCode).toBe(409);
      expect(theirs.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read' });
    });

    it('scopes a token to its operation: making Inactive and reactivating are two', async () => {
      const id = await fresh();
      const token = crypto.randomUUID();
      expect((await inactivate(id, { version: 1, token })).statusCode).toBe(200);

      const res = await reactivate(id, { version: 2, token });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: id, version: 3 });
      expect((await requestableOf(id)).is_active).toBe(true);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const id = await fresh();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 6 }, () => inactivate(id, { version: 1, token })));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((res) => res.json().version))).toEqual(new Set([2]));
      expect((await requestableOf(id)).history).toHaveLength(2);
    });
  });

  // CODING_STANDARDS, "A rule read under a lock has a test of its order": each write reads the version and then the
  // status under the Requestable Material's FOR UPDATE lock (#209 start decisions, comment 7101453040).
  describe('order', () => {
    it('makes Inactive only after a write moving the Requestable Material on, then refuses the stale version', async () => {
      const id = await fresh();

      const [res] = await whileWriting(versionHeld(id), () => [inactivate(id, { version: 1 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read', current_values: { version: 2 } });
    });

    it('makes Inactive only after another write making it Inactive, then refuses it as already Inactive', async () => {
      const id = await fresh();

      const [res] = await whileWriting(statusHeld(id, false), () => [inactivate(id, { version: 2 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'The Requestable Material is already Inactive' });
    });

    it('reactivates only after a write moving the Requestable Material on, then refuses the stale version', async () => {
      const id = await madeInactive();

      const [res] = await whileWriting(versionHeld(id), () => [reactivate(id, { version: 2 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read', current_values: { version: 3 } });
    });

    it('reactivates only after another write reactivating it, then refuses it as already active', async () => {
      const id = await madeInactive();

      const [res] = await whileWriting(statusHeld(id, true), () => [reactivate(id, { version: 3 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'The Requestable Material is already active' });
    });
  });
});
