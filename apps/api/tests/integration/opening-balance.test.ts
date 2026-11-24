import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T2 (#233): the Opening Balance (ยอดตั้งต้น): a Draft any Supply Officer keeps, and its confirm (ยืนยันยอดตั้งต้น),
// which numbers it and adds one Stock Movement per line (#231 MOB-01–MOB-04, MC-15, Q13, Q20, Q25, Q28, P1, P2, P4,
// P7, P8, P10; start decisions, #233 comment 7122742883). The order tests are in opening-balance-order.test.ts.
describe('Opening Balance (Seam A - F010-T2)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let otherOfficer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let requester: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // Today in Asia/Bangkok is 2026-11-24 while it is still 2026-11-23 in UTC, so a check against the UTC date shows.
  const now = new Date('2026-11-24T00:30:00+07:00');

  const materials = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { unitNamed, created, materialOf, unitsAsRead, inOrder, replaceUnits, inactivate, correct } = materials;
  const { createDraft, draft, line, complete, openingBalanceOf, replaceDraft, removeDraft, confirm, confirmed, listOf } = openingBalanceHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));

  // A Stock Material counted in รีม, whole numbers only unless `wholeNumberOnly` is false, with กล่อง of 5 รีม as an
  // Alternate Unit, each Unit new.
  const stocked = async (overrides: Record<string, unknown> & { wholeNumberOnly?: boolean } = {}) => {
    const ream = await unitNamed(`รีม ${crypto.randomUUID().slice(0, 6)}`);
    const box = await unitNamed(`กล่อง ${crypto.randomUUID().slice(0, 6)}`);
    const name = `กระดาษ ${crypto.randomUUID().slice(0, 8)}`;
    const { wholeNumberOnly = true, ...rest } = overrides as { wholeNumberOnly?: boolean };
    const id = await created({ name, base_unit: { unit_id: ream, whole_number_only: wholeNumberOnly }, alternate_units: [{ unit_id: box, conversion_factor: '5' }], ...rest });
    return { id, name, ream, box };
  };

  const tableCount = async (table: string): Promise<number> => (await api.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const counts = async () => ({
    opening_balances: await tableCount('opening_balances'),
    opening_balance_lines: await tableCount('opening_balance_lines'),
    stock_movements: await tableCount('stock_movements'),
    opening_balance_history: await tableCount('opening_balance_history'),
  });

  // A Draft save refused with Feature 002's validation shape, its message `message`, and nothing saved.
  const expectDraftRefused = async (send: () => Promise<{ statusCode: number; json: () => any }>, message: string) => {
    const before = await counts();
    const res = await send();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message });
    expect(await counts()).toEqual(before);
  };

  // A confirm of the Draft `id` refused with exactly `problems`, and the Draft left as it was.
  const expectNotConfirmable = async (id: string, problems: { field: string; message: string }[]) => {
    const before = await counts();
    const res = await confirm(id, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_CONFIRMABLE', message: `The Opening Balance cannot be confirmed: ${problems.map(({ message }) => message).join('; ')}` });
    expect(res.json().problems).toEqual(problems);
    expect(await counts()).toEqual(before);
    expect(await openingBalanceOf(id)).toMatchObject({ state: 'DRAFT', version: 1, opening_balance_number: null });
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    officer = await api.actor('officer_opening', 'SUPPLY_OFFICER');
    otherOfficer = await api.actor('officer_opening_two', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_opening', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_opening', 'READ_ONLY');
    requester = await api.actor('requester_opening', 'REQUESTER');
    custodian = await api.actor('custodian_opening', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_opening', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_opening', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a Draft (Q25, P1, P8; #233 start decision 1)', () => {
    it('saves an empty Draft, which every material:view holder reads with no number and no history', async () => {
      const res = await createDraft({ lines: [] });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ opening_balance_id: expect.any(String), version: 1 });
      const id = res.json().opening_balance_id;

      for (const reader of [readonly, admin, officer]) {
        expect(await openingBalanceOf(id, reader)).toMatchObject({
          id,
          opening_balance_number: null,
          as_of_date: null,
          source: null,
          note: null,
          state: 'DRAFT',
          version: 1,
          created_by: officer.id,
          created_by_username: 'officer_opening',
          confirmed_by: null,
          confirmed_at: null,
          lines: [],
          history: [],
        });
      }
    });

    it('saves a Draft with its header and lines, a line without its Unit or quantity, a quantity as typed without trailing zeros, and a future As-of Date', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const res = await createDraft({
        as_of_date: '2026-11-25',
        source: '  สมุดคุมวัสดุ ปี 2569  ',
        note: 'นับเมื่อสิ้นเดือน\nตุลาคม',
        lines: [line(paper.id, paper.box, '2.50', { note: 'ชั้นบน' }), { stock_material_id: pens.id }],
      });
      expect(res.statusCode).toBe(201);

      const page = await openingBalanceOf(res.json().opening_balance_id);
      expect(page).toMatchObject({ as_of_date: '2026-11-25', source: 'สมุดคุมวัสดุ ปี 2569', note: 'นับเมื่อสิ้นเดือน\nตุลาคม', state: 'DRAFT' });
      expect(page.lines).toEqual([
        {
          id: expect.any(String),
          position: 0,
          stock_material: { id: paper.id, name: paper.name, is_active: true },
          unit: { unit_id: paper.box, name: expect.stringMatching(/^กล่อง /) },
          quantity: '2.5',
          note: 'ชั้นบน',
          is_voided: false,
          stock_movement_id: null,
          stock_movements: [],
        },
        {
          id: expect.any(String),
          position: 1,
          stock_material: { id: pens.id, name: pens.name, is_active: true },
          unit: null,
          quantity: null,
          note: null,
          is_voided: false,
          stock_movement_id: null,
          stock_movements: [],
        },
      ]);
    });

    it('saves a line in a Unit its Stock Material no longer uses, which only a confirm refuses', async () => {
      const paper = await stocked();
      const page = await materialOf(paper.id);
      expect((await replaceUnits(paper.id, inOrder(unitsAsRead(page), [paper.box, false]))).statusCode).toBe(200);

      expect((await createDraft({ lines: [line(paper.id, paper.box, '1')] })).statusCode).toBe(201);
    });

    it('saves 50 lines, each a different Stock Material', async () => {
      const ream = await unitNamed();
      const ids = await Promise.all(Array.from({ length: 50 }, () => created({ base_unit: { unit_id: ream } })));
      const res = await createDraft({ lines: ids.map((id) => line(id, ream, '1')) });
      expect(res.statusCode).toBe(201);
      expect((await openingBalanceOf(res.json().opening_balance_id)).lines).toHaveLength(50);
      ids.push(await created({ base_unit: { unit_id: ream } }));
      await expectDraftRefused(() => createDraft({ lines: ids.map((id) => line(id, ream, '1')) }), 'lines must hold at most 50 lines');
    });

    it('refuses an As-of Date that is not a date', async () => {
      await expectDraftRefused(() => createDraft({ as_of_date: '2026-02-30', lines: [] }), 'as_of_date must be a date (YYYY-MM-DD)');
    });

    it('refuses a source over 500 characters or with a control character, and a note over 2000 characters (P7)', async () => {
      expect((await createDraft({ source: 'ก'.repeat(500), note: 'ข'.repeat(2000), lines: [] })).statusCode).toBe(201);
      await expectDraftRefused(() => createDraft({ source: 'ก'.repeat(501), lines: [] }), 'source must be at most 500 characters');
      await expectDraftRefused(() => createDraft({ source: 'สมุด\u0007', lines: [] }), 'source must not contain control characters');
      await expectDraftRefused(() => createDraft({ note: 'ข'.repeat(2001), lines: [] }), 'note must be at most 2000 characters');
    });

    it('refuses a line note over 500 characters', async () => {
      const paper = await stocked();
      expect((await createDraft({ lines: [line(paper.id, null, null, { note: 'ก'.repeat(500) })] })).statusCode).toBe(201);
      await expectDraftRefused(() => createDraft({ lines: [line(paper.id, null, null, { note: 'ก'.repeat(501) })] }), 'lines[0].note must be at most 500 characters');
    });

    it('refuses a quantity that is not a decimal, has more than four decimal places, is too large, or is not greater than 0, naming its line', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const second = (quantity: string) => createDraft({ lines: [line(pens.id, pens.ream, '1'), line(paper.id, paper.ream, quantity)] });
      expect((await second('0.0001')).statusCode).toBe(201);
      await expectDraftRefused(() => second('สอง'), 'lines[1].quantity must be a decimal number');
      await expectDraftRefused(() => second('1.00001'), 'lines[1].quantity must have at most four decimal places');
      await expectDraftRefused(() => second('100000000000000'), 'lines[1].quantity is too large');
      await expectDraftRefused(() => second('0'), 'lines[1].quantity must be greater than 0');
      await expectDraftRefused(() => second('-1'), 'lines[1].quantity must be greater than 0');
    });

    it('refuses a line naming no Stock Material, a Stock Material twice, or a Unit its Stock Material does not have', async () => {
      const paper = await stocked();
      const pens = await stocked();
      await expectDraftRefused(() => createDraft({ lines: [line('กระดาษ', null, null)] }), 'lines[0].stock_material_id must be a valid UUID');
      await expectDraftRefused(() => createDraft({ lines: [line(paper.id, 'รีม', null)] }), 'lines[0].unit_id must be a valid UUID');
      await expectDraftRefused(() => createDraft({ lines: [line(paper.id, null, null), line(pens.id, null, null), line(paper.id.toUpperCase(), null, null)] }), 'lines[2].stock_material_id repeats the Stock Material of lines[0]');
      await expectDraftRefused(() => createDraft({ lines: [line(pens.id, null, null), line(crypto.randomUUID(), null, null)] }), 'lines[1].stock_material_id must name a Stock Material');
      await expectDraftRefused(() => createDraft({ lines: [line(pens.id, pens.ream, null), line(paper.id, pens.ream, null)] }), 'lines[1].unit_id must name a Unit of its Stock Material');
    });

    it('replaces the whole Draft at its version, a replace that changes nothing included (#233 start decision 3), by any Supply Officer', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const id = await draft({ source: 'เดิม', lines: [line(paper.id, paper.ream, '3'), line(pens.id, null, null)] });

      const replaced = await replaceDraft(id, { expected_version: 1, as_of_date: '2026-09-30', note: 'นับใหม่', lines: [line(pens.id, pens.box, '2')] }, crypto.randomUUID(), otherOfficer);
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json()).toEqual({ opening_balance_id: id, version: 2 });
      const page = await openingBalanceOf(id);
      expect(page).toMatchObject({ as_of_date: '2026-09-30', source: null, note: 'นับใหม่', version: 2, state: 'DRAFT', history: [] });
      expect(page.lines.map(({ position, stock_material, unit, quantity }: any) => ({ position, stock_material_id: stock_material.id, unit_id: unit?.unit_id, quantity }))).toEqual([
        { position: 0, stock_material_id: pens.id, unit_id: pens.box, quantity: '2' },
      ]);

      const same = await replaceDraft(id, { expected_version: 2, as_of_date: '2026-09-30', note: 'นับใหม่', lines: [line(pens.id, pens.box, '2')] });
      expect(same.statusCode).toBe(200);
      expect(same.json()).toEqual({ opening_balance_id: id, version: 3 });
    });

    it('refuses a replace at another version with the current one, a replace of an Opening Balance that does not exist, and a replace that breaks a Draft rule', async () => {
      const paper = await stocked();
      const id = await draft({ lines: [line(paper.id, null, null)] });
      expect((await replaceDraft(id, { expected_version: 1, lines: [] })).statusCode).toBe(200);
      const before = await openingBalanceOf(id);

      const stale = await replaceDraft(id, { expected_version: 1, lines: [line(paper.id, paper.ream, '1')] });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: 'STALE_BEFORE_CONFLICT',
        message: 'The Opening Balance changed since it was read',
        current_values: { version: 2, state: 'DRAFT' },
        expected_values: { version: 1 },
      });
      const missing = await replaceDraft(crypto.randomUUID(), { expected_version: 1, lines: [] });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
      await expectDraftRefused(() => replaceDraft(id, { expected_version: 2, lines: [line(crypto.randomUUID(), null, null)] }), 'lines[0].stock_material_id must name a Stock Material');
      expect(await openingBalanceOf(id)).toEqual(before);
    });

    it('removes a Draft with its lines for good at its version, leaving no trace, and refuses a stale or a missing one', async () => {
      const paper = await stocked();
      const id = await draft({ source: 'ลบทิ้ง', lines: [line(paper.id, paper.ream, '1')] });
      expect((await replaceDraft(id, { expected_version: 1, source: 'ลบทิ้ง', lines: [line(paper.id, paper.ream, '1')] })).statusCode).toBe(200);
      const before = await counts();

      const stale = await removeDraft(id, 1);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 2, state: 'DRAFT' } });
      expect(await counts()).toEqual(before);

      const removed = await removeDraft(id, 2);
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ opening_balance_id: id });
      expect(await counts()).toEqual({ ...before, opening_balances: before.opening_balances - 1, opening_balance_lines: before.opening_balance_lines - 1 });
      const gone = await api.get(readonly, `/opening-balances/${id}`);
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
      const again = await removeDraft(id, 2);
      expect(again.statusCode).toBe(404);
      expect(again.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
    });

    it('refuses a replace, a remove and a second confirm of a confirmed Opening Balance at its version', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '1')]);
      const before = await counts();
      for (const res of [await replaceDraft(id, { expected_version: 2, lines: [] }), await removeDraft(id, 2), await confirm(id, 2)]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          code: 'NOT_DRAFT',
          message: 'The Opening Balance is confirmed: only a Draft can be replaced, removed or confirmed',
          current_values: { version: 2, state: 'CONFIRMED' },
          expected_values: { version: 2 },
        });
      }
      expect(await counts()).toEqual(before);
    });
  });

  describe('confirming (MOB-01–MOB-04, Q13, Q20, Q28, P2, P10)', () => {
    it('numbers the Opening Balance, adds one Stock Movement per line on its As-of Date with its Conversion Snapshot, and records the confirmed entry', async () => {
      const paper = await stocked();
      // Counted with fractions in its Base Unit.
      const pens = await stocked({ wholeNumberOnly: false });
      const id = await draft(complete([line(paper.id, paper.box, '2', { note: 'ชั้นบน' }), line(pens.id, pens.ream, '7.5')], { note: 'ตั้งต้นระบบ' }));

      const res = await confirm(id, 1, crypto.randomUUID(), otherOfficer);
      expect(res.statusCode).toBe(200);
      const { opening_balance_number: number } = res.json();
      expect(res.json()).toEqual({ opening_balance_id: id, opening_balance_number: expect.stringMatching(/^[1-9]\d*$/), version: 2 });

      const page = await openingBalanceOf(id);
      expect(page).toMatchObject({ opening_balance_number: number, state: 'CONFIRMED', version: 2, confirmed_by: otherOfficer.id, confirmed_by_username: 'officer_opening_two' });
      expect(Date.parse(page.confirmed_at)).toBeLessThanOrEqual(Date.now());
      const [paperLine, pensLine] = page.lines;
      expect(paperLine.stock_movements).toEqual([
        {
          id: paperLine.stock_movement_id,
          kind: 'OPENING_BALANCE',
          effective_date: '2026-09-30',
          original_quantity: '2',
          original_unit: { unit_id: paper.box, name: expect.stringMatching(/^กล่อง /) },
          base_unit: { unit_id: paper.ream, name: expect.stringMatching(/^รีม /) },
          conversion_factor: '5',
          base_quantity: '10',
          recorded_by: otherOfficer.id,
          recorded_by_username: 'officer_opening_two',
          recorded_at: page.confirmed_at,
        },
      ]);
      expect(pensLine.stock_movements).toEqual([
        expect.objectContaining({ id: pensLine.stock_movement_id, original_quantity: '7.5', conversion_factor: '1', base_quantity: '7.5', base_unit: { unit_id: pens.ream, name: expect.any(String) } }),
      ]);
      expect(page.history).toEqual([
        {
          version: 2,
          kind: 'CONFIRMED',
          facts: {
            opening_balance_number: number,
            as_of_date: '2026-09-30',
            source: 'สมุดคุมวัสดุ',
            note: 'ตั้งต้นระบบ',
            lines: [
              { line_id: paperLine.id, position: 0, stock_material: { id: paper.id, name: paper.name }, quantity: '2', unit: { id: paper.box, name: paperLine.unit.name }, note: 'ชั้นบน' },
              { line_id: pensLine.id, position: 1, stock_material: { id: pens.id, name: pens.name }, quantity: '7.5', unit: { id: pens.ream, name: pensLine.unit.name }, note: null },
            ],
          },
          reason: null,
          recorded_by: otherOfficer.id,
          recorded_by_username: 'officer_opening_two',
          recorded_at: page.confirmed_at,
        },
      ]);
      // The next one takes a later number (P10).
      const next = await stocked();
      expect(BigInt((await confirmed([line(next.id, next.ream, '1')])).number)).toBeGreaterThan(BigInt(number));
    });

    it('confirms an As-of Date of today in Asia/Bangkok, and an Inactive Stock Material', async () => {
      const paper = await stocked();
      const page = await materialOf(paper.id);
      expect((await inactivate(paper.id, { expected_version: page.version })).statusCode).toBe(200);
      const id = await draft(complete([line(paper.id, paper.ream, '3')], { as_of_date: '2026-11-24' }));

      expect((await confirm(id, 1)).statusCode).toBe(200);
      expect((await openingBalanceOf(id)).lines[0].stock_movements[0]).toMatchObject({ effective_date: '2026-11-24', base_quantity: '3' });
    });

    it('keeps in the confirmed entry the names as they were, while the page shows them as they are now (#175 P6)', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '1')]);
      const page = await materialOf(paper.id);
      const renamed = `กระดาษถ่ายเอกสาร ${crypto.randomUUID().slice(0, 6)}`;
      expect((await correct(paper.id, { expected_version: page.version, name: renamed, brand_id: null, model: null, specification: null, reason: 'สะกดผิด', explicit_continuation: true })).statusCode).toBe(200);

      const after = await openingBalanceOf(id);
      expect(after.lines[0].stock_material.name).toBe(renamed);
      expect(after.history[0].facts.lines[0].stock_material).toEqual({ id: paper.id, name: paper.name });
    });

    it('refuses a Draft with no line', async () => {
      const id = await draft(complete([]));
      await expectNotConfirmable(id, [{ field: 'lines', message: 'lines must hold at least one line' }]);
    });

    it('refuses a Draft with no As-of Date, or one after today in Asia/Bangkok', async () => {
      const paper = await stocked();
      await expectNotConfirmable(await draft(complete([line(paper.id, paper.ream, '1')], { as_of_date: null })), [{ field: 'as_of_date', message: 'as_of_date is required' }]);
      await expectNotConfirmable(await draft(complete([line(paper.id, paper.ream, '1')], { as_of_date: '2026-11-25' })), [
        { field: 'as_of_date', message: 'as_of_date must not be after today (2026-11-24, Asia/Bangkok)' },
      ]);
    });

    it('refuses a Draft with no source', async () => {
      const paper = await stocked();
      await expectNotConfirmable(await draft(complete([line(paper.id, paper.ream, '1')], { source: null })), [{ field: 'source', message: 'source is required' }]);
    });

    it('refuses a line with no Unit, or with no quantity, naming it', async () => {
      const paper = await stocked();
      const pens = await stocked();
      await expectNotConfirmable(await draft(complete([line(pens.id, pens.ream, '1'), line(paper.id, null, '1')])), [{ field: 'lines[1].unit_id', message: 'lines[1].unit_id is required' }]);
      await expectNotConfirmable(await draft(complete([line(pens.id, pens.ream, '1'), line(paper.id, paper.ream, null)])), [{ field: 'lines[1].quantity', message: 'lines[1].quantity is required' }]);
    });

    it('refuses a line in a Unit its Stock Material no longer uses (#233 start decision 2)', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.box, '1')]));
      const page = await materialOf(paper.id);
      expect((await replaceUnits(paper.id, inOrder(unitsAsRead(page), [paper.box, false]))).statusCode).toBe(200);

      await expectNotConfirmable(id, [{ field: 'lines[0].unit_id', message: 'lines[0].unit_id names a Unit that is not active on its Stock Material' }]);

      // Another Unit of the Stock Material being Inactive refuses nothing.
      const ink = await stocked();
      const inBase = await draft(complete([line(ink.id, ink.ream, '1')]));
      expect((await replaceUnits(ink.id, inOrder(unitsAsRead(await materialOf(ink.id)), [ink.box, false]))).statusCode).toBe(200);
      expect((await confirm(inBase, 1)).statusCode).toBe(200);
    });

    it('confirms a line in a Unit whose list entry is Inactive while its Stock Material still uses it (#233 start decision 2)', async () => {
      const paper = await stocked();
      const unit = (await api.get(readonly, '/units')).json().items.find((entry: any) => entry.id === paper.box);
      expect((await api.post(officer, `/units/${paper.box}/inactivate`, { expected_version: unit.version }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);
      const id = await draft(complete([line(paper.id, paper.box, '1')]));

      expect((await confirm(id, 1)).statusCode).toBe(200);
    });

    it('refuses a fraction in a whole-number Unit, and a Base Quantity that is not whole or has more than four decimal places, naming the line', async () => {
      const paper = await stocked();
      const fraction = await draft(complete([line(paper.id, paper.ream, '1.5')]));
      await expectNotConfirmable(fraction, [{ field: 'lines[0].quantity', message: 'lines[0].quantity must be a whole number in its Unit' }]);

      // A pack of 5 รีม counted with fractions, into a whole-number Base Unit: half a pack is 2.5 รีม.
      const sheet = await unitNamed();
      const half = await stocked({ alternate_units: [{ unit_id: sheet, conversion_factor: '5', whole_number_only: false }] });
      await expectNotConfirmable(await draft(complete([line(half.id, sheet, '0.5')])), [
        { field: 'lines[0].quantity', message: 'lines[0].quantity gives a Base Quantity that is not whole, as its Base Unit counts in whole numbers' },
      ]);
      const tiny = await stocked({ wholeNumberOnly: false, alternate_units: [{ unit_id: sheet, conversion_factor: '0.0001', whole_number_only: false }] });
      await expectNotConfirmable(await draft(complete([line(tiny.id, sheet, '0.5')])), [
        { field: 'lines[0].quantity', message: 'lines[0].quantity gives a Base Quantity with more than four decimal places' },
      ]);
    });

    it('refuses a Stock Material with a Stock Movement in effect, naming the Opening Balance that holds it, and confirms several Opening Balances of other Stock Materials (Q20, Q28)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const first = await confirmed([line(paper.id, paper.ream, '4')]);
      const id = await draft(complete([line(pens.id, pens.ream, '1'), line(paper.id, paper.ream, '2')]));

      const before = await counts();
      const res = await confirm(id, 1);
      expect(res.statusCode).toBe(409);
      const message = `lines[1].stock_material_id names a Stock Material with a Stock Movement in effect, from Opening Balance ${first.number}`;
      expect(res.json()).toMatchObject({ code: 'NOT_CONFIRMABLE', message: `The Opening Balance cannot be confirmed: ${message}` });
      expect(res.json().problems).toEqual([{ field: 'lines[1].stock_material_id', message, in_effect_opening_balance: { opening_balance_id: first.id, opening_balance_number: first.number } }]);
      expect(await counts()).toEqual(before);

      expect((await replaceDraft(id, { ...complete([line(pens.id, pens.ream, '1')]), expected_version: 1 })).statusCode).toBe(200);
      expect((await confirm(id, 2)).statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('4');
      expect((await materialOf(pens.id)).current_stock).toBe('1');
    });

    it('names every failing rule and line at once', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const id = await draft({ as_of_date: '2026-12-01', lines: [line(paper.id, null, '1'), line(pens.id, pens.ream, '0.5')] });
      await expectNotConfirmable(id, [
        { field: 'as_of_date', message: 'as_of_date must not be after today (2026-11-24, Asia/Bangkok)' },
        { field: 'source', message: 'source is required' },
        { field: 'lines[0].unit_id', message: 'lines[0].unit_id is required' },
        { field: 'lines[1].quantity', message: 'lines[1].quantity must be a whole number in its Unit' },
      ]);
    });

    it('refuses a confirm at another version, or of an Opening Balance that does not exist', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.ream, '1')]));
      const before = await counts();
      const stale = await confirm(id, 2);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Opening Balance changed since it was read', current_values: { version: 1, state: 'DRAFT' } });
      const missing = await confirm(crypto.randomUUID(), 1);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Opening Balance not found' });
      const invalid = await api.post(officer, '/opening-balances/ยอด/confirm', { expected_version: 1 }, { 'x-retry-token': crypto.randomUUID() });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_ID', message: 'Opening Balance ID must be a valid UUID string' });
      expect(await counts()).toEqual(before);
    });
  });

  describe('the list (#233 start decision 4)', () => {
    it('lists the Opening Balances newest first with number, As-of Date, source, state and line count, by state and by text in the number, the source or a Stock Material name', async () => {
      const tag = `ตรวจรายการ${crypto.randomUUID().slice(0, 6)}`;
      // A name and a source without a digit, so that a search by number can find the Opening Balance by its number alone.
      const letters = [...crypto.randomUUID().replace(/-/g, '').slice(0, 10)].map((hex) => 'กขคงจฉชซญฎฏฐณดตถ'['0123456789abcdef'.indexOf(hex)]).join('');
      const paper = await stocked({ name: `${tag} กระดาษ` });
      const marker = await stocked({ name: `ปากกาเคมี ${letters}` });
      const third = await confirmed([line(marker.id, marker.ream, '1')], { source: `สมุดคุม ${letters}` });
      const pens = await stocked();
      const first = await draft({ source: `${tag} สมุด`, lines: [line(pens.id, null, null)] });
      const second = await confirmed([line(paper.id, paper.ream, '1'), line(pens.id, pens.ream, '1')], { source: 'แฟ้มนับ' });

      const all = await listOf(`search=${encodeURIComponent(tag)}`);
      expect(all).toMatchObject({ total_count: 2, has_more: false, limit: 25, offset: 0, can_manage: false });
      expect(all.items).toEqual([
        { id: second.id, opening_balance_number: second.number, as_of_date: '2026-09-30', source: 'แฟ้มนับ', state: 'CONFIRMED', line_count: 2, created_at: expect.any(String) },
        { id: first, opening_balance_number: null, as_of_date: null, source: `${tag} สมุด`, state: 'DRAFT', line_count: 1, created_at: expect.any(String) },
      ]);
      expect((await listOf(`search=${encodeURIComponent(tag)}&state=draft`)).items.map(({ id }: any) => id)).toEqual([first]);
      expect((await listOf(`search=${encodeURIComponent(tag)}&state=confirmed`)).items.map(({ id }: any) => id)).toEqual([second.id]);
      expect((await listOf(`search=${third.number}&state=confirmed`)).items.map(({ id }: any) => id)).toContain(third.id);
      expect((await listOf(`search=${encodeURIComponent(tag)}`, officer)).can_manage).toBe(true);
      const refused = await api.get(readonly, '/opening-balances?state=voided');
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('state') });
    });

    it('splits two Opening Balances recorded at the same moment across a page break by id', async () => {
      const tag = `แบ่งหน้า${crypto.randomUUID().slice(0, 6)}`;
      const ids = [await draft({ source: tag, lines: [] }), await draft({ source: tag, lines: [] })];
      await api.pool.query(`UPDATE opening_balances SET created_at = '2026-11-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [ids]);
      const expected = [...ids].sort().reverse();
      const pageOne = await listOf(`search=${tag}&limit=1`);
      const pageTwo = await listOf(`search=${tag}&limit=1&offset=1`);
      expect([pageOne.items[0].id, pageTwo.items[0].id]).toEqual(expected);
    });
  });

  describe('retry tokens (Q26)', () => {
    it('needs a token on every write', async () => {
      const id = await draft();
      for (const res of [
        await api.post(officer, '/opening-balances', { lines: [] }),
        await api.put(officer, `/opening-balances/${id}`, { expected_version: 1, lines: [] }),
        await api.post(officer, `/opening-balances/${id}/remove`, { expected_version: 1 }),
        await api.post(officer, `/opening-balances/${id}/confirm`, { expected_version: 1 }),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      }
      expect((await openingBalanceOf(id)).version).toBe(1);
    });

    it('answers a replayed confirm with its first answer and adds no second Stock Movement', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.ream, '2')]));
      const token = crypto.randomUUID();
      const first = await confirm(id, 1, token);
      expect(first.statusCode).toBe(200);
      const before = await counts();
      const replay = await confirm(id, 1, token);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await counts()).toEqual(before);
    });

    it('answers a replayed create, replace and remove with their first answers', async () => {
      const paper = await stocked();
      const createToken = crypto.randomUUID();
      const created1 = await createDraft({ lines: [line(paper.id, null, null)] }, createToken);
      const id = created1.json().opening_balance_id;
      expect((await createDraft({ lines: [line(paper.id, null, null)] }, createToken)).json()).toEqual(created1.json());
      const replaceToken = crypto.randomUUID();
      const replaced = await replaceDraft(id, { expected_version: 1, lines: [] }, replaceToken);
      expect((await replaceDraft(id, { expected_version: 1, lines: [] }, replaceToken)).json()).toEqual(replaced.json());
      const removeToken = crypto.randomUUID();
      const removed = await removeDraft(id, 2, removeToken);
      expect(removed.statusCode).toBe(200);
      const replay = await removeDraft(id, 2, removeToken);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(removed.json());
    });

    // One case per field the fingerprint covers (CODING_STANDARDS, "A refusal test sends a request only its rule refuses").
    it('refuses a token replayed with one field of a create changed', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const base = { as_of_date: '2026-09-30', source: 'สมุด', note: 'หมายเหตุ', lines: [line(paper.id, paper.ream, '1', { note: 'ชั้นบน' })] };
      const changes: Record<string, unknown>[] = [
        { as_of_date: '2026-09-29' },
        { source: 'แฟ้ม' },
        { note: 'อื่น' },
        { lines: [line(pens.id, paper.ream, '1', { note: 'ชั้นบน' })] },
        { lines: [line(paper.id, paper.box, '1', { note: 'ชั้นบน' })] },
        { lines: [line(paper.id, paper.ream, '2', { note: 'ชั้นบน' })] },
        { lines: [line(paper.id, paper.ream, '1', { note: 'ชั้นล่าง' })] },
      ];
      for (const change of changes) {
        const token = crypto.randomUUID();
        expect((await createDraft(base, token)).statusCode).toBe(201);
        const before = await counts();
        const res = await createDraft({ ...base, ...change }, token);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
        expect(await counts()).toEqual(before);
      }
    });

    it('refuses a token replayed with the Opening Balance, the version or a fact of a replace changed', async () => {
      const paper = await stocked();
      const one = await draft();
      const other = await draft();
      const token = crypto.randomUUID();
      expect((await replaceDraft(one, { expected_version: 1, source: 'สมุด', lines: [] }, token)).statusCode).toBe(200);
      for (const [id, payload] of [
        [other, { expected_version: 1, source: 'สมุด', lines: [] }],
        [one, { expected_version: 2, source: 'สมุด', lines: [] }],
        [one, { expected_version: 1, source: 'แฟ้ม', lines: [] }],
        [one, { expected_version: 1, source: 'สมุด', lines: [line(paper.id, null, null)] }],
      ] as const) {
        const res = await replaceDraft(id, payload, token);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
      }
      expect((await openingBalanceOf(other)).version).toBe(1);
    });

    it('refuses a token replayed with the Opening Balance or the version of a confirm or a remove changed', async () => {
      for (const send of [confirm, removeDraft]) {
        const paper = await stocked();
        const pens = await stocked();
        const one = await draft(complete([line(paper.id, paper.ream, '1')]));
        const other = await draft(complete([line(pens.id, pens.ream, '1')]));
        const token = crypto.randomUUID();
        expect((await send(one, 1, token)).statusCode).toBe(200);
        for (const [id, version] of [
          [other, 1],
          [one, 2],
        ] as const) {
          const res = await send(id, version, token);
          expect(res.statusCode).toBe(409);
          expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
        }
        expect(await openingBalanceOf(other)).toMatchObject({ state: 'DRAFT', version: 1 });
      }
    });
  });

  describe('permissions (Q3, P8)', () => {
    it('lets every material:view holder read and only the Supply Officer write; every other role is refused on every route, and nothing is written', async () => {
      const paper = await stocked();
      const id = await draft({ source: 'สิทธิ์', lines: [line(paper.id, paper.ream, '1')] });
      for (const reader of [officer, admin, readonly]) {
        expect((await api.get(reader, '/opening-balances')).statusCode).toBe(200);
        expect((await api.get(reader, `/opening-balances/${id}`)).statusCode).toBe(200);
      }
      const before = await counts();
      for (const actor of [admin, readonly, requester, custodian, staff, maintainer]) {
        const writes = [
          await createDraft({ lines: [] }, crypto.randomUUID(), actor),
          await replaceDraft(id, { expected_version: 1, lines: [] }, crypto.randomUUID(), actor),
          await removeDraft(id, 1, crypto.randomUUID(), actor),
          await confirm(id, 1, crypto.randomUUID(), actor),
        ];
        for (const res of writes) {
          expect(res.statusCode).toBe(403);
        }
      }
      for (const actor of [requester, custodian, staff, maintainer]) {
        for (const url of ['/opening-balances', `/opening-balances/${id}`, `/stock-materials/${paper.id}`, '/stock-materials']) {
          const res = await api.get(actor, url);
          expect(res.statusCode).toBe(403);
          expect(res.body).not.toContain('สิทธิ์');
        }
      }
      expect(await counts()).toEqual(before);
    });

    // The Supply Officer holds both capabilities, so a gate on the other would let them through.
    it('needs material:view itself for each read and material:manage itself for each write, failing closed when the lookup fails', async () => {
      const paper = await stocked();
      const id = await draft({ source: 'ปิดสิทธิ์', lines: [line(paper.id, paper.ream, '1')] });
      for (const url of ['/opening-balances?search=%E0%B8%9B%E0%B8%B4%E0%B8%94', `/opening-balances/${id}`]) {
        const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(officer, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('ปิดสิทธิ์');
        const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(officer, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('ปิดสิทธิ์');
      }
      const before = await counts();
      const writes = [
        () => createDraft({ lines: [] }),
        () => replaceDraft(id, { expected_version: 1, lines: [] }),
        () => removeDraft(id, 1),
        () => confirm(id, 1),
      ];
      for (const write of writes) {
        expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, write)).statusCode).toBe(403);
        const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, write);
        expect(failed.statusCode).toBe(500);
        expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected internal server error occurred.' });
      }
      expect(await counts()).toEqual(before);
    });

    it('needs a session and the CSRF token for every write', async () => {
      const id = await draft();
      const before = await counts();
      for (const [method, url, payload] of [
        ['POST', '/opening-balances', { lines: [] }],
        ['PUT', `/opening-balances/${id}`, { expected_version: 1, lines: [] }],
        ['POST', `/opening-balances/${id}/remove`, { expected_version: 1 }],
        ['POST', `/opening-balances/${id}/confirm`, { expected_version: 1 }],
      ] as const) {
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method, url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });
        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      }
      expect(await counts()).toEqual(before);
    });
  });

  describe('Stock Movements at the database (MSL-04, story 61)', () => {
    it('refuses every UPDATE and DELETE of a Stock Movement, and a second line pointing at one', async () => {
      const paper = await stocked();
      const { id } = await confirmed([line(paper.id, paper.ream, '2')]);
      const movementId = (await openingBalanceOf(id)).lines[0].stock_movement_id;
      await expect(api.pool.query('UPDATE stock_movements SET base_quantity = 5 WHERE id = $1', [movementId])).rejects.toThrow('Stock Movements are append-only: UPDATE refused');
      await expect(api.pool.query('DELETE FROM stock_movements WHERE id = $1', [movementId])).rejects.toThrow('Stock Movements are append-only: DELETE refused');
      const other = await draft({ lines: [line((await stocked()).id, null, null)] });
      const otherLine = (await openingBalanceOf(other)).lines[0].id;
      await expect(api.pool.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [otherLine, movementId])).rejects.toThrow(/opening_balance_lines/);
      expect((await materialOf(paper.id)).current_stock).toBe('2');
    });
  });
});
