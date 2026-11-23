import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialRequestHelpers } from './support/material-request-helpers.ts';
import { requestableMaterialHelpers } from './support/requestable-material-helpers.ts';

// F009-T8 (#210): renaming a Requestable Material (เปลี่ยนชื่อ) to fix its spelling, and changing its Other Details
// (แก้ไขข้อมูลอื่น): the description, the whole-number setting and the Request Unit (#202 MRQ-30, Q6, Q17, P2).
describe('Rename and Other Details of a Requestable Material (Seam A - F009-T8)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let readonly: Actor;
  let requester: Actor;
  let admin: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit the Requestable Materials here are asked for in.
  let ream: string;

  const helpers = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, materialOf, replaceUnits, unitsAsRead } = helpers;
  const { requestableIn, requestableOf, add, end, inactivate, rename, changeDetails } = requestableMaterialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileHolding, whileWriting, untilWaiting } = lockHelpers(() => ({ api }));
  const { offered, created, createRequest, item, requestOf, cancelRequest } = materialRequestHelpers(() => ({ api, requester, officer, reader: readonly, requestUnit: ream }));

  // A Stock Material whose Base Unit is a Unit of its own and whose Alternate Units are `alternates`, each active at a
  // factor of 500, named `name` when given; its id.
  const stockMaterialWith = async (alternates: string[], name?: string): Promise<string> => {
    const id = await helpers.created(name ? { name } : {});
    const res = await replaceUnits(id, {
      ...unitsAsRead(await materialOf(id)),
      alternate_units: alternates.map((unit_id) => ({ unit_id, conversion_factor: '500', whole_number_only: true, is_active: true })),
    });
    expect(res.statusCode).toBe(200);
    return id;
  };

  // A Requestable Material asked for in รีม whose current Compatible Stock Materials are `stockMaterials`; its id.
  const compatibleWith = async (...stockMaterials: string[]): Promise<string> => {
    const id = await fresh();
    for (const stockMaterial of stockMaterials) {
      expect((await add(id, stockMaterial)).statusCode).toBe(200);
    }
    return id;
  };

  // A refused Rename to `name`: `statusCode` with `body`, the page left as it was.
  const expectRenameRefused = async (id: string, name: string, statusCode: number, body: Record<string, unknown>) => {
    const before = await requestableOf(id);
    const res = await rename(id, name, { version: before.version });
    expect(res.statusCode).toBe(statusCode);
    expect(res.json()).toMatchObject(body);
    expect(await requestableOf(id)).toEqual(before);
  };

  // A refused Other Details change: 400 with Feature 002's validation shape and `message`, the page left as it was.
  const expectDetailsRefused = async (id: string, changes: Parameters<typeof changeDetails>[1], message: unknown) => {
    const before = await requestableOf(id);
    const res = await changeDetails(id, changes);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
    expect(await requestableOf(id)).toEqual(before);
  };

  // A Requestable Material named uniquely, with `tag` in its name when given.
  const fresh = async (tag = crypto.randomUUID().slice(0, 8)) => requestableIn(ream, `กระดาษเปลี่ยนชื่อ ${tag}`);

  // The page without what a write moves: its name, version and history.
  const unchangedOf = ({ name: _n, version: _v, history: _h, ...rest }: any) => rest;

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_rm_rename', 'SUPPLY_OFFICER');
    readonly = await api.actor('readonly_rm_rename', 'READ_ONLY');
    requester = await api.actor('requester_rm_rename', 'REQUESTER');
    admin = await api.actor('admin_rm_rename', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_rm_rename', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_rm_rename', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_rm_rename', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('Rename (Q6, Q17)', () => {
    it('renames the Requestable Material at its next version, with the old and new names in its history, changing nothing else', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const id = await fresh(tag);
      const before = await requestableOf(id);

      const res = await rename(id, `  กระดาษถ่ายเอกสาร ${tag} `, { version: before.version });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: id, version: before.version + 1 });
      const after = await requestableOf(id);
      expect(after.name).toBe(`กระดาษถ่ายเอกสาร ${tag}`);
      expect(unchangedOf(after)).toEqual(unchangedOf(before));
      expect(after.history.slice(0, -1)).toEqual(before.history);
      expect(after.history.at(-1)).toMatchObject({
        version: before.version + 1,
        kind: 'RENAMED',
        changes: [{ field: 'name', before: `กระดาษเปลี่ยนชื่อ ${tag}`, after: `กระดาษถ่ายเอกสาร ${tag}` }],
        recorded_by: officer.id,
        recorded_by_username: 'officer_rm_rename',
      });
    });

    it('takes a change of case or spaces alone as a Rename, and refuses the very same name as changing nothing (#183 decision 2)', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const id = await requestableIn(ream, `Paper  Clip ${tag}`);

      expect((await rename(id, `paper clip ${tag}`)).statusCode).toBe(200);
      expect((await requestableOf(id)).name).toBe(`paper clip ${tag}`);
      await expectRenameRefused(id, ` paper clip ${tag}  `, 400, { code: 'VALIDATION_FAILED', message: 'This Rename changes nothing' });
    });

    it('takes a name of 200 characters, and refuses a blank name, one of 201 and any control character', async () => {
      const id = await fresh();
      expect((await rename(id, `${'ก'.repeat(191)}${crypto.randomUUID().slice(0, 9)}`)).statusCode).toBe(200);

      for (const [name, message] of [
        ['   ', 'name must not be blank'],
        ['ก'.repeat(201), 'name must be at most 200'],
        ['กระดาษ\tA4', 'name must not contain control characters'],
        ['กระดาษ A4\n', 'name must not contain control characters'],
      ]) {
        await expectRenameRefused(id, name, 400, { code: 'VALIDATION_FAILED', message: expect.stringContaining(message) });
      }
    });

    it('refuses a name another Requestable Material holds after ignoring case and repeated spaces, an Inactive one included, naming it', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const holder = await requestableIn(ream, `ลวดเย็บ  ${tag}`);
      const retired = await requestableIn(ream, `ซองเลิกใช้ ${tag}`);
      expect((await inactivate(retired)).statusCode).toBe(200);
      const id = await fresh();

      await expectRenameRefused(id, `  ลวดเย็บ ${tag.toUpperCase()} `, 409, { code: 'DUPLICATE_NAME', message: 'A Requestable Material with this name already exists', entry: { id: holder, name: `ลวดเย็บ  ${tag}`, is_active: true, version: 1 } });
      await expectRenameRefused(id, `ซองเลิกใช้ ${tag}`, 409, { code: 'DUPLICATE_NAME', message: 'A Requestable Material with this name already exists', entry: { id: retired, is_active: false, version: 2 } });
    });

    it('of a Rename and a create of one name at once, saves one and refuses the other naming it', async () => {
      const name = `หมึกพิมพ์ ${crypto.randomUUID().slice(0, 8)}`;
      const id = await fresh();

      const [renamed, createdRes] = await Promise.all([
        rename(id, name, { version: 1 }),
        api.post(officer, '/requestable-materials', { name: name.toUpperCase(), request_unit_id: ream }, { 'x-retry-token': crypto.randomUUID() }),
      ]);

      expect([[200, 409], [409, 201]]).toContainEqual([renamed.statusCode, createdRes.statusCode]);
      if (renamed.statusCode === 200) {
        expect(createdRes.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: 'A Requestable Material with this name already exists', entry: { id } });
      } else {
        expect(renamed.json()).toMatchObject({ code: 'DUPLICATE_NAME', message: 'A Requestable Material with this name already exists', entry: { id: createdRes.json().requestable_material_id } });
      }
    });
  });

  describe('every write (Q17)', () => {
    // Each write of this ticket: a Rename to a new name and an Other Details change of the description.
    const writes = [
      ['Rename', (id: string, options: { version?: number; token?: string; actor?: Actor } = {}) => rename(id, `ชื่อใหม่ ${crypto.randomUUID().slice(0, 8)}`, options)],
      // Sent as stated, so that it needs no page of the Requestable Material.
      [
        'Other Details change',
        (id: string, { version = 1, token = crypto.randomUUID(), actor = officer }: { version?: number; token?: string; actor?: Actor } = {}) =>
          api.put(actor, `/requestable-materials/${id}/details`, { expected_version: version, description: `รายละเอียด ${crypto.randomUUID().slice(0, 8)}`, whole_number_only: true, request_unit_id: ream }, { 'x-retry-token': token }),
      ],
    ] as const;

    it.each(writes)('%s: refuses a stale version with the version the Requestable Material is at, writing nothing', async (_name, write) => {
      const id = await fresh();
      expect((await changeDetails(id, { whole_number_only: false })).statusCode).toBe(200);
      const before = await requestableOf(id);

      const res = await write(id, { version: 1 });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await requestableOf(id)).toEqual(before);
    });

    it.each(writes)('%s: answers 404 for a Requestable Material that does not exist, and 400 for an id that is not one', async (_name, write) => {
      const missing = await write(crypto.randomUUID(), { version: 1 });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Requestable Material not found' });
      const invalid = await write('not-an-id', { version: 1 });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Requestable Material ID must be a valid UUID string' });
    });

    it('needs every field of each write in its type, and nothing else', async () => {
      const page = await requestableOf(await fresh());
      const details = { expected_version: page.version, description: null, whole_number_only: false, request_unit_id: ream };
      const payloads: [string, Record<string, unknown>][] = [
        ['rename', {}],
        ['rename', { expected_version: page.version }],
        ['rename', { expected_version: 0, name: 'ชื่อ' }],
        ['rename', { expected_version: page.version, name: 5 }],
        ['rename', { expected_version: page.version, name: 'ชื่อ', note: 'x' }],
        ['details', { ...details, expected_version: 1.5 }],
        ['details', { expected_version: page.version, whole_number_only: false, request_unit_id: ream }],
        ['details', { expected_version: page.version, description: null, request_unit_id: ream }],
        ['details', { expected_version: page.version, description: null, whole_number_only: false }],
        ['details', { ...details, whole_number_only: 'false' }],
        ['details', { ...details, name: 'ชื่อ' }],
      ];
      for (const [path, payload] of payloads) {
        const send = path === 'rename' ? api.post : api.put;
        const res = await send.call(api, officer, `/requestable-materials/${page.id}/${path}`, payload, { 'x-retry-token': crypto.randomUUID() });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.any(String) });
      }
      expect(await requestableOf(page.id)).toEqual(page);
    });

    it('refuses an Other Details change that changes nothing, a blank description against none included', async () => {
      const id = await fresh();
      await expectDetailsRefused(id, {}, 'This Other Details change changes nothing');
      await expectDetailsRefused(id, { description: '  ' }, 'This Other Details change changes nothing');
      expect((await changeDetails(id, { description: 'สีขาว' })).statusCode).toBe(200);
      await expectDetailsRefused(id, { description: ' สีขาว ' }, 'This Other Details change changes nothing');
    });

    it('takes a description of 2000 characters keeping tab and line breaks, and refuses one more or any other control character', async () => {
      const id = await fresh();
      expect((await changeDetails(id, { description: 'ก'.repeat(2000) })).statusCode).toBe(200);
      expect((await changeDetails(id, { description: 'ขาว\tA4\r\nถ่ายเอกสาร' })).statusCode).toBe(200);
      expect((await requestableOf(id)).description).toBe('ขาว\tA4\r\nถ่ายเอกสาร');

      await expectDetailsRefused(id, { description: 'ก'.repeat(2001) }, expect.stringContaining('description must be at most 2000'));
      await expectDetailsRefused(id, { description: 'สีขาว\u0007' }, 'description must not contain control characters');
    });

    it('applies to an Inactive Requestable Material too', async () => {
      const id = await fresh();
      expect((await inactivate(id)).statusCode).toBe(200);

      expect((await rename(id, `ชื่อใหม่ ${crypto.randomUUID().slice(0, 8)}`)).statusCode).toBe(200);
      expect((await changeDetails(id, { description: 'หยุดใช้อยู่' })).statusCode).toBe(200);
      expect((await requestableOf(id)).is_active).toBe(false);
    });
  });

  describe('Other Details (Q17)', () => {
    it('changes the description and the whole-number setting at the next version, in one history entry with each value before and after', async () => {
      const id = await fresh();
      const before = await requestableOf(id);

      const res = await changeDetails(id, { description: '  กระดาษขาว\n80 แกรม ', whole_number_only: false }, { version: before.version });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: id, version: before.version + 1 });
      const after = await requestableOf(id);
      expect(after).toMatchObject({ description: 'กระดาษขาว\n80 แกรม', whole_number_only: false, request_unit: before.request_unit, name: before.name });
      expect(after.history.slice(0, -1)).toEqual(before.history);
      expect(after.history.at(-1)).toMatchObject({
        version: before.version + 1,
        kind: 'DETAILS_CHANGED',
        changes: [
          { field: 'whole_number_only', before: true, after: false },
          { field: 'description', before: null, after: 'กระดาษขาว\n80 แกรม' },
        ],
        recorded_by: officer.id,
      });
    });

    it('records only the fields that changed, and clears a description left blank', async () => {
      const id = await fresh();
      expect((await changeDetails(id, { description: 'สีขาว' })).statusCode).toBe(200);

      const res = await changeDetails(id, { description: '   ' });

      expect(res.statusCode).toBe(200);
      const page = await requestableOf(id);
      expect(page.description).toBeNull();
      expect(page.whole_number_only).toBe(true);
      expect(page.history.at(-1)).toMatchObject({ version: 3, kind: 'DETAILS_CHANGED', changes: [{ field: 'description', before: 'สีขาว', after: null }] });
    });
  });

  describe('the Request Unit (P2, Q15, ADR 0002)', () => {
    const LACKS = 'request_unit_id names a Unit that is not an active Unit of the current Compatible Stock Materials';

    it('changes the Request Unit when every current Compatible Stock Material has it as an active Unit, recording both Units by name', async () => {
      const box = await unitNamed();
      const boxName = (await api.pool.query('SELECT name FROM units WHERE id = $1', [box])).rows[0].name;
      const id = await compatibleWith(await stockMaterialWith([ream, box]), await stockMaterialWith([ream, box]));
      // An ended Compatible Stock Material without the Unit does not count.
      const ended = await stockMaterialWith([ream]);
      expect((await add(id, ended)).statusCode).toBe(200);
      expect((await end(id, ended)).statusCode).toBe(200);
      const before = await requestableOf(id);

      const res = await changeDetails(id, { request_unit_id: box });

      expect(res.statusCode).toBe(200);
      const after = await requestableOf(id);
      expect(after.request_unit).toEqual({ unit_id: box, name: boxName, unit_is_active: true });
      expect(after.is_offered).toBe(true);
      expect(after.history.at(-1)).toMatchObject({
        version: before.version + 1,
        kind: 'DETAILS_CHANGED',
        changes: [{ field: 'request_unit', before: { id: ream, name: 'รีม' }, after: { id: box, name: boxName } }],
      });
    });

    it('changes the Request Unit of a Requestable Material with no Compatible Stock Material', async () => {
      const box = await unitNamed();
      const id = await fresh();

      expect((await changeDetails(id, { request_unit_id: box })).statusCode).toBe(200);
      expect((await requestableOf(id)).request_unit.unit_id).toBe(box);
    });

    it('needs a new Request Unit that is on the Unit list and active (Q15)', async () => {
      const id = await fresh();
      const retired = await unitNamed();
      expect((await api.post(officer, `/units/${retired}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);

      await expectDetailsRefused(id, { request_unit_id: retired }, 'request_unit_id must name an active Unit of the list');
      await expectDetailsRefused(id, { request_unit_id: crypto.randomUUID() }, 'request_unit_id must name an active Unit of the list');
      await expectDetailsRefused(id, { request_unit_id: 'not-a-unit' }, 'request_unit_id must be a valid UUID');
    });

    it('keeps a Request Unit made Inactive in the Unit list while the other details change (Q15)', async () => {
      const bottle = await unitNamed();
      const id = await requestableIn(bottle);
      expect((await api.post(officer, `/units/${bottle}/inactivate`, { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);

      expect((await changeDetails(id, { description: 'ยังขอเป็นขวด' })).statusCode).toBe(200);
      expect((await requestableOf(id)).request_unit).toMatchObject({ unit_id: bottle, unit_is_active: false });
    });

    it('refuses a new Request Unit while a Pending Requested Item uses the Requestable Material, and still changes its other details', async () => {
      const box = await unitNamed();
      const id = await offered();
      await created([item(id)]);

      await expectDetailsRefused(id, { request_unit_id: box }, 'request_unit_id cannot change while Requested Items use this Requestable Material');
      expect((await changeDetails(id, { description: 'ใช้อยู่', whole_number_only: false })).statusCode).toBe(200);
    });

    it('refuses a new Request Unit while only Cancelled Requested Items use it (#210 start decision 3)', async () => {
      const box = await unitNamed();
      const id = await offered();
      const { material_request_id: requestId } = await created([item(id)]);
      expect((await cancelRequest(requestId)).statusCode).toBe(200);

      await expectDetailsRefused(id, { request_unit_id: box }, 'request_unit_id cannot change while Requested Items use this Requestable Material');
    });

    it('refuses a new Request Unit that a current Compatible Stock Material lacks as an active Unit, naming each such one by name', async () => {
      const box = await unitNamed();
      const tag = crypto.randomUUID().slice(0, 6);
      const lacking = await stockMaterialWith([ream], `ข ไม่มีหน่วย ${tag}`);
      const inactiveBox = await stockMaterialWith([ream, box], `ก หน่วยหยุดใช้ ${tag}`);
      const write = unitsAsRead(await materialOf(inactiveBox));
      const res = await replaceUnits(inactiveBox, { ...write, alternate_units: write.alternate_units.map((unit: any) => (unit.unit_id === box ? { ...unit, is_active: false } : unit)) });
      expect(res.statusCode).toBe(200);
      const id = await compatibleWith(await stockMaterialWith([ream, box], `ค มีหน่วย ${tag}`), lacking, inactiveBox);

      await expectDetailsRefused(id, { request_unit_id: box }, `${LACKS} "ก หน่วยหยุดใช้ ${tag}", "ข ไม่มีหน่วย ${tag}"; add it to their Units or end them first`);
    });

    it('never changes a Requested Quantity already recorded when the whole-number setting is switched on', async () => {
      const id = await offered({ wholeNumberOnly: false });
      const { material_request_id: requestId } = await created([item(id, '1.5')]);

      expect((await changeDetails(id, { whole_number_only: true })).statusCode).toBe(200);

      const page = await requestOf(requestId);
      expect(page.requested_items[0]).toMatchObject({ requested_quantity: '1.5', request_unit: { unit_id: ream } });
    });
  });

  describe('permissions (Q4, Q18, P9)', () => {
    it('lets only the Supply Officer Rename a Requestable Material or change its Other Details', async () => {
      const page = await requestableOf(await fresh());

      for (const other of [admin, readonly, custodian, staff, maintainer, requester]) {
        for (const res of [await rename(page.id, 'ชื่อที่ไม่ได้รับสิทธิ์', { version: page.version, actor: other }), await changeDetails(page.id, { description: 'ไม่ได้รับสิทธิ์' }, { actor: other })]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: expect.any(String) });
        }
      }
      expect(await requestableOf(page.id)).toEqual(page);
    });

    it('needs material:manage itself, and fails closed when the lookup fails, writing nothing', async () => {
      const page = await requestableOf(await fresh());
      // Each sent as stated: reading the page asks for material:manage too.
      const writes = [
        () => rename(page.id, 'ชื่อที่ไม่ได้รับสิทธิ์', { version: page.version }),
        () =>
          api.put(officer, `/requestable-materials/${page.id}/details`, { expected_version: page.version, description: 'ไม่ได้รับสิทธิ์', whole_number_only: true, request_unit_id: ream }, { 'x-retry-token': crypto.randomUUID() }),
      ];

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
      expect(await requestableOf(page.id)).toEqual(page);
    });

    it('needs a session and the CSRF token', async () => {
      const page = await requestableOf(await fresh());
      for (const [method, url, payload] of [
        ['POST', `/requestable-materials/${page.id}/rename`, { expected_version: page.version, name: 'ชื่อไม่มีโทเคน' }],
        ['PUT', `/requestable-materials/${page.id}/details`, { expected_version: page.version, description: 'ไม่มีโทเคน', whole_number_only: true, request_unit_id: ream }],
      ] as const) {
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method, url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      }
      expect(await requestableOf(page.id)).toEqual(page);
    });
  });

  describe('retry token', () => {
    it('needs a token for each write', async () => {
      const page = await requestableOf(await fresh());
      for (const res of [
        await api.post(officer, `/requestable-materials/${page.id}/rename`, { expected_version: page.version, name: 'ชื่อไม่มีโทเคน' }),
        await api.put(officer, `/requestable-materials/${page.id}/details`, { expected_version: page.version, description: 'ไม่มีโทเคน', whole_number_only: true, request_unit_id: ream }),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      }
      expect(await requestableOf(page.id)).toEqual(page);
    });

    it('answers an identical replay with the committed result and writes nothing, even after the Requestable Material changed again', async () => {
      const id = await fresh();
      const name = `ชื่อเล่นซ้ำ ${crypto.randomUUID().slice(0, 8)}`;
      const [renameToken, detailsToken] = [crypto.randomUUID(), crypto.randomUUID()];
      const renamed = await rename(id, name, { version: 1, token: renameToken });
      expect(renamed.statusCode).toBe(200);
      const changed = await changeDetails(id, { description: 'เล่นซ้ำ' }, { version: 2, token: detailsToken });
      expect(changed.statusCode).toBe(200);
      const before = await requestableOf(id);

      const replays = [
        await rename(id, name, { version: 1, token: renameToken }),
        await api.put(officer, `/requestable-materials/${id}/details`, { expected_version: 2, description: 'เล่นซ้ำ', whole_number_only: true, request_unit_id: ream }, { 'x-retry-token': detailsToken }),
      ];

      expect(replays.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(replays.map((res) => res.json())).toEqual([renamed.json(), changed.json()]);
      expect(await requestableOf(id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const id = await fresh();
      const [renameToken, detailsToken] = [crypto.randomUUID(), crypto.randomUUID()];
      expect((await rename(id, `ชื่อแรก ${renameToken.slice(0, 8)}`, { version: 1, token: renameToken })).statusCode).toBe(200);
      expect((await changeDetails(id, { description: 'แรก' }, { version: 2, token: detailsToken })).statusCode).toBe(200);
      const before = await requestableOf(id);

      for (const res of [
        await rename(id, `ชื่อสอง ${renameToken.slice(0, 8)}`, { version: 1, token: renameToken }),
        await api.put(officer, `/requestable-materials/${id}/details`, { expected_version: 2, description: 'สอง', whole_number_only: true, request_unit_id: ream }, { 'x-retry-token': detailsToken }),
      ]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect(await requestableOf(id)).toEqual(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_rm_rename_two', 'SUPPLY_OFFICER');
      const id = await fresh();
      const token = crypto.randomUUID();
      const name = `ชื่อของคนแรก ${token.slice(0, 8)}`;
      expect((await rename(id, name, { version: 1, token })).statusCode).toBe(200);

      // Their request under the same token is their own write, refused at the version the first one moved.
      const theirs = await rename(id, name, { version: 1, token, actor: otherOfficer });

      expect(theirs.statusCode).toBe(409);
      expect(theirs.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read' });
    });

    it('scopes a token to its operation: a Rename and an Other Details change are two', async () => {
      const id = await fresh();
      const token = crypto.randomUUID();
      expect((await rename(id, `ชื่อสองงาน ${token.slice(0, 8)}`, { version: 1, token })).statusCode).toBe(200);

      const res = await changeDetails(id, { description: 'งานที่สอง' }, { version: 2, token });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requestable_material_id: id, version: 3 });
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const id = await fresh();
      const [renameToken, detailsToken] = [crypto.randomUUID(), crypto.randomUUID()];
      const name = `ชื่อพร้อมกัน ${renameToken.slice(0, 8)}`;

      const renames = await Promise.all(Array.from({ length: 4 }, () => rename(id, name, { version: 1, token: renameToken })));
      const changes = await Promise.all(
        Array.from({ length: 4 }, () =>
          api.put(officer, `/requestable-materials/${id}/details`, { expected_version: 2, description: 'พร้อมกัน', whole_number_only: true, request_unit_id: ream }, { 'x-retry-token': detailsToken })
        )
      );

      expect([...renames, ...changes].map((res) => res.statusCode)).toEqual(Array(8).fill(200));
      expect(new Set(renames.map((res) => res.json().version))).toEqual(new Set([2]));
      expect(new Set(changes.map((res) => res.json().version))).toEqual(new Set([3]));
      expect((await requestableOf(id)).history).toHaveLength(3);
    });
  });

  // CODING_STANDARDS, "A rule read under a lock has a test of its order": both writes lock the Requestable Material FOR
  // UPDATE and read under it its version and fields; a Request Unit change then reads the rules of P2 under the locks of
  // the lock-order plan (#210 start decisions, comment 7116487192). Each test expects the version the held write leaves,
  // so only the rule under test decides.
  describe('order', () => {
    // What another write of the Requestable Material commits, held uncommitted: one moving it to its next version, as
    // adding a Compatible Stock Material does, and one changing a field as well.
    const versionHeld = (id: string) => ({ sql: 'UPDATE requestable_materials SET version = version + 1 WHERE id = $1', params: [id] });
    const fieldHeld = (id: string, field: 'name' | 'description', value: string) => ({
      sql: `UPDATE requestable_materials SET ${field} = $2, version = version + 1 WHERE id = $1`,
      params: [id, value],
    });
    // What a write on the Unit `id` of the list commits, held uncommitted: making it Inactive or active, or a Rename.
    const unitHeld = (id: string, change: 'is_active = false' | 'is_active = true' | 'name = $2', name?: string) => ({
      sql: `UPDATE units SET ${change}, version = version + 1 WHERE id = $1`,
      params: name === undefined ? [id] : [id, name],
    });
    const unitStatus = (id: string, action: 'inactivate' | 'reactivate', version: number) =>
      api.post(officer, `/units/${id}/${action}`, { expected_version: version }, { 'x-retry-token': crypto.randomUUID() });

    // The Units write that keeps the Stock Material `id` as it is but makes its Alternate Unit `unitId` Inactive.
    const makingInactive = async (id: string, unitId: string) => {
      const write = unitsAsRead(await materialOf(id));
      return { ...write, alternate_units: write.alternate_units.map((unit: any) => (unit.unit_id === unitId ? { ...unit, is_active: false } : unit)) };
    };

    it('Renames only after a write moving the Requestable Material on, then refuses the stale version', async () => {
      const id = await fresh();

      const [res] = await whileWriting(versionHeld(id), () => [rename(id, `ชื่อช้า ${crypto.randomUUID().slice(0, 8)}`, { version: 1 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read', current_values: { version: 2 } });
    });

    it('Renames only after another Rename to that name, then refuses it as changing nothing', async () => {
      const id = await fresh();
      const name = `ชื่อเดียวกัน ${crypto.randomUUID().slice(0, 8)}`;

      const [res] = await whileWriting(fieldHeld(id, 'name', name), () => [rename(id, name, { version: 2 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This Rename changes nothing' });
    });

    it('changes the Other Details only after a write moving the Requestable Material on, then refuses the stale version', async () => {
      const id = await fresh();

      const [res] = await whileWriting(versionHeld(id), () => [changeDetails(id, { description: 'ช้าไป' }, { version: 1 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Requestable Material changed since it was read', current_values: { version: 2 } });
    });

    it('changes the Other Details only after the same change, then refuses it as changing nothing', async () => {
      const id = await fresh();

      const [res] = await whileWriting(fieldHeld(id, 'description', 'สีขาว'), () => [changeDetails(id, { description: 'สีขาว' }, { version: 2 })], () => untilWaiting('requestable_materials'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'This Other Details change changes nothing' });
    });

    it('changes the Request Unit only after the new Unit is made Inactive, then refuses it', async () => {
      const box = await unitNamed();
      const id = await fresh();

      const [res] = await whileWriting(unitHeld(box, 'is_active = false'), () => [changeDetails(id, { request_unit_id: box })], () => untilWaiting('units', 1, 'FOR SHARE'));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'request_unit_id must name an active Unit of the list' });
    });

    it('changes the Request Unit only after the new Unit is reactivated, then takes it', async () => {
      const box = await unitNamed();
      expect((await unitStatus(box, 'inactivate', 1)).statusCode).toBe(200);
      const id = await fresh();

      const [res] = await whileWriting(unitHeld(box, 'is_active = true'), () => [changeDetails(id, { request_unit_id: box })], () => untilWaiting('units', 1, 'FOR SHARE'));

      expect(res.statusCode).toBe(200);
      expect((await requestableOf(id)).request_unit.unit_id).toBe(box);
    });

    it('changes the Request Unit only after the new Unit is renamed, and records its new name in the history (#175 P6)', async () => {
      const box = await unitNamed();
      const renamed = `กล่องเปลี่ยนชื่อ ${crypto.randomUUID().slice(0, 8)}`;
      const id = await fresh();

      const [res] = await whileWriting(unitHeld(box, 'name = $2', renamed), () => [changeDetails(id, { request_unit_id: box })], () => untilWaiting('units', 1, 'FOR SHARE'));

      expect(res.statusCode).toBe(200);
      expect((await requestableOf(id)).history.at(-1).changes).toEqual([{ field: 'request_unit', before: { id: ream, name: 'รีม' }, after: { id: box, name: renamed } }]);
    });

    it('changes the Request Unit only after the Unit it leaves is renamed, and records that new name in the history (#175 P6)', async () => {
      const [bottle, box] = [await unitNamed(), await unitNamed()];
      const renamed = `ขวดเปลี่ยนชื่อ ${crypto.randomUUID().slice(0, 8)}`;
      const id = await requestableIn(bottle);

      const [res] = await whileWriting(unitHeld(bottle, 'name = $2', renamed), () => [changeDetails(id, { request_unit_id: box })], () => untilWaiting('units', 1, 'FOR SHARE'));

      expect(res.statusCode).toBe(200);
      expect((await requestableOf(id)).history.at(-1).changes).toMatchObject([{ field: 'request_unit', before: { id: bottle, name: renamed }, after: { id: box } }]);
    });

    it('changes the Request Unit only after a Material Request asking for it, then refuses it as used', async () => {
      const box = await unitNamed();
      const id = await compatibleWith(await stockMaterialWith([ream, box]));

      // The create queues first on the held row, and the change queues behind it (as F009-T7's order tests do).
      const [made, res] = await whileHolding(
        'requestable_materials',
        id,
        () => [createRequest({ requested_items: [item(id)] }), untilWaiting('requestable_materials', 1, 'FOR SHARE').then(() => changeDetails(id, { request_unit_id: box }))],
        () => untilWaiting('requestable_materials')
      );

      expect(made.statusCode).toBe(201);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'request_unit_id cannot change while Requested Items use this Requestable Material' });
    });

    it('changes the Request Unit only after an add of a Compatible Stock Material lacking it, then refuses naming it', async () => {
      const box = await unitNamed();
      const name = `ไม่มีกล่อง ${crypto.randomUUID().slice(0, 8)}`;
      const lacking = await stockMaterialWith([ream], name);
      const id = await compatibleWith(await stockMaterialWith([ream, box]));

      const [added, res] = await whileHolding(
        'requestable_materials',
        id,
        () => [add(id, lacking, { version: 2 }), untilWaiting('requestable_materials').then(() => changeDetails(id, { request_unit_id: box }, { version: 3 }))],
        () => untilWaiting('requestable_materials', 2)
      );

      expect(added.statusCode).toBe(200);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(`Compatible Stock Materials "${name}";`) });
    });

    it('changes the Request Unit only after an end of the only Compatible Stock Material lacking it, then takes it', async () => {
      const box = await unitNamed();
      const lacking = await stockMaterialWith([ream]);
      const id = await compatibleWith(await stockMaterialWith([ream, box]), lacking);

      const [ended, res] = await whileHolding(
        'requestable_materials',
        id,
        () => [end(id, lacking, { version: 3 }), untilWaiting('requestable_materials').then(() => changeDetails(id, { request_unit_id: box }, { version: 4 }))],
        () => untilWaiting('requestable_materials', 2)
      );

      expect(ended.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await requestableOf(id)).request_unit.unit_id).toBe(box);
    });

    it('changes the Request Unit only after a Units write making it Inactive on a current Compatible Stock Material, then refuses naming it (#205 carry-over 1)', async () => {
      const box = await unitNamed();
      const name = `กล่องหยุดใช้ ${crypto.randomUUID().slice(0, 8)}`;
      const paper = await stockMaterialWith([ream, box], name);
      const id = await compatibleWith(paper);
      const write = await makingInactive(paper, box);

      // The Units write queues first on the held Stock Material, and the change queues behind it.
      const [units, res] = await whileHolding(
        'stock_materials',
        paper,
        () => [replaceUnits(paper, write), untilWaiting('stock_materials').then(() => changeDetails(id, { request_unit_id: box }))],
        () => untilWaiting('stock_materials', 1, 'FOR SHARE')
      );

      expect(units.statusCode).toBe(200);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(`Compatible Stock Materials "${name}";`) });
    });

    it('changes the Request Unit only after a Units write adding it to the only Compatible Stock Material lacking it, then takes it', async () => {
      const box = await unitNamed();
      const paper = await stockMaterialWith([ream]);
      const id = await compatibleWith(paper);
      const read = unitsAsRead(await materialOf(paper));
      const write = { ...read, alternate_units: [...read.alternate_units, { unit_id: box, conversion_factor: '10', whole_number_only: true, is_active: true }] };

      const [units, res] = await whileHolding(
        'stock_materials',
        paper,
        () => [replaceUnits(paper, write), untilWaiting('stock_materials').then(() => changeDetails(id, { request_unit_id: box }))],
        () => untilWaiting('stock_materials', 1, 'FOR SHARE')
      );

      expect(units.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect((await requestableOf(id)).request_unit.unit_id).toBe(box);
    });

    it('adds a Compatible Stock Material only after a Request Unit change, then refuses one lacking the new Request Unit (F009-T2)', async () => {
      const box = await unitNamed();
      const reamOnly = await stockMaterialWith([ream]);
      const id = await fresh();

      const [changed, res] = await whileHolding(
        'requestable_materials',
        id,
        () => [changeDetails(id, { request_unit_id: box }, { version: 1 }), untilWaiting('requestable_materials').then(() => add(id, reamOnly, { version: 2 }))],
        () => untilWaiting('requestable_materials', 2)
      );

      expect(changed.statusCode).toBe(200);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'stock_material_id names a Stock Material whose active Units do not include the Request Unit' });
    });
  });
});
