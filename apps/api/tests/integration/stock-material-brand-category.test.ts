import * as crypto from 'node:crypto';
  // It confirms any Duplicate Candidate (F008-T5): the Stock Materials here share names.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// Text of `length` characters.
const text = (length: number) => 'ก'.repeat(length);

// F008-T4 (#179): a Stock Material's Brand and Material Category, chosen when it is created, its Material Category
// and note changed later without a reason, and the list searched by Brand and filtered by Material Category (#175
// MC-10, MC-12, MC-26, Q2, Q3, Q4, Q11, Q15, Q18, Q21, Q23, P6, P7).
describe('Stock Material Brand and Material Category (Seam A - F008-T4)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit every Stock Material here counts in.
  let sheet: string;

  const { unitNamed, createMaterial, created, materialOf, brandNamed, materialCategoryNamed, changeDetails, materialCount } = materialHelpers(() => ({
    api,
    officer,
    reader: readonly,
  }));
  const { whileWriting, untilWaiting } = lockHelpers(() => ({ api }));

  // A valid creation: กระดาษ A4 counted in แผ่น, unless `overrides` says otherwise.
  const paper = (overrides: Record<string, unknown> = {}) => ({ name: 'กระดาษ A4', base_unit: { unit_id: sheet }, explicit_continuation: true, ...overrides });

  // A refused creation: its message naming `field`, and nothing saved.
  const expectCreateRefused = async (payload: Record<string, unknown>, field: string) => {
    const before = await materialCount();
    const res = await createMaterial(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialCount()).toBe(before);
  };

  // Makes an entry Inactive where it is stored, as F008-T8 will.
  const inactivate = (table: 'brands' | 'material_categories', id: string) => api.pool.query(`UPDATE ${table} SET is_active = false, version = version + 1 WHERE id = $1`, [id]);

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_brand', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_brand', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_brand', 'READ_ONLY');
    custodian = await api.actor('custodian_brand', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_brand', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_brand', 'SYSTEM_MAINTAINER');
    sheet = await unitNamed('แผ่น');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('creating', () => {
    it('creates a Stock Material with a Brand and a Material Category, which its page shows and its history records by name', async () => {
      const brand = await brandNamed('Double A');
      const category = await materialCategoryNamed('วัสดุสำนักงาน');

      const res = await createMaterial(paper({ model: 'Premium', brand_id: brand, material_category_id: category, note: 'ใช้ทั่วไป' }));

      expect(res.statusCode).toBe(201);
      const page = await materialOf(res.json().stock_material_id);
      expect(page).toMatchObject({ brand: { id: brand, name: 'Double A' }, material_category: { id: category, name: 'วัสดุสำนักงาน' } });
      expect(page.history[0].changes.map(({ field }: { field: string }) => field)).toEqual(['name', 'brand', 'model', 'material_category', 'note', 'units']);
      expect(page.history[0].changes).toContainEqual({ field: 'brand', before: null, after: { id: brand, name: 'Double A' } });
      expect(page.history[0].changes).toContainEqual({ field: 'material_category', before: null, after: { id: category, name: 'วัสดุสำนักงาน' } });
    });

    it('needs neither: a Brand and a Material Category left out or null are none, and the history lists neither', async () => {
      for (const payload of [paper(), paper({ brand_id: null, material_category_id: null })]) {
        const page = await materialOf((await createMaterial(payload)).json().stock_material_id);

        expect(page).toMatchObject({ brand: null, material_category: null });
        expect(page.history[0].changes.map(({ field }: { field: string }) => field)).toEqual(['name', 'units']);
      }
    });

    it('refuses a Brand or a Material Category that is not an id, not on its list, or on the other list', async () => {
      const brand = await brandNamed();
      const category = await materialCategoryNamed();

      await expectCreateRefused(paper({ brand_id: 'not-a-brand' }), 'brand_id');
      await expectCreateRefused(paper({ material_category_id: 'not-a-category' }), 'material_category_id');
      await expectCreateRefused(paper({ brand_id: crypto.randomUUID() }), 'brand_id');
      await expectCreateRefused(paper({ material_category_id: crypto.randomUUID() }), 'material_category_id');
      await expectCreateRefused(paper({ brand_id: category }), 'brand_id');
      await expectCreateRefused(paper({ material_category_id: brand }), 'material_category_id');
    });

    it('refuses an Inactive Brand or Material Category (Q21)', async () => {
      const brand = await brandNamed();
      const category = await materialCategoryNamed();
      await inactivate('brands', brand);
      await inactivate('material_categories', category);

      await expectCreateRefused(paper({ brand_id: brand }), 'brand_id');
      await expectCreateRefused(paper({ material_category_id: category }), 'material_category_id');
    });

    it('waits for a Brand being made Inactive and then refuses it', async () => {
      const brand = await brandNamed();
      const before = await materialCount();

      const [res] = await whileWriting(
        // What making a Brand Inactive writes (F008-T8), held uncommitted.
        { sql: 'UPDATE brands SET is_active = false, version = version + 1 WHERE id = $1', params: [brand] },
        () => [createMaterial(paper({ brand_id: brand }))],
        () => untilWaiting('brands', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('brand_id');
      expect(await materialCount()).toBe(before);
    });

    it('waits for a Material Category being made Inactive and then refuses it', async () => {
      const category = await materialCategoryNamed();
      const before = await materialCount();

      const [res] = await whileWriting(
        { sql: 'UPDATE material_categories SET is_active = false, version = version + 1 WHERE id = $1', params: [category] },
        () => [createMaterial(paper({ material_category_id: category }))],
        () => untilWaiting('material_categories', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('material_category_id');
      expect(await materialCount()).toBe(before);
    });

    it('keeps Brand and Material Category names in history as they were when recorded, while the page shows their names now (P6)', async () => {
      const brand = await brandNamed('Dubble A');
      const category = await materialCategoryNamed('วัสดุสำนักกงาน');
      const id = await created(paper({ brand_id: brand, material_category_id: category }));
      // The renames of F008-T8, written where they are stored.
      await api.pool.query(`UPDATE brands SET name = 'Double A ตัวจริง', version = version + 1 WHERE id = $1`, [brand]);
      await api.pool.query(`UPDATE material_categories SET name = 'วัสดุสำนักงานจริง', version = version + 1 WHERE id = $1`, [category]);

      const page = await materialOf(id);

      expect(page).toMatchObject({ brand: { name: 'Double A ตัวจริง' }, material_category: { name: 'วัสดุสำนักงานจริง' } });
      expect(page.history[0].changes).toContainEqual({ field: 'brand', before: null, after: { id: brand, name: 'Dubble A' } });
      expect(page.history[0].changes).toContainEqual({ field: 'material_category', before: null, after: { id: category, name: 'วัสดุสำนักกงาน' } });
    });

    it('fingerprints the Brand and the Material Category with the rest of the request', async () => {
      const token = crypto.randomUUID();
      const chosen = { brand_id: await brandNamed(), material_category_id: await materialCategoryNamed() };
      expect((await createMaterial(paper(chosen), token)).statusCode).toBe(201);

      for (const changed of [paper({ ...chosen, brand_id: await brandNamed() }), paper({ ...chosen, material_category_id: await materialCategoryNamed() })]) {
        const res = await createMaterial(changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
    });
  });

  describe('the list', () => {
    // The ids of the rows a reader gets for `query`, sorted.
    const idsListed = async (query: string): Promise<string[]> => {
      const res = await api.get(readonly, `/stock-materials?${query}&limit=100`);
      expect(res.statusCode).toBe(200);
      return res.json().items.map(({ id }: { id: string }) => id).sort();
    };

    it('shows each row with its Brand and its Material Category, or none', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const brand = await brandNamed(`ยี่ห้อแถว ${tag}`);
      const category = await materialCategoryNamed(`หมวดแถว ${tag}`);
      const withBoth = await created(paper({ name: `แถว ${tag} ก`, brand_id: brand, material_category_id: category }));
      const withNeither = await created(paper({ name: `แถว ${tag} ข` }));

      const res = await api.get(readonly, `/stock-materials?search=${encodeURIComponent(`แถว ${tag}`)}`);

      expect(res.json().items).toMatchObject([
        { id: withBoth, brand: { id: brand, name: `ยี่ห้อแถว ${tag}` }, material_category: { id: category, name: `หมวดแถว ${tag}` } },
        { id: withNeither, brand: null, material_category: null },
      ]);
    });

    it('searches the Brand name too, ignoring case, but not the Material Category name (MC-10, Q15)', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const byBrand = await created(paper({ name: 'ปากกา', brand_id: await brandNamed(`Pentel ${tag}`) }));
      const byName = await created(paper({ name: `ปากกา pentel ${tag}` }));
      await created(paper({ name: 'ดินสอ', material_category_id: await materialCategoryNamed(`Pentel ${tag}`) }));

      expect(await idsListed(`search=${encodeURIComponent(`PENTEL ${tag}`)}`)).toEqual([byBrand, byName].sort());
    });

    it('filters by Material Category, or by none with "ไม่มีหมวด" (Q3)', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const office = await materialCategoryNamed(`สำนักงาน ${tag}`);
      const cleaning = await materialCategoryNamed(`ทำความสะอาด ${tag}`);
      const inOffice = [await created(paper({ name: `กรอง ${tag} 1`, material_category_id: office })), await created(paper({ name: `กรอง ${tag} 2`, material_category_id: office }))];
      const inCleaning = await created(paper({ name: `กรอง ${tag} 3`, material_category_id: cleaning }));
      const inNone = await created(paper({ name: `กรอง ${tag} 4` }));
      const search = `search=${encodeURIComponent(`กรอง ${tag}`)}`;

      expect(await idsListed(`${search}&material_category_id=${office}`)).toEqual(inOffice.sort());
      expect(await idsListed(`${search}&material_category_id=${encodeURIComponent(` ${cleaning.toUpperCase()} `)}`)).toEqual([inCleaning]);
      expect(await idsListed(`${search}&material_category_id=none`)).toEqual([inNone]);
      expect(await idsListed(search)).toEqual([...inOffice, inCleaning, inNone].sort());
      // An Inactive Material Category still finds the Stock Materials it groups (Q21).
      await inactivate('material_categories', cleaning);
      expect(await idsListed(`${search}&material_category_id=${cleaning}`)).toEqual([inCleaning]);
    });

    it('counts and pages within the Material Category filter', async () => {
      const tag = crypto.randomUUID().slice(0, 8);
      const category = await materialCategoryNamed(`นับ ${tag}`);
      await created(paper({ name: `นับ ${tag} ก`, material_category_id: category }));
      await created(paper({ name: `นับ ${tag} ข`, material_category_id: category }));
      await created(paper({ name: `นับ ${tag} ค` }));

      const res = await api.get(readonly, `/stock-materials?material_category_id=${category}&limit=1`);

      expect(res.json()).toMatchObject({ total_count: 2, has_more: true, items: [{ name: `นับ ${tag} ก` }] });
    });

    it('refuses a Material Category filter that is neither an id nor "none"', async () => {
      for (const value of ['not-an-id', 'NONE', '']) {
        const res = await api.get(readonly, `/stock-materials?material_category_id=${value}`);
        expect(res.statusCode, value).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('material_category_id') });
      }
    });
  });

  describe('changing other details (Q11)', () => {
    // A Stock Material with the Material Category `category` and a note, unless `overrides` says otherwise, and its page.
    const withDetails = async (overrides: Record<string, unknown> = {}) => {
      const category = await materialCategoryNamed();
      return materialOf(await created(paper({ material_category_id: category, note: 'หมายเหตุเดิม', ...overrides })));
    };

    // The details write that keeps a page's details as they are, at its version, for a test to change.
    const detailsAsRead = (page: { version: number; material_category: { id: string } | null; note: string | null; minimum_stock: string | null }) => ({
      expected_version: page.version,
      material_category_id: page.material_category?.id ?? null,
      note: page.note,
      minimum_stock: page.minimum_stock,
    });

    // A refused details write: its message naming `field`, and the Stock Material left as it was.
    const expectDetailsRefused = async (id: string, payload: Record<string, unknown>, field: string) => {
      const before = await materialOf(id);
      const res = await changeDetails(id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
      expect(await materialOf(id)).toEqual(before);
    };

    it('changes the Material Category and the note without a reason, with the values before and after in history', async () => {
      const page = await withDetails();
      const other = await materialCategoryNamed('ทำความสะอาด');

      const res = await changeDetails(page.id, { expected_version: 1, material_category_id: other, note: 'ย้ายหมวด', minimum_stock: null });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 2 });
      const after = await materialOf(page.id);
      expect(after).toMatchObject({ version: 2, material_category: { id: other, name: 'ทำความสะอาด' }, note: 'ย้ายหมวด', name: page.name, brand: page.brand, units: page.units });
      expect(after.history[1]).toEqual({
        version: 2,
        kind: 'DETAILS_CHANGED',
        changes: [
          { field: 'material_category', before: page.material_category, after: { id: other, name: 'ทำความสะอาด' } },
          { field: 'note', before: 'หมายเหตุเดิม', after: 'ย้ายหมวด' },
        ],
        reason: null,
        note: null,
        recorded_by: officer.id,
        recorded_by_username: 'officer_brand',
        recorded_at: expect.any(String),
      });
    });

    it('lists only what changed: the note alone, or the Material Category alone', async () => {
      const page = await withDetails();
      expect((await changeDetails(page.id, { ...detailsAsRead(page), note: 'หมายเหตุใหม่' })).statusCode).toBe(200);
      const other = await materialCategoryNamed();
      expect((await changeDetails(page.id, { ...detailsAsRead(page), expected_version: 2, note: 'หมายเหตุใหม่', material_category_id: other })).statusCode).toBe(200);

      const { history } = await materialOf(page.id);

      expect(history[1].changes).toEqual([{ field: 'note', before: 'หมายเหตุเดิม', after: 'หมายเหตุใหม่' }]);
      expect(history[2].changes.map(({ field }: { field: string }) => field)).toEqual(['material_category']);
    });

    it('clears the Material Category and the note, and sets them again', async () => {
      const page = await withDetails();

      expect((await changeDetails(page.id, { expected_version: 1, material_category_id: null, note: '  ', minimum_stock: null })).statusCode).toBe(200);
      const cleared = await materialOf(page.id);
      expect(cleared).toMatchObject({ material_category: null, note: null });
      expect(cleared.history[1].changes).toEqual([
        { field: 'material_category', before: page.material_category, after: null },
        { field: 'note', before: 'หมายเหตุเดิม', after: null },
      ]);

      expect((await changeDetails(page.id, { expected_version: 2, material_category_id: page.material_category.id, note: 'กลับมา', minimum_stock: null })).statusCode).toBe(200);
      const setAgain = await materialOf(page.id);
      expect(setAgain).toMatchObject({ material_category: page.material_category, note: 'กลับมา' });
      expect(setAgain.history[2].changes).toEqual([
        { field: 'material_category', before: null, after: page.material_category },
        { field: 'note', before: null, after: 'กลับมา' },
      ]);
    });

    it('refuses a details write that changes nothing', async () => {
      const page = await withDetails();

      await expectDetailsRefused(page.id, detailsAsRead(page), 'changes nothing');
      // A note that differs only by the spaces around it is stored the same.
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), note: ' หมายเหตุเดิม ' }, 'changes nothing');
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), material_category_id: page.material_category.id.toUpperCase() }, 'changes nothing');
    });

    it('refuses a new Material Category that is not an id, not on its list, on the other list, or Inactive', async () => {
      const page = await withDetails();
      const retired = await materialCategoryNamed();
      await inactivate('material_categories', retired);

      await expectDetailsRefused(page.id, { ...detailsAsRead(page), material_category_id: 'not-a-category' }, 'material_category_id');
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), material_category_id: crypto.randomUUID() }, 'material_category_id');
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), material_category_id: await brandNamed() }, 'material_category_id');
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), material_category_id: retired }, 'material_category_id');
    });

    it('keeps a Material Category made Inactive since it was chosen, while the note changes (Q21)', async () => {
      const page = await withDetails();
      await inactivate('material_categories', page.material_category.id);

      const res = await changeDetails(page.id, { ...detailsAsRead(page), note: 'หมวดหยุดใช้แล้ว' });

      expect(res.statusCode).toBe(200);
      expect(await materialOf(page.id)).toMatchObject({ material_category: page.material_category, note: 'หมวดหยุดใช้แล้ว' });
    });

    it('takes a note of 2000 characters with tab and line breaks inside it, and refuses one more or any other control character (P7)', async () => {
      const page = await withDetails();

      await expectDetailsRefused(page.id, { ...detailsAsRead(page), note: text(2001) }, 'note');
      await expectDetailsRefused(page.id, { ...detailsAsRead(page), note: 'หมายเหตุ\u0007' }, 'note');
      // 1987 characters, then 13: a tab, "แท็บ", a line break and "บรรทัด".
      const note = `${text(1987)}\tแท็บ\r\nบรรทัด`;
      expect(note).toHaveLength(2000);
      expect((await changeDetails(page.id, { ...detailsAsRead(page), note })).statusCode).toBe(200);
      expect((await materialOf(page.id)).note).toBe(note);
    });

    it('changes neither the name, the Brand, the Model nor the Specification, which a Material Correction does (Q11)', async () => {
      const page = await withDetails({ brand_id: await brandNamed() });

      for (const field of ['name', 'brand_id', 'model', 'specification']) {
        await expectDetailsRefused(page.id, { ...detailsAsRead(page), [field]: null }, field);
      }
    });

    it('needs both details, each stated even when none', async () => {
      const page = await withDetails();
      const { material_category_id: _category, ...noCategory } = detailsAsRead(page);
      const { note: _note, ...noNote } = detailsAsRead(page);

      await expectDetailsRefused(page.id, { ...noCategory, note: 'ใหม่' }, 'material_category_id');
      await expectDetailsRefused(page.id, { ...noNote, material_category_id: null }, 'note');
    });

    it('keeps Material Category names in history as they were when recorded (P6)', async () => {
      const page = await withDetails();
      const other = await materialCategoryNamed('หมวดสะกดผิด');
      expect((await changeDetails(page.id, { ...detailsAsRead(page), material_category_id: other })).statusCode).toBe(200);
      await api.pool.query(`UPDATE material_categories SET name = 'หมวดสะกดถูก', version = version + 1 WHERE id = $1`, [other]);

      const after = await materialOf(page.id);

      expect(after.material_category.name).toBe('หมวดสะกดถูก');
      expect(after.history[1].changes[0].after).toEqual({ id: other, name: 'หมวดสะกดผิด' });
    });
  });

  describe('versions and the request of other details', () => {
    const detailsOf = async () => {
      const page = await materialOf(await created(paper({ note: 'เดิม' })));
      return { page, payload: { expected_version: page.version, material_category_id: null, note: 'ใหม่', minimum_stock: null } };
    };

    it('refuses a stale expected version with the current and expected versions, writing nothing (Q23)', async () => {
      const { page, payload } = await detailsOf();
      expect((await changeDetails(page.id, payload)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      const res = await changeDetails(page.id, { ...payload, note: 'ใหม่กว่า' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('waits for a write holding the Stock Material and then refuses the version it changed', async () => {
      const { page, payload } = await detailsOf();

      const [res] = await whileWriting(
        // What another write of the Stock Material commits, held uncommitted.
        { sql: 'UPDATE stock_materials SET version = version + 1 WHERE id = $1', params: [page.id] },
        () => [changeDetails(page.id, payload)],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect((await materialOf(page.id)).note).toBe('เดิม');
    });

    it('waits for a Material Category being made Inactive and then refuses it', async () => {
      const { page, payload } = await detailsOf();
      const category = await materialCategoryNamed();

      const [res] = await whileWriting(
        { sql: 'UPDATE material_categories SET is_active = false, version = version + 1 WHERE id = $1', params: [category] },
        () => [changeDetails(page.id, { ...payload, material_category_id: category })],
        () => untilWaiting('material_categories', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('material_category_id');
      expect((await materialOf(page.id)).version).toBe(1);
    });

    it('waits for the Material Category it replaces being renamed and then records its new name as the one before (P6)', async () => {
      const replaced = await materialCategoryNamed('หมวดเก่าสะกดผิด');
      const page = await materialOf(await created(paper({ material_category_id: replaced })));

      const [res] = await whileWriting(
        // What renaming a Material Category writes (F008-T8), held uncommitted.
        { sql: `UPDATE material_categories SET name = 'หมวดเก่าสะกดถูก', version = version + 1 WHERE id = $1`, params: [replaced] },
        () => [changeDetails(page.id, { expected_version: 1, material_category_id: null, note: null, minimum_stock: null })],
        () => untilWaiting('material_categories', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).history[1].changes).toEqual([{ field: 'material_category', before: { id: replaced, name: 'หมวดเก่าสะกดถูก' }, after: null }]);
    });

    it('needs an expected version', async () => {
      const { page, payload } = await detailsOf();
      const { expected_version: _version, ...noVersion } = payload;

      const res = await changeDetails(page.id, noVersion);

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('expected_version');
      expect((await materialOf(page.id)).version).toBe(1);
    });

    it('answers 404 for a Stock Material that does not exist, and 400 for an id that is not one', async () => {
      const { payload } = await detailsOf();

      const missing = await changeDetails(crypto.randomUUID(), payload);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');
      const invalid = await changeDetails('not-an-id', payload);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe('INVALID_ID');
    });
  });

  describe('permissions', () => {
    it('lets the Supply Officer, the Administrator and the Read-only User read the Brand and Material Category of a Stock Material, and no one else', async () => {
      const brand = await brandNamed(`ยี่ห้ออ่าน ${crypto.randomUUID().slice(0, 8)}`);
      const id = await created(paper({ brand_id: brand }));

      for (const viewer of [officer, admin, readonly]) {
        expect((await materialOf(id, viewer)).brand.id).toBe(brand);
      }
      for (const other of [custodian, staff, maintainer]) {
        const res = await api.get(other, `/stock-materials/${id}`);
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain(brand);
      }
    });

    it('lets only the Supply Officer change other details', async () => {
      const page = await materialOf(await created(paper()));

      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await changeDetails(page.id, { expected_version: 1, material_category_id: null, note: 'ไม่ได้', minimum_stock: null }, crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs material:manage itself to change other details, and fails closed when the lookup fails, writing nothing', async () => {
      const page = await materialOf(await created(paper()));
      const payload = { expected_version: 1, material_category_id: null, note: 'ไม่ได้', minimum_stock: null };

      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => changeDetails(page.id, payload))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => changeDetails(page.id, payload));
      expect(failed.statusCode).toBe(500);
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs a session and the CSRF token to change other details', async () => {
      const page = await materialOf(await created(paper()));
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'PUT',
          url: `/stock-materials/${page.id}/details`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: { expected_version: 1, material_category_id: null, note: 'ไม่ได้', minimum_stock: null },
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await materialOf(page.id)).toEqual(page);
    });
  });

  describe('retry token of other details', () => {
    const fresh = async () => {
      const page = await materialOf(await created(paper()));
      return { page, payload: { expected_version: 1, material_category_id: null, note: 'ครั้งเดียว', minimum_stock: null } };
    };

    it('needs a token', async () => {
      const { page, payload } = await fresh();

      const res = await api.put(officer, `/stock-materials/${page.id}/details`, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('retry token');
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('answers an identical replay with the committed result and writes nothing, even after the version moved on', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      const first = await changeDetails(page.id, payload, token);
      expect(first.statusCode).toBe(200);
      const before = await materialOf(page.id);

      const replay = await changeDetails(page.id, payload, token);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await changeDetails(page.id, payload, token)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      for (const changed of [{ ...payload, note: 'อีกครั้ง' }, { ...payload, material_category_id: await materialCategoryNamed() }]) {
        const res = await changeDetails(page.id, changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_brand_two', 'SUPPLY_OFFICER');
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await changeDetails(page.id, payload, token)).statusCode).toBe(200);

      // Their request under the same token is their own write, refused at the version the first one moved.
      const theirs = await changeDetails(page.id, payload, token, otherOfficer);

      expect(theirs.statusCode).toBe(409);
      expect(theirs.json().code).toBe('STALE_BEFORE_CONFLICT');
    });

    it('scopes a token to its operation', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await createMaterial(paper(), token)).statusCode).toBe(201);

      const res = await changeDetails(page.id, payload, token);

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).note).toBe('ครั้งเดียว');
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 6 }, () => changeDetails(page.id, payload, token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((res) => res.json().version))).toEqual(new Set([2]));
      expect((await materialOf(page.id)).history).toHaveLength(2);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await changeDetails(page.id, { ...payload, note: text(2001) }, token)).statusCode).toBe(400);

      expect((await changeDetails(page.id, payload, token)).statusCode).toBe(200);
    });
  });
});
