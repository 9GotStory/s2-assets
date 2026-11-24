import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';

// What a rename, and making an entry Inactive or reactivating it, commit, to hold uncommitted.
const renameHeld = (table: string, id: string, name: string) => ({ sql: `UPDATE ${table} SET name = $2, version = version + 1 WHERE id = $1`, params: [id, name] });
const statusHeld = (table: string, id: string, isActive: boolean) => ({ sql: `UPDATE ${table} SET is_active = $2, version = version + 1 WHERE id = $1`, params: [id, isActive] });
const versionHeld = (table: string, id: string) => ({ sql: `UPDATE ${table} SET version = version + 1 WHERE id = $1`, params: [id] });

// F010-T1 (#232): the Source Party (แหล่งที่มา) and Source Type (วิธีได้มา) lists, two kinds of the shared catalog
// lists with the behavior of the Brand list: a Supply Officer adds an entry, renames it, makes it Inactive and
// reactivates it; nothing is deleted. A Source Party also holds an optional note (#231 MRC-06, MRC-09, MRC-10,
// MRC-11, MC-16, Q3, Q6, Q12, P6, P7; #232 decision 1).
describe.each([
  { concept: 'Source Party', path: '/source-parties', table: 'source_parties' as const },
  { concept: 'Source Type', path: '/source-types', table: 'source_types' as const },
])('$concept list (Seam A - F010-T1)', ({ concept, path, table }) => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;
  // The six roles other than the Supply Officer, the Requester included (Q3).
  let others: Actor[];

  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  const add = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) => api.post(actor, path, payload, { 'x-retry-token': token });
  const rename = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `${path}/${id}/rename`, payload, { 'x-retry-token': token });
  const inactivate = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `${path}/${id}/inactivate`, payload, { 'x-retry-token': token });
  const reactivate = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `${path}/${id}/reactivate`, payload, { 'x-retry-token': token });

  // An entry added to the list, named `name` or uniquely, and its id.
  const entryId = async (name: string = `รายการ ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await add({ name });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  // An entry made Inactive through the API, at version 2, and its id.
  const inactiveEntryId = async (name?: string): Promise<string> => {
    const id = await entryId(name);
    expect((await inactivate(id, { expected_version: 1 })).statusCode).toBe(200);
    return id;
  };

  const listOf = async (actor: Actor = readonly) => {
    const res = await api.get(actor, path);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The entry `id` as the list shows it.
  const listed = async (id: string) => (await listOf()).items.find((entry: { id: string }) => entry.id === id);

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_source', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_source', 'READ_ONLY');
    others = [
      await api.actor('admin_source', 'ADMINISTRATOR'),
      readonly,
      await api.actor('requester_source', 'REQUESTER'),
      await api.actor('custodian_source', 'ASSET_CUSTODIAN'),
      await api.actor('staff_source', 'VERIFICATION_STAFF'),
      await api.actor('maintainer_source', 'SYSTEM_MAINTAINER'),
    ];
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('add (MRC-09, Q6, Q12)', () => {
    it('adds an active entry at version 1, which the list shows with no usage and its CREATED history', async () => {
      const res = await add({ name: '  บริษัท  เครื่องเขียนไทย  ' });
      expect(res.statusCode).toBe(201);
      const entry = res.json();
      expect(entry).toMatchObject({ name: 'บริษัท  เครื่องเขียนไทย', is_active: true, version: 1 });

      expect(await listed(entry.id)).toMatchObject({
        id: entry.id,
        name: 'บริษัท  เครื่องเขียนไทย',
        is_active: true,
        version: 1,
        usage_count: 0,
        history: [{ version: 1, action: 'CREATED', changes: { name: { before: null, after: 'บริษัท  เครื่องเขียนไทย' }, is_active: { before: null, after: true } }, actor_username: 'officer_source' }],
      });
    });

    it('refuses a name another entry holds, ignoring case and repeated spaces, answering with that entry and adding nothing', async () => {
      const name = `Office  Mart ${crypto.randomUUID().slice(0, 8)}`;
      const id = await entryId(name);
      const before = (await listOf()).items.length;

      const res = await add({ name: ` office mart   ${name.slice(-8).toUpperCase()} ` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: `A ${concept} with this name is already in the list`, entry: { id, name, is_active: true, version: 1 } });
      expect((await listOf()).items).toHaveLength(before);
    });

    it('refuses a name an Inactive entry holds, answering with that entry so that it can be reactivated (Q12)', async () => {
      const name = `หยุดใช้แล้ว ${crypto.randomUUID().slice(0, 8)}`;
      const id = await inactiveEntryId(name);

      const res = await add({ name });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: `A ${concept} with this name is already in the list`, entry: { id, name, is_active: false, version: 2 } });
      expect((await reactivate(id, { expected_version: 2 })).json()).toMatchObject({ id, is_active: true, version: 3 });
    });

    it('needs a name that is not blank, of at most 200 characters and with no control character (P7)', async () => {
      for (const [name, message] of [
        ['   ', 'name must not be blank'],
        ['ก'.repeat(201), 'name must be at most 200 characters'],
        ['ชื่อ\n', 'name must not contain control characters'],
      ]) {
        const res = await add({ name });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
      }
      expect(await listed(await entryId('ก'.repeat(200)))).toMatchObject({ name: 'ก'.repeat(200) });
    });

    it('answers an identical replay with the committed entry, refuses the same token with another name, and scopes a token to its actor', async () => {
      const token = crypto.randomUUID();
      const name = `โทเคน ${crypto.randomUUID().slice(0, 8)}`;
      const first = await add({ name }, token);
      expect(first.statusCode).toBe(201);
      const replay = await add({ name }, token);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const mismatch = await add({ name: `${name} อื่น` }, token);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: expect.any(String) });
      expect((await listOf()).items.some((entry: { name: string }) => entry.name === `${name} อื่น`)).toBe(false);

      // Another Supply Officer's write under the same token is their own.
      const colleague = await api.actor(`officer_source_${crypto.randomUUID().slice(0, 6)}`, 'SUPPLY_OFFICER');
      const theirs = await add({ name: `${name} ของอีกคน` }, token, colleague);
      expect(theirs.statusCode).toBe(201);
      expect(theirs.json().id).not.toBe(first.json().id);
    });

    it('needs a retry token', async () => {
      const name = `ไม่มีโทเคน ${crypto.randomUUID().slice(0, 8)}`;
      const res = await api.post(officer, path, { name });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry') });
      expect((await listOf()).items.some((entry: { name: string }) => entry.name === name)).toBe(false);
    });
  });

  describe('rename (MRC-11, Q12)', () => {
    it('renames an entry at the version it read, keeping the old and the new name in its history', async () => {
      const id = await entryId('บริษัท สะกดผิด');
      const res = await rename(id, { expected_version: 1, name: 'บริษัท สะกดถูก' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, name: 'บริษัท สะกดถูก', is_active: true, version: 2 });
      expect((await listed(id)).history[1]).toMatchObject({ version: 2, action: 'CHANGED', changes: { name: { before: 'บริษัท สะกดผิด', after: 'บริษัท สะกดถูก' } } });
    });

    it('renames an Inactive entry, which stays Inactive', async () => {
      const id = await inactiveEntryId();
      expect((await rename(id, { expected_version: 2, name: `ชื่อใหม่ ${id.slice(0, 8)}` })).json()).toMatchObject({ is_active: false, version: 3 });
    });

    it('refuses a rename to the very same name, the name of another entry and a stale version, recording nothing', async () => {
      const name = `ชื่อเดิม ${crypto.randomUUID().slice(0, 8)}`;
      const id = await entryId(name);
      const other = await inactiveEntryId();
      const otherName = (await listed(other)).name;

      const same = await rename(id, { expected_version: 1, name });
      expect(same.statusCode).toBe(400);
      expect(same.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This rename changes nothing' });
      const taken = await rename(id, { expected_version: 1, name: otherName.toUpperCase() });
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: `A ${concept} with this name is already in the list`, entry: { id: other, is_active: false } });
      const stale = await rename(id, { expected_version: 2, name: `${name} ใหม่` });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: `The ${concept} changed since it was read`, current_values: { version: 1 }, expected_values: { version: 2 } });
      expect(await listed(id)).toMatchObject({ name, version: 1, history: [{ action: 'CREATED' }] });
    });
  });

  describe('Inactive and reactivate (Q12)', () => {
    it('makes an entry Inactive and reactivates it as the same entry, each at the version it read with a history entry', async () => {
      const id = await entryId();
      expect((await inactivate(id, { expected_version: 1 })).json()).toMatchObject({ id, is_active: false, version: 2 });
      expect((await reactivate(id, { expected_version: 2 })).json()).toMatchObject({ id, is_active: true, version: 3 });
      expect((await listed(id)).history.slice(1)).toMatchObject([
        { version: 2, action: 'CHANGED', changes: { is_active: { before: true, after: false } } },
        { version: 3, action: 'CHANGED', changes: { is_active: { before: false, after: true } } },
      ]);
    });

    it('refuses to make an Inactive entry Inactive, to reactivate an active one, or a stale version', async () => {
      const id = await inactiveEntryId();
      const again = await inactivate(id, { expected_version: 2 });
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: `The ${concept} is already Inactive` });
      const active = await entryId();
      const back = await reactivate(active, { expected_version: 1 });
      expect(back.statusCode).toBe(400);
      expect(back.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: `The ${concept} is already active` });
      const stale = await reactivate(id, { expected_version: 1 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: `The ${concept} changed since it was read`, current_values: { version: 2 } });
      expect(await listed(id)).toMatchObject({ is_active: false, version: 2 });
    });

    it('answers an identical replay with the committed result, and refuses the same token with another version', async () => {
      const id = await entryId();
      const token = crypto.randomUUID();
      const first = await inactivate(id, { expected_version: 1 }, token);
      expect((await inactivate(id, { expected_version: 1 }, token)).json()).toEqual(first.json());
      const mismatch = await inactivate(id, { expected_version: 2 }, token);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: expect.any(String) });
      expect(await listed(id)).toMatchObject({ is_active: false, version: 2 });
    });
  });

  describe('no delete (MC-16)', () => {
    it('has no way to delete an entry', async () => {
      const id = await entryId();
      for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
        const res = await api.app.inject({ method, url: `${path}/${id}`, headers: { cookie: officer.cookie, 'x-csrf-token': officer.csrf } });
        expect(res.statusCode).toBe(404);
      }
      expect((await api.post(officer, `${path}/${id}/delete`, {}, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(404);
      expect(await listed(id)).toMatchObject({ id, version: 1 });
    });
  });

  describe('permissions (Q3)', () => {
    // Each write, as the Supply Officer would send it to the entry `id` at `version`.
    const writes = [
      { name: 'rename', send: (id: string, version: number, actor: Actor) => rename(id, { expected_version: version, name: `ชื่อไม่ควรเปลี่ยน ${id.slice(0, 8)}` }, crypto.randomUUID(), actor) },
      { name: 'inactivate', send: (id: string, version: number, actor: Actor) => inactivate(id, { expected_version: version }, crypto.randomUUID(), actor) },
      { name: 'reactivate', send: (id: string, version: number, actor: Actor) => reactivate(id, { expected_version: version }, crypto.randomUUID(), actor) },
    ];

    // An entry that each write above would change: active for a rename or an Inactive, Inactive for a reactivation.
    const entryFor = async (write: string) => {
      const id = write === 'reactivate' ? await inactiveEntryId() : await entryId();
      return { id, before: await listed(id) };
    };

    it('lets material:view read the list, telling only the Supply Officer it may manage, and refuses every other role', async () => {
      const id = await entryId();
      expect((await listOf(officer)).can_manage).toBe(true);
      for (const viewer of [others[0], readonly]) {
        const list = await listOf(viewer);
        expect(list.can_manage).toBe(false);
        expect(list.items.find((entry: { id: string }) => entry.id === id)).toMatchObject({ usage_count: 0, history: [{ action: 'CREATED' }] });
      }
      for (const other of others.slice(2)) {
        const res = await api.get(other, path);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Permission denied' } });
      }
    });

    it('fails the read closed without material:view or when the lookup fails', async () => {
      expect((await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(officer, path))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(readonly, path));
      expect(failed.statusCode).toBe(500);
    });

    it('lets only the Supply Officer add an entry, and needs material:manage itself, failing closed', async () => {
      const before = (await listOf()).items.length;
      for (const other of others) {
        const res = await add({ name: `ไม่ควรเพิ่ม ${crypto.randomUUID().slice(0, 8)}` }, crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Permission denied' } });
      }
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => add({ name: 'ไม่มีสิทธิ์' }))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => add({ name: 'ค้นสิทธิ์ไม่ได้' }));
      expect(failed.statusCode).toBe(500);
      expect((await listOf()).items).toHaveLength(before);
    });

    it.each(writes)('lets only the Supply Officer $name an entry', async ({ name, send }) => {
      const { id, before } = await entryFor(name);
      for (const other of others) {
        const res = await send(id, before.version, other);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Permission denied' } });
      }
      expect(await listed(id)).toEqual(before);
    });

    it.each(writes)('needs material:manage itself to $name, and fails closed when the lookup fails, writing nothing', async ({ name, send }) => {
      const { id, before } = await entryFor(name);
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => send(id, before.version, officer))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => send(id, before.version, officer));
      expect(failed.statusCode).toBe(500);
      expect(await listed(id)).toEqual(before);
    });

    it.each([{ name: 'add' }, ...writes])('needs a session and the CSRF token to $name', async ({ name }) => {
      const { id, before } = await entryFor(name);
      const url = name === 'add' ? path : `${path}/${id}/${name}`;
      const payload = name === 'add' ? { name: `ไม่มีโทเคน CSRF ${id.slice(0, 8)}` } : name === 'rename' ? { expected_version: before.version, name: 'ไม่มีโทเคน CSRF' } : { expected_version: before.version };
      const inject = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await listed(id)).toEqual(before);
      expect((await listOf()).items.some((entry: { name: string }) => entry.name.startsWith('ไม่มีโทเคน CSRF'))).toBe(false);
    });
  });

  // Each rule a write of the entry reads under its lock, queued behind the write that changes it (CODING_STANDARDS, "A
  // rule read under a lock has a test of its order"; #232 lock-order plan rows 1–6); each test expects the version the
  // held write leaves, so that only the rule under test decides.
  describe('order of the writes of an entry', () => {
    it('renames only after a write holding the entry, and refuses the version it changed', async () => {
      const id = await entryId();
      const [res] = await whileWriting(versionHeld(table, id), () => [rename(id, { expected_version: 1, name: `ชื่อช้า ${id.slice(0, 8)}` })], () => untilWaiting(table));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: `The ${concept} changed since it was read`, current_values: { version: 2 } });
    });

    it('renames only after a rename to the same name, and then refuses it as changing nothing', async () => {
      const id = await entryId();
      const name = `ชื่อเดียวกัน ${id.slice(0, 8)}`;
      const [res] = await whileWriting(renameHeld(table, id, name), () => [rename(id, { expected_version: 2, name })], () => untilWaiting(table));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This rename changes nothing' });
    });

    it('makes an entry Inactive only after a write holding it, and refuses the version it changed', async () => {
      const id = await entryId();
      const [res] = await whileWriting(versionHeld(table, id), () => [inactivate(id, { expected_version: 1 })], () => untilWaiting(table));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: `The ${concept} changed since it was read`, current_values: { version: 2 } });
      expect(await listed(id)).toMatchObject({ is_active: true });
    });

    it('makes an entry Inactive only after another makes it Inactive, and then refuses it as already Inactive', async () => {
      const id = await entryId();
      const [res] = await whileWriting(statusHeld(table, id, false), () => [inactivate(id, { expected_version: 2 })], () => untilWaiting(table));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: `The ${concept} is already Inactive` });
    });

    it('reactivates an entry only after a write holding it, and refuses the version it changed', async () => {
      const id = await inactiveEntryId();
      const [res] = await whileWriting(versionHeld(table, id), () => [reactivate(id, { expected_version: 2 })], () => untilWaiting(table));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: `The ${concept} changed since it was read`, current_values: { version: 3 } });
      expect(await listed(id)).toMatchObject({ is_active: false });
    });

    it('reactivates an entry only after another reactivates it, and then refuses it as already active', async () => {
      const id = await inactiveEntryId();
      const [res] = await whileWriting(statusHeld(table, id, true), () => [reactivate(id, { expected_version: 3 })], () => untilWaiting(table));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: `The ${concept} is already active` });
    });
  });
});

// F010-T1 (#232 decision 1): a Source Party's optional note, of at most 2000 characters (MRC-10, P7), given when it is
// added and changed by its own write, at the version the request read, with the old and the new note in its history.
// A Source Type holds no note.
describe('Source Party note (Seam A - F010-T1)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;
  let others: Actor[];

  const add = (payload: Record<string, unknown>, path = '/source-parties', token: string = crypto.randomUUID()) => api.post(officer, path, payload, { 'x-retry-token': token });
  const changeNote = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `/source-parties/${id}/note`, payload, { 'x-retry-token': token });

  // A Source Party added with `note`, and its id.
  const partyId = async (note?: string | null): Promise<string> => {
    const res = await add({ name: `แหล่งที่มา ${crypto.randomUUID().slice(0, 8)}`, ...(note === undefined ? {} : { note }) });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  const listOf = async (path = '/source-parties') => {
    const res = await api.get(readonly, path);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const listed = async (id: string, path = '/source-parties') => (await listOf(path)).items.find((entry: { id: string }) => entry.id === id);

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_party_note', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_party_note', 'READ_ONLY');
    others = [
      await api.actor('admin_party_note', 'ADMINISTRATOR'),
      readonly,
      await api.actor('requester_party_note', 'REQUESTER'),
      await api.actor('custodian_party_note', 'ASSET_CUSTODIAN'),
      await api.actor('staff_party_note', 'VERIFICATION_STAFF'),
      await api.actor('maintainer_party_note', 'SYSTEM_MAINTAINER'),
    ];
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  it('adds a Source Party with a note, trimmed and keeping its line breaks, which the list and its CREATED history show', async () => {
    const res = await add({ name: 'สหกรณ์ออมทรัพย์', note: '  ติดต่อคุณสมใจ\nโทร 02-000-0000  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'สหกรณ์ออมทรัพย์', note: 'ติดต่อคุณสมใจ\nโทร 02-000-0000', version: 1 });

    expect(await listed(res.json().id)).toMatchObject({
      note: 'ติดต่อคุณสมใจ\nโทร 02-000-0000',
      history: [{ action: 'CREATED', changes: { name: { before: null, after: 'สหกรณ์ออมทรัพย์' }, note: { before: null, after: 'ติดต่อคุณสมใจ\nโทร 02-000-0000' }, is_active: { before: null, after: true } } }],
    });
  });

  it('adds a Source Party with no note, or a blank one, as none', async () => {
    for (const note of [undefined, null, '   ']) {
      const id = await partyId(note);
      expect(await listed(id)).toMatchObject({ note: null, history: [{ changes: { note: { before: null, after: null } } }] });
    }
  });

  it('refuses the same retry token with the same name and another note, adding nothing', async () => {
    const token = crypto.randomUUID();
    const name = `โทเคนหมายเหตุ ${crypto.randomUUID().slice(0, 8)}`;
    expect((await add({ name, note: 'หมายเหตุแรก' }, '/source-parties', token)).statusCode).toBe(201);
    const mismatch = await add({ name, note: 'หมายเหตุอื่น' }, '/source-parties', token);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: expect.any(String) });
    expect((await listOf()).items.find((entry: { name: string }) => entry.name === name)).toMatchObject({ note: 'หมายเหตุแรก', version: 1 });
  });

  it('takes a note of 2000 characters and refuses 2001, or a control character, adding nothing', async () => {
    const id = await partyId('ห'.repeat(2000));
    expect((await listed(id)).note).toHaveLength(2000);

    for (const [note, message] of [
      ['ห'.repeat(2001), 'note must be at most 2000 characters'],
      ['มีอักขระ\u0007ควบคุม', 'note must not contain control characters'],
    ]) {
      const name = `ไม่ควรเพิ่ม ${crypto.randomUUID().slice(0, 8)}`;
      const res = await add({ name, note });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
      expect((await listOf()).items.some((entry: { name: string }) => entry.name === name)).toBe(false);
    }
  });

  it('holds no note on a Source Type: its add refuses one, and its entries carry none', async () => {
    const name = `วิธีได้มา ${crypto.randomUUID().slice(0, 8)}`;
    const refused = await add({ name, note: 'ไม่มีหมายเหตุ' }, '/source-types');
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('note') });
    expect((await listOf('/source-types')).items.some((entry: { name: string }) => entry.name === name)).toBe(false);

    const res = await add({ name }, '/source-types');
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('note');
    expect(await listed(res.json().id, '/source-types')).not.toHaveProperty('note');
    // There is no such write: the route itself is not found.
    const noRoute = await api.post(officer, `/source-types/${res.json().id}/note`, { expected_version: 1, note: 'ไม่มี' }, { 'x-retry-token': crypto.randomUUID() });
    expect(noRoute.statusCode).toBe(404);
    expect(noRoute.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Requested resource not found' } });
  });

  describe('note change (แก้ไขหมายเหตุ)', () => {
    it('changes the note at the version it read, answering the entry at the next version, with the old and the new note in its history', async () => {
      const id = await partyId('หมายเหตุเดิม');
      const res = await changeNote(id, { expected_version: 1, note: '  หมายเหตุใหม่  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, note: 'หมายเหตุใหม่', is_active: true, version: 2 });

      const entry = await listed(id);
      expect(entry).toMatchObject({ note: 'หมายเหตุใหม่', version: 2 });
      expect(entry.history[1]).toMatchObject({ version: 2, action: 'CHANGED', changes: { note: { before: 'หมายเหตุเดิม', after: 'หมายเหตุใหม่' } }, actor_username: 'officer_party_note' });
      expect(Object.keys(entry.history[1].changes)).toEqual(['note']);
    });

    it('clears the note with a blank one or null, and gives a note to a Source Party that had none', async () => {
      const id = await partyId('จะถูกลบ');
      expect((await changeNote(id, { expected_version: 1, note: '  ' })).json()).toMatchObject({ note: null, version: 2 });
      expect((await changeNote(id, { expected_version: 2, note: 'กลับมาใหม่' })).json()).toMatchObject({ note: 'กลับมาใหม่', version: 3 });
      expect((await changeNote(id, { expected_version: 3, note: null })).json()).toMatchObject({ note: null, version: 4 });
      expect((await listed(id)).history.map((change: { changes: { note: unknown } }) => change.changes.note)).toEqual([
        { before: null, after: 'จะถูกลบ' },
        { before: 'จะถูกลบ', after: null },
        { before: null, after: 'กลับมาใหม่' },
        { before: 'กลับมาใหม่', after: null },
      ]);
    });

    it('changes the note of an Inactive Source Party, which stays Inactive', async () => {
      const id = await partyId();
      expect((await api.post(officer, `/source-parties/${id}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);
      expect((await changeNote(id, { expected_version: 2, note: 'หยุดใช้แล้ว' })).json()).toMatchObject({ note: 'หยุดใช้แล้ว', is_active: false, version: 3 });
    });

    it('refuses a note that does not change, a blank one for none included, recording nothing', async () => {
      const id = await partyId('เหมือนเดิม');
      for (const note of ['เหมือนเดิม', '  เหมือนเดิม ']) {
        const res = await changeNote(id, { expected_version: 1, note });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This note change changes nothing' });
      }
      const none = await partyId();
      expect((await changeNote(none, { expected_version: 1, note: ' ' })).json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This note change changes nothing' });
      expect((await listed(id)).history).toHaveLength(1);
      expect((await listed(none)).history).toHaveLength(1);
    });

    it('refuses a note of 2001 characters or with a control character, recording nothing', async () => {
      const id = await partyId('เดิม');
      for (const [note, message] of [
        ['ห'.repeat(2001), 'note must be at most 2000 characters'],
        ['มีอักขระ\u0000ควบคุม', 'note must not contain control characters'],
      ]) {
        const res = await changeNote(id, { expected_version: 1, note });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
      }
      expect(await listed(id)).toMatchObject({ note: 'เดิม', version: 1 });
    });

    it('refuses a version other than the one stored with the stale-before conflict, and needs a version and a note', async () => {
      const id = await partyId('เดิม');
      const stale = await changeNote(id, { expected_version: 2, note: 'ใหม่' });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Source Party changed since it was read', current_values: { version: 1 }, expected_values: { version: 2 } });

      for (const [payload, field] of [
        [{ note: 'ใหม่' }, 'expected_version'],
        [{ expected_version: 1 }, 'note'],
        [{ expected_version: 1, note: 'ใหม่', name: 'ไม่รับ' }, 'name'],
      ] as const) {
        const res = await changeNote(id, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
      }
      expect(await listed(id)).toMatchObject({ note: 'เดิม', version: 1 });
    });

    it('answers 404 for a Source Party not on the list and 400 for an id that is not a UUID', async () => {
      const missing = await changeNote(crypto.randomUUID(), { expected_version: 1, note: 'ใหม่' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Source Party not found' });
      const invalid = await changeNote('not-a-uuid', { expected_version: 1, note: 'ใหม่' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Source Party ID must be a valid UUID string' });
    });

    it('answers an identical replay with the committed result, and refuses the same token with another note, writing nothing', async () => {
      const id = await partyId('เดิม');
      const token = crypto.randomUUID();
      const first = await changeNote(id, { expected_version: 1, note: 'ใหม่' }, token);
      expect(first.statusCode).toBe(200);
      const replay = await changeNote(id, { expected_version: 1, note: 'ใหม่' }, token);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());

      const mismatch = await changeNote(id, { expected_version: 1, note: 'อื่น' }, token);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: expect.any(String) });
      expect(await listed(id)).toMatchObject({ note: 'ใหม่', version: 2 });
    });

    it('scopes a token to its operation: a rename and a note change under one token are each their own write', async () => {
      const id = await partyId('เดิม');
      const token = crypto.randomUUID();
      expect((await api.post(officer, `/source-parties/${id}/rename`, { expected_version: 1, name: `ชื่อโทเคนเดียว ${id.slice(0, 8)}` }, { 'x-retry-token': token })).json()).toMatchObject({ version: 2 });
      expect((await changeNote(id, { expected_version: 2, note: 'ใหม่' }, token)).json()).toMatchObject({ note: 'ใหม่', version: 3 });
    });

    it('lets only the Supply Officer change a note, needing material:manage itself and failing closed, writing nothing', async () => {
      const id = await partyId('เดิม');
      const before = await listed(id);
      for (const other of others) {
        const res = await changeNote(id, { expected_version: 1, note: 'ไม่ควรเปลี่ยน' }, crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Permission denied' } });
      }
      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => changeNote(id, { expected_version: 1, note: 'ไม่มีสิทธิ์' }))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => changeNote(id, { expected_version: 1, note: 'ค้นไม่ได้' }));
      expect(failed.statusCode).toBe(500);
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/source-parties/${id}/note`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: { expected_version: 1, note: 'ไม่มีโทเคน CSRF' },
        });
      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await listed(id)).toEqual(before);
    });

    // #232 lock-order plan rows 7 and 8.
    it('changes the note only after a write holding the Source Party, and refuses the version it changed', async () => {
      const id = await partyId('เดิม');
      const [res] = await whileWriting(versionHeld('source_parties', id), () => [changeNote(id, { expected_version: 1, note: 'ช้า' })], () => untilWaiting('source_parties'));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Source Party changed since it was read', current_values: { version: 2 } });
    });

    it('changes the note only after a change to the same note, and then refuses it as changing nothing', async () => {
      const id = await partyId('เดิม');
      const held = { sql: 'UPDATE source_parties SET note = $2, version = version + 1 WHERE id = $1', params: [id, 'เหมือนกัน'] };
      const [res] = await whileWriting(held, () => [changeNote(id, { expected_version: 2, note: 'เหมือนกัน' })], () => untilWaiting('source_parties'));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This note change changes nothing' });
    });
  });
});
