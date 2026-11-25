import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';
import { materialReceiptHelpers } from './support/material-receipt-helpers.ts';
import { openingBalanceHelpers } from './support/opening-balance-helpers.ts';

// F010-T3 (#234): the Material Receipt (รายการรับวัสดุ) through the composed application with real PostgreSQL (Seam A):
// its Draft, its confirm (ยืนยันรับวัสดุ) with its Receipt Number and Stock Movements, the list and the page, retry
// tokens, permissions, and the usage counts of the Source Parties and Source Types it names (#231 MRC-01–MRC-03,
// MRC-05–MRC-09, MSL-04, MSL-05, MC-06–MC-08, MC-14, Q3–Q11, Q21, Q24–Q26, P1, P2, P4, P6–P8; start comment 7133951512).
describe('Material Receipt (Seam A - F010-T3)', () => {
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
  const { unitNamed, created, materialOf, unitsAsRead, inOrder, replaceUnits, inactivate } = materials;
  const { createDraft, draft, line, complete, receiptOf, replaceDraft, removeDraft, confirm, received, listOf, entryNamed, entryOf, entryWrite } = materialReceiptHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));
  const openingBalances = openingBalanceHelpers(() => ({ api, officer, reader: readonly }));

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
    material_receipts: await tableCount('material_receipts'),
    material_receipt_lines: await tableCount('material_receipt_lines'),
    stock_movements: await tableCount('stock_movements'),
    material_receipt_history: await tableCount('material_receipt_history'),
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
  const expectNotConfirmable = async (id: string, problems: Record<string, unknown>[]) => {
    const before = await counts();
    const res = await confirm(id, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_CONFIRMABLE', message: `The Material Receipt cannot be confirmed: ${problems.map(({ message }) => message).join('; ')}` });
    expect(res.json().problems).toEqual(problems);
    expect(await counts()).toEqual(before);
    expect(await receiptOf(id)).toMatchObject({ state: 'DRAFT', version: 1, receipt_number: null });
  };

  beforeAll(async () => {
    api = await startApiHarness({ clock: () => now });
    officer = await api.actor('officer_receipt', 'SUPPLY_OFFICER');
    otherOfficer = await api.actor('officer_receipt_two', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_receipt', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_receipt', 'READ_ONLY');
    requester = await api.actor('requester_receipt', 'REQUESTER');
    custodian = await api.actor('custodian_receipt', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_receipt', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_receipt', 'SYSTEM_MAINTAINER');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('a Draft (MRC-01, Q4–Q9, Q25, P1, P8; #234 start decision 1)', () => {
    it('saves an empty Draft, which every material:view holder reads with no number, no history and no Stock Movement', async () => {
      const before = await tableCount('stock_movements');
      const res = await createDraft({ lines: [] });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ material_receipt_id: expect.any(String), version: 1 });
      const id = res.json().material_receipt_id;
      for (const viewer of [officer, admin, readonly]) {
        expect(await receiptOf(id, viewer)).toMatchObject({
          id,
          receipt_number: null,
          received_date: null,
          source_party: null,
          source_type: null,
          receipt_reference: null,
          note: null,
          state: 'DRAFT',
          version: 1,
          created_by_username: 'officer_receipt',
          confirmed_by: null,
          confirmed_by_username: null,
          confirmed_at: null,
          lines: [],
          history: [],
        });
      }
      expect(await tableCount('stock_movements')).toBe(before);
    });

    it('saves a Draft with its header and lines, a line without its Unit, quantity or Unit Price, sent empty or left out, and a Unit Price as typed, with no stock effect', async () => {
      const paper = await stocked();
      const party = await entryNamed('party', `ร้านสยาม ${crypto.randomUUID().slice(0, 6)}`);
      const type = await entryNamed('type');
      const before = await tableCount('stock_movements');
      const id = await draft({
        received_date: '2026-11-20',
        source_party_id: party,
        source_type_id: type,
        receipt_reference: '  ใบส่งของ 123\nลงวันที่ 20 พ.ย.  ',
        note: 'ตรวจนับแล้ว',
        lines: [line(paper.id, paper.box, '2', { unit_price: '150.50', note: 'ชั้นบน' }), line(paper.id, paper.ream, '3', { unit_price: '0' }), line(paper.id, null, null), { stock_material_id: paper.id, unit_price: null }],
      });
      const page = await receiptOf(id);
      expect(page).toMatchObject({
        received_date: '2026-11-20',
        source_party: { id: party, name: (await entryOf('party', party)).name, is_active: true },
        source_type: { id: type, is_active: true },
        receipt_reference: 'ใบส่งของ 123\nลงวันที่ 20 พ.ย.',
        note: 'ตรวจนับแล้ว',
        state: 'DRAFT',
      });
      expect(page.lines).toEqual([
        {
          id: expect.any(String),
          position: 0,
          stock_material: { id: paper.id, name: paper.name, is_active: true },
          unit: { unit_id: paper.box, name: expect.stringMatching(/^กล่อง /) },
          quantity: '2',
          unit_price: '150.5',
          note: 'ชั้นบน',
          is_voided: false,
          stock_movement_id: null,
          stock_movements: [],
        },
        expect.objectContaining({ position: 1, unit: { unit_id: paper.ream, name: expect.stringMatching(/^รีม /) }, quantity: '3', unit_price: '0', note: null }),
        expect.objectContaining({ position: 2, unit: null, quantity: null, unit_price: null }),
        expect.objectContaining({ position: 3, unit: null, quantity: null, unit_price: null }),
      ]);
      expect(await tableCount('stock_movements')).toBe(before);
      expect((await materialOf(paper.id)).current_stock).toBeNull();
    });

    it('saves a line of an Inactive Stock Material, a Unit its Stock Material no longer uses, and an Inactive Source Party and Source Type, which only a confirm refuses', async () => {
      const paper = await stocked();
      expect((await replaceUnits(paper.id, inOrder(unitsAsRead(await materialOf(paper.id)), [paper.box, false]))).statusCode).toBe(200);
      expect((await inactivate(paper.id, { expected_version: (await materialOf(paper.id)).version })).statusCode).toBe(200);
      const party = await entryNamed('party');
      const type = await entryNamed('type');
      expect((await entryWrite('party', party, 'inactivate')).statusCode).toBe(200);
      expect((await entryWrite('type', type, 'inactivate')).statusCode).toBe(200);
      const res = await createDraft({ source_party_id: party, source_type_id: type, lines: [line(paper.id, paper.box, '1')] });
      expect(res.statusCode).toBe(201);
      expect(await receiptOf(res.json().material_receipt_id)).toMatchObject({
        source_party: { id: party, is_active: false },
        source_type: { id: type, is_active: false },
        lines: [{ stock_material: { id: paper.id, is_active: false }, unit: { unit_id: paper.box } }],
      });
    });

    it('saves a Stock Material on two lines in different Units, or on two lines without a Unit yet, and refuses one Stock Material and Unit pair twice (Q9)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      expect((await createDraft({ lines: [line(paper.id, paper.box, '1'), line(paper.id, paper.ream, '1')] })).statusCode).toBe(201);
      expect((await createDraft({ lines: [line(paper.id, null, '1'), line(paper.id, null, '2')] })).statusCode).toBe(201);
      await expectDraftRefused(
        () => createDraft({ lines: [line(paper.id, paper.box, '1'), line(pens.id, pens.box, '1'), line(paper.id.toUpperCase(), paper.box.toUpperCase(), '2')] }),
        'lines[2].unit_id repeats the Stock Material and Unit of lines[0]'
      );
    });

    it('saves 50 lines, each a different Stock Material and Unit pair, and refuses a 51st', async () => {
      const materialsOf = await Promise.all(Array.from({ length: 26 }, () => stocked()));
      const pairs = materialsOf.flatMap((material) => [line(material.id, material.ream, '1'), line(material.id, material.box, '1')]);
      const res = await createDraft({ lines: pairs.slice(0, 50) });
      expect(res.statusCode).toBe(201);
      expect((await receiptOf(res.json().material_receipt_id)).lines).toHaveLength(50);
      await expectDraftRefused(() => createDraft({ lines: pairs.slice(0, 51) }), 'lines must hold at most 50 lines');
    });

    it('refuses a Received Date that is not a date, and saves one sent empty as none', async () => {
      await expectDraftRefused(() => createDraft({ received_date: '2026-02-30', lines: [] }), 'received_date must be a date (YYYY-MM-DD)');
      expect((await receiptOf(await draft({ received_date: null, source_party_id: null, source_type_id: null, lines: [] }))).received_date).toBeNull();
    });

    it('refuses a Receipt Reference over 500 characters or with a control character, a note over 2000 characters, and a line note over 500 (P7)', async () => {
      const paper = await stocked();
      expect((await createDraft({ receipt_reference: 'ก'.repeat(500), note: 'ข'.repeat(2000), lines: [line(paper.id, null, null, { note: 'ค'.repeat(500) })] })).statusCode).toBe(201);
      await expectDraftRefused(() => createDraft({ receipt_reference: 'ก'.repeat(501), lines: [] }), 'receipt_reference must be at most 500 characters');
      await expectDraftRefused(() => createDraft({ receipt_reference: 'ใบส่งของ\u0007', lines: [] }), 'receipt_reference must not contain control characters');
      await expectDraftRefused(() => createDraft({ note: 'ข'.repeat(2001), lines: [] }), 'note must be at most 2000 characters');
      await expectDraftRefused(() => createDraft({ lines: [line(paper.id, null, null, { note: 'ค'.repeat(501) })] }), 'lines[0].note must be at most 500 characters');
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
    });

    it('refuses a Unit Price that is not a decimal, has more than four decimal places, is too large, or is below 0, naming its line (Q8)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const second = (unitPrice: string) => createDraft({ lines: [line(pens.id, pens.ream, '1'), line(paper.id, paper.ream, '1', { unit_price: unitPrice })] });
      expect((await second('0')).statusCode).toBe(201);
      expect((await second('99.9999')).statusCode).toBe(201);
      await expectDraftRefused(() => second('ร้อย'), 'lines[1].unit_price must be a decimal number');
      await expectDraftRefused(() => second('1.00001'), 'lines[1].unit_price must have at most four decimal places');
      await expectDraftRefused(() => second('100000000000000'), 'lines[1].unit_price is too large');
      await expectDraftRefused(() => second('-0.0001'), 'lines[1].unit_price must be at least 0');
    });

    it('refuses a line naming no Stock Material or a Unit its Stock Material does not have, and a Source Party or Source Type not on its list', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const party = await entryNamed('party');
      const type = await entryNamed('type');
      await expectDraftRefused(() => createDraft({ lines: [line('กระดาษ', null, null)] }), 'lines[0].stock_material_id must be a valid UUID');
      await expectDraftRefused(() => createDraft({ lines: [line(paper.id, 'รีม', null)] }), 'lines[0].unit_id must be a valid UUID');
      await expectDraftRefused(() => createDraft({ lines: [line(pens.id, null, null), line(crypto.randomUUID(), null, null)] }), 'lines[1].stock_material_id must name a Stock Material');
      await expectDraftRefused(() => createDraft({ lines: [line(pens.id, pens.ream, null), line(paper.id, pens.ream, null)] }), 'lines[1].unit_id must name a Unit of its Stock Material');
      await expectDraftRefused(() => createDraft({ source_party_id: 'ร้าน', lines: [] }), 'source_party_id must be a valid UUID');
      await expectDraftRefused(() => createDraft({ source_type_id: 'ซื้อ', lines: [] }), 'source_type_id must be a valid UUID');
      await expectDraftRefused(() => createDraft({ source_party_id: type, lines: [] }), 'source_party_id must name a Source Party');
      await expectDraftRefused(() => createDraft({ source_type_id: party, lines: [] }), 'source_type_id must name a Source Type');
    });

    it('replaces the whole Draft at its version, a replace that changes nothing included (#234 start decision 2), by any Supply Officer', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const id = await draft({ source_party_id: party, receipt_reference: 'ใบเดิม', lines: [line(paper.id, paper.ream, '1', { unit_price: '10' })] });
      const res = await replaceDraft(id, { expected_version: 1, received_date: '2026-11-02', note: 'แก้แล้ว', lines: [line(paper.id, paper.box, '4')] }, crypto.randomUUID(), otherOfficer);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ material_receipt_id: id, version: 2 });
      const page = await receiptOf(id);
      expect(page).toMatchObject({ received_date: '2026-11-02', source_party: null, receipt_reference: null, note: 'แก้แล้ว', version: 2, history: [] });
      expect(page.lines).toEqual([expect.objectContaining({ position: 0, unit: expect.objectContaining({ unit_id: paper.box }), quantity: '4', unit_price: null })]);

      const same = await replaceDraft(id, { expected_version: 2, received_date: '2026-11-02', note: 'แก้แล้ว', lines: [line(paper.id, paper.box, '4')] });
      expect(same.statusCode).toBe(200);
      expect(same.json()).toEqual({ material_receipt_id: id, version: 3 });
      expect(await receiptOf(id)).toMatchObject({ version: 3, note: 'แก้แล้ว', history: [] });
    });

    it('refuses a replace at another version with the current one, a replace of a Draft that does not exist, and a remove at another version', async () => {
      const id = await draft({ note: 'เดิม', lines: [] });
      const stale = await replaceDraft(id, { expected_version: 2, note: 'ใหม่', lines: [] });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: 'STALE_BEFORE_CONFLICT',
        message: 'The Material Receipt changed since it was read',
        current_values: { version: 1, state: 'DRAFT' },
        expected_values: { version: 2 },
      });
      const missing = await replaceDraft(crypto.randomUUID(), { expected_version: 1, lines: [] });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
      const staleRemove = await removeDraft(id, 2);
      expect(staleRemove.statusCode).toBe(409);
      expect(staleRemove.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Receipt changed since it was read' });
      expect(await receiptOf(id)).toMatchObject({ note: 'เดิม', version: 1 });
    });

    it('removes a Draft with its lines for good at its version, leaving no trace, by any Supply Officer', async () => {
      const paper = await stocked();
      const before = await counts();
      const id = await draft(complete([line(paper.id, paper.ream, '1')]));
      const res = await removeDraft(id, 1, crypto.randomUUID(), otherOfficer);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ material_receipt_id: id });
      expect(await counts()).toEqual(before);
      const gone = await api.get(readonly, `/material-receipts/${id}`);
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
    });

    it('refuses a replace, a remove and a second confirm of a Received Material Receipt (Q4)', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '1')]);
      const before = await counts();
      for (const res of [await replaceDraft(id, { expected_version: 2, lines: [] }), await removeDraft(id, 2), await confirm(id, 2)]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          code: 'NOT_DRAFT',
          message: 'The Material Receipt is Received: only a Draft can be replaced, removed or confirmed',
          current_values: { version: 2, state: 'RECEIVED' },
          expected_values: { version: 2 },
        });
      }
      expect(await counts()).toEqual(before);
    });
  });

  describe('confirming (MRC-02, MRC-03, MRC-05, MSL-04, MSL-05, Q5, Q9, Q11, Q21, Q24, Q25, P1, P2)', () => {
    it('numbers the Material Receipt, adds one Stock Movement per line on its Received Date with its Conversion Snapshot, and raises Current Stock', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const type = await entryNamed('type');
      const partyName = (await entryOf('party', party)).name;
      const typeName = (await entryOf('type', type)).name;
      const id = await draft({
        received_date: '2026-11-10',
        source_party_id: party,
        source_type_id: type,
        receipt_reference: 'ใบส่งของ 77',
        note: 'ส่งครบ',
        lines: [line(paper.id, paper.box, '2', { unit_price: '450', note: 'ลังแรก' }), line(paper.id, paper.ream, '3')],
      });
      const res = await confirm(id, 1);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ material_receipt_id: id, receipt_number: expect.stringMatching(/^\d+$/), version: 2 });
      const number = res.json().receipt_number;

      const page = await receiptOf(id);
      expect(page).toMatchObject({ receipt_number: number, state: 'RECEIVED', version: 2, confirmed_by: officer.id, confirmed_by_username: 'officer_receipt' });
      expect(new Date(page.confirmed_at).getTime()).toBeGreaterThan(0);
      const [boxLine, reamLine] = page.lines;
      expect(boxLine.stock_movements).toEqual([
        {
          id: boxLine.stock_movement_id,
          kind: 'MATERIAL_RECEIPT',
          effective_date: '2026-11-10',
          original_quantity: '2',
          original_unit: { unit_id: paper.box, name: boxLine.unit.name },
          base_unit: { unit_id: paper.ream, name: reamLine.unit.name },
          conversion_factor: '5',
          base_quantity: '10',
          recorded_by: officer.id,
          recorded_by_username: 'officer_receipt',
          recorded_at: page.confirmed_at,
        },
      ]);
      expect(reamLine.stock_movements).toEqual([expect.objectContaining({ id: reamLine.stock_movement_id, original_quantity: '3', conversion_factor: '1', base_quantity: '3' })]);
      expect(page.history).toEqual([
        {
          version: 2,
          kind: 'CONFIRMED',
          facts: {
            receipt_number: number,
            received_date: '2026-11-10',
            source_party: { id: party, name: partyName },
            source_type: { id: type, name: typeName },
            receipt_reference: 'ใบส่งของ 77',
            note: 'ส่งครบ',
            lines: [
              { line_id: boxLine.id, position: 0, stock_material: { id: paper.id, name: paper.name }, quantity: '2', unit: { id: paper.box, name: boxLine.unit.name }, unit_price: '450', note: 'ลังแรก' },
              { line_id: reamLine.id, position: 1, stock_material: { id: paper.id, name: paper.name }, quantity: '3', unit: { id: paper.ream, name: reamLine.unit.name }, unit_price: null, note: null },
            ],
          },
          reason: null,
          recorded_by: officer.id,
          recorded_by_username: 'officer_receipt',
          recorded_at: page.confirmed_at,
        },
      ]);
      // The Unit Price moves no stock (MRC-08): 2 กล่อง of 5 and 3 รีม are 13 รีม.
      expect(await materialOf(paper.id)).toMatchObject({ current_stock: '13', has_stock_movement: true });
    });

    it('takes the next Receipt Number at each confirm, and sums every Received Material Receipt into Current Stock (MSL-03)', async () => {
      const paper = await stocked();
      const first = await received([line(paper.id, paper.ream, '4')]);
      const second = await received([line(paper.id, paper.box, '1')], { received_date: '2026-10-01' });
      expect(BigInt(second.number)).toBeGreaterThan(BigInt(first.number));
      expect((await materialOf(paper.id)).current_stock).toBe('9');
    });

    it('confirms a Received Date of today in Asia/Bangkok, an Inactive Stock Material, and a Unit whose list entry is Inactive while its Stock Material still uses it (Q11, MC-14)', async () => {
      const paper = await stocked();
      expect((await inactivate(paper.id, { expected_version: (await materialOf(paper.id)).version })).statusCode).toBe(200);
      const unit = (await api.get(readonly, '/units')).json().items.find((entry: any) => entry.id === paper.box);
      expect((await api.post(officer, `/units/${paper.box}/inactivate`, { expected_version: unit.version }, { 'x-retry-token': crypto.randomUUID() })).statusCode).toBe(200);
      const id = await draft(complete([line(paper.id, paper.box, '1')], { received_date: '2026-11-24' }));
      expect((await confirm(id, 1)).statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('5');
    });

    it('keeps in the confirmed entry the names as they were, or none, while the page shows them as they are now (#175 P6)', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const before = (await entryOf('party', party)).name;
      const { id } = await received([line(paper.id, paper.ream, '1')], { source_party_id: party });
      const renamed = `ร้านใหม่ ${crypto.randomUUID().slice(0, 6)}`;
      expect((await entryWrite('party', party, 'rename', { name: renamed })).statusCode).toBe(200);
      const page = await receiptOf(id);
      expect(page.source_party).toEqual({ id: party, name: renamed, is_active: true });
      expect(page.history[0].facts.source_party).toEqual({ id: party, name: before });
      expect(page.history[0].facts.source_type).toBeNull();
      // One confirmed with neither keeps neither.
      const plain = await received([line(paper.id, paper.ream, '1')]);
      expect((await receiptOf(plain.id)).history[0].facts).toMatchObject({ source_party: null, source_type: null });
    });

    it('refuses a Draft with no line', async () => {
      await expectNotConfirmable(await draft(complete([])), [{ field: 'lines', message: 'lines must hold at least one line' }]);
    });

    it('refuses a Draft with no Received Date, or one after today in Asia/Bangkok (Q5, MRC-05)', async () => {
      const paper = await stocked();
      await expectNotConfirmable(await draft({ lines: [line(paper.id, paper.ream, '1')] }), [{ field: 'received_date', message: 'received_date is required' }]);
      await expectNotConfirmable(await draft(complete([line(paper.id, paper.ream, '1')], { received_date: '2026-11-25' })), [
        { field: 'received_date', message: 'received_date must not be after today (2026-11-24, Asia/Bangkok)' },
      ]);
    });

    it('refuses a line with no Unit, or with no quantity, naming it', async () => {
      const paper = await stocked();
      const pens = await stocked();
      await expectNotConfirmable(await draft(complete([line(pens.id, pens.ream, '1'), line(paper.id, null, '1'), line(paper.id, paper.ream, null)])), [
        { field: 'lines[1].unit_id', message: 'lines[1].unit_id is required' },
        { field: 'lines[2].quantity', message: 'lines[2].quantity is required' },
      ]);
    });

    it('refuses a line in a Unit its Stock Material no longer uses, naming it (Q11)', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.ream, '1'), line(paper.id, paper.box, '1')]));
      expect((await replaceUnits(paper.id, inOrder(unitsAsRead(await materialOf(paper.id)), [paper.box, false]))).statusCode).toBe(200);
      await expectNotConfirmable(id, [{ field: 'lines[1].unit_id', message: 'lines[1].unit_id names a Unit that is not active on its Stock Material' }]);
    });

    it('refuses a fraction in a whole-number Unit, and a Base Quantity that is not whole or has more than four decimal places, naming the line', async () => {
      const paper = await stocked();
      await expectNotConfirmable(await draft(complete([line(paper.id, paper.ream, '1.5')])), [{ field: 'lines[0].quantity', message: 'lines[0].quantity must be a whole number in its Unit' }]);
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

    it('refuses an Inactive Source Party, naming it, and confirms once it is active again (Q24)', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const name = (await entryOf('party', party)).name;
      const id = await draft(complete([line(paper.id, paper.ream, '1')], { source_party_id: party }));
      expect((await entryWrite('party', party, 'inactivate')).statusCode).toBe(200);
      await expectNotConfirmable(id, [{ field: 'source_party_id', message: `source_party_id names ${name}, a Source Party that is Inactive` }]);
      expect((await entryWrite('party', party, 'reactivate')).statusCode).toBe(200);
      expect((await confirm(id, 1)).statusCode).toBe(200);
    });

    it('refuses an Inactive Source Type, naming it (Q24)', async () => {
      const paper = await stocked();
      const type = await entryNamed('type');
      const name = (await entryOf('type', type)).name;
      const id = await draft(complete([line(paper.id, paper.ream, '1')], { source_type_id: type }));
      expect((await entryWrite('type', type, 'inactivate')).statusCode).toBe(200);
      await expectNotConfirmable(id, [{ field: 'source_type_id', message: `source_type_id names ${name}, a Source Type that is Inactive` }]);
    });

    it('refuses a line of a Stock Material whose Opening Balance in effect is as of the Received Date or later, and confirms one dated after it (Q21, story 23)', async () => {
      const paper = await stocked();
      const pens = await stocked();
      const opening = await openingBalances.confirmed([openingBalances.line(paper.id, paper.ream, '10')], { as_of_date: '2026-10-31' });
      const inEffect = { opening_balance_id: opening.id, opening_balance_number: opening.number, as_of_date: '2026-10-31' };
      // A Stock Material with no Opening Balance takes any date (story 45).
      const onAsOf = await draft(complete([line(pens.id, pens.ream, '1'), line(paper.id, paper.box, '1'), line(paper.id, paper.ream, '1')], { received_date: '2026-10-31' }));
      const message = (position: number) =>
        `lines[${position}].stock_material_id names ${paper.name}, whose Opening Balance ${opening.number} is as of 2026-10-31: received_date must be after it`;
      await expectNotConfirmable(onAsOf, [
        { field: 'lines[1].stock_material_id', message: message(1), in_effect_opening_balance: inEffect },
        { field: 'lines[2].stock_material_id', message: message(2), in_effect_opening_balance: inEffect },
      ]);
      await expectNotConfirmable(await draft(complete([line(paper.id, paper.ream, '1')], { received_date: '2026-10-01' })), [
        { field: 'lines[0].stock_material_id', message: message(0), in_effect_opening_balance: inEffect },
      ]);
      const after = await draft(complete([line(paper.id, paper.ream, '1')], { received_date: '2026-11-01' }));
      expect((await confirm(after, 1)).statusCode).toBe(200);
      expect((await materialOf(paper.id)).current_stock).toBe('11');
    });

    it('names every failing rule and line at once', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const type = await entryNamed('type');
      const id = await draft({ source_party_id: party, source_type_id: type, lines: [line(paper.id, null, null)] });
      expect((await entryWrite('party', party, 'inactivate')).statusCode).toBe(200);
      expect((await entryWrite('type', type, 'inactivate')).statusCode).toBe(200);
      await expectNotConfirmable(id, [
        { field: 'received_date', message: 'received_date is required' },
        { field: 'source_party_id', message: `source_party_id names ${(await entryOf('party', party)).name}, a Source Party that is Inactive` },
        { field: 'source_type_id', message: `source_type_id names ${(await entryOf('type', type)).name}, a Source Type that is Inactive` },
        { field: 'lines[0].unit_id', message: 'lines[0].unit_id is required' },
        { field: 'lines[0].quantity', message: 'lines[0].quantity is required' },
      ]);
    });

    it('refuses a confirm at another version, or of a Material Receipt that does not exist', async () => {
      const paper = await stocked();
      const id = await draft(complete([line(paper.id, paper.ream, '1')]));
      const before = await counts();
      const stale = await confirm(id, 2);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', message: 'The Material Receipt changed since it was read', current_values: { version: 1, state: 'DRAFT' } });
      const missing = await confirm(crypto.randomUUID(), 1);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', message: 'Material Receipt not found' });
      expect(await counts()).toEqual(before);
    });
  });

  describe('beside the Opening Balance (story 40; #234 start decision 3)', () => {
    it('refuses an Opening Balance of a Stock Material with a Stock Movement in effect from a Material Receipt, naming the Material Receipt of the lowest number', async () => {
      const paper = await stocked();
      const first = await received([line(paper.id, paper.ream, '2')]);
      await received([line(paper.id, paper.box, '1')]);
      const opening = await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.ream, '5')]));
      const res = await openingBalances.confirm(opening, 1);
      expect(res.statusCode).toBe(409);
      const message = `lines[0].stock_material_id names ${paper.name}, a Stock Material with a Stock Movement in effect, from Material Receipt ${first.number}`;
      expect(res.json()).toMatchObject({ code: 'NOT_CONFIRMABLE', message: `The Opening Balance cannot be confirmed: ${message}` });
      expect(res.json().problems).toEqual([{ field: 'lines[0].stock_material_id', message, in_effect_material_receipt: { material_receipt_id: first.id, receipt_number: first.number } }]);
      expect((await materialOf(paper.id)).current_stock).toBe('7');
    });

    it('lets a Draft of a Material Receipt leave an Opening Balance free (story 45)', async () => {
      const paper = await stocked();
      await draft(complete([line(paper.id, paper.ream, '2')]));
      expect((await openingBalances.confirm(await openingBalances.draft(openingBalances.complete([openingBalances.line(paper.id, paper.ream, '5')])), 1)).statusCode).toBe(200);
    });
  });

  describe('the Source Party and Source Type usage counts (#231 Model; #234 start decision 4)', () => {
    it('counts the Material Receipts naming each entry, Drafts and Received alike', async () => {
      const paper = await stocked();
      const party = await entryNamed('party');
      const other = await entryNamed('party');
      const type = await entryNamed('type');
      expect((await entryOf('party', party)).usage_count).toBe(0);
      await draft({ source_party_id: party, lines: [] });
      await received([line(paper.id, paper.ream, '1')], { source_party_id: party, source_type_id: type });
      await draft({ source_party_id: other, source_type_id: type, lines: [] });
      expect((await entryOf('party', party)).usage_count).toBe(2);
      expect((await entryOf('party', other)).usage_count).toBe(1);
      expect((await entryOf('type', type)).usage_count).toBe(2);
    });
  });

  describe('the list (story 56)', () => {
    it('lists the Material Receipts newest first with number, Received Date, Source Party, state and line count, by state and by text in the number, the Receipt Reference, the Source Party or a Stock Material name', async () => {
      const tag = crypto.randomUUID().slice(0, 8).replace(/\d/g, 'x');
      const paper = await stocked({ name: `แฟ้ม ${tag}` });
      const party = await entryNamed('party', `ร้าน ${tag}`);
      const byParty = await draft({ source_party_id: party, lines: [] });
      const byReference = await draft({ receipt_reference: `ใบส่งของ ${tag}`, lines: [] });
      const byMaterial = await received([line(paper.id, paper.ream, '1'), line(paper.id, paper.box, '1')]);

      const all = await listOf(`search=${encodeURIComponent(tag)}`);
      expect(all).toMatchObject({ total_count: 3, has_more: false, limit: 25, offset: 0, can_manage: false });
      expect(all.items).toEqual([
        { id: byMaterial.id, receipt_number: byMaterial.number, received_date: '2026-11-01', fiscal_year: 2570, source_party: null, state: 'RECEIVED', line_count: 2, created_at: expect.any(String) },
        expect.objectContaining({ id: byReference, receipt_number: null, state: 'DRAFT', line_count: 0 }),
        expect.objectContaining({ id: byParty, source_party: { id: party, name: `ร้าน ${tag}` }, state: 'DRAFT' }),
      ]);
      expect((await listOf(`search=${encodeURIComponent(tag)}&state=draft`)).items.map(({ id }: { id: string }) => id)).toEqual([byReference, byParty]);
      expect((await listOf(`search=${encodeURIComponent(tag)}&state=received`)).items.map(({ id }: { id: string }) => id)).toEqual([byMaterial.id]);
      expect((await listOf(`search=${encodeURIComponent(`ใบส่งของ ${tag}`)}`)).items.map(({ id }: { id: string }) => id)).toEqual([byReference]);
      expect((await listOf(`search=${encodeURIComponent(`ร้าน ${tag}`)}`)).items.map(({ id }: { id: string }) => id)).toEqual([byParty]);
      expect((await listOf(`search=${encodeURIComponent(`แฟ้ม ${tag}`)}`)).items.map(({ id }: { id: string }) => id)).toEqual([byMaterial.id]);
      // Other records' names may hold the digits, so the number finds this one and leaves out the Drafts above, which
      // hold no digit (#233 lesson 3).
      const byNumber = (await listOf(`search=${byMaterial.number}&limit=100`)).items.map(({ id }: { id: string }) => id);
      expect(byNumber).toContain(byMaterial.id);
      expect(byNumber).not.toContain(byReference);
      expect(byNumber).not.toContain(byParty);
    });

    it('splits two Material Receipts recorded at the same moment across a page break by id', async () => {
      const tag = crypto.randomUUID().slice(0, 8).replace(/\d/g, 'y');
      const one = await draft({ receipt_reference: `คู่ ${tag}`, lines: [] });
      const two = await draft({ receipt_reference: `คู่ ${tag}`, lines: [] });
      await api.pool.query(`UPDATE material_receipts SET created_at = '2026-11-20T10:00:00+07:00' WHERE id = ANY($1::uuid[])`, [[one, two]]);
      const [high, low] = [one, two].sort().reverse();
      expect((await listOf(`search=${encodeURIComponent(`คู่ ${tag}`)}&limit=1&offset=0`)).items.map(({ id }: { id: string }) => id)).toEqual([high]);
      expect((await listOf(`search=${encodeURIComponent(`คู่ ${tag}`)}&limit=1&offset=1`)).items.map(({ id }: { id: string }) => id)).toEqual([low]);
    });

    it('refuses a state it does not know', async () => {
      const refused = await api.get(readonly, '/material-receipts?state=voided');
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('state') });
    });
  });

  // F010-T4 (#235): ปีงบประมาณ, worked out from the Received Date, Drafts included (MSL-09–MSL-11, Q16, P3; #235 start
  // decisions 1 and 2).
  describe('the Fiscal Year (story 26, story 56)', () => {
    it('shows the Fiscal Year of each Received Date, 1 October to 30 September named by the Buddhist-era year it ends in, a Draft\'s too, on the list and the page', async () => {
      const tag = crypto.randomUUID().slice(0, 8).replace(/\d/g, 'p');
      const paper = await stocked();
      const lastOf2568 = await received([line(paper.id, paper.ream, '1')], { received_date: '2025-09-30', receipt_reference: `ปี ${tag}` });
      const firstOf2569 = await draft({ received_date: '2025-10-01', receipt_reference: `ปี ${tag}`, lines: [] });
      const lastOf2569 = await received([line(paper.id, paper.ream, '1')], { received_date: '2026-09-30', receipt_reference: `ปี ${tag}` });
      const firstOf2570 = await draft({ received_date: '2026-10-01', receipt_reference: `ปี ${tag}`, lines: [] });
      const undated = await draft({ receipt_reference: `ปี ${tag}`, lines: [] });

      const rows = (await listOf(`search=${encodeURIComponent(`ปี ${tag}`)}`)).items.map(({ id, fiscal_year }: { id: string; fiscal_year: number | null }) => [id, fiscal_year]);
      expect(rows).toEqual([
        [undated, null],
        [firstOf2570, 2570],
        [lastOf2569.id, 2569],
        [firstOf2569, 2569],
        [lastOf2568.id, 2568],
      ]);
      for (const [id, fiscalYear] of [
        [lastOf2568.id, 2568],
        [firstOf2569, 2569],
        [lastOf2569.id, 2569],
        [firstOf2570, 2570],
        [undated, null],
      ] as const) {
        expect((await receiptOf(id)).fiscal_year).toBe(fiscalYear);
      }
    });

    it('filters by Fiscal Year as a range of Received Dates, with the state and the search, leaving out a Draft with no Received Date', async () => {
      const tag = crypto.randomUUID().slice(0, 8).replace(/\d/g, 'q');
      const paper = await stocked();
      const lastOf2568 = await received([line(paper.id, paper.ream, '1')], { received_date: '2025-09-30', receipt_reference: `กรองปี ${tag}` });
      const firstOf2569 = await draft({ received_date: '2025-10-01', receipt_reference: `กรองปี ${tag}`, lines: [] });
      const lastOf2569 = await received([line(paper.id, paper.ream, '1')], { received_date: '2026-09-30', receipt_reference: `กรองปี ${tag}` });
      const firstOf2570 = await draft({ received_date: '2026-10-01', receipt_reference: `กรองปี ${tag}`, lines: [] });
      await draft({ receipt_reference: `กรองปี ${tag}`, lines: [] });

      const idsOf = async (query: string) => {
        const list = await listOf(`search=${encodeURIComponent(`กรองปี ${tag}`)}&${query}`);
        expect(list.total_count).toBe(list.items.length);
        return list.items.map(({ id }: { id: string }) => id);
      };
      expect(await idsOf('fiscal_year=2568')).toEqual([lastOf2568.id]);
      expect(await idsOf('fiscal_year=2569')).toEqual([lastOf2569.id, firstOf2569]);
      expect(await idsOf('fiscal_year=2570')).toEqual([firstOf2570]);
      expect(await idsOf('fiscal_year=2567')).toEqual([]);
      expect(await idsOf('fiscal_year=2569&state=draft')).toEqual([firstOf2569]);
      expect(await idsOf('fiscal_year=2569&state=received')).toEqual([lastOf2569.id]);
    });

    it('offers each Fiscal Year that a Material Receipt has, newest first, whatever the filters', async () => {
      const tag = crypto.randomUUID().slice(0, 8).replace(/\d/g, 'r');
      // Only these two Drafts are dated in 2565 (1 October 2021 to 30 September 2022).
      await draft({ received_date: '2021-10-01', receipt_reference: `เสนอปี ${tag}`, lines: [] });
      await draft({ received_date: '2022-09-30', receipt_reference: `เสนอปี ${tag}`, lines: [] });
      await draft({ receipt_reference: `เสนอปี ${tag}`, lines: [] });
      const { fiscal_years: years }: { fiscal_years: number[] } = await listOf();
      // 2565 twice above, 2570 from Received Material Receipts of 2026-11-01, and no year for the Draft with none.
      expect(years).toEqual([...new Set(years)].sort((a: number, b: number) => b - a));
      expect(years).toEqual(expect.arrayContaining([2570, 2565]));
      expect(years.every((year: unknown) => Number.isInteger(year))).toBe(true);
      for (const query of [`search=${encodeURIComponent(`เสนอปี ${tag}`)}`, 'state=received', 'fiscal_year=2565&limit=1']) {
        expect((await listOf(query)).fiscal_years).toEqual(years);
      }
    });

    it('refuses a Fiscal Year that is not a four-digit Buddhist-era year', async () => {
      for (const year of ['abc', '256', '25690', '0256', '']) {
        const refused = await api.get(readonly, `/material-receipts?fiscal_year=${year}`);
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('Invalid query: fiscal_year') });
      }
    });
  });

  describe('retry tokens (Q26)', () => {
    it('needs a token on every write', async () => {
      const id = await draft();
      for (const res of [
        await api.post(officer, '/material-receipts', { lines: [] }),
        await api.put(officer, `/material-receipts/${id}`, { expected_version: 1, lines: [] }),
        await api.post(officer, `/material-receipts/${id}/remove`, { expected_version: 1 }),
        await api.post(officer, `/material-receipts/${id}/confirm`, { expected_version: 1 }),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('retry token') });
      }
      expect((await receiptOf(id)).version).toBe(1);
    });

    it('answers a replayed confirm with its first answer and adds no second Stock Movement (story 25)', async () => {
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
      expect((await materialOf(paper.id)).current_stock).toBe('2');
    });

    it('answers a replayed create, replace and remove with their first answers', async () => {
      const paper = await stocked();
      const createToken = crypto.randomUUID();
      const created1 = await createDraft({ lines: [line(paper.id, null, null)] }, createToken);
      const id = created1.json().material_receipt_id;
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

    // One case per field the fingerprint covers (CODING_STANDARDS, "A refusal test sends a request only its rule
    // refuses"; the fingerprint plan in start comment 7133951512).
    const fieldChanges = async () => {
      const paper = await stocked();
      const pens = await stocked();
      const party = await entryNamed('party');
      const otherParty = await entryNamed('party');
      const type = await entryNamed('type');
      const otherType = await entryNamed('type');
      const baseLine = (extra: Record<string, unknown> = {}) => line(paper.id, paper.ream, '1', { unit_price: '10', note: 'ชั้นบน', ...extra });
      const base = { received_date: '2026-11-01', source_party_id: party, source_type_id: type, receipt_reference: 'ใบ 1', note: 'หมายเหตุ', lines: [baseLine()] };
      const changes: Record<string, unknown>[] = [
        { received_date: '2026-11-02' },
        { source_party_id: otherParty },
        { source_type_id: otherType },
        { receipt_reference: 'ใบ 2' },
        { note: 'อื่น' },
        { lines: [baseLine({ stock_material_id: pens.id, unit_id: pens.ream })] },
        { lines: [baseLine({ unit_id: paper.box })] },
        { lines: [baseLine({ quantity: '2' })] },
        { lines: [baseLine({ unit_price: '11' })] },
        { lines: [baseLine({ note: 'ชั้นล่าง' })] },
      ];
      return { base, changes };
    };

    const expectMismatch = (res: { statusCode: number; json: () => any }) => {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'RETRY_TOKEN_PAYLOAD_MISMATCH', message: 'Retry token reused with different payload is rejected without writes' });
    };

    it('refuses a token replayed with one field of a create changed', async () => {
      const { base, changes } = await fieldChanges();
      for (const change of changes) {
        const token = crypto.randomUUID();
        expect((await createDraft(base, token)).statusCode).toBe(201);
        const before = await counts();
        expectMismatch(await createDraft({ ...base, ...change }, token));
        expect(await counts()).toEqual(before);
      }
    });

    it('refuses a token replayed with the Material Receipt, the version or one field of a replace changed', async () => {
      const { base, changes } = await fieldChanges();
      const one = await draft();
      const other = await draft();
      const token = crypto.randomUUID();
      expect((await replaceDraft(one, { expected_version: 1, ...base }, token)).statusCode).toBe(200);
      expectMismatch(await replaceDraft(other, { expected_version: 1, ...base }, token));
      expectMismatch(await replaceDraft(one, { expected_version: 2, ...base }, token));
      for (const change of changes) {
        expectMismatch(await replaceDraft(one, { expected_version: 1, ...base, ...change }, token));
      }
      expect((await receiptOf(other)).version).toBe(1);
      expect((await receiptOf(one)).version).toBe(2);
    });

    it('refuses a token replayed with the Material Receipt or the version of a confirm or a remove changed', async () => {
      for (const send of [confirm, removeDraft]) {
        const paper = await stocked();
        const pens = await stocked();
        const one = await draft(complete([line(paper.id, paper.ream, '1')]));
        const other = await draft(complete([line(pens.id, pens.ream, '1')]));
        const token = crypto.randomUUID();
        expect((await send(one, 1, token)).statusCode).toBe(200);
        expectMismatch(await send(other, 1, token));
        expectMismatch(await send(one, 2, token));
        expect(await receiptOf(other)).toMatchObject({ state: 'DRAFT', version: 1 });
      }
    });
  });

  describe('permissions (Q3, P8)', () => {
    it('lets every material:view holder read and only the Supply Officer write; every other role is refused on every route, and nothing is written', async () => {
      const paper = await stocked();
      const id = await draft({ receipt_reference: 'สิทธิ์รับ', lines: [line(paper.id, paper.ream, '1')] });
      for (const reader of [officer, admin, readonly]) {
        expect((await api.get(reader, '/material-receipts')).statusCode).toBe(200);
        expect((await api.get(reader, `/material-receipts/${id}`)).statusCode).toBe(200);
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
          expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
        }
      }
      for (const actor of [requester, custodian, staff, maintainer]) {
        for (const url of ['/material-receipts', `/material-receipts/${id}`]) {
          const res = await api.get(actor, url);
          expect(res.statusCode).toBe(403);
          expect(res.body).not.toContain('สิทธิ์รับ');
        }
      }
      expect(await counts()).toEqual(before);
    });

    // The Supply Officer holds both capabilities, so a gate on the other would let them through.
    it('needs material:view itself for each read and material:manage itself for each write, failing closed when the lookup fails', async () => {
      const paper = await stocked();
      const id = await draft({ receipt_reference: 'ปิดสิทธิ์รับ', lines: [line(paper.id, paper.ream, '1')] });
      for (const url of [`/material-receipts?search=${encodeURIComponent('ปิดสิทธิ์รับ')}`, `/material-receipts/${id}`]) {
        const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, () => api.get(officer, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('ปิดสิทธิ์รับ');
        const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, () => api.get(officer, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('ปิดสิทธิ์รับ');
      }
      const before = await counts();
      const writes = [() => createDraft({ lines: [] }), () => replaceDraft(id, { expected_version: 1, lines: [] }), () => removeDraft(id, 1), () => confirm(id, 1)];
      for (const write of writes) {
        const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, write);
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Permission denied' });
        const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, write);
        expect(failed.statusCode).toBe(500);
        expect(failed.json().error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected internal server error occurred.' });
      }
      expect(await counts()).toEqual(before);
    });

    it('tells the list and the page whether the viewer may write, which follows material:manage alone', async () => {
      const id = await draft();
      for (const url of ['/material-receipts?limit=1', `/material-receipts/${id}`]) {
        expect((await api.get(officer, url)).json().can_manage).toBe(true);
        for (const viewer of [admin, readonly]) {
          expect((await api.get(viewer, url)).json().can_manage).toBe(false);
        }
        const denied = await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => api.get(officer, url));
        expect(denied.statusCode).toBe(200);
        expect(denied.json().can_manage).toBe(false);
      }
    });

    it('needs a session and the CSRF token for every write', async () => {
      const id = await draft();
      const before = await counts();
      for (const [method, url, payload] of [
        ['POST', '/material-receipts', { lines: [] }],
        ['PUT', `/material-receipts/${id}`, { expected_version: 1, lines: [] }],
        ['POST', `/material-receipts/${id}/remove`, { expected_version: 1 }],
        ['POST', `/material-receipts/${id}/confirm`, { expected_version: 1 }],
      ] as const) {
        const inject = (headers: Record<string, string>) =>
          api.app.inject({ method, url, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });
        expect([401, 403]).toContain((await inject({})).statusCode);
        expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      }
      expect(await counts()).toEqual(before);
    });

    it('refuses an id that is not a UUID on every route with one', async () => {
      for (const res of [
        await api.get(readonly, '/material-receipts/not-a-uuid'),
        await replaceDraft('not-a-uuid', { expected_version: 1, lines: [] }),
        await removeDraft('not-a-uuid', 1),
        await confirm('not-a-uuid', 1),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'INVALID_ID', message: 'Material Receipt ID must be a valid UUID string' });
      }
    });
  });

  describe('Stock Movements at the database (MSL-04, story 61)', () => {
    it('refuses every UPDATE and DELETE of a รับวัสดุ Stock Movement, and a second line pointing at one', async () => {
      const paper = await stocked();
      const { id } = await received([line(paper.id, paper.ream, '2')]);
      const movementId = (await receiptOf(id)).lines[0].stock_movement_id;
      await expect(api.pool.query('UPDATE stock_movements SET base_quantity = 5 WHERE id = $1', [movementId])).rejects.toThrow('Stock Movements are append-only: UPDATE refused');
      await expect(api.pool.query('DELETE FROM stock_movements WHERE id = $1', [movementId])).rejects.toThrow('Stock Movements are append-only: DELETE refused');
      const other = await draft({ lines: [line((await stocked()).id, null, null)] });
      const otherLine = (await receiptOf(other)).lines[0].id;
      await expect(api.pool.query('UPDATE material_receipt_lines SET stock_movement_id = $2 WHERE id = $1', [otherLine, movementId])).rejects.toThrow(/material_receipt_lines/);
      expect((await materialOf(paper.id)).current_stock).toBe('2');
    });
  });
});
