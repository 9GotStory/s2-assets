import { test, expect } from '@playwright/test';
import { actorSwitch } from './support/actors.ts';
import { delaySessionCheck, endSessionDelay } from './support/session-check.ts';
import { createServer, type ViteDevServer } from 'vite';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, pg, type FastifyInstance, type StartedPostgreSqlContainer } from '../../../api/tests/journey-deps.ts';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { buildApp } from '../../../api/src/app.ts';
import { UserService } from '../../../api/src/services/user.service.ts';
import { SessionService } from '../../../api/src/services/session.service.ts';
import { StockMaterialService } from '../../../api/src/services/stock-material.service.ts';
import { CatalogListService } from '../../../api/src/services/catalog-list.service.ts';
import { MaterialReceiptService } from '../../../api/src/services/material-receipt.service.ts';
import { OpeningBalanceService } from '../../../api/src/services/opening-balance.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F010-T2 (#233): Journey J1 starts: a Supply Officer sets a Stock Material's Minimum Stock, records its Opening Balance
// as a Draft, is refused a confirm that lacks ที่มาของยอด with the rule named, completes the Draft, confirms it below the
// Minimum Stock, and sees คงเหลือ and ต่ำกว่าขั้นต่ำ on the list, under the Low Stock filter and on the page (#231 J1,
// MC-19, MC-20, Q13, Q14, Q22, Q25). T3 and later tickets go on with it.
// F010-T3 (#234): Journey J2 starts: a Supply Officer drafts a Material Receipt with a new แหล่งที่มา and two lines of
// one Stock Material in different Units, confirms it, and sees เลขที่รับ and คงเหลือ; Journey J3 starts: a Read-only
// User reads รับวัสดุ and ยอดตั้งต้น with no write action (#231 J2, J3, Q8, Q9, Q24).
// F010-T4 (#235): Journey J1 ends: the Supply Officer follows the Stock Material in รายการเคลื่อนไหว, its ยอดตั้งต้น
// row and a รับวัสดุ row with the balance after each, by ปีงบประมาณ and a page at a time, and finds the Material Receipt
// by its ปีงบประมาณ (#231 J1, stories 26, 50–52, 56, Q16, Q23; #235 start decisions 1–4).
// F010-T5 (#236): Journey J3 ends: a Read-only User reads คงเหลือ of a Stock Material with an Opening Balance, with no
// write action, and the Supply Officer's แก้ไขหน่วยนับ shows its หน่วยนับหลัก locked, with the reason, and still
// changes an อัตราแปลง (#231 J3, stories 53, 54, Q15, MC-09; #236 start decision 2).
// F010-T6 (#237): Journey J2 ends: the Supply Officer corrects J2's Material Receipt with a reason: a quantity fix shows
// กลับรายการ and the new row in รายการเคลื่อนไหว and the change in the history; คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน shows
// today's อัตราแปลง before save; a refused save names the line; a voided line stays shown as ยกเลิกแล้ว (#231 J2, Q18,
// Q25, Q29, story 35).
test.describe.serial('Material Stock journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;

  let officerUserId: string;
  let readonlyUserId: string;
  // Journey F010-T2.1's Stock Material and Draft, which Journey F010-T2.2 goes on with.
  let j1: { tag: string; name: string; ream: string; reamUnitId: string; boxUnitId: string; materialId: string; draftUrl: string };
  // Journey F010-T3.1's Stock Material and Material Receipt, which Journey F010-T6.1 corrects.
  let j2: { name: string; pen: string; box: string; penUnitId: string; boxUnitId: string; materialId: string; receiptId: string; receiptNumber: string };

  test.beforeAll(async () => {
    test.setTimeout(120_000);

    if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
      process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    }
    if (!process.env.DOCKER_HOST) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1001;
      const podmanSocket = `/run/user/${uid}/podman/podman.sock`;
      if (fs.existsSync(podmanSocket)) {
        process.env.DOCKER_HOST = `unix://${podmanSocket}`;
      }
    }

    container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
    const databaseUrl = container.getConnectionUri();
    await runMigrator({ command: 'latest', databaseUrl, migrationFolder });

    pool = new Pool({ connectionString: databaseUrl });
    sessionService = new SessionService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-material-stock-e2e',
      logger: false,
    });
    const fastifyAddr = await fastifyApp.listen({ port: 0, host: '127.0.0.1' });
    const match = fastifyAddr.match(/:(\d+)$/);
    const fastifyPort = match ? parseInt(match[1], 10) : 3000;

    const passwordHash = await UserService.hashPassword('Password123!');
    const createUser = async (username: string, role: string): Promise<string> => {
      const res = await pool.query('INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id', [username, passwordHash]);
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [res.rows[0].id, role]);
      return res.rows[0].id;
    };
    officerUserId = await createUser('officer_material_stock', 'SUPPLY_OFFICER');
    readonlyUserId = await createUser('readonly_material_stock', 'READ_ONLY');

    const testProxy: Record<string, any> = {};
    for (const [route, opts] of Object.entries(repositoryProxyConfig)) {
      testProxy[route] = { ...opts, target: `http://127.0.0.1:${fastifyPort}` };
    }
    viteServer = await createServer({
      root: webRoot,
      configFile: path.resolve(webRoot, 'vite.config.ts'),
      server: { port: 0, strictPort: false, proxy: testProxy },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    targetBaseUrl = typeof address === 'object' && address ? `http://localhost:${address.port}` : 'http://localhost:5173';
    (fastifyApp as any).publicAppOrigin = targetBaseUrl;
  });

  test.afterAll(async () => {
    if (viteServer) await viteServer.close();
    if (fastifyApp) await fastifyApp.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  const { loginAs, switchActor } = actorSwitch(() => sessionService, () => targetBaseUrl);

  test('Journey F010-T2.1: a Supply Officer sets a Minimum Stock, saves an Opening Balance Draft without ที่มาของยอด, and is refused its confirm with the rule named', async ({ page, context }) => {
    // The fact the journey needs, made here: a Stock Material counted in a whole-number Base Unit "รีม", with a
    // "กล่อง" of 5 รีม, no Minimum Stock and no Stock Movement.
    const tag = crypto.randomUUID().slice(0, 6);
    const name = `กระดาษถ่ายเอกสาร J1 ${tag}`;
    const ream = `รีม ${tag}`;
    const catalog = new CatalogListService({ db: pool });
    const reamUnit = await catalog.add(officerUserId, 'unit', { name: ream }, { retryToken: crypto.randomUUID() });
    const boxUnit = await catalog.add(officerUserId, 'unit', { name: `กล่อง ${tag}` }, { retryToken: crypto.randomUUID() });
    const { stock_material_id: materialId } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name, base_unit: { unit_id: reamUnit.id, whole_number_only: true }, alternate_units: [{ unit_id: boxUnit.id, conversion_factor: '5' }] },
      { retryToken: crypto.randomUUID() }
    );

    await loginAs(context, officerUserId);
    await delaySessionCheck(page);

    // Before any Stock Movement: no คงเหลือ, never ต่ำกว่าขั้นต่ำ (Q22).
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toHaveText('ยังไม่มีรายการเคลื่อนไหว');
    // F010-T4 (#235): so does รายการเคลื่อนไหว, which offers no ปีงบประมาณ yet.
    await expect(page.locator('#stock-movement-empty')).toHaveText('ยังไม่มีรายการเคลื่อนไหว');
    await expect(page.locator('#stock-movement-fiscal-year option')).toHaveText(['ทั้งหมด']);
    await expect(page.locator('#stock-movement-count')).toHaveCount(0);

    // The Supply Officer sets จำนวนขั้นต่ำ to 10 รีม.
    await page.locator('#stock-material-edit-details').click();
    await page.locator('#stock-material-details-minimum-stock').fill('10');
    await page.locator('#stock-material-details-submit').click();
    await expect(page.locator('#stock-material-details-form')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-minimum-stock"]')).toHaveText(`10 ${ream}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toHaveText('ยังไม่มีรายการเคลื่อนไหว');
    await expect(page.locator('[data-testid="stock-material-low-stock-badge"]')).toHaveCount(0);
    await endSessionDelay(page);

    // "ยอดตั้งต้น" from the Dashboard's "วัสดุ" menu, then "เพิ่มยอดตั้งต้น".
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-opening-balance-list').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น', exact: true })).toBeVisible();
    await page.locator('#opening-balance-add-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'เพิ่มยอดตั้งต้น' })).toBeVisible();

    // A Draft saves without ที่มาของยอด, and with a line in กล่อง whose quantity is not yet counted.
    await page.locator('#opening-balance-as-of-date').fill('2026-09-30');
    await page.locator('#opening-balance-stock-material-search').fill(name);
    await page.locator('#opening-balance-stock-material-search-submit').click();
    await page.locator(`[data-testid="opening-balance-choose-${materialId}"]`).click();
    await expect(page.locator('[data-testid="opening-balance-line-0"]')).toContainText(name);
    await page.locator('#opening-balance-line-0-unit').selectOption({ label: `กล่อง ${tag}` });
    await page.locator('#opening-balance-draft-submit').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();
    await expect(page.locator('[data-testid="opening-balance-source"]')).toHaveText('-');

    // The confirm is refused with every rule it fails named, a line's by its number in the table, and nothing is
    // recorded (Q25).
    await page.locator('#opening-balance-confirm-action').click();
    await page.locator('#opening-balance-confirm-submit').click();
    const problems = page.locator('[data-testid="opening-balance-confirm-problems"] li');
    await expect(problems).toHaveText(['source is required', 'รายการที่ 1: lines[0].quantity is required']);
    await page.locator('#opening-balance-confirm-cancel').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();
    j1 = { tag, name, ream, reamUnitId: reamUnit.id, boxUnitId: boxUnit.id, materialId, draftUrl: page.url() };
  });

  test('Journey F010-T2.2: the Supply Officer completes the Draft, confirms it below the Minimum Stock, and sees คงเหลือ and ต่ำกว่าขั้นต่ำ on the list, the Low Stock filter and the page', async ({ page, context }) => {
    const { tag, name, ream, reamUnitId, materialId, draftUrl } = j1;
    // A second fact made here: a Stock Material found by the same search, with a Minimum Stock and no Stock Movement,
    // so never ต่ำกว่าขั้นต่ำ (Q22).
    const { stock_material_id: untouchedId } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name: `ปากกาลูกลื่น J1 ${tag}`, base_unit: { unit_id: reamUnitId }, minimum_stock: '5' },
      { retryToken: crypto.randomUUID() }
    );
    await loginAs(context, officerUserId);
    await page.goto(draftUrl);
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();

    // "แก้ไขร่าง": ที่มาของยอด added, and the line moves to รีม: 7 รีม, below the Minimum Stock of 10.
    await page.locator('#opening-balance-edit-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'แก้ไขร่าง' })).toBeVisible();
    await expect(page.locator('#opening-balance-line-0-unit option:checked')).toHaveText(`กล่อง ${tag}`);
    await expect(page.locator('#opening-balance-line-0-quantity')).toHaveValue('');
    // Meanwhile a second tab saves the Draft with a หมายเหตุ, so the save on what was read first is refused as stale.
    const other = await context.newPage();
    await other.goto(`${draftUrl}/edit`);
    await expect(other.locator('#opening-balance-line-0-unit option:checked')).toHaveText(`กล่อง ${tag}`);
    await other.locator('#opening-balance-note').fill('นับเมื่อ 30 ก.ย.');
    await other.locator('#opening-balance-draft-submit').click();
    await expect(other.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();
    await other.close();
    const completeDraft = async () => {
      await page.locator('#opening-balance-source').fill('สมุดคุมวัสดุ ปีงบประมาณ 2569');
      await page.locator('#opening-balance-line-0-unit').selectOption({ label: ream });
      await page.locator('#opening-balance-line-0-quantity').fill('7');
      await page.locator('#opening-balance-draft-submit').click();
    };
    await completeDraft();
    const formError = page.locator('[data-testid="opening-balance-draft-form-error"]');
    await expect(formError).toContainText('มีผู้แก้ไขร่างนี้ไปแล้ว กรุณาโหลดใหม่');
    // A reload whose read fails says so and keeps what was typed; the next one reads the newer Draft (#237 retro).
    const draftRead = new RegExp(`${new URL(draftUrl).pathname}$`);
    await page.route(draftRead, (route: any) => (route.request().resourceType() === 'fetch' ? route.fulfill({ status: 500, body: '{}' }) : route.continue()));
    await page.locator('#opening-balance-draft-reload').click();
    await expect(formError).toContainText('ไม่สามารถดึงข้อมูลล่าสุดได้ กรุณาลองใหม่อีกครั้ง');
    await expect(page.locator('#opening-balance-source')).toHaveValue('สมุดคุมวัสดุ ปีงบประมาณ 2569');
    await expect(page.locator('#opening-balance-note')).toHaveValue('');
    await page.unroute(draftRead);
    await page.locator('#opening-balance-draft-reload').click();
    await expect(page.locator('#opening-balance-note')).toHaveValue('นับเมื่อ 30 ก.ย.');
    await expect(page.locator('#opening-balance-source')).toHaveValue('');
    await expect(page.locator('#opening-balance-line-0-unit option:checked')).toHaveText(`กล่อง ${tag}`);
    await completeDraft();
    await expect(page.locator('[data-testid="opening-balance-source"]')).toHaveText('สมุดคุมวัสดุ ปีงบประมาณ 2569');

    // "ยืนยันยอดตั้งต้น": the number is taken and the line's Stock Movement recorded in the Base Unit.
    await page.locator('#opening-balance-confirm-action').click();
    await page.locator('#opening-balance-confirm-submit').click();
    await expect(page.getByRole('heading', { level: 1, name: /^ยอดตั้งต้น เลขที่ยอดตั้งต้น \d+$/ })).toBeVisible();
    await expect(page.locator('[data-testid="opening-balance-state"]')).toHaveText('ยืนยันแล้ว');
    await expect(page.locator('[data-testid="opening-balance-line-0"]')).toContainText(`+7 ${ream} (7 ${ream} × 1)`);
    await expect(page.locator('#opening-balance-confirm-action')).toHaveCount(0);
    await expect(page.locator('#opening-balance-edit-action')).toHaveCount(0);

    // The Stock Material list shows คงเหลือ 7 รีม with ต่ำกว่าขั้นต่ำ, and the Low Stock filter finds it (MC-20, Q14).
    await page.goto(`${targetBaseUrl}/stock-materials?search=${encodeURIComponent(`J1 ${tag}`)}`);
    await expect(page.locator('#stock-material-list-table tbody tr')).toHaveCount(2);
    await expect(page.locator(`[data-testid="stock-material-current-stock-${materialId}"]`)).toContainText(`7 ${ream}`);
    await expect(page.locator(`[data-testid="stock-material-low-stock-badge-${materialId}"]`)).toHaveText('ต่ำกว่าขั้นต่ำ');
    await expect(page.locator(`[data-testid="stock-material-current-stock-${untouchedId}"]`)).toHaveText('ยังไม่มีรายการเคลื่อนไหว');
    await expect(page.locator(`[data-testid="stock-material-low-stock-badge-${untouchedId}"]`)).toHaveCount(0);
    // The filters re-render with the list they read, so the click is checked against the list it brings.
    await page.locator('#stock-material-low-stock-filter').click();
    await expect(page).toHaveURL(/low_stock=true/);
    await expect(page.locator('#stock-material-low-stock-filter')).toBeChecked();
    await expect(page.locator('#stock-material-list-table tbody tr')).toHaveCount(1);
    await expect(page.locator(`[data-testid="stock-material-row-${materialId}"]`)).toBeVisible();

    // And so does its page.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`7 ${ream}`);
    await expect(page.locator('[data-testid="stock-material-low-stock-badge"]')).toHaveText('ต่ำกว่าขั้นต่ำ');
  });

  test('Journey F010-T3.1: a Supply Officer drafts a Material Receipt with a new แหล่งที่มา and two lines of one Stock Material in different Units, confirms it, and sees เลขที่รับ and คงเหลือ', async ({ page, context }) => {
    // The fact the journey needs, made here: a Stock Material counted in a whole-number Base Unit "ด้าม", with a
    // "กล่อง" of 12 ด้าม and no Stock Movement.
    const tag = crypto.randomUUID().slice(0, 6);
    const name = `ปากกาน้ำเงิน J2 ${tag}`;
    const [pen, box] = [`ด้าม ${tag}`, `กล่อง ${tag}`];
    const catalog = new CatalogListService({ db: pool });
    const penUnit = await catalog.add(officerUserId, 'unit', { name: pen }, { retryToken: crypto.randomUUID() });
    const boxUnit = await catalog.add(officerUserId, 'unit', { name: box }, { retryToken: crypto.randomUUID() });
    const { stock_material_id: materialId } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name, base_unit: { unit_id: penUnit.id, whole_number_only: true }, alternate_units: [{ unit_id: boxUnit.id, conversion_factor: '12' }] },
      { retryToken: crypto.randomUUID() }
    );
    // Another Draft of it, with no แหล่งที่มา, which the list's search leaves out.
    const { material_receipt_id: otherDraftId } = await new MaterialReceiptService({ db: pool }).create(
      officerUserId,
      { lines: [{ stock_material_id: materialId }] },
      { retryToken: crypto.randomUUID() }
    );
    const party = `ร้านเครื่องเขียน J2 ${tag}`;

    await loginAs(context, officerUserId);

    // "รับวัสดุ" from the Dashboard's "วัสดุ" menu, then "เพิ่มรายการรับวัสดุ".
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-material-receipt-list').click();
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ', exact: true })).toBeVisible();
    await page.locator('#material-receipt-add-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'เพิ่มรายการรับวัสดุ' })).toBeVisible();

    // A new แหล่งที่มา added from the form, which it then names; no วันที่รับ yet.
    await page.locator('#material-receipt-new-source-party').fill(party);
    await page.locator('#material-receipt-new-source-party-add').click();
    await expect(page.locator('#material-receipt-source-party option:checked')).toHaveText(party);
    // The form loaded for a Supply Officer: no "not allowed" line, and no total while it has no line.
    await expect(page.locator('#material-receipt-form-not-allowed')).toHaveCount(0);
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveCount(0);

    // The Stock Material twice (Q9): 2 กล่อง at 120, then a second line, which takes the Unit no line of it holds, with
    // no quantity yet. An amount shows once its line has both, for reference only (Q8).
    await page.locator('#material-receipt-stock-material-search').fill(name);
    await page.locator('#material-receipt-stock-material-search-submit').click();
    await expect(page.locator('#material-receipt-stock-material-choices li')).toHaveCount(1);
    await page.locator(`[data-testid="material-receipt-choose-${materialId}"]`).click();
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(name);
    // F010-T6 (#237): a Draft's form numbers no line, shows no อัตราแปลง and asks no reason; a line is removed.
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).not.toContainText(`1. ${name}`);
    await expect(page.locator('#material-receipt-line-0-change-material')).toHaveCount(0);
    await expect(page.locator('#material-receipt-line-0-remove')).toBeVisible();
    await expect(page.locator('#material-receipt-correction-reason')).toHaveCount(0);
    await expect(page.locator('#material-receipt-draft-submit')).toHaveText('บันทึกร่าง');
    await page.locator('#material-receipt-line-0-unit').selectOption({ label: box });
    await page.locator('#material-receipt-line-0-quantity').fill('2');
    await expect(page.locator('[data-testid="material-receipt-line-0-amount"]')).toHaveText('-');
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveText('-');
    await page.locator('#material-receipt-line-0-unit-price').fill('120');
    await expect(page.locator('[data-testid="material-receipt-line-0-amount"]')).toHaveText('240.00');
    await page.locator(`[data-testid="material-receipt-choose-${materialId}"]`).click();
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).toContainText(name);
    await expect(page.locator('#material-receipt-line-1-unit option:checked')).toHaveText(pen);
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveText('240.00');
    await page.locator('#material-receipt-draft-submit').click();
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ ร่าง' })).toBeVisible();
    await expect(page.locator('[data-testid="material-receipt-source-party"]')).toHaveText(party);
    await expect(page.locator('[data-testid="material-receipt-reference"]')).toHaveText('-');
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveText('240.00');
    // A Draft is edited, never corrected (F010-T6, #237).
    await expect(page.locator('#material-receipt-correct-action')).toHaveCount(0);

    // The confirm is refused with every rule it fails named, a line's by its number in the table (Q25).
    await page.locator('#material-receipt-confirm-action').click();
    await expect(page.locator('#material-receipt-edit-action')).toHaveCount(0);
    await page.locator('#material-receipt-confirm-submit').click();
    await expect(page.locator('[data-testid="material-receipt-confirm-problems"] li')).toHaveText(['received_date is required', 'รายการที่ 2: lines[1].quantity is required']);
    await page.locator('#material-receipt-confirm-cancel').click();

    // "แก้ไขร่าง" reads the Draft back, and วันที่รับ and 5 ด้าม at 10.5 complete it.
    await page.locator('#material-receipt-edit-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'แก้ไขร่าง' })).toBeVisible();
    await expect(page.locator('#material-receipt-source-party option:checked')).toHaveText(party);
    await expect(page.locator('#material-receipt-line-0-unit option:checked')).toHaveText(box);
    await expect(page.locator('#material-receipt-line-0-quantity')).toHaveValue('2');
    await expect(page.locator('#material-receipt-line-0-unit-price')).toHaveValue('120');
    await expect(page.locator('#material-receipt-line-1-unit option:checked')).toHaveText(pen);
    await expect(page.locator('#material-receipt-line-1-quantity')).toHaveValue('');
    await expect(page.locator('#material-receipt-line-1-unit-price')).toHaveValue('');
    await expect(page.locator('#material-receipt-line-0-note')).toHaveValue('');
    await expect(page.locator('#material-receipt-line-0-void')).toHaveCount(0);
    await page.locator('#material-receipt-received-date').fill('2026-10-15');
    await page.locator('#material-receipt-line-1-unit-price').fill('10.5');
    await expect(page.locator('[data-testid="material-receipt-line-1-amount"]')).toHaveText('-');
    await page.locator('#material-receipt-line-1-quantity').fill('5');
    await expect(page.locator('[data-testid="material-receipt-line-1-amount"]')).toHaveText('52.50');
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveText('292.50');
    await page.locator('#material-receipt-draft-submit').click();
    await expect(page.locator('[data-testid="material-receipt-received-date"]')).toHaveText('15 ตุลาคม 2569');

    // "ยืนยันรับวัสดุ": the Receipt Number is taken and each line's Stock Movement recorded in the Base Unit.
    await page.locator('#material-receipt-confirm-action').click();
    await page.locator('#material-receipt-confirm-submit').click();
    const heading = page.getByRole('heading', { level: 1, name: /^รายการรับวัสดุ เลขที่รับ \d+$/ });
    await expect(heading).toBeVisible();
    await expect(page.locator('[data-testid="material-receipt-state"]')).toHaveText('รับแล้ว');
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`+24 ${pen} (2 ${box} × 12)`);
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).toContainText(`+5 ${pen} (5 ${pen} × 1)`);
    await expect(page.locator('#material-receipt-confirm-action')).toHaveCount(0);
    await expect(page.locator('#material-receipt-edit-action')).toHaveCount(0);
    await expect(page.locator('#material-receipt-history li')).toHaveCount(1);
    await expect(page.locator('#material-receipt-history li')).toContainText('ยืนยันรับวัสดุ โดย officer_material_stock');
    const receiptNumber = (await heading.textContent())!.replace('รายการรับวัสดุ เลขที่รับ ', '');
    j2 = { name, pen, box, penUnitId: penUnit.id, boxUnitId: boxUnit.id, materialId, receiptId: new URL(page.url()).pathname.split('/').pop()!, receiptNumber };

    // The list finds it by its แหล่งที่มา, Received, with its เลขที่รับ.
    await page.goto(`${targetBaseUrl}/material-receipts?search=${encodeURIComponent(party)}`);
    await expect(page.locator('#material-receipt-list-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#material-receipt-list-table tbody td')).toHaveText([receiptNumber, '15 ตุลาคม 2569', '2570', party, 'รับแล้ว', '2']);

    // คงเหลือ: 24 + 5 = 29 ด้าม.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`29 ${pen}`);

    // The other Draft, removed from its page, leaves the list.
    await page.goto(`${targetBaseUrl}/material-receipts/${otherDraftId}`);
    await page.locator('#material-receipt-remove-action').click();
    await expect(page.getByRole('heading', { level: 3, name: 'ลบร่าง' })).toBeVisible();
    await expect(page.locator('#material-receipt-remove-submit')).toHaveText('ลบร่าง');
    await page.locator('#material-receipt-remove-submit').click();
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ', exact: true })).toBeVisible();
    await expect(page.locator('#material-receipt-list-table')).toContainText(party);
    await expect(page.locator(`[data-testid="material-receipt-row-${otherDraftId}"]`)).toHaveCount(0);
  });

  test('Journey F010-T3.2: a Read-only User reads รับวัสดุ and ยอดตั้งต้น from the "วัสดุ" menu, Drafts included, with no write action', async ({ page, context }) => {
    // The facts the journey needs, made here: a Material Receipt Draft and an Opening Balance Draft of a new Stock
    // Material.
    const tag = crypto.randomUUID().slice(0, 6);
    const unit = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', { name: `ชิ้น J3 ${tag}` }, { retryToken: crypto.randomUUID() });
    const { stock_material_id: materialId } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name: `ยางลบ J3 ${tag}`, base_unit: { unit_id: unit.id } },
      { retryToken: crypto.randomUUID() }
    );
    const draftLines = { lines: [{ stock_material_id: materialId, unit_id: unit.id, quantity: '3' }] };
    const { material_receipt_id: receiptId } = await new MaterialReceiptService({ db: pool }).create(officerUserId, draftLines, { retryToken: crypto.randomUUID() });
    const { opening_balance_id: balanceId } = await new OpeningBalanceService({ db: pool }).create(officerUserId, draftLines, { retryToken: crypto.randomUUID() });

    await loginAs(context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-material-receipt-list').click();
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ', exact: true })).toBeVisible();
    await expect(page.locator(`[data-testid="material-receipt-row-${receiptId}"] td`)).toHaveText(['ร่าง', '-', '-', '-', 'ร่าง', '1']);
    await expect(page.locator('#material-receipt-add-action')).toHaveCount(0);
    // Found by its line's Stock Material from the search box; Drafts only keeps it, Received only does not.
    await page.locator('#material-receipt-search').fill(`ยางลบ J3 ${tag}`);
    await page.locator('#material-receipt-search-submit').click();
    await expect(page).toHaveURL(/[?&]search=/);
    await expect(page.locator('#material-receipt-list-table tbody tr')).toHaveCount(1);
    await page.locator('#material-receipt-state-filter').selectOption('draft');
    // The state joins the search, which stays.
    await expect(page).toHaveURL(/\?search=[^&]+&state=draft$/);
    await expect(page.locator(`[data-testid="material-receipt-row-${receiptId}"]`)).toHaveCount(1);
    await page.locator('#material-receipt-state-filter').selectOption('received');
    await expect(page).toHaveURL(/[?&]state=received/);
    await expect(page.locator('#material-receipt-list-empty')).toHaveText('ไม่พบรายการรับวัสดุที่ค้นหา');
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ ร่าง' })).toBeVisible();
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`ยางลบ J3 ${tag}`);
    // F010-T4 (#235): a Draft with no Received Date has no ปีงบประมาณ yet.
    await expect(page.locator('[data-testid="material-receipt-fiscal-year"]')).toHaveText('-');
    await expect(page.locator('#material-receipt-edit-action, #material-receipt-confirm-action, #material-receipt-remove-action')).toHaveCount(0);
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}/edit`);
    await expect(page.locator('#material-receipt-form-not-allowed')).toHaveText('แก้ไขได้เฉพาะร่างโดยผู้มีสิทธิ์บันทึกรายการรับวัสดุ');
    await expect(page.locator('#material-receipt-draft-submit')).toHaveCount(0);

    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-opening-balance-list').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น', exact: true })).toBeVisible();
    await expect(page.locator(`[data-testid="opening-balance-row-${balanceId}"]`)).toContainText('ร่าง');
    await expect(page.locator('#opening-balance-add-action')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/opening-balances/${balanceId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();
    await expect(page.locator('#opening-balance-edit-action, #opening-balance-confirm-action, #opening-balance-remove-action')).toHaveCount(0);
  });

  test('Journey F010-T4.1: the Supply Officer follows the Stock Material in รายการเคลื่อนไหว, its ยอดตั้งต้น and a รับวัสดุ row with the balance after each, by ปีงบประมาณ and a page at a time, and finds the Material Receipt by its ปีงบประมาณ', async ({ page, context }) => {
    test.setTimeout(60_000);
    const { tag, ream, reamUnitId, boxUnitId, materialId } = j1;
    const receipts = new MaterialReceiptService({ db: pool });
    const receive = async (stockMaterialId: string, receivedDate: string, unitId: string, quantity: string, reference = `ใบส่งของ J1 ${tag}`) => {
      const { material_receipt_id: id } = await receipts.create(
        officerUserId,
        { received_date: receivedDate, receipt_reference: reference, lines: [{ stock_material_id: stockMaterialId, unit_id: unitId, quantity }] },
        { retryToken: crypto.randomUUID() }
      );
      const { receipt_number: number } = await receipts.confirm(officerUserId, id, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
      return { id, number };
    };
    // The facts the journey needs, made here: J1's Stock Material, whose Opening Balance of 7 รีม is as of 2026-09-30
    // (ปีงบประมาณ 2569), receives 2 กล่อง of 5 รีม on 2026-10-01 (ปีงบประมาณ 2570); another Stock Material, found by
    // the same Receipt Reference, receives 1 รีม on 2026-09-30 (ปีงบประมาณ 2569); a third receives 1 รีม 26 times, one
    // page and a row.
    const stockMaterials = new StockMaterialService({ db: pool });
    const { stock_material_id: otherId } = await stockMaterials.create(officerUserId, { name: `ยางลบ J1 ${tag}`, base_unit: { unit_id: reamUnitId }, explicit_continuation: true }, { retryToken: crypto.randomUUID() });
    const { stock_material_id: pagedId } = await stockMaterials.create(officerUserId, { name: `ดินสอ J1 ${tag}`, base_unit: { unit_id: reamUnitId }, explicit_continuation: true }, { retryToken: crypto.randomUUID() });
    const october = await receive(materialId, '2026-10-01', boxUnitId, '2');
    const september = await receive(otherId, '2026-09-30', reamUnitId, '1');
    for (let i = 0; i < 26; i++) {
      await receive(pagedId, '2026-10-02', reamUnitId, '1', `ใบส่งของดินสอ ${tag}`);
    }

    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    // คงเหลือ 7 + 10 = 17 รีม, no longer below the Minimum Stock of 10 (MC-20).
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`17 ${ream}`);
    await expect(page.locator('[data-testid="stock-material-low-stock-badge"]')).toHaveCount(0);

    // รายการเคลื่อนไหว, oldest first: the ยอดตั้งต้น row and the รับวัสดุ row, each with the balance after it.
    const rows = page.locator('#stock-movement-table tbody tr');
    await expect(rows).toHaveCount(2);
    // The balance after a row is คงเหลือหลังรายการ; คงเหลือ alone is the Current Stock above (#235 review decision 1).
    await expect(page.locator('#stock-movement-table thead th')).toHaveText([
      'วันที่มีผล',
      'รายการ',
      'เอกสาร',
      'จำนวนที่บันทึก',
      'จำนวน (หน่วยนับหลัก)',
      'คงเหลือหลังรายการ',
      'วันที่บันทึก',
    ]);
    await expect(rows.nth(0).locator('td')).toHaveText([
      '30 กันยายน 2569',
      'ยอดตั้งต้น',
      /^เลขที่ยอดตั้งต้น \d+$/,
      `7 ${ream} × 1`,
      `7 ${ream}`,
      `7 ${ream}`,
      /โดย officer_material_stock$/,
    ]);
    await expect(rows.nth(1).locator('td')).toHaveText([
      '1 ตุลาคม 2569',
      'รับวัสดุ',
      `เลขที่รับ ${october.number}`,
      `2 กล่อง ${tag} × 5`,
      `10 ${ream}`,
      `17 ${ream}`,
      /โดย officer_material_stock$/,
    ]);
    await expect(page.locator('#stock-movement-count')).toHaveText('รายการที่ 1–2 จาก 2');
    await expect(page.locator('#stock-movement-previous')).toBeDisabled();
    await expect(page.locator('#stock-movement-next')).toBeDisabled();

    // ปีงบประมาณ offers the years it has, newest first; each keeps the whole ledger's balance (#235 start decision 4).
    await expect(page.locator('#stock-movement-fiscal-year option')).toHaveText(['ทั้งหมด', '2570', '2569']);
    await page.locator('#stock-movement-fiscal-year').selectOption('2570');
    await expect(page).toHaveURL(/[?&]fiscal_year=2570/);
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#stock-movement-fiscal-year option')).toHaveText(['ทั้งหมด', '2570', '2569']);
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('รับวัสดุ');
    await expect(rows.nth(0).locator('td').nth(5)).toHaveText(`17 ${ream}`);
    await page.locator('#stock-movement-fiscal-year').selectOption('2569');
    await expect(page).toHaveURL(/[?&]fiscal_year=2569/);
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('ยอดตั้งต้น');
    await expect(rows.nth(0).locator('td').nth(5)).toHaveText(`7 ${ream}`);
    await page.locator('#stock-movement-fiscal-year').selectOption('');
    await expect(page).not.toHaveURL(/fiscal_year=/);
    await expect(rows).toHaveCount(2);
    // A year it does not have, from a link: the select shows it among the others, and ทั้งหมด takes it away.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}?fiscal_year=2560`);
    await expect(page.locator('#stock-movement-empty')).toHaveText('ไม่พบรายการเคลื่อนไหวในปีงบประมาณ 2560');
    await expect(page.locator('#stock-movement-fiscal-year')).toHaveValue('2560');
    await expect(page.locator('#stock-movement-fiscal-year option')).toHaveText(['ทั้งหมด', '2570', '2569', '2560']);
    await page.locator('#stock-movement-fiscal-year').selectOption('');
    await expect(page).not.toHaveURL(/fiscal_year=/);
    await expect(rows).toHaveCount(2);

    // The ยอดตั้งต้น row's number opens its Opening Balance; the รับวัสดุ row's its Material Receipt, with ปีงบประมาณ.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await rows.nth(0).getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^ยอดตั้งต้น เลขที่ยอดตั้งต้น \d+$/ })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/stock-materials/${materialId}$`));
    await rows.nth(1).getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: `รายการรับวัสดุ เลขที่รับ ${october.number}` })).toBeVisible();
    await expect(page.locator('[data-testid="material-receipt-fiscal-year"]')).toHaveText('2570');

    // The รับวัสดุ list shows ปีงบประมาณ and filters by it, leaving out the other year.
    await page.goto(`${targetBaseUrl}/material-receipts?search=${encodeURIComponent(`ใบส่งของ J1 ${tag}`)}`);
    const listRows = page.locator('#material-receipt-list-table tbody tr');
    await expect(listRows).toHaveCount(2);
    await expect(page.locator(`[data-testid="material-receipt-row-${october.id}"] td`).nth(2)).toHaveText('2570');
    await expect(page.locator(`[data-testid="material-receipt-row-${september.id}"] td`).nth(2)).toHaveText('2569');
    await page.locator('#material-receipt-fiscal-year-filter').selectOption('2569');
    await expect(page).toHaveURL(/[?&]fiscal_year=2569/);
    await expect(page).toHaveURL(/[?&]search=/);
    await expect(listRows).toHaveCount(1);
    await expect(page.locator(`[data-testid="material-receipt-row-${september.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="material-receipt-row-${october.id}"]`)).toHaveCount(0);
    // The state joins the Fiscal Year, which stays; ทั้งหมด takes the Fiscal Year away and keeps the state.
    await page.locator('#material-receipt-state-filter').selectOption('received');
    await expect(page).toHaveURL(/[?&]state=received/);
    await expect(page).toHaveURL(/[?&]fiscal_year=2569/);
    await expect(listRows).toHaveCount(1);
    await page.locator('#material-receipt-fiscal-year-filter').selectOption('');
    await expect(page).not.toHaveURL(/fiscal_year=/);
    await expect(page).toHaveURL(/[?&]state=received/);
    await expect(listRows).toHaveCount(2);
    // A year no Material Receipt has, from a link, finds none.
    await page.goto(`${targetBaseUrl}/material-receipts?fiscal_year=2560`);
    await expect(page.locator('#material-receipt-list-empty')).toHaveText('ไม่พบรายการรับวัสดุที่ค้นหา');
    await expect(page.locator('#material-receipt-fiscal-year-filter')).toHaveValue('2560');
    await expect(page.locator('#material-receipt-fiscal-year-filter option').last()).toHaveText('2560');
    await page.locator('#material-receipt-fiscal-year-filter').selectOption('');
    await expect(page).not.toHaveURL(/fiscal_year=/);
    await expect(listRows.first()).toBeVisible();
    await expect(page.locator('#material-receipt-list-empty')).toHaveCount(0);

    // A page at a time: 26 รับวัสดุ rows of ปีงบประมาณ 2570, the balance going on across the page break, and the page
    // keeping the Fiscal Year.
    await page.goto(`${targetBaseUrl}/stock-materials/${pagedId}`);
    await expect(rows).toHaveCount(25);
    await expect(rows.nth(24).locator('td').nth(5)).toHaveText(`25 ${ream}`);
    await expect(page.locator('#stock-movement-count')).toHaveText('รายการที่ 1–25 จาก 26');
    await page.locator('#stock-movement-fiscal-year').selectOption('2570');
    await expect(page).toHaveURL(/[?&]fiscal_year=2570/);
    await expect(page.locator('#stock-movement-count')).toHaveText('รายการที่ 1–25 จาก 26');
    await expect(page.locator('#stock-movement-previous')).toBeDisabled();
    await page.locator('#stock-movement-next').click();
    await expect(page).toHaveURL(/[?&]offset=25/);
    await expect(page).toHaveURL(/[?&]fiscal_year=2570/);
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('td').nth(5)).toHaveText(`26 ${ream}`);
    await expect(page.locator('#stock-movement-count')).toHaveText('รายการที่ 26–26 จาก 26');
    await expect(page.locator('#stock-movement-next')).toBeDisabled();
    await page.locator('#stock-movement-previous').click();
    await expect(page).not.toHaveURL(/offset=/);
    await expect(page).toHaveURL(/[?&]fiscal_year=2570/);
    await expect(rows).toHaveCount(25);
  });

  test('Journey F010-T5.1: a Read-only User reads คงเหลือ of a Stock Material with an Opening Balance, with no write action, and the Supply Officer finds its หน่วยนับหลัก locked in แก้ไขหน่วยนับ, with the reason, and changes its อัตราแปลง', async ({ page, context }) => {
    // The facts the journey needs, made here: a Stock Material counted in ชิ้น, with แพ็ค of 12 ชิ้น, and a confirmed
    // Opening Balance of 2 แพ็ค (24 ชิ้น); another one counted in ชิ้น with only a Draft Opening Balance (Q15).
    const tag = crypto.randomUUID().slice(0, 6);
    const catalog = new CatalogListService({ db: pool });
    const piece = await catalog.add(officerUserId, 'unit', { name: `ชิ้น J3 ${tag}` }, { retryToken: crypto.randomUUID() });
    const pack = await catalog.add(officerUserId, 'unit', { name: `แพ็ค J3 ${tag}` }, { retryToken: crypto.randomUUID() });
    const stockMaterials = new StockMaterialService({ db: pool });
    const openingBalances = new OpeningBalanceService({ db: pool });
    // An Opening Balance Draft as of 2026-09-30 of one line: `quantity` in the Unit `unitId` of `stockMaterialId`.
    const openingBalanceDraft = (stockMaterialId: string, unitId: string, quantity: string) =>
      openingBalances.create(
        officerUserId,
        { as_of_date: '2026-09-30', source: 'สมุดคุมวัสดุ', lines: [{ stock_material_id: stockMaterialId, unit_id: unitId, quantity }] },
        { retryToken: crypto.randomUUID() }
      );
    const { stock_material_id: materialId } = await stockMaterials.create(
      officerUserId,
      { name: `ยางลบก้อน J3 ${tag}`, base_unit: { unit_id: piece.id }, alternate_units: [{ unit_id: pack.id, conversion_factor: '12' }] },
      { retryToken: crypto.randomUUID() }
    );
    const { opening_balance_id: balanceId } = await openingBalanceDraft(materialId, pack.id, '2');
    await openingBalances.confirm(officerUserId, balanceId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    const { stock_material_id: draftedId } = await stockMaterials.create(officerUserId, { name: `ยางลบดินสอ J3 ${tag}`, base_unit: { unit_id: piece.id } }, { retryToken: crypto.randomUUID() });
    await openingBalanceDraft(draftedId, piece.id, '5');
    const currentStock = page.locator('[data-testid="stock-material-current-stock"]');
    const writeActions = page.locator('#stock-material-correct, #stock-material-edit-details, #stock-material-inactivate, #stock-material-edit-units');

    await loginAs(context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(currentStock).toContainText(`24 ชิ้น J3 ${tag}`);
    await expect(writeActions).toHaveCount(0);

    await switchActor(page, context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(currentStock).toContainText(`24 ชิ้น J3 ${tag}`);
    await page.locator('#stock-material-edit-units').click();
    const baseUnit = page.locator('#stock-material-units-base-unit');
    await expect(baseUnit).toBeDisabled();
    await expect(baseUnit.locator('option:checked')).toHaveText(`ชิ้น J3 ${tag}`);
    await expect(page.locator('#stock-material-units-base-unit-frozen-reason')).toHaveText('เปลี่ยนหน่วยนับหลักไม่ได้ เพราะวัสดุนี้มีรายการเคลื่อนไหวแล้ว');
    await expect(baseUnit).toHaveAccessibleDescription('เปลี่ยนหน่วยนับหลักไม่ได้ เพราะวัสดุนี้มีรายการเคลื่อนไหวแล้ว');

    // The อัตราแปลง still changes, for the future: คงเหลือ and the ยอดตั้งต้น row keep 12 ชิ้น a แพ็ค (MC-09).
    await page.locator('#stock-material-units-alternate-0-factor').fill('10');
    await page.locator('#stock-material-units-submit').click();
    await expect(page.locator('#stock-material-units-form')).toHaveCount(0);
    await expect(page.locator(`[data-testid="stock-material-unit-${pack.id}"]`)).toContainText(`1 แพ็ค J3 ${tag} = 10 ชิ้น J3 ${tag}`);
    await expect(currentStock).toContainText(`24 ชิ้น J3 ${tag}`);
    const row = page.locator('#stock-movement-table tbody tr').nth(0).locator('td');
    await expect(row.nth(3)).toHaveText(`2 แพ็ค J3 ${tag} × 12`);
    await expect(row.nth(4)).toHaveText(`24 ชิ้น J3 ${tag}`);

    // A Stock Material with only a Draft Opening Balance has no Stock Movement: its หน่วยนับหลัก is still chosen, with
    // no reason shown.
    await page.goto(`${targetBaseUrl}/stock-materials/${draftedId}`);
    await expect(currentStock).toHaveText('ยังไม่มีรายการเคลื่อนไหว');
    await page.locator('#stock-material-edit-units').click();
    await expect(baseUnit.locator('option:checked')).toHaveText(`ชิ้น J3 ${tag}`);
    await expect(baseUnit).toBeEnabled();
    await expect(page.locator('#stock-material-units-base-unit-frozen-reason')).toHaveCount(0);
  });

  test('Journey F010-T6.1: the Supply Officer corrects J2’s Material Receipt with a reason: the quantity fix shows กลับรายการ and the new row in รายการเคลื่อนไหว and the change in the history; a voided line stays shown as ยกเลิกแล้ว; a Stock Material change and a new line take today’s อัตราแปลง', async ({ page, context }) => {
    test.setTimeout(120_000);
    const { name, pen, box, penUnitId, boxUnitId, materialId, receiptId, receiptNumber } = j2;
    const tag = crypto.randomUUID().slice(0, 6);
    // The facts the journey needs, made here: J2's กล่อง has since been given 10 ด้าม for the 12 it was received at;
    // pencils are counted in ด้าม, with a กล่อง of 6, and their Opening Balance is as of 2026-10-20; a Material Receipt
    // holds 50 lines.
    const stockMaterials = new StockMaterialService({ db: pool });
    const { version } = (await pool.query('SELECT version FROM stock_materials WHERE id = $1', [materialId])).rows[0];
    await stockMaterials.replaceUnits(
      officerUserId,
      materialId,
      { expected_version: version, base_unit: { unit_id: penUnitId, whole_number_only: true }, alternate_units: [{ unit_id: boxUnitId, conversion_factor: '10', whole_number_only: false, is_active: true }] },
      { retryToken: crypto.randomUUID() }
    );
    const pencils = `ดินสอ J2 ${tag}`;
    const { stock_material_id: pencilId } = await stockMaterials.create(
      officerUserId,
      { name: pencils, base_unit: { unit_id: penUnitId, whole_number_only: true }, alternate_units: [{ unit_id: boxUnitId, conversion_factor: '6' }] },
      { retryToken: crypto.randomUUID() }
    );
    const openingBalances = new OpeningBalanceService({ db: pool });
    const { opening_balance_id: openingId } = await openingBalances.create(
      officerUserId,
      { as_of_date: '2026-10-20', source: 'สมุดคุมวัสดุ', lines: [{ stock_material_id: pencilId, unit_id: penUnitId, quantity: '3' }] },
      { retryToken: crypto.randomUUID() }
    );
    const { opening_balance_number: openingNumber } = await openingBalances.confirm(officerUserId, openingId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    const fullLines = [];
    for (let i = 0; i < 25; i++) {
      const { stock_material_id: eraserId } = await stockMaterials.create(
        officerUserId,
        { name: `ยางลบ J2 ${i} ${tag}`, base_unit: { unit_id: penUnitId }, alternate_units: [{ unit_id: boxUnitId, conversion_factor: '12' }] },
        { retryToken: crypto.randomUUID() }
      );
      fullLines.push({ stock_material_id: eraserId, unit_id: penUnitId, quantity: '1' }, { stock_material_id: eraserId, unit_id: boxUnitId, quantity: '1' });
    }
    const receipts = new MaterialReceiptService({ db: pool });
    const { material_receipt_id: fullId } = await receipts.create(officerUserId, { received_date: '2026-10-15', lines: fullLines }, { retryToken: crypto.randomUUID() });
    await receipts.confirm(officerUserId, fullId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });

    const submit = page.locator('#material-receipt-correction-submit');
    const formError = page.locator('[data-testid="material-receipt-correction-form-error"]');
    const problems = page.locator('[data-testid="material-receipt-correction-problems"] li');
    const searchLabel = page.locator('label[for="material-receipt-stock-material-search"]');
    const history = page.locator('#material-receipt-history > li');

    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}`);
    await page.locator('#material-receipt-correct-action').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/material-receipts/${receiptId}/correct`);
    await expect(page.getByRole('heading', { level: 1, name: 'แก้ไขรายการที่บันทึกผิด' })).toBeVisible();

    // The form reads the Material Receipt back whole, each line with the อัตราแปลง it was recorded at.
    await expect(page.locator('#material-receipt-received-date')).toHaveValue('2026-10-15');
    await expect(page.locator('#material-receipt-line-0-quantity')).toHaveValue('2');
    await expect(page.locator('#material-receipt-line-1-quantity')).toHaveValue('5');
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`1. ${name}`);
    await expect(submit).toHaveText('บันทึกการแก้ไข');
    const boxFactor = page.locator('[data-testid="material-receipt-line-0-factor"]');
    await expect(boxFactor).toHaveText(`อัตราแปลง 1 ${box} = 12 ${pen}`);
    await expect(page.locator('[data-testid="material-receipt-line-1-factor"]')).toHaveText(`อัตราแปลง 1 ${pen} = 1 ${pen}`);
    // A Unit change shows that Unit's อัตราแปลง today; with no Unit, none, and the save asks for one.
    await page.locator('#material-receipt-line-0-unit').selectOption({ label: pen });
    await expect(boxFactor).toHaveText(`อัตราแปลง 1 ${pen} = 1 ${pen}`);
    await expect(page.locator('#material-receipt-line-0-recalculate')).toHaveCount(0);
    await page.locator('#material-receipt-line-0-unit').selectOption('');
    await expect(boxFactor).toHaveCount(0);
    await submit.click();
    await expect(formError).toContainText('กรุณาเลือกหน่วยนับและกรอกจำนวนให้ครบทุกรายการ');
    await page.locator('#material-receipt-line-0-unit').selectOption({ label: box });
    await expect(boxFactor).toHaveText(`อัตราแปลง 1 ${box} = 12 ${pen}`);
    // คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน shows today's อัตราแปลง before save (Q29); unticked, the line keeps its own.
    await page.locator('#material-receipt-line-0-recalculate').check();
    await expect(boxFactor).toHaveText(`อัตราแปลง 1 ${box} = 10 ${pen}`);
    await page.locator('#material-receipt-line-0-recalculate').uncheck();
    await expect(boxFactor).toHaveText(`อัตราแปลง 1 ${box} = 12 ${pen}`);

    // A save needs every quantity and a reason; a fraction of the whole-number ด้าม and a วันที่รับ to come are refused,
    // the line named by its number (Q25).
    await page.locator('#material-receipt-line-1-quantity').fill('');
    await submit.click();
    await expect(formError).toContainText('กรุณาเลือกหน่วยนับและกรอกจำนวนให้ครบทุกรายการ');
    await page.locator('#material-receipt-line-1-quantity').fill('5.5');
    await submit.click();
    await expect(formError).toContainText('กรุณากรอกเหตุผลที่แก้ไข');
    await page.locator('#material-receipt-correction-reason').fill('นับปากกาผิด');
    await page.locator('#material-receipt-received-date').fill('2099-01-01');
    await submit.click();
    await expect(problems).toHaveText(['รายการที่ 2: lines[1].quantity must be a whole number in its Unit', /^received_date must not be after today \(\d{4}-\d{2}-\d{2}, Asia\/Bangkok\)$/]);

    // 6 ด้าม on วันที่รับ as it was saves it: the line's new Stock Movement, and the change in the history with the
    // reason.
    await page.locator('#material-receipt-received-date').fill('2026-10-15');
    await page.locator('#material-receipt-line-1-quantity').fill('6');
    await submit.click();
    await expect(page.getByRole('heading', { level: 1, name: `รายการรับวัสดุ เลขที่รับ ${receiptNumber}` })).toBeVisible();
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).toContainText(`+6 ${pen} (6 ${pen} × 1)`);
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`+24 ${pen} (2 ${box} × 12)`);
    await expect(history).toHaveCount(2);
    await expect(history.nth(1)).toContainText('แก้ไขรายการที่บันทึกผิด โดย officer_material_stock');
    await expect(history.nth(1)).toContainText('เหตุผล: นับปากกาผิด');
    await expect(history.nth(1).locator('ul li')).toHaveText([`รายการที่ 2: จำนวน 5 → 6, อัตราแปลง 1 → 1, จำนวน (หน่วยนับหลัก) 5 → 6`]);
    await expect(history.nth(0).locator('ul')).toHaveCount(0);

    // รายการเคลื่อนไหว keeps the 5 ด้าม, then shows its กลับรายการ and the new row, each from the Material Receipt:
    // 24 + 5 - 5 + 6 = 30 ด้าม.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`30 ${pen}`);
    const rows = page.locator('#stock-movement-table tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(2).locator('td')).toHaveText(['15 ตุลาคม 2569', 'กลับรายการ', `เลขที่รับ ${receiptNumber}`, `5 ${pen} × 1`, `-5 ${pen}`, `24 ${pen}`, /โดย officer_material_stock$/]);
    await expect(rows.nth(3).locator('td')).toHaveText(['15 ตุลาคม 2569', 'รับวัสดุ', `เลขที่รับ ${receiptNumber}`, `6 ${pen} × 1`, `6 ${pen}`, `30 ${pen}`, /โดย officer_material_stock$/]);

    // ยกเลิกรายการ, and undone; a line voided needs no quantity, shows no อัตราแปลง and no amount.
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}/correct`);
    await expect(page.locator('#material-receipt-line-1-quantity')).toHaveValue('6');
    const voidLine = page.locator('#material-receipt-line-1-void');
    const total = page.locator('[data-testid="material-receipt-total-amount"]');
    await page.locator('#material-receipt-line-1-unit-price').fill('10');
    await expect(total).toHaveText('300.00');
    await expect(voidLine).toHaveCSS('background-color', 'rgb(254, 226, 226)');
    await expect(voidLine).toHaveCSS('color', 'rgb(153, 27, 27)');
    await voidLine.click();
    await expect(voidLine).toHaveText('ไม่ยกเลิก');
    await expect(total).toHaveText('240.00');
    await expect(voidLine).toHaveCSS('background-color', 'rgb(243, 244, 246)');
    await expect(voidLine).toHaveCSS('color', 'rgb(55, 65, 81)');
    await voidLine.click();
    await expect(voidLine).toHaveText('ยกเลิกรายการ');
    await expect(total).toHaveText('300.00');
    // Meanwhile another Supply Officer notes the count.
    const other = await context.newPage();
    await other.goto(`${targetBaseUrl}/material-receipts/${receiptId}/correct`);
    await expect(other.locator('#material-receipt-line-1-quantity')).toHaveValue('6');
    await other.locator('#material-receipt-note').fill('ตรวจนับแล้ว');
    await other.locator('#material-receipt-correction-reason').fill('เพิ่มหมายเหตุ');
    await other.locator('#material-receipt-correction-submit').click();
    await expect(other.locator('[data-testid="material-receipt-received-date"]')).toBeVisible();
    await other.close();
    // The ด้าม line, which was pencils, never pens: voided, it stays shown as ยกเลิกแล้ว (and its delivery note found
    // since goes in เอกสารอ้างอิง, which had none). The save on what was read first is refused as stale, and reloads.
    const voidRedo = async () => {
      await page.locator('#material-receipt-line-1-quantity').fill('');
      await voidLine.click();
      await expect(voidLine).toHaveText('ไม่ยกเลิก');
      await expect(page.locator('[data-testid="material-receipt-line-1"]')).toHaveCSS('text-decoration-line', 'line-through');
      await expect(page.locator('[data-testid="material-receipt-line-0"]')).toHaveCSS('text-decoration-line', 'none');
      await expect(page.locator('[data-testid="material-receipt-line-1-factor"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveText('240.00');
      await page.locator('#material-receipt-reference').fill('ใบส่งของ 7');
      await page.locator('#material-receipt-correction-reason').fill('เป็นดินสอ ไม่ใช่ปากกา');
      await submit.click();
    };
    await voidRedo();
    await expect(formError).toContainText('มีผู้แก้ไขรายการรับวัสดุนี้ไปแล้ว กรุณาโหลดใหม่');
    // A reload whose read fails says so and keeps what was typed; the next one reads the newer Material Receipt.
    const receiptRead = new RegExp(`/material-receipts/${receiptId}$`);
    await page.route(receiptRead, (route: any) => (route.request().resourceType() === 'fetch' ? route.fulfill({ status: 500, body: '{}' }) : route.continue()));
    await page.locator('#material-receipt-correction-reload').click();
    await expect(formError).toContainText('ไม่สามารถดึงข้อมูลล่าสุดได้ กรุณาลองใหม่อีกครั้ง');
    await expect(page.locator('#material-receipt-reference')).toHaveValue('ใบส่งของ 7');
    await expect(voidLine).toHaveText('ไม่ยกเลิก');
    await page.unroute(receiptRead);
    await page.locator('#material-receipt-correction-reload').click();
    await expect(page.locator('#material-receipt-note')).toHaveValue('ตรวจนับแล้ว');
    await expect(voidLine).toHaveText('ยกเลิกรายการ');
    await expect(page.locator('#material-receipt-line-1-quantity')).toHaveValue('6');
    await voidRedo();
    await expect(page.locator('[data-testid="material-receipt-line-1-voided"]')).toHaveText('ยกเลิกแล้ว');
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toHaveCSS('text-decoration-line', 'none');
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).toContainText(name);
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).not.toContainText('+6');
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveText('240.00');
    await expect(history.nth(2).locator('ul li')).toHaveText(['หมายเหตุ - → ตรวจนับแล้ว']);
    await expect(history.nth(3).locator('ul li')).toHaveText(['เอกสารอ้างอิง - → ใบส่งของ 7', `ยกเลิกรายการที่ 2: ${name} 6 ${pen}`]);
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`24 ${pen}`);

    // The 2 กล่อง were pencils too, and one more ด้าม of pencils came; วันที่รับ was 2026-10-21.
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}/correct`);
    // The voided line stays shown, struck through, and counts toward the 50 lines.
    await expect(page.locator('[data-testid="material-receipt-voided-line-1"]')).toHaveText(`2. ${name} 6 ${pen} (ยกเลิกแล้ว)`);
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`1. ${name}`);
    await expect(page.getByRole('heading', { level: 2, name: 'รายการ (2/50)' })).toBeVisible();
    // A new line takes today's อัตราแปลง of the first Unit no line holds, a voided one included, numbered after them
    // all; with none left, none, and the save asks for one; it is removed, never voided.
    await expect(searchLabel).toHaveText('เพิ่มวัสดุ');
    await page.locator('#material-receipt-stock-material-search').fill(pencils);
    await page.locator('#material-receipt-stock-material-search-submit').click();
    await expect(page.locator(`[data-testid="material-receipt-choose-${pencilId}"]`)).toHaveText('เพิ่ม');
    await page.locator(`[data-testid="material-receipt-choose-${pencilId}"]`).click();
    await expect(page.locator('[data-testid="material-receipt-line-1"]')).toContainText(`3. ${pencils}`);
    await expect(page.locator('#material-receipt-line-1-unit option:checked')).toHaveText(pen);
    await expect(page.locator('[data-testid="material-receipt-line-1-factor"]')).toHaveText(`อัตราแปลง 1 ${pen} = 1 ${pen}`);
    await expect(page.locator('#material-receipt-line-1-void')).toHaveCount(0);
    await page.locator('#material-receipt-line-1-quantity').fill('1');
    await page.locator('#material-receipt-stock-material-search').fill(name);
    await page.locator('#material-receipt-stock-material-search-submit').click();
    await page.locator(`[data-testid="material-receipt-choose-${materialId}"]`).click();
    await expect(page.locator('[data-testid="material-receipt-line-2"]')).toContainText(`4. ${name}`);
    await expect(page.locator('#material-receipt-line-2-unit option:checked')).toHaveText('-');
    await expect(page.locator('[data-testid="material-receipt-line-2-factor"]')).toHaveCount(0);
    await page.locator('#material-receipt-line-2-quantity').fill('1');
    await submit.click();
    await expect(formError).toContainText('กรุณาเลือกหน่วยนับและกรอกจำนวนให้ครบทุกรายการ');
    await page.locator('#material-receipt-line-2-remove').click();
    await expect(page.locator('[data-testid="material-receipt-line-2"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'รายการ (3/50)' })).toBeVisible();
    // "เปลี่ยนวัสดุ" turns the search to that line, and back; the line takes the pencils' free กล่อง at today's
    // อัตราแปลง, and the line of pencils already there keeps its ด้าม.
    const changeMaterial = page.locator('#material-receipt-line-0-change-material');
    await expect(changeMaterial).toHaveText('เปลี่ยนวัสดุ');
    await changeMaterial.click();
    await expect(changeMaterial).toHaveText('ไม่เปลี่ยน');
    await expect(searchLabel).toHaveText('เปลี่ยนวัสดุของรายการที่ 1');
    await changeMaterial.click();
    await expect(changeMaterial).toHaveText('เปลี่ยนวัสดุ');
    await expect(searchLabel).toHaveText('เพิ่มวัสดุ');
    await changeMaterial.click();
    await page.locator('#material-receipt-stock-material-search').fill(pencils);
    await page.locator('#material-receipt-stock-material-search-submit').click();
    await expect(page.locator(`[data-testid="material-receipt-choose-${pencilId}"]`)).toHaveText('เลือก');
    await page.locator(`[data-testid="material-receipt-choose-${pencilId}"]`).click();
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`1. ${pencils}`);
    await expect(page.locator('#material-receipt-line-0-unit option:checked')).toHaveText(box);
    await expect(page.locator('#material-receipt-line-0-quantity')).toHaveValue('2');
    await expect(page.locator('#material-receipt-line-0-recalculate')).toHaveCount(0);
    await expect(boxFactor).toHaveText(`อัตราแปลง 1 ${box} = 6 ${pen}`);
    await expect(page.locator('#material-receipt-line-1-unit option:checked')).toHaveText(pen);
    await expect(searchLabel).toHaveText('เพิ่มวัสดุ');
    await page.locator('#material-receipt-correction-reason').fill('เป็นดินสอ และดินสอมาเพิ่ม');
    // The As-of Date rule names each line by its number, with its Opening Balance (Q21, Q25).
    await submit.click();
    const asOf = (index: number) =>
      `lines[${index}].stock_material_id names ${pencils}, whose Opening Balance ${openingNumber} is as of 2026-10-20: received_date must be after it (เลขที่ยอดตั้งต้น ${openingNumber})`;
    await expect(problems).toHaveText([`รายการที่ 1: ${asOf(0)}`, `รายการที่ 3: ${asOf(1)}`]);
    await expect(problems.first().getByRole('link')).toHaveAttribute('href', `/opening-balances/${openingId}`);
    // วันที่รับ 2026-10-21 saves it: every line moves to that date.
    await page.locator('#material-receipt-received-date').fill('2026-10-21');
    await submit.click();
    await expect(page.locator('[data-testid="material-receipt-received-date"]')).toHaveText('21 ตุลาคม 2569');
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(pencils);
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`+12 ${pen} (2 ${box} × 6) ณ 21 ตุลาคม 2569`);
    await expect(page.locator('[data-testid="material-receipt-line-2"]')).toContainText(`+1 ${pen} (1 ${pen} × 1) ณ 21 ตุลาคม 2569`);
    await expect(history.nth(4).locator('ul li')).toHaveText([
      'วันที่รับ 15 ตุลาคม 2569 → 21 ตุลาคม 2569',
      `รายการที่ 1: วัสดุ ${name} → ${pencils}, อัตราแปลง 12 → 6, จำนวน (หน่วยนับหลัก) 24 → 12`,
      `เพิ่มรายการที่ 3: ${pencils} 1 ${pen}`,
    ]);
    await page.goto(`${targetBaseUrl}/stock-materials/${pencilId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`16 ${pen}`);

    // At 50 lines no line is added, but a line's Stock Material may still be changed.
    await page.goto(`${targetBaseUrl}/material-receipts/${fullId}/correct`);
    await expect(page.locator('#material-receipt-line-49-quantity')).toHaveValue('1');
    await expect(page.getByRole('heading', { level: 2, name: 'รายการ (50/50)' })).toBeVisible();
    await expect(page.locator('#material-receipt-stock-material-search')).toHaveCount(0);
    await page.locator('#material-receipt-line-0-change-material').click();
    await expect(searchLabel).toHaveText('เปลี่ยนวัสดุของรายการที่ 1');
    // Chosen again, its own Stock Material keeps the line's Unit: the line's own pair is free to it.
    await page.locator('#material-receipt-stock-material-search').fill(`ยางลบ J2 0 ${tag}`);
    await page.locator('#material-receipt-stock-material-search-submit').click();
    await page.locator('[data-testid^="material-receipt-choose-"]').click();
    await expect(page.locator('#material-receipt-line-0-unit option:checked')).toHaveText(pen);
    await expect(page.locator('#material-receipt-line-0-change-material')).toHaveText('เปลี่ยนวัสดุ');

    // A Read-only User reads it with no "แก้ไขรายการที่บันทึกผิด", and the form refuses them.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}`);
    await expect(page.locator('[data-testid="material-receipt-line-1-voided"]')).toHaveText('ยกเลิกแล้ว');
    await expect(page.locator('#material-receipt-correct-action')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}/correct`);
    await expect(page.locator('#material-receipt-form-not-allowed')).toHaveText('แก้ไขรายการที่บันทึกผิดได้เฉพาะรายการรับวัสดุที่รับแล้ว โดยผู้มีสิทธิ์บันทึกรายการรับวัสดุ');
  });
});
