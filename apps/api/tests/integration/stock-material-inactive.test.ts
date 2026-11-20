import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// Text of `length` characters.
const text = (length: number) => 'ก'.repeat(length);

// F008-T7 (#180): making a Stock Material Inactive (หยุดใช้) and reactivating it (เปิดใช้อีกครั้ง) as the same record,
// and finding it by status (#175 MC-14, Q13, Q23, P7, P9).
describe('Inactive and reactivate a Stock Material (Seam A - F008-T7)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;

  const { created, materialOf, correct, inactivate, reactivate } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // The page of an Inactive Stock Material, made Inactive through the API.
  const inactive = async () => {
    const page = await fresh();
    expect((await inactivate(page.id, { expected_version: page.version })).statusCode).toBe(200);
    return materialOf(page.id);
  };

  // What another write of the Stock Material commits, held uncommitted: one making it Inactive or active.
  const statusHeld = (id: string, isActive: boolean) => ({
    sql: 'UPDATE stock_materials SET is_active = $2, version = version + 1 WHERE id = $1',
    params: [id, isActive],
  });

  // The ids of the rows a reader gets for `query`, sorted.
  const idsListed = async (query: string, actor: Actor = readonly): Promise<string[]> => {
    const res = await api.get(actor, `/stock-materials?${query}&limit=100`);
    expect(res.statusCode).toBe(200);
    return res.json().items.map(({ id }: { id: string }) => id).sort();
  };

  // The page of a new Stock Material, as a viewer reads it.
  const fresh = async (overrides: Record<string, unknown> = {}) => materialOf(await created(overrides));

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_inactive', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_inactive', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_inactive', 'READ_ONLY');
    custodian = await api.actor('custodian_inactive', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_inactive', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_inactive', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('making Inactive', () => {
    it('makes the Stock Material Inactive with a note, changing nothing else, and its history records who, when and the note (MC-14, Q13)', async () => {
      const page = await fresh({ model: 'A4 80 แกรม', note: 'ห้องพัสดุ' });
      const startedAt = Date.now();

      const res = await inactivate(page.id, { expected_version: 1, note: 'เลิกสั่งแล้ว ยังเหลือในคลัง' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 2 });
      const after = await materialOf(page.id);
      const { history, ...rest } = after;
      expect(rest).toEqual({ ...page, history: undefined, is_active: false, version: 2, can_inactivate: false, can_reactivate: false });
      expect(history.slice(0, 1)).toEqual(page.history);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({
        version: 2,
        kind: 'INACTIVATED',
        changes: [{ field: 'is_active', before: true, after: false }],
        reason: null,
        note: 'เลิกสั่งแล้ว ยังเหลือในคลัง',
        recorded_by: officer.id,
        recorded_by_username: 'officer_inactive',
      });
      expect(Date.parse(history[1].recorded_at)).toBeGreaterThanOrEqual(startedAt - 1000);
    });

    it('takes no note, or a blank one, as none', async () => {
      for (const payload of [{}, { note: null }, { note: ' \n ' }]) {
        const page = await fresh();

        expect((await inactivate(page.id, { expected_version: 1, ...payload })).statusCode).toBe(200);

        expect((await materialOf(page.id)).history[1]).toMatchObject({ kind: 'INACTIVATED', note: null });
      }
    });

    it('needs a note of at most 2000 characters with no control character but tab and line breaks, kept as written inside (P7)', async () => {
      const page = await fresh();
      const refused: [string, string][] = [
        [text(2001), 'note must be at most 2000 characters'],
        ['ห้อง\u0007พัสดุ', 'note must not contain control characters'],
        ['ห้อง\u007fพัสดุ', 'note must not contain control characters'],
      ];
      for (const [note, message] of refused) {
        const res = await inactivate(page.id, { expected_version: 1, note });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(message) });
      }
      expect(await materialOf(page.id)).toEqual(page);

      const note = `${text(1990)}\tเลิก\r\nใช้`;
      expect((await inactivate(page.id, { expected_version: 1, note: ` ${note} ` })).statusCode).toBe(200);
      expect((await materialOf(page.id)).history[1].note).toBe(note);
    });

    it('needs the expected version, and a note that is text, and nothing else', async () => {
      const page = await fresh();
      const refused: [Record<string, unknown>, string][] = [
        [{}, 'expected_version'],
        [{ expected_version: 0 }, 'expected_version'],
        [{ expected_version: '1' }, 'expected_version'],
        [{ expected_version: 1, note: 5 }, 'note'],
        [{ expected_version: 1, reason: 'เลิกใช้' }, 'reason'],
        [{ expected_version: 1, is_active: false }, 'is_active'],
      ];
      for (const [payload, field] of refused) {
        const res = await inactivate(page.id, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json(), JSON.stringify(payload)).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
      }
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('refuses a Stock Material already Inactive, and writes nothing', async () => {
      const page = await inactive();

      const res = await inactivate(page.id, { expected_version: page.version, note: 'อีกครั้ง' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('already Inactive') });
      expect(await materialOf(page.id)).toEqual(page);
    });
  });

  describe('reactivating', () => {
    it('reactivates the Stock Material as the same record, changing nothing else, and keeps every history entry (MC-14, Q13)', async () => {
      const page = await inactive();
      const startedAt = Date.now();

      const res = await reactivate(page.id, { expected_version: 2 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 3 });
      const { history, ...rest } = await materialOf(page.id);
      expect(rest).toEqual({ ...page, history: undefined, is_active: true, version: 3 });
      expect(history.slice(0, 2)).toEqual(page.history);
      expect(history).toHaveLength(3);
      expect(history[2]).toMatchObject({
        version: 3,
        kind: 'REACTIVATED',
        changes: [{ field: 'is_active', before: false, after: true }],
        reason: null,
        note: null,
        recorded_by: officer.id,
        recorded_by_username: 'officer_inactive',
      });
      expect(Date.parse(history[2].recorded_at)).toBeGreaterThanOrEqual(startedAt - 1000);
    });

    it('refuses a Stock Material in use, and writes nothing', async () => {
      const page = await fresh();

      const res = await reactivate(page.id, { expected_version: 1 });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('already active') });
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs the expected version, and takes no note', async () => {
      const page = await inactive();
      const refused: [Record<string, unknown>, string][] = [
        [{}, 'expected_version'],
        [{ expected_version: 0 }, 'expected_version'],
        [{ expected_version: 2, note: 'กลับมาใช้' }, 'note'],
        [{ expected_version: 2, note: null }, 'note'],
      ];
      for (const [payload, field] of refused) {
        const res = await reactivate(page.id, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json(), JSON.stringify(payload)).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
      }
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('makes Inactive and reactivates again and again, each an entry of its own', async () => {
      const page = await inactive();
      expect((await reactivate(page.id, { expected_version: 2 })).statusCode).toBe(200);
      expect((await inactivate(page.id, { expected_version: 3, note: 'หยุดอีกรอบ' })).statusCode).toBe(200);

      const after = await materialOf(page.id);

      expect(after.is_active).toBe(false);
      expect(after.history.map(({ kind, note }: { kind: string; note: string | null }) => [kind, note])).toEqual([
        ['CREATED', null],
        ['INACTIVATED', null],
        ['REACTIVATED', null],
        ['INACTIVATED', 'หยุดอีกรอบ'],
      ]);
    });
  });

  describe('the version each write expects (Q23)', () => {
    it('refuses a stale version with the version the Stock Material is at, and writes nothing', async () => {
      const page = await fresh({ name: `ซองจดหมาย ${crypto.randomUUID().slice(0, 8)}` });
      expect((await correct(page.id, { expected_version: 1, name: page.name, brand_id: null, model: 'DL', specification: null, reason: 'ลืมรุ่น' })).statusCode).toBe(200);
      const corrected = await materialOf(page.id);

      const res = await inactivate(page.id, { expected_version: 1 });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await materialOf(page.id)).toEqual(corrected);

      const madeInactive = await inactive();
      const stale = await reactivate(madeInactive.id, { expected_version: 1 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await materialOf(madeInactive.id)).toEqual(madeInactive);
    });

    it('makes Inactive only after a write holding the Stock Material, then refuses the version it changed', async () => {
      const page = await fresh();

      const [res] = await whileWriting(statusHeld(page.id, false), () => [inactivate(page.id, { expected_version: 1 })], () => untilWaiting('stock_materials'));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 } });
      expect((await materialOf(page.id)).history).toHaveLength(1);
    });

    it('reactivates only after a write holding the Stock Material, then refuses the version it changed', async () => {
      const page = await inactive();

      const [res] = await whileWriting(statusHeld(page.id, true), () => [reactivate(page.id, { expected_version: 2 })], () => untilWaiting('stock_materials'));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 3 } });
      expect((await materialOf(page.id)).history).toHaveLength(2);
    });

    it('makes Inactive only after another write making it Inactive, then refuses it as already Inactive', async () => {
      const page = await fresh();

      const [res] = await whileWriting(statusHeld(page.id, false), () => [inactivate(page.id, { expected_version: 2 })], () => untilWaiting('stock_materials'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('already Inactive') });
      expect((await materialOf(page.id)).history).toHaveLength(1);
    });

    it('reactivates only after another write reactivating it, then refuses it as already active', async () => {
      const page = await inactive();

      const [res] = await whileWriting(statusHeld(page.id, true), () => [reactivate(page.id, { expected_version: 3 })], () => untilWaiting('stock_materials'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('already active') });
      expect((await materialOf(page.id)).history).toHaveLength(2);
    });

    it('answers 404 for a Stock Material that does not exist, and 400 for an id that is not one', async () => {
      for (const write of [inactivate, reactivate]) {
        const missing = await write(crypto.randomUUID(), { expected_version: 1 });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Stock Material not found' });
        const invalid = await write('not-an-id', { expected_version: 1 });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: expect.stringContaining('UUID') });
      }
    });
  });

  describe('permissions', () => {
    it('lets only the Supply Officer make a Stock Material Inactive or reactivate it', async () => {
      const page = await fresh();
      const madeInactive = await inactive();

      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        for (const res of [await inactivate(page.id, { expected_version: 1 }, crypto.randomUUID(), other), await reactivate(madeInactive.id, { expected_version: 2 }, crypto.randomUUID(), other)]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        }
      }
      expect(await materialOf(page.id)).toEqual(page);
      expect(await materialOf(madeInactive.id)).toEqual(madeInactive);
    });

    it('needs material:manage itself, and fails closed when the lookup fails, writing nothing', async () => {
      const page = await fresh();
      const madeInactive = await inactive();
      const writes = [() => inactivate(page.id, { expected_version: 1 }), () => reactivate(madeInactive.id, { expected_version: 2 })];

      for (const write of writes) {
        expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, write)).statusCode).toBe(403);
        const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, write);
        expect(failed.statusCode).toBe(500);
      }
      expect(await materialOf(page.id)).toEqual(page);
      expect(await materialOf(madeInactive.id)).toEqual(madeInactive);
    });

    it('needs a session and the CSRF token', async () => {
      const page = await fresh();
      const madeInactive = await inactive();
      for (const [url, payload] of [[`/stock-materials/${page.id}/inactivate`, { expected_version: 1 }], [`/stock-materials/${madeInactive.id}/reactivate`, { expected_version: 2 }]] as const) {
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      }
      expect(await materialOf(page.id)).toEqual(page);
      expect(await materialOf(madeInactive.id)).toEqual(madeInactive);
    });

    it('offers "หยุดใช้" on a Stock Material in use and "เปิดใช้อีกครั้ง" on an Inactive one, to the Supply Officer alone (P9)', async () => {
      const page = await fresh();
      const madeInactive = await inactive();

      expect(await materialOf(page.id, officer)).toMatchObject({ is_active: true, can_manage: true, can_inactivate: true, can_reactivate: false });
      expect(await materialOf(madeInactive.id, officer)).toMatchObject({ is_active: false, can_manage: true, can_inactivate: false, can_reactivate: true });
      for (const viewer of [admin, readonly]) {
        for (const id of [page.id, madeInactive.id]) {
          expect(await materialOf(id, viewer)).toMatchObject({ can_manage: false, can_inactivate: false, can_reactivate: false });
        }
      }
    });
  });

  describe('retry token', () => {
    it('needs a token for each write', async () => {
      const page = await fresh();
      const madeInactive = await inactive();

      for (const [url, payload] of [[`/stock-materials/${page.id}/inactivate`, { expected_version: 1 }], [`/stock-materials/${madeInactive.id}/reactivate`, { expected_version: 2 }]] as const) {
        const res = await api.post(officer, url, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('retry token');
      }
      expect(await materialOf(page.id)).toEqual(page);
      expect(await materialOf(madeInactive.id)).toEqual(madeInactive);
    });

    it('answers an identical replay with the committed result and writes nothing, even after the Stock Material was reactivated', async () => {
      const page = await fresh();
      const token = crypto.randomUUID();
      const first = await inactivate(page.id, { expected_version: 1, note: 'ครั้งเดียว' }, token);
      expect(first.statusCode).toBe(200);
      const reactivateToken = crypto.randomUUID();
      const reactivated = await reactivate(page.id, { expected_version: 2 }, reactivateToken);
      expect(reactivated.statusCode).toBe(200);
      const before = await materialOf(page.id);

      const replays = [await inactivate(page.id, { expected_version: 1, note: 'ครั้งเดียว' }, token), await reactivate(page.id, { expected_version: 2 }, reactivateToken)];

      expect(replays.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(replays.map((res) => res.json())).toEqual([first.json(), reactivated.json()]);
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const page = await fresh();
      const token = crypto.randomUUID();
      expect((await inactivate(page.id, { expected_version: 1, note: 'ครั้งเดียว' }, token)).statusCode).toBe(200);
      const reactivateToken = crypto.randomUUID();
      expect((await reactivate(page.id, { expected_version: 2 }, reactivateToken)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      for (const res of [
        await inactivate(page.id, { expected_version: 1, note: 'อีกหมายเหตุ' }, token),
        await inactivate(page.id, { expected_version: 3, note: 'ครั้งเดียว' }, token),
        await reactivate(page.id, { expected_version: 4 }, reactivateToken),
      ]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_inactive_two', 'SUPPLY_OFFICER');
      const page = await fresh();
      const token = crypto.randomUUID();
      expect((await inactivate(page.id, { expected_version: 1 }, token)).statusCode).toBe(200);

      // Their request under the same token is their own write, refused at the version the first one moved.
      const theirs = await inactivate(page.id, { expected_version: 1 }, token, otherOfficer);

      expect(theirs.statusCode).toBe(409);
      expect(theirs.json().code).toBe('STALE_BEFORE_CONFLICT');
    });

    it('scopes a token to its operation: making Inactive and reactivating are two', async () => {
      const page = await fresh();
      const token = crypto.randomUUID();
      expect((await inactivate(page.id, { expected_version: 1 }, token)).statusCode).toBe(200);

      const res = await reactivate(page.id, { expected_version: 2 }, token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 3 });
      expect((await materialOf(page.id)).is_active).toBe(true);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const page = await fresh();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 6 }, () => inactivate(page.id, { expected_version: 1 }, token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((res) => res.json().version))).toEqual(new Set([2]));
      expect((await materialOf(page.id)).history).toHaveLength(2);
    });
  });

  describe('the list', () => {
    it('shows the Stock Materials in use by default, the Inactive ones with the status filter, and all of them with "all", each row with its status (MC-14, Q13)', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const inUse = await created({ name: `สถานะ ${tag} ก` });
      const madeInactive = await created({ name: `สถานะ ${tag} ข` });
      const reactivated = await created({ name: `สถานะ ${tag} ค` });
      expect((await inactivate(madeInactive, { expected_version: 1 })).statusCode).toBe(200);
      expect((await inactivate(reactivated, { expected_version: 1 })).statusCode).toBe(200);
      expect((await reactivate(reactivated, { expected_version: 2 })).statusCode).toBe(200);
      const search = `search=${encodeURIComponent(`สถานะ ${tag}`)}`;

      expect(await idsListed(search)).toEqual([inUse, reactivated].sort());
      expect(await idsListed(`${search}&status=active`)).toEqual([inUse, reactivated].sort());
      expect(await idsListed(`${search}&status=inactive`)).toEqual([madeInactive]);
      expect(await idsListed(`${search}&status=all`)).toEqual([inUse, madeInactive, reactivated].sort());
      const res = await api.get(readonly, `/stock-materials?${search}&status=all`);
      expect(res.json().items.map(({ id, is_active }: { id: string; is_active: boolean }) => [id, is_active])).toEqual([
        [inUse, true],
        [madeInactive, false],
        [reactivated, true],
      ]);
    });

    it('counts and pages within the status filter', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      for (const name of [`นับสถานะ ${tag} ก`, `นับสถานะ ${tag} ข`]) {
        expect((await inactivate(await created({ name }), { expected_version: 1 })).statusCode).toBe(200);
      }
      await created({ name: `นับสถานะ ${tag} ค` });

      const res = await api.get(readonly, `/stock-materials?search=${encodeURIComponent(`นับสถานะ ${tag}`)}&status=inactive&limit=1`);

      expect(res.json()).toMatchObject({ total_count: 2, has_more: true, items: [{ name: `นับสถานะ ${tag} ก`, is_active: false }] });
    });

    it('lets every viewer of the catalog use the status filter', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const id = await created({ name: `ผู้ดู ${tag}` });
      expect((await inactivate(id, { expected_version: 1 })).statusCode).toBe(200);

      for (const viewer of [officer, admin, readonly]) {
        expect(await idsListed(`search=${encodeURIComponent(`ผู้ดู ${tag}`)}&status=inactive`, viewer)).toEqual([id]);
      }
      for (const other of [custodian, staff, maintainer]) {
        expect((await api.get(other, '/stock-materials?status=inactive')).statusCode).toBe(403);
      }
    });

    it('refuses a status filter that is not "active", "inactive" or "all"', async () => {
      for (const value of ['Inactive', 'ACTIVE', 'none', 'true', '']) {
        const res = await api.get(readonly, `/stock-materials?status=${value}`);
        expect(res.statusCode, value).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('status') });
      }
    });
  });
});
