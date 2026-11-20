import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';
import { materialHelpers } from './support/material-helpers.ts';

// Text of `length` characters.
const text = (length: number) => 'ก'.repeat(length);

// A name no other test here uses, and that holds no other name of this file: `stem` and a random tail.
const freshName = (stem: string) => `${stem} ${crypto.randomUUID().slice(0, 8)}`;

// F008-T5 (#181): the Duplicate Candidates (รายการที่อาจซ้ำ) of a name, the warning that creating a Stock Material
// gives with them, and the Material Correction (แก้ไขรายการที่บันทึกผิด) of a name, Brand, Model or Specification
// recorded wrong (#175 MC-03, MC-11, MC-17, MC-18, MC-22, Q11, Q12, Q23, P4, P7).
describe('Duplicate Candidates and Material Correction (Seam A - F008-T5)', () => {
  let api: ApiHarness;
  let officer: Actor;
  let admin: Actor;
  let readonly: Actor;
  let custodian: Actor;
  let staff: Actor;
  let maintainer: Actor;
  // The Unit every Stock Material here counts in.
  let sheet: string;

  const { unitNamed, createMaterial, materialOf, brandNamed, materialCategoryNamed, changeDetails, duplicateCandidatesOf, correct, materialCount } = materialHelpers(() => ({ api, officer, reader: readonly }));
  const { whileWriting, untilWaiting, untilWaitingOnAdvisoryLock } = lockHelpers(() => ({ api }));

  // What creating a Stock Material named `name` writes under the lock that orders the writes of names, held uncommitted
  // by `whileWriting`.
  const createHeld = (name: string) => ({
    sql: `WITH held AS (SELECT pg_advisory_xact_lock(hashtext('stock-material:identity'))),
               material AS (INSERT INTO stock_materials (name, created_by) SELECT $1, $2 FROM held RETURNING id)
          INSERT INTO stock_material_units (stock_material_id, unit_id, is_base, conversion_factor, whole_number_only, is_active)
          SELECT id, $3, true, 1, true, true FROM material`,
    params: [name, officer.id, sheet],
  });

  // What a Material Correction renaming the Stock Material `id` to `name` writes under the same lock, held uncommitted.
  const renameHeld = (id: string, name: string) => ({
    sql: `WITH held AS (SELECT pg_advisory_xact_lock(hashtext('stock-material:identity')))
          UPDATE stock_materials SET name = $2, version = version + 1 FROM held WHERE id = $1`,
    params: [id, name],
  });

  // Creates a Stock Material named `name`, counted in แผ่น, confirming any Duplicate Candidate, and answers its id.
  const createdNamed = async (name: string, overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await createMaterial({ name, base_unit: { unit_id: sheet }, explicit_continuation: true, ...overrides });
    expect(res.statusCode).toBe(201);
    return res.json().stock_material_id;
  };

  // Makes a Brand Inactive where it is stored, as F008-T8 will.
  const inactivateBrand = (id: string) => api.pool.query('UPDATE brands SET is_active = false, version = version + 1 WHERE id = $1', [id]);

  // Makes a Stock Material Inactive where it is stored, as F008-T7 will.
  const inactivate = (id: string) => api.pool.query('UPDATE stock_materials SET is_active = false, version = version + 1 WHERE id = $1', [id]);

  // The Duplicate Candidates a reader looks up for `name`, leaving out `excluded` when given.
  const candidatesOf = async (name: string, excluded?: string) => {
    const res = await duplicateCandidatesOf(`name=${encodeURIComponent(name)}${excluded ? `&exclude_stock_material_id=${excluded}` : ''}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    api = await startApiHarness();
    officer = await api.actor('officer_duplicate', 'SUPPLY_OFFICER');
    admin = await api.actor('admin_duplicate', 'ADMINISTRATOR');
    readonly = await api.actor('readonly_duplicate', 'READ_ONLY');
    custodian = await api.actor('custodian_duplicate', 'ASSET_CUSTODIAN');
    staff = await api.actor('staff_duplicate', 'VERIFICATION_STAFF');
    maintainer = await api.actor('maintainer_duplicate', 'SYSTEM_MAINTAINER');
    sheet = await unitNamed('แผ่น');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('looking up Duplicate Candidates', () => {
    it('finds a Stock Material whose name equals the name, contains it or is contained in it, ignoring case and repeated spaces, and nothing else', async () => {
      const stem = freshName('ลวดเย็บกระดาษ');
      const equal = await createdNamed(stem.toUpperCase());
      const containing = await createdNamed(`${stem}  เบอร์ 10`);
      const contained = await createdNamed(stem.slice(0, 8));
      await createdNamed(freshName('ลวดเย็บ'));

      const found = await candidatesOf(`  ${stem.replace(' ', '   ')} `);

      expect(new Set(found.candidates.map((candidate: any) => candidate.id))).toEqual(new Set([equal, containing, contained]));
      expect(found).toMatchObject({ total_count: 3, has_more: false, limit: 50, offset: 0 });
    });

    it('includes an Inactive Stock Material, and shows each candidate with its Brand, Model, Specification, Base Unit and status', async () => {
      const name = freshName('แฟ้มเอกสาร');
      const brand = await brandNamed();
      const id = await createdNamed(name, { brand_id: brand, model: 'สันกว้าง 3 นิ้ว', specification: 'สีน้ำเงิน\nขนาด A4' });
      await inactivate(id);

      const found = await candidatesOf(name);

      expect(found.candidates).toEqual([
        expect.objectContaining({
          id,
          name,
          brand: { id: brand, name: expect.any(String) },
          model: 'สันกว้าง 3 นิ้ว',
          specification: 'สีน้ำเงิน\nขนาด A4',
          base_unit: { unit_id: sheet, name: 'แผ่น' },
          is_active: false,
        }),
      ]);
    });

    it('leaves out the Stock Material it is given', async () => {
      const name = freshName('ซองจดหมาย');
      const itself = await createdNamed(name);
      const other = await createdNamed(`${name} มีจ่าหน้า`);

      const found = await candidatesOf(name, itself);

      expect(found.candidates.map((candidate: any) => candidate.id)).toEqual([other]);
      expect(found.total_count).toBe(1);
    });

    it('lists at most 50 candidates by name, with how many there are', async () => {
      const stem = freshName('ปากกาเน้นข้อความ');
      for (let i = 0; i < 51; i++) {
        await createdNamed(`${stem} สี ${String(i).padStart(2, '0')}`);
      }

      const found = await candidatesOf(stem);

      expect(found.candidates).toHaveLength(50);
      expect(found.candidates[0].name).toBe(`${stem} สี 00`);
      expect(found.candidates[49].name).toBe(`${stem} สี 49`);
      expect(found).toMatchObject({ total_count: 51, has_more: true, limit: 50, offset: 0 });
    });

    it('needs a nonblank name of one line of at most 200 characters, and a Stock Material to leave out that is an id', async () => {
      const cases: [string, string][] = [
        ['', 'name'],
        [`name=${encodeURIComponent('   ')}`, 'name'],
        [`name=${text(201)}`, 'name'],
        [`name=${encodeURIComponent('ลวด\nเย็บ')}`, 'name'],
        ['name=ลวด&exclude_stock_material_id=not-an-id', 'exclude_stock_material_id'],
      ];
      for (const [query, field] of cases) {
        const res = await duplicateCandidatesOf(query);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().message, query).toContain(field);
      }
      expect((await duplicateCandidatesOf(`name=${text(200)}`)).statusCode).toBe(200);
    });

    it('lets the Supply Officer, the Administrator and the Read-only User look up candidates, and no one else', async () => {
      const name = freshName('กาวแท่ง');
      const id = await createdNamed(name);

      for (const viewer of [officer, admin, readonly]) {
        const res = await duplicateCandidatesOf(`name=${encodeURIComponent(name)}`, viewer);
        expect(res.statusCode).toBe(200);
        expect(res.json().candidates.map((candidate: any) => candidate.id)).toEqual([id]);
      }
      for (const other of [custodian, staff, maintainer]) {
        const res = await duplicateCandidatesOf(`name=${encodeURIComponent(name)}`, other);
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain(id);
      }
    });

    it('needs material:view itself to look up candidates, and fails closed when the lookup fails', async () => {
      const name = freshName('เทปใส');
      const id = await createdNamed(name);
      const lookUp = () => duplicateCandidatesOf(`name=${encodeURIComponent(name)}`, officer);

      const denied = await withCapabilityAnswer(api.app, 'material:view', async () => false, lookUp);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain(id);
      const failed = await withCapabilityAnswer(api.app, 'material:view', async () => { throw new Error('lookup failed'); }, lookUp);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain(id);
    });
  });

  describe('creating with Duplicate Candidates', () => {
    // A valid creation named `name`, counted in แผ่น.
    const named = (name: string, overrides: Record<string, unknown> = {}) => ({ name, base_unit: { unit_id: sheet }, ...overrides });

    it('refuses a Stock Material with Duplicate Candidates unless it is confirmed, listing them in Feature 002\'s contract, and saves nothing', async () => {
      const name = freshName('กระดาษโน้ต');
      const existing = await createdNamed(`${name} แบบกาว`);
      const before = await materialCount();

      const res = await createMaterial(named(name));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        statusCode: 409,
        code: 'DUPLICATE_CANDIDATES_FOUND',
        error: 'DUPLICATE_CANDIDATES_FOUND',
        candidates: [expect.objectContaining({ id: existing, name: `${name} แบบกาว`, base_unit: { unit_id: sheet, name: 'แผ่น' }, is_active: true })],
        total_count: 1,
        has_more: false,
        limit: 50,
        offset: 0,
      });
      expect(await materialCount()).toBe(before);
    });

    it('saves it when "เป็นคนละรายการ" is confirmed, with no uniqueness: the same name twice is two Stock Materials (MC-22)', async () => {
      const name = freshName('ถ่านไฟฉาย AA');
      const first = await createdNamed(name);

      const res = await createMaterial(named(name, { explicit_continuation: true }));

      expect(res.statusCode).toBe(201);
      const second = res.json().stock_material_id;
      expect(second).not.toBe(first);
      expect((await materialOf(second)).name).toBe(name);
      expect((await candidatesOf(name)).total_count).toBe(2);
    });

    it('saves a Stock Material with no Duplicate Candidate without a confirmation', async () => {
      const res = await createMaterial(named(freshName('ยางลบดินสอ')));

      expect(res.statusCode).toBe(201);
    });

    it('warns of an Inactive Stock Material too', async () => {
      const name = freshName('หมึกพิมพ์');
      const old = await createdNamed(name);
      await inactivate(old);

      const res = await createMaterial(named(name));

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates).toEqual([expect.objectContaining({ id: old, is_active: false })]);
    });

    it('lists at most 50 Duplicate Candidates in the warning, with how many there are (P4)', async () => {
      const stem = freshName('คลิปหนีบกระดาษ');
      for (let i = 0; i < 51; i++) {
        await createdNamed(`${stem} ขนาด ${String(i).padStart(2, '0')}`);
      }

      const res = await createMaterial(named(stem));

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates).toHaveLength(50);
      expect(res.json()).toMatchObject({ total_count: 51, has_more: true, limit: 50, offset: 0 });
    });

    it('refuses a request that cannot be saved for its own fault before it warns of Duplicate Candidates', async () => {
      const name = freshName('สมุดบันทึก');
      await createdNamed(name);

      const brand = await brandNamed();
      await inactivateBrand(brand);

      const res = await createMaterial(named(name, { brand_id: brand }));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('brand_id');
    });

    it('needs a confirmation that is true or false', async () => {
      const res = await createMaterial(named(freshName('ตลับเมตร'), { explicit_continuation: 'yes' }));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('explicit_continuation');
    });

    it('waits for a Stock Material being created under a similar name and then warns of it', async () => {
      const name = freshName('เครื่องเย็บกระดาษ');

      const [res] = await whileWriting(createHeld(`${name} ขนาดใหญ่`), () => [createMaterial(named(name))], () => untilWaitingOnAdvisoryLock('stock-material:identity'));

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates.map((candidate: any) => candidate.name)).toEqual([`${name} ขนาดใหญ่`]);
    });

    it('waits for a Material Correction renaming a Stock Material to a similar name and then warns of it', async () => {
      const name = freshName('แผ่นใสพลาสติก');
      const renamed = await createdNamed(freshName('ฟิล์มเคลือบบัตร'));
      expect((await candidatesOf(name)).total_count).toBe(0);

      const [res] = await whileWriting(renameHeld(renamed, `${name} แบบหนา`), () => [createMaterial(named(name))], () => untilWaitingOnAdvisoryLock('stock-material:identity'));

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates.map((candidate: any) => candidate.id)).toEqual([renamed]);
    });
  });

  describe('retry token of a confirmed creation', () => {
    it('stores no receipt for the warning, so the same token carries the confirmed request, which a replay answers again', async () => {
      const name = freshName('ไม้บรรทัด');
      await createdNamed(name);
      const token = crypto.randomUUID();
      expect((await createMaterial({ name, base_unit: { unit_id: sheet } }, token)).statusCode).toBe(409);

      const confirmed = await createMaterial({ name, base_unit: { unit_id: sheet }, explicit_continuation: true }, token);
      expect(confirmed.statusCode).toBe(201);
      const replay = await createMaterial({ name, base_unit: { unit_id: sheet }, explicit_continuation: true }, token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(confirmed.json());
      expect((await candidatesOf(name)).total_count).toBe(2);
    });

    it('refuses the same token without the confirmation once the confirmed request is saved, and writes nothing', async () => {
      const name = freshName('กรรไกร');
      await createdNamed(name);
      const token = crypto.randomUUID();
      expect((await createMaterial({ name, base_unit: { unit_id: sheet }, explicit_continuation: true }, token)).statusCode).toBe(201);
      const before = await materialCount();

      const res = await createMaterial({ name, base_unit: { unit_id: sheet } }, token);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await materialCount()).toBe(before);
    });

    it('answers the replay of an unconfirmed request saved with no candidate by its committed result, though a candidate exists by now', async () => {
      const name = freshName('คัตเตอร์');
      const token = crypto.randomUUID();
      const first = await createMaterial({ name, base_unit: { unit_id: sheet } }, token);
      expect(first.statusCode).toBe(201);
      await createdNamed(`${name} ใบมีดใหญ่`);

      const replay = await createMaterial({ name, base_unit: { unit_id: sheet } }, token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
    });
  });

  // The page a reader gets of a Stock Material created named `name`, with `overrides`.
  const pageNamed = async (name: string, overrides: Record<string, unknown> = {}) => materialOf(await createdNamed(name, overrides));

  // A Material Correction of `page` at its version: its identity as the page shows it, with `changes` over it.
  const correctionOf = (page: any, changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    expected_version: page.version,
    name: page.name,
    brand_id: page.brand?.id ?? null,
    model: page.model,
    specification: page.specification,
    reason: 'บันทึกผิดตอนสร้างรายการ',
    ...changes,
  });

  // A refused correction of `page`: its status, its code, its message naming `field`, and nothing written.
  const expectCorrectionRefused = async (page: any, payload: Record<string, unknown>, field: string) => {
    const res = await correct(page.id, payload);
    expect(res.statusCode, field).toBe(400);
    expect(res.json(), field).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(field) });
    expect(await materialOf(page.id)).toEqual(page);
  };

  describe('Material Correction', () => {
    it('corrects the name, Brand, Model and Specification with a reason, changing nothing else, and its history records the reason and each value before and after (MC-03, Q11)', async () => {
      const name = freshName('กระดาษถ่ายเอกสร');
      const wrongBrand = await brandNamed(freshName('Doble A'));
      const rightBrand = await brandNamed(freshName('Double A'));
      const category = await materialCategoryNamed();
      const page = await pageNamed(name, { brand_id: wrongBrand, model: 'Premuim', specification: '80 แกรม', note: 'ใช้ในงานธุรการ', material_category_id: category, minimum_stock: '10' });
      const corrected = name.replace('เอกสร', 'เอกสาร');

      const res = await correct(
        page.id,
        correctionOf(page, { name: `  ${corrected} `, brand_id: rightBrand, model: 'Premium', specification: '80 แกรม\nสีขาว', reason: '  สะกดชื่อ ยี่ห้อ และรุ่นผิด\nตามใบส่งของ ' })
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stock_material_id: page.id, version: 2 });
      const after = await materialOf(page.id);
      const { history: _before, ...unchanged } = page;
      const { history, ...rest } = after;
      expect(rest).toEqual({ ...unchanged, name: corrected, brand: { id: rightBrand, name: expect.stringContaining('Double A') }, model: 'Premium', specification: '80 แกรม\nสีขาว', version: 2 });
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({
        version: 2,
        kind: 'CORRECTED',
        reason: 'สะกดชื่อ ยี่ห้อ และรุ่นผิด\nตามใบส่งของ',
        note: null,
        recorded_by: officer.id,
        changes: [
          { field: 'name', before: name, after: corrected },
          { field: 'brand', before: { id: wrongBrand, name: page.brand.name }, after: { id: rightBrand, name: after.brand.name } },
          { field: 'model', before: 'Premuim', after: 'Premium' },
          { field: 'specification', before: '80 แกรม', after: '80 แกรม\nสีขาว' },
        ],
      });
    });

    it('records only the values it changes, a Brand taken away as none after', async () => {
      const brand = await brandNamed();
      const page = await pageNamed(freshName('น้ำยาลบคำผิด'), { brand_id: brand, model: 'แบบปากกา' });

      const res = await correct(page.id, correctionOf(page, { brand_id: null }));

      expect(res.statusCode).toBe(200);
      const after = await materialOf(page.id);
      expect(after.brand).toBeNull();
      expect(after.history[1].changes).toEqual([{ field: 'brand', before: { id: brand, name: page.brand.name }, after: null }]);
    });

    it('records a Brand given to a Stock Material that had none as none before', async () => {
      const page = await pageNamed(freshName('แท่นตัดเทป'));
      const brand = await brandNamed();

      const res = await correct(page.id, correctionOf(page, { brand_id: brand }));

      expect(res.statusCode).toBe(200);
      const after = await materialOf(page.id);
      expect(after.history[1].changes).toEqual([{ field: 'brand', before: null, after: { id: brand, name: after.brand.name } }]);
    });

    it('refuses a correction that changes nothing, the same text with other spaces around it included (Q11)', async () => {
      const page = await pageNamed(freshName('ซองพลาสติก'), { model: 'A4', specification: 'ใส' });

      await expectCorrectionRefused(page, correctionOf(page, { name: ` ${page.name}  `, model: ' A4', specification: 'ใส ' }), 'changes nothing');
    });

    it('needs a nonblank reason of at most 2000 characters with no control character but tab and line breaks (P7)', async () => {
      const page = await pageNamed(freshName('ตรายาง'));
      const corrected = { name: freshName('ตรายางวันที่') };

      await expectCorrectionRefused(page, correctionOf(page, { ...corrected, reason: '   ' }), 'reason');
      await expectCorrectionRefused(page, correctionOf(page, { ...corrected, reason: null }), 'reason');
      await expectCorrectionRefused(page, correctionOf(page, { ...corrected, reason: text(2001) }), 'reason');
      await expectCorrectionRefused(page, correctionOf(page, { ...corrected, reason: 'สะกด\u0007ผิด' }), 'reason');

      const res = await correct(page.id, correctionOf(page, { ...corrected, reason: `${text(1990)}\n\tสะกด` }));
      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).history[1].reason).toBe(`${text(1990)}\n\tสะกด`);
    });

    it('needs a nonblank name of one line of at most 200 characters, a Model of at most 200 and a Specification of at most 500 (P7)', async () => {
      const page = await pageNamed(freshName('เชือกฟาง'));

      await expectCorrectionRefused(page, correctionOf(page, { name: '  ' }), 'name');
      await expectCorrectionRefused(page, correctionOf(page, { name: text(201) }), 'name');
      await expectCorrectionRefused(page, correctionOf(page, { name: 'เชือก\nฟาง' }), 'name');
      await expectCorrectionRefused(page, correctionOf(page, { model: text(201) }), 'model');
      await expectCorrectionRefused(page, correctionOf(page, { model: 'ม้วน\tใหญ่' }), 'model');
      await expectCorrectionRefused(page, correctionOf(page, { specification: text(501) }), 'specification');
      await expectCorrectionRefused(page, correctionOf(page, { specification: 'สี\u0007แดง' }), 'specification');
      await expectCorrectionRefused(page, correctionOf(page, { brand_id: 'not-an-id' }), 'brand_id');

      const res = await correct(page.id, correctionOf(page, { name: text(200), model: text(200), specification: text(500) }));
      expect(res.statusCode).toBe(200);
    });

    it('needs every identity value stated, null for none, and the expected version', async () => {
      const page = await pageNamed(freshName('แม็กซ์'));

      for (const field of ['expected_version', 'name', 'brand_id', 'model', 'specification', 'reason']) {
        const { [field]: _left, ...payload } = correctionOf(page, { model: 'เบอร์ 10' });
        const res = await correct(page.id, payload);
        expect(res.statusCode, field).toBe(400);
        expect(res.json().message, field).toContain(field);
      }
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('chooses a new Brand only among active ones, and keeps an Inactive Brand the Stock Material already has (Q21)', async () => {
      const page = await pageNamed(freshName('กระดาษกาว'));
      const retired = await brandNamed();
      await inactivateBrand(retired);

      await expectCorrectionRefused(page, correctionOf(page, { brand_id: retired }), 'brand_id');

      const kept = await brandNamed();
      const withKept = await pageNamed(freshName('เทปกาวสองหน้า'), { brand_id: kept });
      await inactivateBrand(kept);
      const res = await correct(withKept.id, correctionOf(withKept, { model: 'หนา 1 มม.' }));
      expect(res.statusCode).toBe(200);
      expect((await materialOf(withKept.id)).brand.id).toBe(kept);
    });

    it('checks the correction for Duplicate Candidates, leaving out the Stock Material itself, and saves it once confirmed (MC-17)', async () => {
      const name = freshName('ผ้าหมึก');
      const page = await pageNamed(name);

      // The name kept is its own: nothing else is like it.
      expect((await correct(page.id, correctionOf(page, { model: 'LQ-310' }))).statusCode).toBe(200);
      const corrected = await materialOf(page.id);
      const other = await createdNamed(`${name} สีดำ ตลับยาว`);

      const warned = await correct(corrected.id, correctionOf(corrected, { name: `${name} สีดำ` }));
      expect(warned.statusCode).toBe(409);
      expect(warned.json()).toMatchObject({ code: 'DUPLICATE_CANDIDATES_FOUND', total_count: 1, has_more: false, limit: 50, offset: 0 });
      expect(warned.json().candidates.map((candidate: any) => candidate.id)).toEqual([other]);
      expect(await materialOf(page.id)).toEqual(corrected);

      const confirmed = await correct(corrected.id, correctionOf(corrected, { name: `${name} สีดำ`, explicit_continuation: true }));
      expect(confirmed.statusCode).toBe(200);
      expect((await materialOf(page.id)).name).toBe(`${name} สีดำ`);
    });

    it('checks a correction that keeps the name too (#181 decision 2)', async () => {
      const name = freshName('ลูกแม็ก');
      const page = await pageNamed(name);
      const twin = await createdNamed(name);

      const res = await correct(page.id, correctionOf(page, { model: 'เบอร์ 35' }));

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates.map((candidate: any) => candidate.id)).toEqual([twin]);
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('refuses a stale version with the version the Stock Material is at, and writes nothing (Q23)', async () => {
      const page = await pageNamed(freshName('หลอดไฟ'));
      expect((await changeDetails(page.id, { expected_version: 1, material_category_id: null, note: 'ห้องประชุม', minimum_stock: null })).statusCode).toBe(200);
      const before = await materialOf(page.id);

      const res = await correct(page.id, correctionOf(page, { model: 'LED 18 วัตต์' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: 2 }, expected_values: { version: 1 } });
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('waits for a write holding the Stock Material and then refuses the version it changed', async () => {
      const page = await pageNamed(freshName('สายไฟ'));

      const [res] = await whileWriting(
        // What another write of the Stock Material commits, held uncommitted.
        { sql: 'UPDATE stock_materials SET version = version + 1 WHERE id = $1', params: [page.id] },
        () => [correct(page.id, correctionOf(page, { model: 'VAF 2x1.5' }))],
        () => untilWaiting('stock_materials')
      );

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STALE_BEFORE_CONFLICT');
      expect((await materialOf(page.id)).model).toBeNull();
    });

    it('waits for a Brand being made Inactive and then refuses it', async () => {
      const page = await pageNamed(freshName('ปลั๊กพ่วง'));
      const brand = await brandNamed();

      const [res] = await whileWriting(
        { sql: 'UPDATE brands SET is_active = false, version = version + 1 WHERE id = $1', params: [brand] },
        () => [correct(page.id, correctionOf(page, { brand_id: brand }))],
        () => untilWaiting('brands', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('brand_id');
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('waits for the Brand it replaces being renamed and then records its new name as the one before (P6)', async () => {
      const replaced = await brandNamed(freshName('ยี่ห้อสะกดผิด'));
      const page = await pageNamed(freshName('ถุงขยะ'), { brand_id: replaced });

      const [res] = await whileWriting(
        // What renaming a Brand writes (F008-T8), held uncommitted.
        { sql: `UPDATE brands SET name = 'ยี่ห้อสะกดถูก ' || id::text, version = version + 1 WHERE id = $1`, params: [replaced] },
        () => [correct(page.id, correctionOf(page, { brand_id: null }))],
        () => untilWaiting('brands', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).history[1].changes).toEqual([{ field: 'brand', before: { id: replaced, name: `ยี่ห้อสะกดถูก ${replaced}` }, after: null }]);
    });

    it('waits for a Stock Material being created under a similar name and then warns of it', async () => {
      const name = freshName('กระดาษชำระ');
      const page = await pageNamed(name);

      const [res] = await whileWriting(
        createHeld(`${name} ม้วนใหญ่`),
        () => [correct(page.id, correctionOf(page, { model: 'หนา 2 ชั้น' }))],
        () => untilWaitingOnAdvisoryLock('stock-material:identity')
      );

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates.map((candidate: any) => candidate.name)).toEqual([`${name} ม้วนใหญ่`]);
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('waits for another Material Correction renaming a Stock Material to a similar name and then warns of it', async () => {
      const name = freshName('กระดาษคาร์บอน');
      const page = await pageNamed(name);
      const renamed = await createdNamed(freshName('กระดาษไข'));
      expect((await candidatesOf(name, page.id)).total_count).toBe(0);

      const [res] = await whileWriting(
        renameHeld(renamed, `${name} สีน้ำเงิน`),
        () => [correct(page.id, correctionOf(page, { model: 'แผ่นบาง' }))],
        () => untilWaitingOnAdvisoryLock('stock-material:identity')
      );

      expect(res.statusCode).toBe(409);
      expect(res.json().candidates.map((candidate: any) => candidate.id)).toEqual([renamed]);
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('waits for the Brand it chooses being renamed and then records its new name as the one after (P6)', async () => {
      const chosen = await brandNamed(freshName('ยี่ห้อใหม่สะกดผิด'));
      const page = await pageNamed(freshName('ถ่านกระดุม'));

      const [res] = await whileWriting(
        // What renaming a Brand writes (F008-T8), held uncommitted.
        { sql: `UPDATE brands SET name = 'ยี่ห้อใหม่สะกดถูก ' || id::text, version = version + 1 WHERE id = $1`, params: [chosen] },
        () => [correct(page.id, correctionOf(page, { brand_id: chosen }))],
        () => untilWaiting('brands', 1, 'FOR SHARE')
      );

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).history[1].changes).toEqual([{ field: 'brand', before: null, after: { id: chosen, name: `ยี่ห้อใหม่สะกดถูก ${chosen}` } }]);
    });

    it('answers 404 for a Stock Material that does not exist, and 400 for an id that is not one', async () => {
      const page = await pageNamed(freshName('น้ำดื่ม'));

      const missing = await correct(crypto.randomUUID(), correctionOf(page, { model: 'ขวด 600 มล.' }));
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');
      const invalid = await correct('not-an-id', correctionOf(page, { model: 'ขวด 600 มล.' }));
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe('INVALID_ID');
    });
  });

  describe('permissions of a Material Correction', () => {
    it('lets only the Supply Officer correct a Stock Material', async () => {
      const page = await pageNamed(freshName('แปรงลบกระดาน'));

      for (const other of [admin, readonly, custodian, staff, maintainer]) {
        const res = await correct(page.id, correctionOf(page, { model: 'ไม่ได้' }), crypto.randomUUID(), other);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs material:manage itself to correct, and fails closed when the lookup fails, writing nothing', async () => {
      const page = await pageNamed(freshName('ปากกาไวท์บอร์ด'));
      const payload = correctionOf(page, { model: 'ไม่ได้' });

      expect((await withCapabilityAnswer(api.app, 'material:manage', async () => false, () => correct(page.id, payload))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'material:manage', async () => { throw new Error('lookup failed'); }, () => correct(page.id, payload));
      expect(failed.statusCode).toBe(500);
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('needs a session and the CSRF token to correct', async () => {
      const page = await pageNamed(freshName('หมึกเติมปากกา'));
      const inject = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: `/stock-materials/${page.id}/corrections`,
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: correctionOf(page, { model: 'ไม่ได้' }),
        });

      expect([401, 403]).toContain((await inject({})).statusCode);
      expect((await inject({ cookie: officer.cookie })).statusCode).toBe(403);
      expect(await materialOf(page.id)).toEqual(page);
    });
  });

  describe('retry token of a Material Correction', () => {
    const fresh = async () => {
      const page = await pageNamed(freshName('แฟ้มแขวน'));
      return { page, payload: correctionOf(page, { model: 'ครั้งเดียว' }) };
    };

    it('needs a token', async () => {
      const { page, payload } = await fresh();

      const res = await api.post(officer, `/stock-materials/${page.id}/corrections`, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('retry token');
      expect(await materialOf(page.id)).toEqual(page);
    });

    it('answers an identical replay with the committed result and writes nothing, even after the version moved on', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      const first = await correct(page.id, payload, token);
      expect(first.statusCode).toBe(200);
      const before = await materialOf(page.id);

      const replay = await correct(page.id, payload, token);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await correct(page.id, payload, token)).statusCode).toBe(200);
      const before = await materialOf(page.id);

      for (const changed of [{ ...payload, reason: 'อีกเหตุผล' }, { ...payload, explicit_continuation: true }]) {
        const res = await correct(page.id, changed, token);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      }
      expect(await materialOf(page.id)).toEqual(before);
    });

    it('scopes a token to its actor', async () => {
      const otherOfficer = await api.actor('officer_duplicate_two', 'SUPPLY_OFFICER');
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await correct(page.id, payload, token)).statusCode).toBe(200);

      // Their request under the same token is their own write, refused at the version the first one moved.
      const theirs = await correct(page.id, payload, token, otherOfficer);

      expect(theirs.statusCode).toBe(409);
      expect(theirs.json().code).toBe('STALE_BEFORE_CONFLICT');
    });

    it('scopes a token to its operation', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();
      expect((await createMaterial({ name: freshName('ซองกันกระแทก'), base_unit: { unit_id: sheet } }, token)).statusCode).toBe(201);

      const res = await correct(page.id, payload, token);

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).model).toBe('ครั้งเดียว');
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const { page, payload } = await fresh();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 6 }, () => correct(page.id, payload, token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((res) => res.json().version))).toEqual(new Set([2]));
      expect((await materialOf(page.id)).history).toHaveLength(2);
    });

    it('stores no receipt for the Duplicate Candidates warning, so the same token carries the confirmed correction', async () => {
      const name = freshName('กระดาษปรู๊ฟ');
      const page = await pageNamed(name);
      await createdNamed(`${name} แผ่นใหญ่`);
      const token = crypto.randomUUID();
      const payload = correctionOf(page, { model: 'ปอนด์' });
      expect((await correct(page.id, payload, token)).statusCode).toBe(409);

      const res = await correct(page.id, { ...payload, explicit_continuation: true }, token);

      expect(res.statusCode).toBe(200);
      expect((await materialOf(page.id)).model).toBe('ปอนด์');
    });
  });
});
