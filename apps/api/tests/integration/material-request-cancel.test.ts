import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialRequestHelpers } from './support/material-request-helpers.ts';

// F009-T5 (#207): the Requester Cancels (ยกเลิก) a Pending Requested Item, or every Pending Requested Item of their
// Material Request, with an optional note; nothing is deleted (#202 MRQ-19, Q12, Q13, Q20, P4).
describe('Material Request Cancel (Seam A - F009-T5)', () => {
  let api: ApiHarness;
  let requester: Actor;
  let otherRequester: Actor;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit the Requestable Materials here are asked for in.
  let ream: string;

  const { unitNamed } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { offered, item, created, requestOf, cancelItem, cancelRequest } = materialRequestHelpers(() => ({ api, requester, officer, reader: readonly, requestUnit: ream }));
  const { whileHolding, whileWriting, untilWaiting, untilWaitingOnTable } = lockHelpers(() => ({ api }));

  type Answer = { statusCode: number; json: () => any; body: string };

  // A Material Request of `count` Pending Requested Items by `actor`: its id, version and Requested Item ids.
  const pendingRequest = async (count = 2, actor: Actor = requester) => {
    const items = [];
    for (let i = 0; i < count; i += 1) {
      items.push(item(await offered()));
    }
    const { material_request_id: id, version } = await created(items, {}, actor);
    const page = await requestOf(id, actor);
    return { id, version, items: page.requested_items.map(({ id: itemId }: any) => itemId) as string[] };
  };

  // A refused Cancel: `status` with Feature 002's shape of `code` and a message holding `part`, and the Material Request
  // `id` as it was (`before`, its page) so that nothing was written.
  const expectRefused = async (res: Answer, status: number, code: string, part: string, id: string, before: unknown) => {
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code, message: expect.stringContaining(part) });
    expect(await requestOf(id)).toEqual(before);
  };

  // The whole body of a Cancel refused with the current state (#207 start decision 1, review decision 1): Feature 002's
  // shape with the Material Request's version and state now, and the version the Cancel expected.
  const refusalBody = (code: string, message: string, current: Record<string, unknown>, expectedVersion: number) => ({
    statusCode: 409,
    code,
    error: code,
    message,
    current_values: current,
    expected_values: { version: expectedVersion },
  });

  // Queues the Cancel `first` behind a held lock of the Material Request `id`, then `second` behind it, and answers both:
  // a row lock grants its waiters in turn, so `second` reads what `first` committed (CODING_STANDARDS, "A rule read
  // under a lock has a test of its order").
  const inTurn = async (id: string, first: () => Promise<Answer>, second: () => Promise<Answer>): Promise<[Answer, Answer]> => {
    let later: Promise<Answer> | undefined;
    const [earlier] = await whileHolding('material_requests', id, () => [first()], async () => {
      await untilWaiting('material_requests', 1);
      later = second();
      await untilWaiting('material_requests', 2);
    });
    return [earlier, await later!];
  };

  beforeAll(async () => {
    api = await startApiHarness();
    requester = await api.actor('requester_cancel', 'REQUESTER');
    otherRequester = await api.actor('requester_cancel_two', 'REQUESTER');
    officer = await api.actor('officer_cancel', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_cancel', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_cancel', 'READ_ONLY');
    custodian = await api.actor('custodian_cancel', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_cancel', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_cancel', 'SYSTEM_MAINTAINER');
    ream = await unitNamed('รีม');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a Requested Item (MRQ-19, Q12, P4)', () => {
    it('Cancels one Pending Requested Item with a note: it records who and when, keeps its Requested Quantity and Request Unit, writes a history entry and moves the version', async () => {
      const paper = await offered();
      const pens = await offered({ wholeNumberOnly: false });
      const { material_request_id: id, version } = await created([item(paper, '3'), item(pens, '1.25')]);
      const [first, second] = (await requestOf(id)).requested_items;

      const res = await cancelItem(id, first.id, { version, note: 'ไม่ใช้แล้ว' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ material_request_id: id, version: version + 1 });
      const page = await requestOf(id);
      expect(page.version).toBe(version + 1);
      expect(page.state).toBe('PENDING');
      expect(page.requested_items[0]).toMatchObject({
        id: first.id,
        requested_quantity: '3',
        request_unit: { unit_id: ream, name: 'รีม' },
        state: 'CANCELLED',
        cancelled_by: requester.id,
        cancelled_by_username: 'requester_cancel',
        cancelled_at: expect.any(String),
        cancel_note: 'ไม่ใช้แล้ว',
      });
      expect(page.requested_items[1]).toMatchObject({ id: second.id, requested_quantity: '1.25', state: 'PENDING', cancelled_by: null, cancelled_at: null, cancel_note: null });
      expect(page.history.slice(1)).toEqual([
        {
          version: version + 1,
          kind: 'REQUESTED_ITEM_CANCELLED',
          requested_item_ids: [first.id],
          note: 'ไม่ใช้แล้ว',
          recorded_by: requester.id,
          recorded_by_username: 'requester_cancel',
          recorded_at: page.requested_items[0].cancelled_at,
        },
      ]);
    });
  });
  describe('a Requested Item, refused (Q12, Q20, P4)', () => {
    it('takes no note, and a blank one is none', async () => {
      const { id, version, items } = await pendingRequest();

      expect((await cancelItem(id, items[0], { version })).statusCode).toBe(200);
      expect((await cancelItem(id, items[1], { version: version + 1, note: '   ' })).statusCode).toBe(200);

      const page = await requestOf(id);
      expect(page.requested_items.map(({ cancel_note }: any) => cancel_note)).toEqual([null, null]);
      expect(page.history.slice(1).map(({ note }: any) => note)).toEqual([null, null]);
    });

    it('takes a note of 500 characters and refuses one character more, writing nothing', async () => {
      const { id, version, items } = await pendingRequest();
      const before = await requestOf(id);

      await expectRefused(await cancelItem(id, items[0], { version, note: 'ก'.repeat(501) }), 400, 'VALIDATION_FAILED', 'note must be at most 500 characters', id, before);
      expect((await cancelItem(id, items[0], { version, note: 'ก'.repeat(500) })).statusCode).toBe(200);
      expect((await requestOf(id)).requested_items[0].cancel_note).toBe('ก'.repeat(500));
    });

    it('keeps tab and line breaks inside a note, and refuses any other control character', async () => {
      const { id, version, items } = await pendingRequest();
      const before = await requestOf(id);

      await expectRefused(await cancelItem(id, items[0], { version, note: 'ไม่ใช้\u0007แล้ว' }), 400, 'VALIDATION_FAILED', 'note must not contain control characters', id, before);
      expect((await cancelItem(id, items[0], { version, note: 'ไม่ใช้\tแล้ว\nขอบคุณ' })).statusCode).toBe(200);
      expect((await requestOf(id)).requested_items[0].cancel_note).toBe('ไม่ใช้\tแล้ว\nขอบคุณ');
    });

    it('refuses a Requested Item already Cancelled, at the version it now has, with the current state', async () => {
      const { id, version, items } = await pendingRequest();
      expect((await cancelItem(id, items[0], { version, note: 'ครั้งแรก' })).statusCode).toBe(200);
      const before = await requestOf(id);

      const res = await cancelItem(id, items[0], { version: version + 1, note: 'ครั้งที่สอง' });

      await expectRefused(res, 409, 'NOT_PENDING', 'The Requested Item is already Cancelled', id, before);
      expect(res.json()).toEqual(
        refusalBody('NOT_PENDING', 'The Requested Item is already Cancelled', { version: version + 1, state: 'PENDING', requested_item_state: 'CANCELLED' }, version + 1)
      );
    });

    it('refuses a version other than the one the Material Request has, with the current state', async () => {
      const { id, version, items } = await pendingRequest();
      expect((await cancelItem(id, items[0], { version })).statusCode).toBe(200);
      const before = await requestOf(id);

      for (const stale of [version, version + 2]) {
        const res = await cancelItem(id, items[1], { version: stale });
        await expectRefused(res, 409, 'STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', id, before);
        expect(res.json()).toEqual(
          refusalBody('STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', { version: version + 1, state: 'PENDING', requested_item_state: 'PENDING' }, stale)
        );
      }
    });

    it('checks the version before whether the Requested Item is Pending', async () => {
      const { id, version, items } = await pendingRequest();
      expect((await cancelItem(id, items[0], { version })).statusCode).toBe(200);
      const before = await requestOf(id);

      const res = await cancelItem(id, items[0], { version });

      await expectRefused(res, 409, 'STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', id, before);
      expect(res.json()).toEqual(
        refusalBody('STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', { version: version + 1, state: 'PENDING', requested_item_state: 'CANCELLED' }, version)
      );
    });

    it('answers 404 for a Requested Item of another Material Request or none, and 400 for an id that is not a UUID', async () => {
      const { id, version } = await pendingRequest();
      const other = await pendingRequest(1);
      const before = await requestOf(id);

      await expectRefused(await cancelItem(id, other.items[0], { version }), 404, 'NOT_FOUND', 'Requested Item not found', id, before);
      await expectRefused(await cancelItem(id, crypto.randomUUID(), { version }), 404, 'NOT_FOUND', 'Requested Item not found', id, before);
      await expectRefused(await cancelItem(id, 'not-a-uuid', { version }), 400, 'INVALID_ID', 'Requested Item ID must be a valid UUID string', id, before);
      await expectRefused(await cancelItem('not-a-uuid', before.requested_items[0].id, { version }), 400, 'INVALID_ID', 'Material Request ID must be a valid UUID string', id, before);
      expect((await requestOf(other.id)).requested_items[0].state).toBe('PENDING');
    });

    it('needs the expected version as a positive whole number and takes no field it does not know', async () => {
      const { id, items } = await pendingRequest();
      const before = await requestOf(id);
      const url = `/material-requests/${id}/requested-items/${items[0]}/cancel`;

      for (const [payload, part] of [
        [{}, 'expected_version'],
        [{ expected_version: 0 }, 'expected_version'],
        [{ expected_version: 1.5 }, 'expected_version'],
        [{ expected_version: '1' }, 'expected_version'],
        [{ expected_version: 1, reason: 'อื่น' }, 'reason'],
      ] as [Record<string, unknown>, string][]) {
        const res = await api.post(requester, url, payload, { 'x-retry-token': crypto.randomUUID() });
        await expectRefused(res, 400, 'VALIDATION_FAILED', part, id, before);
      }
    });
  });

  describe('a Material Request (MRQ-19, Q12, P4)', () => {
    it('Cancels every Pending Requested Item in one write, each with the note, under one history entry naming them, and the Material Request is Cancelled', async () => {
      const { id, version, items } = await pendingRequest(3);

      const res = await cancelRequest(id, { version, note: 'ไม่ต้องการแล้ว' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ material_request_id: id, version: version + 1 });
      const page = await requestOf(id);
      expect(page.state).toBe('CANCELLED');
      expect(page.version).toBe(version + 1);
      const cancelledAt = page.requested_items[0].cancelled_at;
      expect(page.requested_items.map(({ id: itemId, requested_quantity, state, cancelled_by, cancelled_at, cancel_note }: any) => ({ itemId, requested_quantity, state, cancelled_by, cancelled_at, cancel_note }))).toEqual(
        items.map((itemId) => ({ itemId, requested_quantity: '2', state: 'CANCELLED', cancelled_by: requester.id, cancelled_at: cancelledAt, cancel_note: 'ไม่ต้องการแล้ว' }))
      );
      expect(page.history.slice(1)).toEqual([
        {
          version: version + 1,
          kind: 'MATERIAL_REQUEST_CANCELLED',
          requested_item_ids: items,
          note: 'ไม่ต้องการแล้ว',
          recorded_by: requester.id,
          recorded_by_username: 'requester_cancel',
          recorded_at: cancelledAt,
        },
      ]);
    });

    it('Cancels only the Requested Items still Pending, keeping who Cancelled the others, when and why', async () => {
      const { id, version, items } = await pendingRequest(3);
      expect((await cancelItem(id, items[1], { version, note: 'รายการเดียว' })).statusCode).toBe(200);
      const earlier = (await requestOf(id)).requested_items[1];

      expect((await cancelRequest(id, { version: version + 1, note: 'ที่เหลือ' })).statusCode).toBe(200);

      const page = await requestOf(id);
      expect(page.state).toBe('CANCELLED');
      expect(page.requested_items[1]).toEqual(earlier);
      expect(page.requested_items.map(({ cancel_note }: any) => cancel_note)).toEqual(['ที่เหลือ', 'รายการเดียว', 'ที่เหลือ']);
      expect(page.history.slice(1).map(({ kind, requested_item_ids, note }: any) => ({ kind, requested_item_ids, note }))).toEqual([
        { kind: 'REQUESTED_ITEM_CANCELLED', requested_item_ids: [items[1]], note: 'รายการเดียว' },
        { kind: 'MATERIAL_REQUEST_CANCELLED', requested_item_ids: [items[0], items[2]], note: 'ที่เหลือ' },
      ]);
    });

    it('makes the Material Request Cancelled when its last Pending Requested Item is Cancelled alone, and the lists show it so (Q13, P10)', async () => {
      const lister = await api.actor('requester_cancel_lister', 'REQUESTER');
      const { id, version, items } = await pendingRequest(2, lister);
      expect((await cancelItem(id, items[0], { version, actor: lister })).statusCode).toBe(200);
      expect((await requestOf(id, lister)).state).toBe('PENDING');

      expect((await cancelItem(id, items[1], { version: version + 1, actor: lister })).statusCode).toBe(200);

      expect((await requestOf(id, lister)).state).toBe('CANCELLED');
      const listed = async (state: string) => (await api.get(lister, `/my-material-requests?state=${state}`)).json().items.map(({ id: rowId, state: rowState }: any) => [rowId, rowState]);
      expect(await listed('cancelled')).toEqual([[id, 'CANCELLED']]);
      expect(await listed('pending')).toEqual([]);
    });

    it('refuses a Material Request with no Pending Requested Item left, at the version it now has, with the current state', async () => {
      const { id, version } = await pendingRequest();
      expect((await cancelRequest(id, { version })).statusCode).toBe(200);
      const before = await requestOf(id);

      const res = await cancelRequest(id, { version: version + 1, note: 'อีกครั้ง' });

      await expectRefused(res, 409, 'NOT_PENDING', 'The Material Request has no Pending Requested Item', id, before);
      expect(res.json()).toEqual(refusalBody('NOT_PENDING', 'The Material Request has no Pending Requested Item', { version: version + 1, state: 'CANCELLED' }, version + 1));
    });

    it('refuses a version other than the one the Material Request has, before whether any Requested Item is Pending, with the current state', async () => {
      const { id, version, items } = await pendingRequest();
      expect((await cancelItem(id, items[0], { version })).statusCode).toBe(200);
      const partly = await requestOf(id);

      const stale = await cancelRequest(id, { version });
      await expectRefused(stale, 409, 'STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', id, partly);
      expect(stale.json()).toEqual(refusalBody('STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', { version: version + 1, state: 'PENDING' }, version));

      expect((await cancelRequest(id, { version: version + 1 })).statusCode).toBe(200);
      const before = await requestOf(id);
      const res = await cancelRequest(id, { version: version + 1 });
      await expectRefused(res, 409, 'STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', id, before);
      expect(res.json()).toEqual(refusalBody('STALE_BEFORE_CONFLICT', 'The Material Request changed since it was read', { version: version + 2, state: 'CANCELLED' }, version + 1));
    });

    it('takes a note of 500 characters and refuses one character more or a control character, writing nothing', async () => {
      const { id, version } = await pendingRequest();
      const before = await requestOf(id);

      await expectRefused(await cancelRequest(id, { version, note: 'ข'.repeat(501) }), 400, 'VALIDATION_FAILED', 'note must be at most 500 characters', id, before);
      await expectRefused(await cancelRequest(id, { version, note: 'ไม่\u0000ใช้' }), 400, 'VALIDATION_FAILED', 'note must not contain control characters', id, before);
      expect((await cancelRequest(id, { version, note: 'ข'.repeat(500) })).statusCode).toBe(200);
      expect((await requestOf(id)).history[1].note).toBe('ข'.repeat(500));
    });

    it('answers 404 for a Material Request that does not exist, and 400 for an id that is not a UUID or a version that is not a positive whole number', async () => {
      const { id } = await pendingRequest(1);
      const before = await requestOf(id);

      const missing = await cancelRequest(crypto.randomUUID(), { version: 1 });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Request not found' });
      await expectRefused(await cancelRequest('not-a-uuid', { version: 1 }), 400, 'INVALID_ID', 'Material Request ID must be a valid UUID string', id, before);
      for (const [payload, part] of [
        [{}, 'expected_version'],
        [{ expected_version: 0 }, 'expected_version'],
        [{ expected_version: 1, reason: 'อื่น' }, 'reason'],
      ] as [Record<string, unknown>, string][]) {
        const res = await api.post(requester, `/material-requests/${id}/cancel`, payload, { 'x-retry-token': crypto.randomUUID() });
        await expectRefused(res, 400, 'VALIDATION_FAILED', part, id, before);
      }
    });
  });

  describe("another person's Material Request (Q12, P5)", () => {
    it('answers both Cancels as if it did not exist, and writes nothing, even for a Requester who also holds every other role', async () => {
      const both = await api.actor('requester_cancel_every_role', 'REQUESTER');
      for (const role of ['SYSTEM_MAINTAINER', 'ADMINISTRATOR', 'READ_ONLY', 'ASSET_CUSTODIAN', 'VERIFICATION_STAFF', 'SUPPLY_OFFICER']) {
        await api.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [both.id, role]);
      }
      // One Requested Item already Cancelled, so that a stale version and a Requested Item not Pending would each be
      // refused with the current state if the owner were checked after them.
      const { id, version, items } = await pendingRequest(2, otherRequester);
      expect((await cancelItem(id, items[0], { version, actor: otherRequester })).statusCode).toBe(200);
      const before = await requestOf(id, otherRequester);

      for (const actor of [requester, both]) {
        for (const res of [
          await cancelItem(id, items[1], { version: version + 1, actor }),
          await cancelItem(id, items[1], { version, actor }),
          await cancelItem(id, items[0], { version: version + 1, actor }),
          await cancelRequest(id, { version: version + 1, actor }),
          await cancelRequest(id, { version, actor }),
        ]) {
          expect(res.statusCode).toBe(404);
          expect(res.json()).toEqual({ statusCode: 404, code: 'NOT_FOUND', error: 'NOT_FOUND', message: 'Material Request not found' });
        }
      }
      expect(await requestOf(id, otherRequester)).toEqual(before);
    });
  });

  describe('permissions (Q1, Q12, P9)', () => {
    it('lets only the Requester Cancel, and refuses the six other roles and anyone without a session, writing nothing', async () => {
      const { id, version, items } = await pendingRequest();
      const before = await requestOf(id);

      for (const other of [officer, admin, readonly, custodian, staff, maintainer]) {
        for (const res of [await cancelItem(id, items[0], { version, actor: other }), await cancelRequest(id, { version, actor: other })]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: expect.any(String) });
        }
      }
      for (const url of [`/material-requests/${id}/requested-items/${items[0]}/cancel`, `/material-requests/${id}/cancel`]) {
        const anonymous = await api.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID() }, payload: { expected_version: version } });
        expect([401, 403]).toContain(anonymous.statusCode);
      }
      expect(await requestOf(id)).toEqual(before);
      expect((await cancelItem(id, items[0], { version })).statusCode).toBe(200);
    });

    // The actor holds every role, so a gate on any other capability would let them through.
    it('needs material-request:create itself for both Cancels, and fails closed when the lookup fails, writing nothing', async () => {
      const everyone = await api.actor('requester_cancel_gate', 'REQUESTER');
      for (const role of ['SYSTEM_MAINTAINER', 'ADMINISTRATOR', 'READ_ONLY', 'ASSET_CUSTODIAN', 'VERIFICATION_STAFF', 'SUPPLY_OFFICER']) {
        await api.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [everyone.id, role]);
      }
      const { id, version, items } = await pendingRequest(2, everyone);
      const before = await requestOf(id, everyone);

      for (const write of [() => cancelItem(id, items[0], { version, actor: everyone }), () => cancelRequest(id, { version, actor: everyone })]) {
        const denied = await withCapabilityAnswer(api.app, 'material-request:create', async () => false, write);
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', message: expect.any(String) });
        const failed = await withCapabilityAnswer(api.app, 'material-request:create', async () => { throw new Error('lookup failed'); }, write);
        expect(failed.statusCode).toBe(500);
        expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: expect.any(String) });
      }
      expect(await requestOf(id, everyone)).toEqual(before);
      expect((await cancelRequest(id, { version, actor: everyone })).statusCode).toBe(200);
    });

    it('needs the CSRF token for both Cancels, and an inactive user is refused', async () => {
      const leaving = await api.actor('requester_cancel_inactive', 'REQUESTER');
      const { id, version, items } = await pendingRequest(2, leaving);
      const before = await requestOf(id, leaving);
      for (const url of [`/material-requests/${id}/requested-items/${items[0]}/cancel`, `/material-requests/${id}/cancel`]) {
        const res = await api.app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), cookie: leaving.cookie },
          payload: { expected_version: version },
        });
        expect(res.statusCode).toBe(403);
      }
      expect(await requestOf(id, leaving)).toEqual(before);

      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      for (const res of [await cancelItem(id, items[0], { version, actor: leaving }), await cancelRequest(id, { version, actor: leaving })]) {
        expect([401, 403]).toContain(res.statusCode);
      }
      const page = await api.pool.query('SELECT version FROM material_requests WHERE id = $1', [id]);
      expect(page.rows[0].version).toBe(version);
    });
  });

  describe('retry token (Q20)', () => {
    it('needs a token for both Cancels', async () => {
      const { id, version, items } = await pendingRequest();
      const before = await requestOf(id);

      const itemCancel = await api.post(requester, `/material-requests/${id}/requested-items/${items[0]}/cancel`, { expected_version: version });
      await expectRefused(itemCancel, 400, 'VALIDATION_FAILED', 'retry token', id, before);
      const requestCancel = await api.post(requester, `/material-requests/${id}/cancel`, { expected_version: version });
      await expectRefused(requestCancel, 400, 'VALIDATION_FAILED', 'retry token', id, before);
    });

    it('answers an identical replay with the same answer and writes nothing, even after the Requested Item is Cancelled', async () => {
      const { id, version, items } = await pendingRequest(3);
      const token = crypto.randomUUID();
      const first = await cancelItem(id, items[0], { version, note: 'ส่งซ้ำ', token });
      expect(first.statusCode).toBe(200);
      const requestToken = crypto.randomUUID();
      const whole = await cancelRequest(id, { version: version + 1, note: 'ทั้งหมด', token: requestToken });
      expect(whole.statusCode).toBe(200);
      const before = await requestOf(id);

      const replay = await cancelItem(id, items[0], { version, note: 'ส่งซ้ำ', token });
      const wholeReplay = await cancelRequest(id, { version: version + 1, note: 'ทั้งหมด', token: requestToken });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(wholeReplay.statusCode).toBe(200);
      expect(wholeReplay.json()).toEqual(whole.json());
      expect(await requestOf(id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const { id, version, items } = await pendingRequest(3);
      const token = crypto.randomUUID();
      expect((await cancelItem(id, items[0], { version, note: 'เดิม', token })).statusCode).toBe(200);
      const requestToken = crypto.randomUUID();
      const other = await pendingRequest(1);
      expect((await cancelRequest(other.id, { version: other.version, note: 'เดิม', token: requestToken })).statusCode).toBe(200);
      // At the version `other` was Cancelled at, so that only the Material Request differs.
      const third = await pendingRequest(1);
      const before = await requestOf(id);
      const thirdBefore = await requestOf(third.id);

      for (const changed of [
        () => cancelItem(id, items[0], { version, note: 'ใหม่', token }),
        () => cancelItem(id, items[0], { version: version + 1, note: 'เดิม', token }),
        () => cancelItem(id, items[1], { version, note: 'เดิม', token }),
        () => cancelRequest(other.id, { version: other.version, note: 'ใหม่', token: requestToken }),
        () => cancelRequest(other.id, { version: other.version + 1, note: 'เดิม', token: requestToken }),
        () => cancelRequest(id, { version: version + 1, note: 'เดิม', token: requestToken }),
        () => cancelRequest(third.id, { version: other.version, note: 'เดิม', token: requestToken }),
        () => cancelItem(third.id, items[0], { version, note: 'เดิม', token }),
      ]) {
        const res = await changed();
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect(await requestOf(id)).toEqual(before);
      expect(await requestOf(third.id)).toEqual(thirdBefore);
    });

    it('scopes a token to its actor and to its kind of Cancel', async () => {
      const token = crypto.randomUUID();
      const mine = await pendingRequest();
      const theirs = await pendingRequest(1, otherRequester);
      expect((await cancelItem(mine.id, mine.items[0], { version: mine.version, token })).statusCode).toBe(200);

      const theirCancel = await cancelRequest(theirs.id, { version: theirs.version, token, actor: otherRequester });
      const wholeCancel = await cancelRequest(mine.id, { version: mine.version + 1, token });

      expect(theirCancel.statusCode).toBe(200);
      expect(wholeCancel.statusCode).toBe(200);
      expect((await requestOf(mine.id)).state).toBe('CANCELLED');
    });
  });

  // Both Cancels lock the Material Request FOR UPDATE and read each rule after it (#207 start comment, lock-order plan).
  // Each test queues the other Cancel first and passes every rule checked before the one it tests.
  describe('order of two Cancels of one Material Request (P4)', () => {
    describe('the version', () => {
      it('a Requested Item Cancel waits for another Requested Item Cancel and then is refused as stale', async () => {
        const { id, version, items } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelItem(id, items[0], { version }),
          () => cancelItem(id, items[1], { version })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Request changed since it was read' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'PENDING', requested_item_state: 'PENDING' });
      });

      it('a Requested Item Cancel waits for a Material Request Cancel and then is refused as stale', async () => {
        const { id, version, items } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelRequest(id, { version }),
          () => cancelItem(id, items[1], { version })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Request changed since it was read' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'CANCELLED', requested_item_state: 'CANCELLED' });
      });

      it('a Material Request Cancel waits for a Requested Item Cancel and then is refused as stale', async () => {
        const { id, version, items } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelItem(id, items[0], { version }),
          () => cancelRequest(id, { version })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Request changed since it was read' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'PENDING' });
        expect((await requestOf(id)).requested_items[1].state).toBe('PENDING');
      });

      it('a Material Request Cancel waits for another Material Request Cancel and then is refused as stale', async () => {
        const { id, version } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelRequest(id, { version, note: 'แท็บแรก' }),
          () => cancelRequest(id, { version, note: 'แท็บที่สอง' })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Request changed since it was read' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'CANCELLED' });
        expect((await requestOf(id)).history.slice(1).map(({ note }: any) => note)).toEqual(['แท็บแรก']);
      });
    });

    describe('the Requested Item is Pending', () => {
      it('a Requested Item Cancel waits for a Cancel of the same Requested Item and then is refused as not Pending', async () => {
        const { id, version, items } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelItem(id, items[0], { version, note: 'แท็บแรก' }),
          () => cancelItem(id, items[0], { version: version + 1, note: 'แท็บที่สอง' })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'NOT_PENDING', message: 'The Requested Item is already Cancelled' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'PENDING', requested_item_state: 'CANCELLED' });
        expect((await requestOf(id)).requested_items[0].cancel_note).toBe('แท็บแรก');
      });

      it('a Requested Item Cancel waits for a Material Request Cancel and then is refused as not Pending', async () => {
        const { id, version, items } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelRequest(id, { version, note: 'ทั้งหมด' }),
          () => cancelItem(id, items[0], { version: version + 1, note: 'รายการเดียว' })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'NOT_PENDING', message: 'The Requested Item is already Cancelled' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'CANCELLED', requested_item_state: 'CANCELLED' });
      });
    });

    describe('the Pending Requested Items', () => {
      it('a Material Request Cancel waits for a Requested Item Cancel and then Cancels and names only the rest', async () => {
        const { id, version, items } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelItem(id, items[0], { version, note: 'รายการเดียว' }),
          () => cancelRequest(id, { version: version + 1, note: 'ที่เหลือ' })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        const page = await requestOf(id);
        expect(page.requested_items.map(({ cancel_note }: any) => cancel_note)).toEqual(['รายการเดียว', 'ที่เหลือ']);
        expect(page.history.at(-1)).toMatchObject({ kind: 'MATERIAL_REQUEST_CANCELLED', requested_item_ids: [items[1]] });
      });

      it('a Material Request Cancel waits for the Cancel of its last Pending Requested Item and then is refused as not Pending', async () => {
        const { id, version, items } = await pendingRequest(1);

        const [first, second] = await inTurn(
          id,
          () => cancelItem(id, items[0], { version }),
          () => cancelRequest(id, { version: version + 1 })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'NOT_PENDING', message: 'The Material Request has no Pending Requested Item' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'CANCELLED' });
      });

      it('a Material Request Cancel waits for another Material Request Cancel and then is refused as not Pending', async () => {
        const { id, version } = await pendingRequest();

        const [first, second] = await inTurn(
          id,
          () => cancelRequest(id, { version }),
          () => cancelRequest(id, { version: version + 1 })
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ code: 'NOT_PENDING', message: 'The Material Request has no Pending Requested Item' });
        expect(second.json().current_values).toEqual({ version: version + 1, state: 'CANCELLED' });
      });
    });
  });

  // #206 review decision 1 (carried over to #207): the page reads its Material Request, Requested Items, names and
  // history in one snapshot.
  describe('the Material Request page', () => {
    // #207 start decision 2: from Pending alone while only the owner reads the page (P5); T6 (#208) adds the rest.
    it('offers Cancel on the Material Request while any Requested Item is Pending, and on each Pending Requested Item (P9)', async () => {
      const { id, version, items } = await pendingRequest();
      const fresh = await requestOf(id);
      expect(fresh.can_cancel).toBe(true);
      expect(fresh.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([true, true]);

      expect((await cancelItem(id, items[0], { version })).statusCode).toBe(200);
      const partly = await requestOf(id);
      expect(partly.can_cancel).toBe(true);
      expect(partly.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([false, true]);

      expect((await cancelItem(id, items[1], { version: version + 1 })).statusCode).toBe(200);
      const cancelled = await requestOf(id);
      expect(cancelled.can_cancel).toBe(false);
      expect(cancelled.requested_items.map(({ can_cancel }: any) => can_cancel)).toEqual([false, false]);
    });

    it('reads in one snapshot: a Cancel that commits while the page is being read shows nowhere on it', async () => {
      const { id, version } = await pendingRequest();
      const before = await requestOf(id);
      let cancel: Answer | undefined;

      // The page waits at its Requested Items, which name their Request Unit, after it has read the Material Request;
      // a Cancel touches no Unit, so it commits meanwhile.
      const [page] = await whileWriting(
        { sql: 'LOCK TABLE units IN ACCESS EXCLUSIVE MODE', params: [] },
        () => [api.get(requester, `/material-requests/${id}`)],
        async () => {
          await untilWaitingOnTable('units');
          cancel = await cancelRequest(id, { version, note: 'ระหว่างอ่าน' });
        }
      );

      expect(cancel!.statusCode).toBe(200);
      expect(page.statusCode).toBe(200);
      expect(page.json()).toEqual(before);
      expect((await requestOf(id)).state).toBe('CANCELLED');
    });
  });
});
