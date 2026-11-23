import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialRequestHelpers } from './support/material-request-helpers.ts';
import { requestableMaterialHelpers } from './support/requestable-material-helpers.ts';

// F009-T4 (#206): a Requester (ผู้ขอเบิก) searches the offered Requestable Materials, creates a Material Request
// (คำขอเบิก) of Requested Items (รายการที่ขอ) and follows it in "คำขอของฉัน" (#202 MRQ-01, MRQ-04, MRQ-05, MRQ-16,
// MRQ-28, Q1, Q4, Q9, Q10, Q13, Q14, Q18, Q19, Q20, P3, P5, P7, P9, P10; start decisions, #206 comment 7086878211).
describe('Material Request (Seam A - F009-T4)', () => {
  let api: ApiHarness;
  let requester: Actor;
  let otherRequester: Actor;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit most Requestable Materials here are asked for in.
  let ream: string;

  const materials = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, materialOf } = materials;
  const { requestableIn, requestableOf, add, end } = requestableMaterialHelpers(() => ({ api, officer, reader: readonly }));
  const { offeredIn, offered, createRequest, item, created, requestOf, cancelItem } = materialRequestHelpers(() => ({ api, requester, officer, reader: readonly, requestUnit: ream }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // "คำขอของฉัน" as `actor` reads it for `query`.
  const mine = async (query = '', actor: Actor = requester) => {
    const res = await api.get(actor, `/my-material-requests?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The offered Requestable Materials `actor` finds for `query`.
  const offeredFor = async (query: string, actor: Actor = requester) => {
    const res = await api.get(actor, `/offered-requestable-materials?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // How many Material Requests exist, to show that a refused write saved nothing.
  const requestCount = async (): Promise<number> => (await api.pool.query('SELECT count(*)::int AS n FROM material_requests')).rows[0].n;

  // The rows of every table, to show what a create wrote and that it wrote no stock fact.
  const tableCounts = async (): Promise<Record<string, number>> => {
    const tables = await api.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const counts: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      counts[table_name] = (await api.pool.query(`SELECT count(*)::int AS n FROM "${table_name}"`)).rows[0].n;
    }
    return counts;
  };

  // A refused create: 400 with Feature 002's validation shape, its message holding each of `parts`, and nothing saved.
  const expectRefused = async (payload: Record<string, unknown>, parts: string[]) => {
    const before = await requestCount();
    const res = await createRequest(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.any(String) });
    for (const part of parts) {
      expect(res.json().message).toContain(part);
    }
    expect(await requestCount()).toBe(before);
  };

  // A create refused because the Requested Item at `position` asks for a Requestable Material that is not offered.
  const expectNotOffered = (res: { statusCode: number; json: () => any }, position: number) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_OFFERED', position, message: expect.stringContaining(`requested_items[${position}]`) });
  };

  // F009-T5's Cancel of the Requested Item at `position` of the Material Request `id`, by its Requester `actor`.
  const cancelledAt = async (id: string, position: number, actor: Actor = requester) => {
    const page = await requestOf(id, actor);
    expect((await cancelItem(id, page.requested_items[position].id, { version: page.version, actor })).statusCode).toBe(200);
  };

  beforeAll(async () => {
    api = await startApiHarness();
    requester = await api.actor('requester_request', 'REQUESTER');
    otherRequester = await api.actor('requester_request_two', 'REQUESTER');
    officer = await api.actor('officer_request', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_request', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_request', 'READ_ONLY');
    custodian = await api.actor('custodian_request', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_request', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_request', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('creating (MRQ-16, Q10, Q14, P3)', () => {
    it('creates a Material Request of two Requested Items, answers its Request Number, and its page shows each one Pending in the Request Unit as recorded', async () => {
      const box = await unitNamed('กล่อง');
      const paper = await offered({ name: 'กระดาษ A4 ขอเบิกครั้งแรก' });
      const { requestable: pens } = await offeredIn(box, { name: 'ปากกาขอเบิกครั้งแรก', wholeNumberOnly: false });

      const res = await createRequest({
        note: 'ใช้ในงานประชุม',
        requested_items: [item(paper, '2', { note: 'สีขาว' }), item(pens, '0.5')],
      });

      expect(res.statusCode).toBe(201);
      const { material_request_id: id, request_number: number, version } = res.json();
      expect(number).toMatch(/^[1-9]\d*$/);
      expect(version).toBe(1);
      const page = await requestOf(id);
      expect(page).toMatchObject({
        id,
        request_number: number,
        requested_by: requester.id,
        requested_by_username: 'requester_request',
        note: 'ใช้ในงานประชุม',
        version: 1,
        state: 'PENDING',
      });
      expect(Date.parse(page.recorded_at)).toBeLessThanOrEqual(Date.now());
      expect(page.requested_items).toEqual([
        {
          id: expect.any(String),
          position: 0,
          requestable_material_id: paper,
          requestable_material_name: 'กระดาษ A4 ขอเบิกครั้งแรก',
          requested_quantity: '2',
          request_unit: { unit_id: ream, name: 'รีม' },
          note: 'สีขาว',
          state: 'PENDING',
          cancelled_by: null,
          cancelled_by_username: null,
          cancelled_at: null,
          cancel_note: null,
          can_cancel: true,
        },
        {
          id: expect.any(String),
          position: 1,
          requestable_material_id: pens,
          requestable_material_name: 'ปากกาขอเบิกครั้งแรก',
          requested_quantity: '0.5',
          request_unit: { unit_id: box, name: 'กล่อง' },
          note: null,
          state: 'PENDING',
          cancelled_by: null,
          cancelled_by_username: null,
          cancelled_at: null,
          cancel_note: null,
          can_cancel: true,
        },
      ]);
      expect(page.history).toEqual([
        { version: 1, kind: 'CREATED', requested_item_ids: null, note: null, recorded_by: requester.id, recorded_by_username: 'requester_request', recorded_at: page.recorded_at },
      ]);
    });

    it('numbers each Material Request with a new Request Number, larger than the one before', async () => {
      const paper = await offered();
      const first = await created([item(paper)]);
      const second = await created([item(paper)]);

      expect(BigInt(second.request_number)).toBeGreaterThan(BigInt(first.request_number));
      expect((await requestOf(second.material_request_id)).request_number).toBe(second.request_number);
    });

    it('needs no note: one left out or blank is none, on the Material Request and on each Requested Item', async () => {
      const paper = await offered();
      const { material_request_id: id } = await created([item(paper, '1', { note: '   ' })], { note: '  ' });

      const page = await requestOf(id);
      expect(page.note).toBeNull();
      expect(page.requested_items[0].note).toBeNull();
    });

    it('keeps a Requested Quantity exactly as asked, never rounded: up to four decimal places where it need not be whole, and a whole one written with zeros', async () => {
      const loose = await offered({ wholeNumberOnly: false });
      const whole = await offered();
      const { material_request_id: id } = await created([item(loose, '0.0001'), item(whole, '3.0')]);

      expect((await requestOf(id)).requested_items.map(({ requested_quantity }: any) => requested_quantity)).toEqual(['0.0001', '3']);
    });

    it('writes the Material Request, its Requested Items, its history entry and its retry receipt, and no stock fact (MRQ-05, MRQ-07)', async () => {
      const { requestable, stockMaterial } = await offeredIn();
      const other = await offered();
      const materialBefore = await materialOf(stockMaterial);
      const requestableBefore = await requestableOf(requestable);
      const before = await tableCounts();

      await created([item(requestable), item(other)]);

      const after = await tableCounts();
      const changed = Object.fromEntries(Object.keys(after).filter((table) => after[table] !== before[table]).map((table) => [table, after[table] - before[table]]));
      expect(changed).toEqual({ material_requests: 1, requested_items: 2, material_request_history: 1, registration_retry_tokens: 1 });
      expect(await materialOf(stockMaterial)).toEqual(materialBefore);
      expect(await requestableOf(requestable)).toEqual(requestableBefore);
    });

    it('takes no field it does not know, on the Material Request or a Requested Item', async () => {
      const paper = await offered();
      await expectRefused({ requested_items: [item(paper)], urgent: true }, ['urgent']);
      await expectRefused({ requested_items: [item(paper, '2', { stock_material_id: crypto.randomUUID() })] }, ['stock_material_id']);
    });
  });

  describe('Requested Items (Q10)', () => {
    it('needs at least one Requested Item', async () => {
      await expectRefused({ requested_items: [] }, ['requested_items must hold at least one Requested Item']);
    });

    it('takes 50 Requested Items and refuses 51, each one offered and distinct', async () => {
      const stockMaterial = await materials.created({ base_unit: { unit_id: ream } });
      const requestables: string[] = [];
      for (let i = 0; i < 51; i++) {
        const requestable = await requestableIn(ream, `วัสดุขอเบิกห้าสิบ ${String(i).padStart(2, '0')} ${crypto.randomUUID().slice(0, 4)}`);
        expect((await add(requestable, stockMaterial)).statusCode).toBe(200);
        requestables.push(requestable);
      }

      await expectRefused({ requested_items: requestables.map((requestable) => item(requestable)) }, ['requested_items must hold at most 50 Requested Items']);
      const fifty = await created(requestables.slice(0, 50).map((requestable) => item(requestable)));
      expect((await requestOf(fifty.material_request_id)).requested_items).toHaveLength(50);
    });

    it('refuses the same Requestable Material twice, naming both Requested Items', async () => {
      const paper = await offered();
      const pens = await offered();
      await expectRefused({ requested_items: [item(pens), item(paper), item(paper, '3')] }, ['requested_items[2]', 'requested_items[1]']);
    });

    it('needs each Requested Item to name a Requestable Material by a valid UUID, naming the Requested Item', async () => {
      const paper = await offered();
      await expectRefused({ requested_items: [item(paper), item('not-a-uuid')] }, ['requested_items[1].requestable_material_id must be a valid UUID']);
    });

    it('refuses a Requestable Material that does not exist, naming the Requested Item', async () => {
      const paper = await offered();
      await expectRefused({ requested_items: [item(paper), item(crypto.randomUUID())] }, ['requested_items[1].requestable_material_id must name a Requestable Material']);
    });

    it('needs a Requested Quantity greater than 0, naming the Requested Item', async () => {
      const paper = await offered();
      const pens = await offered({ wholeNumberOnly: false });
      await expectRefused({ requested_items: [item(paper), item(pens, '0')] }, ['requested_items[1].requested_quantity must be greater than 0']);
      await expectRefused({ requested_items: [item(paper), item(pens, '-1')] }, ['requested_items[1].requested_quantity must be greater than 0']);
    });

    it('refuses more than four decimal places, even when the extra places are zeros, and never rounds', async () => {
      const paper = await offered();
      const pens = await offered({ wholeNumberOnly: false });
      await expectRefused({ requested_items: [item(paper), item(pens, '1.23456')] }, ['requested_items[1].requested_quantity must have at most four decimal places']);
      await expectRefused({ requested_items: [item(paper), item(pens, '1.00000')] }, ['requested_items[1].requested_quantity must have at most four decimal places']);
    });

    it('needs a Requested Quantity written as a decimal number, naming the Requested Item', async () => {
      const paper = await offered();
      const pens = await offered({ wholeNumberOnly: false });
      await expectRefused({ requested_items: [item(paper), item(pens, '1e3')] }, ['requested_items[1].requested_quantity must be a decimal number']);
      await expectRefused({ requested_items: [item(paper), item(pens, ' 2')] }, ['requested_items[1].requested_quantity must be a decimal number']);
      await expectRefused({ requested_items: [item(paper), { requestable_material_id: pens, requested_quantity: 2 }] }, ['requested_items.1.requested_quantity']);
    });

    it('refuses a Requested Quantity too large for NUMERIC(18,4), naming the Requested Item', async () => {
      const paper = await offered();
      const pens = await offered({ wholeNumberOnly: false });
      await expectRefused({ requested_items: [item(paper), item(pens, '100000000000000')] }, ['requested_items[1].requested_quantity is too large']);
      expect((await created([item(pens, '99999999999999.9999')])).version).toBe(1);
    });

    it('needs a whole Requested Quantity for a Requestable Material counted in whole numbers, naming the Requested Item, and takes a fraction for one that is not', async () => {
      const paper = await offered();
      const pens = await offered();
      await expectRefused({ requested_items: [item(paper), item(pens, '1.5')] }, ['requested_items[1].requested_quantity must be a whole number']);
      const loose = await offered({ wholeNumberOnly: false });
      expect((await created([item(paper), item(loose, '1.5')])).version).toBe(1);
    });

    it('checks a Requested Item for being offered before its whole-number setting', async () => {
      const paper = await offered();
      const pens = await requestableIn(ream);
      expectNotOffered(await createRequest({ requested_items: [item(paper), item(pens, '1.5')] }), 1);
    });
  });

  describe('text (P7)', () => {
    it('takes a note of 2000 characters and a Requested Item note of 500, and refuses one character more, naming the Requested Item', async () => {
      const paper = await offered();
      const pens = await offered();
      expect((await created([item(paper, '1', { note: 'ก'.repeat(500) })], { note: 'ก'.repeat(2000) })).version).toBe(1);
      await expectRefused({ requested_items: [item(paper)], note: 'ก'.repeat(2001) }, ['note must be at most 2000 characters']);
      await expectRefused({ requested_items: [item(paper), item(pens, '1', { note: 'ก'.repeat(501) })] }, ['requested_items[1].note must be at most 500 characters']);
    });

    it('keeps tab and line breaks inside a note, and refuses any other control character', async () => {
      const paper = await offered();
      const pens = await offered();
      const { material_request_id: id } = await created([item(paper, '1', { note: 'บรรทัด\tหนึ่ง\nสอง' })], { note: 'ก\nข' });
      const page = await requestOf(id);
      expect(page.note).toBe('ก\nข');
      expect(page.requested_items[0].note).toBe('บรรทัด\tหนึ่ง\nสอง');
      await expectRefused({ requested_items: [item(paper)], note: 'ก\u0007ข' }, ['note must not contain control characters']);
      await expectRefused({ requested_items: [item(paper), item(pens, '1', { note: 'ก\u0007ข' })] }, ['requested_items[1].note must not contain control characters']);
    });
  });

  describe('offered at the moment of saving (Q9, Q20)', () => {
    it('refuses a Requestable Material with no Compatible Stock Material, naming the Requested Item, and saves nothing', async () => {
      const paper = await offered();
      const bare = await requestableIn(ream);
      const before = await requestCount();

      expectNotOffered(await createRequest({ requested_items: [item(paper), item(bare)] }), 1);
      expect(await requestCount()).toBe(before);
    });

    it('refuses a Requestable Material whose only Compatible Stock Material was ended', async () => {
      const paper = await offered();
      const { requestable, stockMaterial } = await offeredIn();
      expect((await end(requestable, stockMaterial)).statusCode).toBe(200);

      expectNotOffered(await createRequest({ requested_items: [item(paper), item(requestable)] }), 1);
    });

    it('refuses an Inactive Requestable Material that still has a current Compatible Stock Material', async () => {
      const paper = await offered();
      const inactive = await offered();
      // What F009-T7's Inactive writes, standing in until T7 builds it (#206 start decisions).
      await api.pool.query('UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', [inactive]);

      expectNotOffered(await createRequest({ requested_items: [item(paper), item(inactive)] }), 1);
    });

    it('takes a Requestable Material whose only Compatible Stock Material is Inactive, as offered is decided by the Requestable Material (Q9)', async () => {
      const { requestable, stockMaterial } = await offeredIn();
      const page = await materialOf(stockMaterial);
      expect((await materials.inactivate(stockMaterial, { expected_version: page.version })).statusCode).toBe(200);

      expect((await created([item(requestable)])).version).toBe(1);
    });
  });

  // Creating a Material Request locks each Requestable Material FOR SHARE and reads its rules after the lock, in a
  // statement of its own (#206 start decision 2; CODING_STANDARDS, "A rule read under a lock has a test of its order").
  describe('concurrency', () => {
    it('waits for its only Compatible Stock Material being ended and then refuses it as not offered', async () => {
      const paper = await offered();
      const { requestable, stockMaterial } = await offeredIn();

      const [res] = await whileWriting(
        // F009-T2's end, held uncommitted: it ends the pair and moves the Requestable Material to its next version.
        {
          sql: `WITH ended AS (UPDATE compatible_stock_materials SET is_current = false WHERE requestable_material_id = $1 AND stock_material_id = $2 RETURNING 1)
                UPDATE requestable_materials SET version = version + 1 WHERE id = $1`,
          params: [requestable, stockMaterial],
        },
        () => [createRequest({ requested_items: [item(paper), item(requestable)] })],
        () => untilWaiting('requestable_materials', 1, 'FOR SHARE')
      );

      expectNotOffered(res, 1);
    });

    it('waits for the Requestable Material being made Inactive and then refuses it as not offered (F009-T7)', async () => {
      const paper = await offered();
      const requestable = await offered();

      const [res] = await whileWriting(
        // What F009-T7's Inactive writes, held uncommitted.
        { sql: 'UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', params: [requestable] },
        () => [createRequest({ requested_items: [item(paper), item(requestable)] })],
        () => untilWaiting('requestable_materials', 1, 'FOR SHARE')
      );

      expectNotOffered(res, 1);
    });

    it('waits for its whole-number setting being turned on and then refuses a fraction (F009-T8)', async () => {
      const paper = await offered();
      const requestable = await offered({ wholeNumberOnly: false });

      const [res] = await whileWriting(
        // What F009-T8's details change writes, held uncommitted.
        { sql: 'UPDATE requestable_materials SET whole_number_only = true, version = version + 1 WHERE id = $1', params: [requestable] },
        () => [createRequest({ requested_items: [item(paper), item(requestable, '1.5')] })],
        () => untilWaiting('requestable_materials', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('requested_items[1].requested_quantity must be a whole number') });
    });

    it('waits for its Request Unit being changed and then records the new one (F009-T8)', async () => {
      const box = await unitNamed();
      const paper = await offered();
      const requestable = await offered();

      const [res] = await whileWriting(
        // What F009-T8's Request Unit change writes, held uncommitted.
        { sql: 'UPDATE requestable_materials SET request_unit_id = $2, version = version + 1 WHERE id = $1', params: [requestable, box] },
        () => [createRequest({ requested_items: [item(paper), item(requestable)] })],
        () => untilWaiting('requestable_materials', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(201);
      const page = await requestOf(res.json().material_request_id);
      expect(page.requested_items.map(({ request_unit }: any) => request_unit.unit_id)).toEqual([ream, box]);
    });
  });

  describe('the offered search (MRQ-01, Q18)', () => {
    it('finds only the offered Requestable Materials, each with its name, Request Unit, whole-number setting and description alone', async () => {
      const tag = `ค้นขอเบิก${crypto.randomUUID().slice(0, 6)}`;
      const { requestable: shown } = await offeredIn(ream, { name: `${tag} ก`, wholeNumberOnly: false });
      await api.pool.query(`UPDATE requestable_materials SET description = 'กระดาษสีขาว' WHERE id = $1`, [shown]);
      await requestableIn(ream, `${tag} ข ไม่มีวัสดุที่ใช้จ่าย`);
      const { requestable: ended, stockMaterial } = await offeredIn(ream, { name: `${tag} ค เลิกแล้ว` });
      expect((await end(ended, stockMaterial)).statusCode).toBe(200);
      const inactive = await offered({ name: `${tag} ง หยุดใช้` });
      await api.pool.query('UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', [inactive]);

      const found = await offeredFor(`search=${encodeURIComponent(tag)}`);

      expect(found).toEqual({
        items: [{ id: shown, name: `${tag} ก`, request_unit: { unit_id: ream, name: 'รีม' }, whole_number_only: false, description: 'กระดาษสีขาว' }],
        limit: 25,
        offset: 0,
        total_count: 1,
        has_more: false,
      });
    });

    it('matches the name ignoring case and repeated spaces', async () => {
      const tag = `ค้นปน${crypto.randomUUID().slice(0, 6)}`;
      const requestable = await offered({ name: `${tag} Paper  A4` });

      const found = await offeredFor(`search=${encodeURIComponent(`  ${tag.toUpperCase()}   paper a4 `)}`);
      expect(found.items.map(({ id }: any) => id)).toEqual([requestable]);
    });

    // requestable_materials_name_unique makes the compared name unique, so names cannot tie and need no tiebreak
    // (CODING_STANDARDS, "An order test of a paged list splits a tie across a page break").
    it('pages the offered Requestable Materials by name', async () => {
      const tag = `ค้นหน้า${crypto.randomUUID().slice(0, 6)}`;
      const c = await offered({ name: `${tag} ค` });
      const a = await offered({ name: `${tag} ก` });
      const b = await offered({ name: `${tag} ข` });

      const first = await offeredFor(`search=${encodeURIComponent(tag)}&limit=2`);
      expect(first).toMatchObject({ total_count: 3, has_more: true, limit: 2, offset: 0 });
      expect(first.items.map(({ id }: any) => id)).toEqual([a, b]);
      const second = await offeredFor(`search=${encodeURIComponent(tag)}&limit=2&offset=2`);
      expect(second).toMatchObject({ total_count: 3, has_more: false });
      expect(second.items.map(({ id }: any) => id)).toEqual([c]);
    });

    it('refuses a search with a control character, a blank one or an unknown parameter', async () => {
      for (const [query, part] of [
        ['search=%07ก', 'search: must not contain control characters'],
        ['search=%20%20', 'search: must not be blank'],
        ['status=all', 'status'],
      ]) {
        const res = await api.get(requester, `/offered-requestable-materials?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(part) });
      }
    });
  });

  describe('"คำขอของฉัน" (Q19)', () => {
    it("lists only the caller's own Material Requests, newest first, each with its Request Number, Requester, Recorded At, state and Requested Item count", async () => {
      const lister = await api.actor('requester_lister', 'REQUESTER');
      const paper = await offered();
      const pens = await offered();
      const older = await created([item(paper)], {}, lister);
      const newer = await created([item(paper), item(pens)], {}, lister);
      await created([item(paper)], {}, otherRequester);

      const list = await mine('', lister);

      expect(list).toEqual({
        items: [
          { id: newer.material_request_id, request_number: newer.request_number, requested_by: lister.id, requested_by_username: 'requester_lister', recorded_at: expect.any(String), state: 'PENDING', requested_item_count: 2 },
          { id: older.material_request_id, request_number: older.request_number, requested_by: lister.id, requested_by_username: 'requester_lister', recorded_at: expect.any(String), state: 'PENDING', requested_item_count: 1 },
        ],
        limit: 25,
        offset: 0,
        total_count: 2,
        has_more: false,
      });
      expect(list.items[0].recorded_at).toBe((await requestOf(newer.material_request_id, lister)).recorded_at);
    });

    // The unique constraint on request_number makes the sort key unique, so Request Numbers cannot tie and need no
    // tiebreak (CODING_STANDARDS, "An order test of a paged list splits a tie across a page break").
    it('pages by Request Number, newest first', async () => {
      const lister = await api.actor('requester_pager', 'REQUESTER');
      const paper = await offered();
      const numbers = [];
      for (let i = 0; i < 3; i++) {
        numbers.push((await created([item(paper)], {}, lister)).material_request_id);
      }

      const first = await mine('limit=2', lister);
      expect(first).toMatchObject({ total_count: 3, has_more: true, limit: 2, offset: 0 });
      expect(first.items.map(({ id }: any) => id)).toEqual([numbers[2], numbers[1]]);
      const second = await mine('limit=2&offset=2', lister);
      expect(second).toMatchObject({ total_count: 3, has_more: false });
      expect(second.items.map(({ id }: any) => id)).toEqual([numbers[0]]);
    });

    it('filters by state, all by default, from the state its Requested Items derive (Q13, P10)', async () => {
      const lister = await api.actor('requester_filter', 'REQUESTER');
      const paper = await offered();
      const pens = await offered();
      const pending = await created([item(paper), item(pens)], {}, lister);
      const partly = await created([item(paper), item(pens)], {}, lister);
      const cancelled = await created([item(paper)], {}, lister);
      await cancelledAt(partly.material_request_id, 0, lister);
      await cancelledAt(cancelled.material_request_id, 0, lister);

      const ids = async (query: string) => (await mine(query, lister)).items.map(({ id, state }: any) => [id, state]);
      expect(await ids('')).toEqual([
        [cancelled.material_request_id, 'CANCELLED'],
        [partly.material_request_id, 'PENDING'],
        [pending.material_request_id, 'PENDING'],
      ]);
      expect(await ids('state=all')).toEqual(await ids(''));
      expect(await ids('state=pending')).toEqual([
        [partly.material_request_id, 'PENDING'],
        [pending.material_request_id, 'PENDING'],
      ]);
      expect(await ids('state=cancelled')).toEqual([[cancelled.material_request_id, 'CANCELLED']]);
      expect((await mine('state=cancelled', lister)).total_count).toBe(1);
    });

    it('refuses a state it does not know and an unknown parameter', async () => {
      for (const [query, part] of [
        ['state=issued', 'state:'],
        ['requested_by=me', 'requested_by'],
      ]) {
        const res = await api.get(requester, `/my-material-requests?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(part) });
      }
    });
  });

  describe('the Material Request page (MRQ-04, Q13, P5)', () => {
    it('derives each state from the Requested Items: Cancelled once every one is, each Requested Item showing who cancelled it and when', async () => {
      const paper = await offered();
      const pens = await offered();
      const { material_request_id: id } = await created([item(paper), item(pens)]);
      await cancelledAt(id, 0);
      const partly = await requestOf(id);
      expect(partly.state).toBe('PENDING');
      expect(partly.requested_items.map(({ state }: any) => state)).toEqual(['CANCELLED', 'PENDING']);
      expect(partly.requested_items[0]).toMatchObject({ cancelled_by: requester.id, cancelled_by_username: 'requester_request', cancelled_at: expect.any(String) });

      await cancelledAt(id, 1);
      expect((await requestOf(id)).state).toBe('CANCELLED');
    });

    it("answers another person's Material Request as if it did not exist", async () => {
      const paper = await offered();
      const { material_request_id: id } = await created([item(paper)], { note: 'คำขอส่วนตัวของผู้ขอเบิก' }, otherRequester);

      const res = await api.get(requester, `/material-requests/${id}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Request not found' });
      expect(res.body).not.toContain('คำขอส่วนตัวของผู้ขอเบิก');
      expect((await requestOf(id, otherRequester)).note).toBe('คำขอส่วนตัวของผู้ขอเบิก');
    });

    it('answers 404 for a Material Request that does not exist, and 400 for an id that is not a UUID', async () => {
      const missing = await api.get(requester, `/material-requests/${crypto.randomUUID()}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Request not found' });
      const invalid = await api.get(requester, '/material-requests/not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Material Request ID must be a valid UUID string' });
    });
  });

  describe('permissions (Q1, P5, P9)', () => {
    // The Supply Officer and the Administrator read the Material Request page through material-request:view (F009-T6,
    // material-request-view.test.ts).
    it('lets only the Requester search, create, list and read, and refuses the six other roles and anyone without a session', async () => {
      const tag = `สิทธิ์ขอเบิก${crypto.randomUUID().slice(0, 6)}`;
      const paper = await offered({ name: tag });
      const { material_request_id: id } = await created([item(paper)], { note: tag });
      const reads = [`/offered-requestable-materials?search=${encodeURIComponent(tag)}`, '/my-material-requests', `/material-requests/${id}`];
      for (const url of reads) {
        const res = await api.get(requester, url);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(url === '/my-material-requests' ? id : tag);
      }

      const before = await requestCount();
      // Each role and the reads it is refused: the Material Request page opens to material-request:view.
      const refusals: [Actor, string[]][] = [
        [officer, reads.slice(0, 2)],
        [admin, reads.slice(0, 2)],
        ...[readonly, custodian, staff, maintainer].map((other): [Actor, string[]] => [other, reads]),
      ];
      for (const [other, refused] of refusals) {
        for (const url of refused) {
          const res = await api.get(other, url);
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
          expect(res.body).not.toContain(tag);
        }
        const write = await createRequest({ requested_items: [item(paper)] }, crypto.randomUUID(), other);
        expect(write.statusCode).toBe(403);
        expect(write.json().error.code).toBe('FORBIDDEN');
      }
      for (const url of reads) {
        const anonymous = await api.app.inject({ method: 'GET', url });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.body).not.toContain(tag);
      }
      expect(await requestCount()).toBe(before);
    });

    // The actor holds every role, so a gate on any other capability would let them through. The page also opens to
    // material-request:view, which the actor holds: material-request-view.test.ts denies both (F009-T6).
    it('needs material-request:create itself for every read and the create, and fails closed when the lookup fails, saving nothing', async () => {
      const everyone = await api.actor('requester_every_role', 'REQUESTER');
      for (const role of ['SYSTEM_MAINTAINER', 'ADMINISTRATOR', 'READ_ONLY', 'ASSET_CUSTODIAN', 'VERIFICATION_STAFF', 'SUPPLY_OFFICER']) {
        await api.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [everyone.id, role]);
      }
      const tag = `ปิดสิทธิ์ขอเบิก${crypto.randomUUID().slice(0, 6)}`;
      const paper = await offered({ name: tag });
      const { material_request_id: id } = await created([item(paper)], { note: tag }, everyone);
      const reads = [`/offered-requestable-materials?search=${encodeURIComponent(tag)}`, '/my-material-requests'];

      for (const url of reads) {
        expect((await api.get(everyone, url)).statusCode).toBe(200);
        const denied = await withCapabilityAnswer(api.app, 'material-request:create', async () => false, () => api.get(everyone, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain(tag);
        expect(denied.body).not.toContain(id);
        const failed = await withCapabilityAnswer(api.app, 'material-request:create', async () => { throw new Error('lookup failed'); }, () => api.get(everyone, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain(tag);
      }
      const before = await requestCount();
      const write = () => createRequest({ requested_items: [item(paper)] }, crypto.randomUUID(), everyone);
      expect((await withCapabilityAnswer(api.app, 'material-request:create', async () => false, write)).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material-request:create', async () => { throw new Error('lookup failed'); }, write);
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await requestCount()).toBe(before);
    });

    it('needs a session and the CSRF token to create, and an inactive user is refused', async () => {
      const paper = await offered();
      const before = await requestCount();
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: '/material-requests',
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: { requested_items: [item(paper)] },
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: requester.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('requester_inactive', 'REQUESTER');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await createRequest({ requested_items: [item(paper)] }, crypto.randomUUID(), leaving)).statusCode);
      expect(await requestCount()).toBe(before);
    });
  });

  describe('retry token (Q20)', () => {
    it('needs a token', async () => {
      const paper = await offered();
      const before = await requestCount();
      const res = await api.post(requester, '/material-requests', { requested_items: [item(paper)] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      expect(await requestCount()).toBe(before);
    });

    it('answers an identical replay with the same Material Request and writes nothing, even after its Requestable Material stopped being offered', async () => {
      const { requestable, stockMaterial } = await offeredIn();
      const token = crypto.randomUUID();
      const payload = { note: 'ส่งซ้ำ', requested_items: [item(requestable, '2', { note: 'สองรีม' })] };
      const first = await createRequest(payload, token);
      expect(first.statusCode).toBe(201);
      expect((await end(requestable, stockMaterial)).statusCode).toBe(200);
      const before = await tableCounts();

      const replay = await createRequest(payload, token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await tableCounts()).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const paper = await offered({ wholeNumberOnly: false });
      const pens = await offered();
      const token = crypto.randomUUID();
      const payload = { note: 'เดิม', requested_items: [item(paper, '2', { note: 'เดิม' }), item(pens)] };
      expect((await createRequest(payload, token)).statusCode).toBe(201);
      const before = await requestCount();

      for (const changed of [
        { ...payload, note: 'ใหม่' },
        { ...payload, requested_items: [item(paper, '2.5', { note: 'เดิม' }), item(pens)] },
        { ...payload, requested_items: [item(paper, '2', { note: 'ใหม่' }), item(pens)] },
        { ...payload, requested_items: [item(pens), item(paper, '2', { note: 'เดิม' })] },
        { ...payload, requested_items: [item(paper, '2', { note: 'เดิม' })] },
      ]) {
        const res = await createRequest(changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect(await requestCount()).toBe(before);
    });

    it('scopes a token to its actor', async () => {
      const paper = await offered();
      const token = crypto.randomUUID();
      const mineRes = await createRequest({ requested_items: [item(paper)] }, token);
      const theirs = await createRequest({ requested_items: [item(paper)] }, token, otherRequester);

      expect(theirs.statusCode).toBe(201);
      expect(theirs.json().material_request_id).not.toBe(mineRes.json().material_request_id);
    });
  });
});
