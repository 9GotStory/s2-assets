import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// A Stock Material page as the tests read it.
type MaterialPage = { units: { name: string }[]; brand: { name: string } | null; material_category: { name: string } | null; history: { changes: { field: string; after: any }[] }[] };

// F008-T8 (#183): keeping the Unit, Brand and Material Category lists on the maintenance page "ยี่ห้อ หมวดวัสดุ และ
// หน่วยนับ": a Supply Officer renames an entry to normalize its spelling, or makes it Inactive and reactivates it; nothing
// is deleted, merged or aliased (#175 MC-12, MC-26, Q19, Q20, Q21, Q23, P5, P6).
describe.each([
  {
    concept: 'Unit',
    path: '/units',
    table: 'units' as const,
    // A Stock Material naming the entry, its Base Unit here.
    use: (id: string) => ({ base_unit: { unit_id: id } }),
    // The entry's name as the Stock Material page shows it now, and as its CREATED history entry recorded it.
    shownOn: (page: MaterialPage) => page.units[0].name,
    recordedOn: (page: MaterialPage) => page.history[0].changes.find(({ field }) => field === 'units')!.after[0].name,
  },
  {
    concept: 'Brand',
    path: '/brands',
    table: 'brands' as const,
    use: (id: string) => ({ brand_id: id }),
    shownOn: (page: MaterialPage) => page.brand!.name,
    recordedOn: (page: MaterialPage) => page.history[0].changes.find(({ field }) => field === 'brand')!.after.name,
  },
  {
    concept: 'Material Category',
    path: '/material-categories',
    table: 'material_categories' as const,
    use: (id: string) => ({ material_category_id: id }),
    shownOn: (page: MaterialPage) => page.material_category!.name,
    recordedOn: (page: MaterialPage) => page.history[0].changes.find(({ field }) => field === 'material_category')!.after.name,
  },
])('$concept list maintenance (Seam A - F008-T8)', ({ path, table, use, shownOn, recordedOn }) => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;
  let others: Actor[];

  const { created, createMaterial, materialOf, unitNamed, replaceUnits, unitsAsRead } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // What a rename, a reactivation and another write of the entry commit (F008-T8), to hold uncommitted.
  const renameHeld = (id: string, name: string) => ({ sql: `UPDATE ${table} SET name = $2, version = version + 1 WHERE id = $1`, params: [id, name] });
  const statusHeld = (id: string, isActive: boolean) => ({ sql: `UPDATE ${table} SET is_active = $2, version = version + 1 WHERE id = $1`, params: [id, isActive] });
  const versionHeld = (id: string) => ({ sql: `UPDATE ${table} SET version = version + 1 WHERE id = $1`, params: [id] });

  // A new Stock Material naming the entry, confirming any Duplicate Candidate.
  const createUsing = async (id: string) =>
    createMaterial({ name: `วัสดุ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: await unitNamed() }, explicit_continuation: true, ...use(id) });

  const addEntry = (name: string, token: string = crypto.randomUUID(), actor: Actor = officer) => api.post(actor, path, { name }, { 'x-retry-token': token });

  // An entry added to the list, named `name` or uniquely, and its id.
  const entryId = async (name: string = `รายการ ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await addEntry(name);
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  const rename = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `${path}/${id}/rename`, payload, { 'x-retry-token': token });
  const inactivate = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `${path}/${id}/inactivate`, payload, { 'x-retry-token': token });
  const reactivate = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = officer) =>
    api.post(actor, `${path}/${id}/reactivate`, payload, { 'x-retry-token': token });

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
    officer = await api.actor('officer_upkeep', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_upkeep', 'READ_ONLY');
    others = [
      await api.actor('admin_upkeep', 'ADMINISTRATOR'),
      readonly,
      await api.actor('custodian_upkeep', 'ASSET_CUSTODIAN'),
      await api.actor('staff_upkeep', 'VERIFICATION_STAFF'),
      await api.actor('maintainer_upkeep', 'SYSTEM_MAINTAINER'),
    ];
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('rename (MC-12, Q19)', () => {
    it('renames an entry at the version it read, answering it at the next version, and the list shows the new name', async () => {
      const id = await entryId('กระดาษสะกดผิด');

      const res = await rename(id, { expected_version: 1, name: '  กระดาษสะกดถูก ' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, name: 'กระดาษสะกดถูก', is_active: true, version: 2 });
      expect(await listed(id)).toMatchObject({ name: 'กระดาษสะกดถูก', is_active: true, version: 2 });
    });

    it('shows the new name on every Stock Material using the entry, whose history keeps the name as it was recorded (P6)', async () => {
      const id = await entryId('ชื่อเดิม');
      const material = await created(use(id));

      expect((await rename(id, { expected_version: 1, name: 'ชื่อใหม่' })).statusCode).toBe(200);

      const page = await materialOf(material);
      expect(shownOn(page)).toBe('ชื่อใหม่');
      expect(recordedOn(page)).toBe('ชื่อเดิม');
      expect(page.history).toHaveLength(1);
    });

    it('takes a change of case or spaces alone, which normalizes the spelling', async () => {
      const id = await entryId('a4 paper');

      const res = await rename(id, { expected_version: 1, name: 'A4 Paper' });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('A4 Paper');
    });

    it('refuses a name that another entry of the list holds, ignoring case and repeated spaces, answering with that entry (Q20)', async () => {
      const holder = await entryId('ชื่อที่มีอยู่');
      const id = await entryId('ชื่อที่จะเปลี่ยน');

      const res = await rename(id, { expected_version: 1, name: '  ชื่อที่มีอยู่ ' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id: holder, name: 'ชื่อที่มีอยู่', is_active: true, version: 1 } });
      expect(await listed(id)).toMatchObject({ name: 'ชื่อที่จะเปลี่ยน', version: 1 });
    });

    it('refuses a rename to the very same name, which changes nothing (#183 decision 2)', async () => {
      const id = await entryId('ชื่อคงเดิม');

      const res = await rename(id, { expected_version: 1, name: ' ชื่อคงเดิม ' });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('This rename changes nothing');
      expect(await listed(id)).toMatchObject({ version: 1 });
    });

    it('refuses a version other than the one stored with the stale-before conflict (Q23)', async () => {
      const id = await entryId('ชื่อก่อนเปลี่ยน');
      expect((await rename(id, { expected_version: 1, name: 'ชื่อรอบแรก' })).statusCode).toBe(200);

      const res = await rename(id, { expected_version: 1, name: 'ชื่อรอบสอง' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await listed(id)).toMatchObject({ name: 'ชื่อรอบแรก', version: 2 });
    });

    it('needs an expected version', async () => {
      const id = await entryId('ชื่อไม่มีรุ่น');

      const res = await rename(id, { name: 'ชื่อใหม่ไม่มีรุ่น' });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('expected_version');
      expect(await listed(id)).toMatchObject({ name: 'ชื่อไม่มีรุ่น' });
    });

    it('answers 404 for an entry not on the list and 400 for an id that is not a UUID', async () => {
      const missing = await rename(crypto.randomUUID(), { expected_version: 1, name: 'ไม่มี' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');

      const malformed = await rename('not-a-uuid', { expected_version: 1, name: 'ไม่มี' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe('INVALID_ID');
    });

    it('answers 404 for an entry of another list', async () => {
      const other = path === '/units' ? '/brands' : '/units';
      const res = await api.post(officer, other, { name: `อีกรายการ ${crypto.randomUUID().slice(0, 8)}` }, { 'x-retry-token': crypto.randomUUID() });
      expect(res.statusCode).toBe(201);

      expect((await rename(res.json().id, { expected_version: 1, name: 'ข้ามรายการ' })).statusCode).toBe(404);
    });
  });

  describe('the list (P5)', () => {
    it('tells how many Stock Materials use each entry, Inactive Stock Materials included (#183 decision 3)', async () => {
      const id = await entryId();
      const unused = await entryId();
      await created(use(id));
      const inactive = await created(use(id));
      expect((await api.post(officer, `/stock-materials/${inactive}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);

      expect(await listed(id)).toMatchObject({ usage_count: 2 });
      expect(await listed(unused)).toMatchObject({ usage_count: 0 });
    });

    it.runIf(path === '/units')('counts a Unit used as a Base Unit or as an Alternate Unit, an Inactive one included', async () => {
      const id = await entryId();
      await created(use(id));
      const material = await created({ alternate_units: [{ unit_id: id, conversion_factor: '5' }] });
      const page = await materialOf(material);
      const payload = unitsAsRead(page);
      expect((await replaceUnits(material, { ...payload, alternate_units: [{ ...payload.alternate_units[0], is_active: false }] })).statusCode).toBe(200);

      expect(await listed(id)).toMatchObject({ usage_count: 2 });
    });

    it('keeps the old and the new name of a rename, and each status change, in the entry history, with who made them (P6)', async () => {
      const id = await entryId('ชื่อแรกเริ่ม');
      expect((await rename(id, { expected_version: 1, name: 'ชื่อที่แก้แล้ว' })).statusCode).toBe(200);
      expect((await inactivate(id, { expected_version: 2 })).statusCode).toBe(200);
      expect((await reactivate(id, { expected_version: 3 })).statusCode).toBe(200);

      const { history } = await listed(id);

      expect(history).toEqual([
        { version: 1, action: 'CREATED', changes: { name: { before: null, after: 'ชื่อแรกเริ่ม' }, is_active: { before: null, after: true } }, actor_id: officer.id, actor_username: 'officer_upkeep', recorded_at: expect.any(String) },
        { version: 2, action: 'CHANGED', changes: { name: { before: 'ชื่อแรกเริ่ม', after: 'ชื่อที่แก้แล้ว' } }, actor_id: officer.id, actor_username: 'officer_upkeep', recorded_at: expect.any(String) },
        { version: 3, action: 'CHANGED', changes: { is_active: { before: true, after: false } }, actor_id: officer.id, actor_username: 'officer_upkeep', recorded_at: expect.any(String) },
        { version: 4, action: 'CHANGED', changes: { is_active: { before: false, after: true } }, actor_id: officer.id, actor_username: 'officer_upkeep', recorded_at: expect.any(String) },
      ]);
      expect(new Date(history[3].recorded_at).getTime()).toBeGreaterThanOrEqual(new Date(history[0].recorded_at).getTime());
    });

    it('records no history for a refused write', async () => {
      const id = await entryId('ชื่อที่ถูกปฏิเสธ');
      expect((await rename(id, { expected_version: 1, name: 'ชื่อที่ถูกปฏิเสธ' })).statusCode).toBe(400);
      expect((await reactivate(id, { expected_version: 1 })).statusCode).toBe(400);

      expect((await listed(id)).history).toHaveLength(1);
    });
  });

  describe('Inactive and reactivate (Q20, Q21)', () => {
    it('makes an entry Inactive and reactivates it as the same entry, each at the version it read, deleting nothing', async () => {
      const id = await entryId('รายการหยุดใช้');

      const inactivated = await inactivate(id, { expected_version: 1 });
      expect(inactivated.statusCode).toBe(200);
      expect(inactivated.json()).toEqual({ id, name: 'รายการหยุดใช้', is_active: false, version: 2 });
      expect(await listed(id)).toMatchObject({ name: 'รายการหยุดใช้', is_active: false, version: 2 });

      const reactivated = await reactivate(id, { expected_version: 2 });
      expect(reactivated.statusCode).toBe(200);
      expect(reactivated.json()).toEqual({ id, name: 'รายการหยุดใช้', is_active: true, version: 3 });
      expect(await listed(id)).toMatchObject({ is_active: true, version: 3 });
    });

    it('refuses to make an Inactive entry Inactive, or to reactivate an active one (#183 decision 2)', async () => {
      const id = await inactiveEntryId();

      const again = await inactivate(id, { expected_version: 2 });
      expect(again.statusCode).toBe(400);
      expect(again.json().message).toMatch(/^The \w+( \w+)? is already Inactive$/);

      expect((await reactivate(id, { expected_version: 2 })).statusCode).toBe(200);
      const active = await reactivate(id, { expected_version: 3 });
      expect(active.statusCode).toBe(400);
      expect(active.json().message).toMatch(/^The \w+( \w+)? is already active$/);
      expect(await listed(id)).toMatchObject({ is_active: true, version: 3 });
    });

    it('refuses a version other than the one stored with the stale-before conflict, either way (Q23)', async () => {
      const id = await entryId();
      expect((await rename(id, { expected_version: 1, name: `เปลี่ยนแล้ว ${crypto.randomUUID().slice(0, 8)}` })).statusCode).toBe(200);

      const stale = await inactivate(id, { expected_version: 1 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await listed(id)).toMatchObject({ is_active: true, version: 2 });

      expect((await inactivate(id, { expected_version: 2 })).statusCode).toBe(200);
      const staleBack = await reactivate(id, { expected_version: 2 });
      expect(staleBack.statusCode).toBe(409);
      expect(staleBack.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 3 }, expected_values: { version: 2 } });
      expect(await listed(id)).toMatchObject({ is_active: false, version: 3 });
    });

    it('needs an expected version and takes nothing else', async () => {
      const id = await entryId();

      for (const write of [inactivate, reactivate]) {
        const res = await write(id, {});
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('expected_version');
      }
      const named = await inactivate(id, { expected_version: 1, name: 'แอบเปลี่ยนชื่อ' });
      expect(named.statusCode).toBe(400);
      expect(named.json().message).toContain('name');
      expect(await listed(id)).toMatchObject({ is_active: true, version: 1 });
    });

    it('answers 404 for an entry not on the list', async () => {
      expect((await inactivate(crypto.randomUUID(), { expected_version: 1 })).statusCode).toBe(404);
      expect((await reactivate(crypto.randomUUID(), { expected_version: 1 })).statusCode).toBe(404);
      expect((await inactivate('not-a-uuid', { expected_version: 1 })).json().code).toBe('INVALID_ID');
      expect((await reactivate('not-a-uuid', { expected_version: 1 })).json().code).toBe('INVALID_ID');
    });

    it('refuses adding a name that matches an Inactive entry, answering with that entry so that it can be reactivated', async () => {
      const id = await inactiveEntryId('ชื่อที่หยุดใช้');

      const res = await addEntry('  ชื่อที่หยุดใช้ ');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id, name: 'ชื่อที่หยุดใช้', is_active: false, version: 2 } });
    });

    it('refuses renaming to the name of an Inactive entry, answering with that entry', async () => {
      const holder = await inactiveEntryId('ชื่อหยุดใช้ที่ถือไว้');
      const id = await entryId();

      const res = await rename(id, { expected_version: 1, name: 'ชื่อหยุดใช้ที่ถือไว้' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_NAME', entry: { id: holder, is_active: false } });
    });

    it('keeps an Inactive entry on, and showing on, every Stock Material using it, but refuses it for a new choice (Q21)', async () => {
      const id = await entryId('รายการที่ยังใช้อยู่');
      const material = await created(use(id));

      expect((await inactivate(id, { expected_version: 1 })).statusCode).toBe(200);

      expect(shownOn(await materialOf(material))).toBe('รายการที่ยังใช้อยู่');
      const refused = await createUsing(id);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toMatch(/must name an active/);

      expect((await reactivate(id, { expected_version: 2 })).statusCode).toBe(200);
      const taken = await createUsing(id);
      expect(taken.statusCode).toBe(201);
    });

    it('answers an identical replay with the committed result, and refuses the same token with another version', async () => {
      const id = await entryId();
      const token = crypto.randomUUID();
      const first = await inactivate(id, { expected_version: 1 }, token);
      expect(first.statusCode).toBe(200);

      const replay = await inactivate(id, { expected_version: 1 }, token);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());

      const mismatch = await inactivate(id, { expected_version: 2 }, token);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');

      const back = crypto.randomUUID();
      const reactivated = await reactivate(id, { expected_version: 2 }, back);
      expect(reactivated.statusCode).toBe(200);
      expect((await reactivate(id, { expected_version: 2 }, back)).json()).toEqual(reactivated.json());
      expect((await reactivate(id, { expected_version: 3 }, back)).json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await listed(id)).toMatchObject({ is_active: true, version: 3 });
    });
  });

  // Each rule a write of the entry reads under its lock, queued behind the write that changes it (CODING_STANDARDS, "A
  // rule read under a lock has a test of its order"); each test expects the version the held write leaves, so that only
  // the rule under test decides.
  describe('order of the writes of an entry', () => {
    it('renames only after a write holding the entry, and refuses the version it changed', async () => {
      const id = await entryId();

      const [res] = await whileWriting(versionHeld(id), () => [rename(id, { expected_version: 1, name: `ชื่อช้า ${crypto.randomUUID().slice(0, 8)}` })], () => untilWaiting(table));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 } });
    });

    it('renames only after a rename to the same name, and then refuses it as changing nothing', async () => {
      const id = await entryId();
      const name = `ชื่อเดียวกัน ${crypto.randomUUID().slice(0, 8)}`;

      const [res] = await whileWriting(renameHeld(id, name), () => [rename(id, { expected_version: 2, name })], () => untilWaiting(table));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('This rename changes nothing');
    });

    it('makes an entry Inactive only after a write holding it, and refuses the version it changed', async () => {
      const id = await entryId();

      const [res] = await whileWriting(versionHeld(id), () => [inactivate(id, { expected_version: 1 })], () => untilWaiting(table));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 } });
      expect(await listed(id)).toMatchObject({ is_active: true });
    });

    it('makes an entry Inactive only after another makes it Inactive, and then refuses it as already Inactive', async () => {
      const id = await entryId();

      const [res] = await whileWriting(statusHeld(id, false), () => [inactivate(id, { expected_version: 2 })], () => untilWaiting(table));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/is already Inactive$/);
    });

    it('reactivates an entry only after a write holding it, and refuses the version it changed', async () => {
      const id = await inactiveEntryId();

      const [res] = await whileWriting(versionHeld(id), () => [reactivate(id, { expected_version: 2 })], () => untilWaiting(table));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 3 } });
      expect(await listed(id)).toMatchObject({ is_active: false });
    });

    it('reactivates an entry only after another reactivates it, and then refuses it as already active', async () => {
      const id = await inactiveEntryId();

      const [res] = await whileWriting(statusHeld(id, true), () => [reactivate(id, { expected_version: 3 })], () => untilWaiting(table));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/is already active$/);
    });
  });

  // A Stock Material write reads the entries it names under a share lock: whether a new choice is active (Q21), and the
  // name its history records (P6). A rename and a reactivation change those facts, so each waits for them (#183
  // carry-over from #179, comment on #183).
  describe('order of a Stock Material write against the entry', () => {
    it('waits for the entry a new Stock Material names being renamed, and records the new name (P6)', async () => {
      const id = await entryId('ชื่อก่อนแก้');

      const [res] = await whileWriting(renameHeld(id, 'ชื่อหลังแก้'), () => [createUsing(id)], () => untilWaiting(table, 1, 'FOR SHARE'));

      expect(res.statusCode).toBe(201);
      expect(recordedOn(await materialOf(res.json().stock_material_id))).toBe('ชื่อหลังแก้');
    });

    it('waits for an Inactive entry a new Stock Material names being reactivated, and then takes it (Q21)', async () => {
      const id = await inactiveEntryId();

      const [res] = await whileWriting(statusHeld(id, true), () => [createUsing(id)], () => untilWaiting(table, 1, 'FOR SHARE'));

      expect(res.statusCode).toBe(201);
    });
  });

  describe('permissions (Q1)', () => {
    // Each write of an existing entry, as the Supply Officer would send it to the entry `id` at version 1.
    const writes = [
      { name: 'rename', send: (id: string, actor: Actor) => rename(id, { expected_version: 1, name: `ชื่อไม่ควรเปลี่ยน ${id.slice(0, 8)}` }, crypto.randomUUID(), actor) },
      { name: 'inactivate', send: (id: string, actor: Actor) => inactivate(id, { expected_version: 1 }, crypto.randomUUID(), actor) },
      { name: 'reactivate', send: (id: string, actor: Actor) => reactivate(id, { expected_version: 1 }, crypto.randomUUID(), actor) },
    ];

    // An entry that each write above would change: active for a rename or an Inactive, Inactive for a reactivation.
    const entryFor = async (write: string) => {
      const id = await entryId();
      if (write === 'reactivate') {
        await api.pool.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [id]);
      }
      return { id, before: await listed(id) };
    };

    it.each(writes)('lets only the Supply Officer $name an entry', async ({ name, send }) => {
      const { id, before } = await entryFor(name);
      for (const other of others) {
        const res = await send(id, other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await listed(id)).toEqual(before);
    });

    // The Supply Officer holds material:view too, so a gate on it would let the write through.
    it.each(writes)('needs material:manage itself to $name, and fails closed when the lookup fails, writing nothing', async ({ name, send }) => {
      const { id, before } = await entryFor(name);

      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => send(id, officer))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => send(id, officer));
      expect(failed.statusCode).toBe(500);
      expect(await listed(id)).toEqual(before);
    });

    it.each(writes)('needs a session and the CSRF token to $name', async ({ name }) => {
      const { id, before } = await entryFor(name);
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `${path}/${id}/${name}`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: name === 'rename' ? { expected_version: 1, name: 'ไม่มีโทเคน CSRF' } : { expected_version: 1 },
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await listed(id)).toEqual(before);
    });

    it('shows every viewer the usage count and the history, and tells only the Supply Officer it may manage', async () => {
      const id = await entryId();
      expect((await listOf(officer)).can_manage).toBe(true);
      for (const viewer of [others[0], readonly]) {
        const list = await listOf(viewer);
        expect(list.can_manage).toBe(false);
        expect(list.items.find((entry: { id: string }) => entry.id === id)).toMatchObject({ usage_count: 0, history: [{ action: 'CREATED' }] });
      }
    });
  });

  describe('the new name (P7)', () => {
    it('needs a name that is not blank', async () => {
      const id = await entryId();

      const res = await rename(id, { expected_version: 1, name: '   ' });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('name must not be blank');
    });

    it('takes 200 characters and refuses 201', async () => {
      const id = await entryId();
      const refused = await rename(id, { expected_version: 1, name: 'ย'.repeat(201) });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toBe('name must be at most 200 characters');

      expect((await rename(id, { expected_version: 1, name: 'ห'.repeat(200) })).statusCode).toBe(200);
    });

    it('refuses a control character, a line break at its end included', async () => {
      const id = await entryId();

      const res = await rename(id, { expected_version: 1, name: 'ชื่อ\n' });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('name must not contain control characters');
      expect(await listed(id)).toMatchObject({ version: 1 });
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const id = await entryId();

      const res = await api.post(officer, `${path}/${id}/rename`, { expected_version: 1, name: 'ไม่มีโทเคน' });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('retry token');
      expect(await listed(id)).toMatchObject({ version: 1 });
    });

    it('answers an identical replay of a rename with the committed result and writes nothing', async () => {
      const id = await entryId();
      const token = crypto.randomUUID();
      const first = await rename(id, { expected_version: 1, name: 'ชื่อซ้ำส่ง' }, token);
      expect(first.statusCode).toBe(200);

      const replay = await rename(id, { expected_version: 1, name: 'ชื่อซ้ำส่ง' }, token);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await listed(id)).toMatchObject({ version: 2 });
    });

    it('refuses the same token with a changed name, and writes nothing', async () => {
      const id = await entryId();
      const token = crypto.randomUUID();
      expect((await rename(id, { expected_version: 1, name: 'ชื่อแรก' }, token)).statusCode).toBe(200);

      const res = await rename(id, { expected_version: 1, name: 'ชื่อที่สอง' }, token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await listed(id)).toMatchObject({ name: 'ชื่อแรก', version: 2 });
    });
  });
});

// F008-T8 (#183): the Stock Material writes that name a list entry of their own kind, each queued behind a rename or a
// reactivation of it: the Units write, for a Unit it keeps as well as one it adds (#183 carry-over from #179), the
// details write for the Material Category it chooses, and a Material Correction for the Brand it chooses. A held
// Inactive is tested beside each write (F008-T1, T3, T4, T5).
describe('Stock Material writes queued behind a rename or a reactivation (Seam A - F008-T8)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;

  const { created, materialOf, unitNamed, brandNamed, materialCategoryNamed, replaceUnits, unitsAsRead, changeDetails, correct } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // What a rename and a reactivation commit (F008-T8), to hold uncommitted.
  const renameHeld = (table: string, id: string, name: string) => ({ sql: `UPDATE ${table} SET name = $2, version = version + 1 WHERE id = $1`, params: [id, name] });
  const reactivationHeld = (table: string, id: string) => ({ sql: `UPDATE ${table} SET is_active = true, version = version + 1 WHERE id = $1`, params: [id] });

  // An entry of the list at `path` made Inactive through the API.
  const inactivated = async (path: string, id: string) => {
    expect((await api.post(officer, `${path}/${id}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);
    return id;
  };

  // The Units of a Stock Material with an Alternate Unit added, as a Units write states them.
  const withAlternate = (page: Parameters<typeof unitsAsRead>[0], unitId: string) => {
    const payload = unitsAsRead(page);
    return { ...payload, alternate_units: [...payload.alternate_units, { unit_id: unitId, conversion_factor: '5', whole_number_only: true, is_active: true }] };
  };

  // The names the Units write recorded, before and after.
  const unitsRecorded = (page: { history: { changes: { field: string; before: any; after: any }[] }[] }) => {
    const units = page.history[1].changes.find(({ field }) => field === 'units')!;
    return { before: units.before.map(({ name }: { name: string }) => name), after: units.after.map(({ name }: { name: string }) => name) };
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_upkeep_order', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_upkeep_order', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  it('a Units write waits for a Unit it keeps being renamed, and records the new name before and after (P6)', async () => {
    const kept = await unitNamed('กล่องสะกดผิด');
    const page = await materialOf(await created({ alternate_units: [{ unit_id: kept, conversion_factor: '5' }] }));
    const payload = unitsAsRead(page);

    const [res] = await whileWriting(
      renameHeld('units', kept, 'กล่องสะกดถูก'),
      () => [replaceUnits(page.id, { ...payload, alternate_units: [{ ...payload.alternate_units[0], conversion_factor: '6' }] })],
      () => untilWaiting('units', 1, 'FOR SHARE')
    );

    expect(res.statusCode).toBe(200);
    const recorded = unitsRecorded(await materialOf(page.id));
    expect(recorded.before).toContain('กล่องสะกดถูก');
    expect(recorded.after).toContain('กล่องสะกดถูก');
  });

  it('a Units write waits for a Unit it adds being renamed, and records the new name (P6)', async () => {
    const added = await unitNamed(`ถุงสะกดผิด ${crypto.randomUUID().slice(0, 8)}`);
    const page = await materialOf(await created());

    const [res] = await whileWriting(renameHeld('units', added, 'ถุงสะกดถูก'), () => [replaceUnits(page.id, withAlternate(page, added))], () => untilWaiting('units', 1, 'FOR SHARE'));

    expect(res.statusCode).toBe(200);
    expect(unitsRecorded(await materialOf(page.id)).after).toContain('ถุงสะกดถูก');
  });

  it('a Units write waits for an Inactive Unit it adds being reactivated, and then takes it (Q21)', async () => {
    const added = await inactivated('/units', await unitNamed());
    const page = await materialOf(await created());

    const [res] = await whileWriting(reactivationHeld('units', added), () => [replaceUnits(page.id, withAlternate(page, added))], () => untilWaiting('units', 1, 'FOR SHARE'));

    expect(res.statusCode).toBe(200);
  });

  it('a details write waits for the Material Category it chooses being renamed, and records the new name (P6)', async () => {
    const chosen = await materialCategoryNamed(`หมวดสะกดผิด ${crypto.randomUUID().slice(0, 8)}`);
    const page = await materialOf(await created());

    const [res] = await whileWriting(
      renameHeld('material_categories', chosen, 'หมวดสะกดถูก'),
      () => [changeDetails(page.id, { expected_version: 1, material_category_id: chosen, note: null, minimum_stock: null })],
      () => untilWaiting('material_categories', 1, 'FOR SHARE')
    );

    expect(res.statusCode).toBe(200);
    expect((await materialOf(page.id)).history[1].changes).toEqual([{ field: 'material_category', before: null, after: { id: chosen, name: 'หมวดสะกดถูก' } }]);
  });

  it('a details write waits for an Inactive Material Category it chooses being reactivated, and then takes it (Q21)', async () => {
    const chosen = await inactivated('/material-categories', await materialCategoryNamed());
    const page = await materialOf(await created());

    const [res] = await whileWriting(
      reactivationHeld('material_categories', chosen),
      () => [changeDetails(page.id, { expected_version: 1, material_category_id: chosen, note: null, minimum_stock: null })],
      () => untilWaiting('material_categories', 1, 'FOR SHARE')
    );

    expect(res.statusCode).toBe(200);
  });

  it('a Material Correction waits for an Inactive Brand it chooses being reactivated, and then takes it (Q21)', async () => {
    const chosen = await inactivated('/brands', await brandNamed());
    const page = await materialOf(await created());

    const [res] = await whileWriting(
      reactivationHeld('brands', chosen),
      () => [correct(page.id, { expected_version: 1, name: page.name, brand_id: chosen, model: null, specification: null, reason: 'ระบุยี่ห้อที่ถูกต้อง', explicit_continuation: true })],
      () => untilWaiting('brands', 1, 'FOR SHARE')
    );

    expect(res.statusCode).toBe(200);
  });
});
