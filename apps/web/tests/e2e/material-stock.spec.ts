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
  let j1: { tag: string; name: string; ream: string; reamUnitId: string; materialId: string; draftUrl: string };

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

  const { loginAs } = actorSwitch(() => sessionService, () => targetBaseUrl);

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
    j1 = { tag, name, ream, reamUnitId: reamUnit.id, materialId, draftUrl: page.url() };
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
    await page.locator('#opening-balance-source').fill('สมุดคุมวัสดุ ปีงบประมาณ 2569');
    await page.locator('#opening-balance-line-0-unit').selectOption({ label: ream });
    await page.locator('#opening-balance-line-0-quantity').fill('7');
    await page.locator('#opening-balance-draft-submit').click();
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
    const party = `ร้านเครื่องเขียน J2 ${tag}`;

    await loginAs(context, officerUserId);

    // "รับวัสดุ" from the Dashboard's "วัสดุ" menu, then "เพิ่มรายการรับวัสดุ".
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-material-receipt-list').click();
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ', exact: true })).toBeVisible();
    await page.locator('#material-receipt-add-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'เพิ่มรายการรับวัสดุ' })).toBeVisible();
    await expect(page.locator('#material-receipt-form-not-allowed')).toHaveCount(0);
    await expect(page.locator('[data-testid="material-receipt-total-amount"]')).toHaveCount(0);

    // A new แหล่งที่มา added from the form, which it then names; no วันที่รับ yet.
    await page.locator('#material-receipt-new-source-party').fill(party);
    await page.locator('#material-receipt-new-source-party-add').click();
    await expect(page.locator('#material-receipt-source-party option:checked')).toHaveText(party);

    // The Stock Material twice (Q9): 2 กล่อง at 120, then a second line, which takes the Unit no line of it holds, with
    // no quantity yet. An amount shows once its line has both, for reference only (Q8).
    await page.locator('#material-receipt-stock-material-search').fill(name);
    await page.locator('#material-receipt-stock-material-search-submit').click();
    await expect(page.locator('#material-receipt-stock-material-choices li')).toHaveCount(1);
    await page.locator(`[data-testid="material-receipt-choose-${materialId}"]`).click();
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(name);
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

    // The list finds it by its แหล่งที่มา, Received, with its เลขที่รับ.
    await page.goto(`${targetBaseUrl}/material-receipts?search=${encodeURIComponent(party)}`);
    await expect(page.locator('#material-receipt-list-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#material-receipt-list-table tbody td')).toHaveText([receiptNumber, '15 ตุลาคม 2569', party, 'รับแล้ว', '2']);

    // คงเหลือ: 24 + 5 = 29 ด้าม.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`29 ${pen}`);
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
    await expect(page.locator(`[data-testid="material-receipt-row-${receiptId}"] td`)).toHaveText(['ร่าง', '-', '-', 'ร่าง', '1']);
    await expect(page.locator('#material-receipt-add-action')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/material-receipts/${receiptId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'รายการรับวัสดุ ร่าง' })).toBeVisible();
    await expect(page.locator('[data-testid="material-receipt-line-0"]')).toContainText(`ยางลบ J3 ${tag}`);
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
});
