import { test, expect } from '@playwright/test';
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
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// The journeys share one database, where a Unit's name is unique: a journey that adds a Unit names it here, so that
// another journey adding the same name, in any order, cannot refuse it (F008-T6 retro, #182).
const freshUnitName = (name: string) => `${name} ${crypto.randomUUID().slice(0, 4)}`;

// F008-T1 (#176): Journey J1 starts (a Supply Officer creates a Stock Material with a new Unit and finds it), and
// Journey J3 (a Read-only User reads the catalog with no action; an Asset Custodian has no "วัสดุ" menu).
// F008-T3 (#178): Journey J1 goes on with an Alternate Unit ("1 กล่อง = 5 รีม") and the Units editor.
// F008-T4 (#179): Journey J1 goes on with a Brand and a Material Category added from the form, the editor of other
// details, the Brand search and the Material Category filter.
// F008-T6 (#182): Journey J2 starts (a Supply Officer sets a Minimum Stock and finds it with the Minimum Stock filter,
// and states it again when the Base Unit changes); F008-T5 and T7 extend it.
// F008-T5 (#181): Journey J1 is warned of a Duplicate Candidate and confirms "เป็นคนละรายการ"; Journey J2 goes on with a
// Material Correction with a reason, warned of a Duplicate Candidate too.
// F008-T7 (#180): Journey J2 goes on: the Supply Officer makes a Stock Material Inactive with a note, finds it with the
// status filter and its "หยุดใช้" badge, and reactivates it; Journey J3 is offered neither.
test.describe.serial('Stock Material journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;

  let officerUserId: string;
  let readonlyUserId: string;
  let custodianUserId: string;

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
      cookieSecret: 'test-secret-at-least-32-chars-long-material-e2e',
      logger: false,
    });
    const fastifyAddr = await fastifyApp.listen({ port: 0, host: '127.0.0.1' });
    const match = fastifyAddr.match(/:(\d+)$/);
    const fastifyPort = match ? parseInt(match[1], 10) : 3000;

    const passwordHash = await UserService.hashPassword('Password123!');
    const createUser = async (username: string, role: string): Promise<string> => {
      const res = await pool.query(
        'INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash]
      );
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [res.rows[0].id, role]);
      return res.rows[0].id;
    };
    officerUserId = await createUser('officer_material', 'SUPPLY_OFFICER');
    readonlyUserId = await createUser('readonly_material', 'READ_ONLY');
    custodianUserId = await createUser('custodian_material', 'ASSET_CUSTODIAN');

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
    targetBaseUrl =
      typeof address === 'object' && address ? `http://localhost:${address.port}` : 'http://localhost:5173';
    (fastifyApp as any).publicAppOrigin = targetBaseUrl;
  });

  test.afterAll(async () => {
    if (viteServer) await viteServer.close();
    if (fastifyApp) await fastifyApp.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  const loginAs = async (context: any, userId: string) => {
    const session = await sessionService.createSession(userId);
    await context.addCookies([{ name: 'session', value: session.token, url: targetBaseUrl }]);
  };

  const switchActor = async (page: any, context: any, userId: string) => {
    await page.goto('about:blank');
    await loginAs(context, userId);
  };

  // Opens the Dashboard and waits until it has asked whether the viewer may read the catalog.
  const openDashboard = async (page: any) => {
    const probed = page.waitForResponse((res: any) => res.url().includes('/stock-materials?limit=1'));
    await page.goto(`${targetBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await probed;
  };

  test('Journey F008-T1.1: a Supply Officer opens "วัสดุ", adds a Unit from the form, creates a Stock Material with it as its Base Unit, and finds it in the list and on its page', async ({ page, context }) => {
    await loginAs(context, officerUserId);
    await openDashboard(page);
    await page.locator('#nav-stock-material-list').click();
    await expect(page).toHaveURL(/\/stock-materials$/);
    await expect(page.locator('#stock-material-list-empty')).toContainText('ยังไม่มีวัสดุ');
    // The status filter alone finds nothing either (F008-T7); back on ใช้งานอยู่, the default, the URL has no filter.
    await page.locator('#stock-material-status-filter').selectOption({ label: 'หยุดใช้' });
    await expect(page).toHaveURL(/\/stock-materials\?status=inactive$/);
    await expect(page.locator('#stock-material-list-empty')).toContainText('ไม่พบวัสดุที่ค้นหา');
    await page.locator('#stock-material-status-filter').selectOption({ label: 'ใช้งานอยู่' });
    await expect(page).toHaveURL(/\/stock-materials$/);
    await expect(page.locator('#stock-material-list-empty')).toContainText('ยังไม่มีวัสดุ');

    await page.locator('#stock-material-add-action').click();
    await expect(page).toHaveURL(/\/stock-materials\/new$/);

    // Neither a name nor a Base Unit is optional.
    await page.locator('#stock-material-submit').click();
    await expect(page.locator('[data-testid="stock-material-form-error"]')).toContainText('กรุณากรอกชื่อวัสดุ');
    await page.locator('#stock-material-name').fill('กระดาษถ่ายเอกสาร A4');
    await page.locator('#stock-material-submit').click();
    await expect(page.locator('[data-testid="stock-material-form-error"]')).toContainText('กรุณาเลือกหน่วยนับหลัก');

    // The Unit list is empty: แผ่น is added from the form and chosen.
    await expect(page.locator('#stock-material-base-unit option')).toHaveCount(1);
    await page.locator('#stock-material-new-unit').fill('แผ่น');
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('[data-testid="stock-material-new-unit-message"]')).toContainText('เพิ่มหน่วยนับ "แผ่น" แล้ว');
    await expect(page.locator('#stock-material-base-unit option:checked')).toHaveText('แผ่น');
    // A name already in the list is chosen, not added again.
    await page.locator('#stock-material-base-unit').selectOption('');
    await page.locator('#stock-material-new-unit').fill(' แผ่น ');
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('[data-testid="stock-material-new-unit-message"]')).toContainText('มีหน่วยนับ "แผ่น" อยู่แล้ว เลือกให้แล้ว');
    await expect(page.locator('#stock-material-base-unit option')).toHaveCount(2);
    await expect(page.locator('#stock-material-base-unit option:checked')).toHaveText('แผ่น');
    await expect(page.locator('#stock-material-base-unit-whole')).toBeChecked();

    await page.locator('#stock-material-model').fill('Double A');
    await page.locator('#stock-material-specification').fill('80 แกรม สีขาว');
    await page.locator('#stock-material-note').fill('ใช้ในงานธุรการ');
    await page.locator('#stock-material-submit').click();

    // Its page shows every field, the Base Unit in the Unit table, and its creation in the history.
    await expect(page).toHaveURL(/\/stock-materials\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'กระดาษถ่ายเอกสาร A4' })).toBeVisible();
    await expect(page.locator('[data-testid="stock-material-model"]')).toHaveText('Double A');
    await expect(page.locator('[data-testid="stock-material-specification"]')).toHaveText('80 แกรม สีขาว');
    await expect(page.locator('[data-testid="stock-material-note"]')).toHaveText('ใช้ในงานธุรการ');
    await expect(page.locator('[data-testid="stock-material-status"]')).toHaveText('ใช้งานอยู่');
    const units = page.locator('#stock-material-units tbody tr');
    await expect(units).toHaveCount(1);
    await expect(units.first()).toContainText('แผ่น(หน่วยนับหลัก)');
    await expect(units.first()).toContainText('ใช่');
    const created = page.locator('[data-testid="stock-material-history-1"]');
    await expect(created).toContainText('สร้างรายการ');
    await expect(created).toContainText('officer_material');
    await expect(created).toContainText('หน่วยนับหลัก แผ่น (นับเป็นจำนวนเต็มเท่านั้น)');

    // The list finds it by its Model, with its Base Unit.
    await page.locator('#back-stock-material-list-link').click();
    await expect(page).toHaveURL(/\/stock-materials$/);
    await page.locator('#stock-material-search').fill('double a');
    await page.locator('#stock-material-search-submit').click();
    await expect(page).toHaveURL(/\/stock-materials\?search=double\+a$/);
    const rows = page.locator('#stock-material-list-table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('กระดาษถ่ายเอกสาร A4');
    await expect(rows.first()).toContainText('แผ่น');
  });

  test('Journey F008-T3.1: a Supply Officer creates a Stock Material with an Alternate Unit, sees "1 กล่อง = 5 รีม", and changes its Base Unit in the Units editor', async ({ page, context }) => {
    // แผ่น and กระดาษถ่ายเอกสาร A4, which Journey F008-T1.1 adds when it runs first.
    if ((await pool.query(`SELECT 1 FROM units WHERE name = 'แผ่น'`)).rows.length === 0) {
      await new CatalogListService({ db: pool }).add(officerUserId, 'unit', 'แผ่น', { retryToken: crypto.randomUUID() });
    }
    if ((await pool.query(`SELECT 1 FROM stock_materials WHERE name = 'กระดาษถ่ายเอกสาร A4'`)).rows.length === 0) {
      const sheet = (await pool.query(`SELECT id FROM units WHERE name = 'แผ่น'`)).rows[0].id;
      await new StockMaterialService({ db: pool }).create(
        officerUserId,
        { name: 'กระดาษถ่ายเอกสาร A4', model: 'Double A', specification: '80 แกรม สีขาว', base_unit: { unit_id: sheet } },
        { retryToken: crypto.randomUUID() }
      );
    }
    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/new`);
    await page.locator('#stock-material-name').fill('กระดาษถ่ายเอกสาร A4 แบบกล่อง');

    // A Unit added from the form becomes the Base Unit while none is chosen, then an Alternate Unit.
    await page.locator('#stock-material-new-unit').fill('รีม');
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('[data-testid="stock-material-new-unit-message"]')).toContainText('เพิ่มหน่วยนับ "รีม" แล้ว');
    await expect(page.locator('#stock-material-base-unit option:checked')).toHaveText('รีม');
    await page.locator('#stock-material-new-unit').fill('กล่อง');
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('[data-testid="stock-material-new-unit-message"]')).toContainText('เพิ่มหน่วยนับ "กล่อง" แล้ว');
    const boxRow = page.locator('[data-testid="stock-material-alternate-0"]');
    await expect(page.locator('#stock-material-alternate-0-unit option:checked')).toHaveText('กล่อง');
    await expect(boxRow).toContainText('รีม');
    await expect(page.locator('#stock-material-alternate-0-whole')).toBeChecked();

    // Neither a factor left blank nor one entered before the Base Unit changed is sent.
    await page.locator('#stock-material-submit').click();
    await expect(page.locator('[data-testid="stock-material-form-error"]')).toContainText('กรุณากรอกอัตราแปลงของ กล่อง');
    await page.locator('#stock-material-alternate-0-factor').fill('5');
    await page.locator('#stock-material-base-unit').selectOption({ label: 'แผ่น' });
    await expect(page.locator('#stock-material-alternate-0-factor')).toHaveValue('');
    await expect(boxRow).toContainText('แผ่น');
    await page.locator('#stock-material-base-unit').selectOption({ label: 'รีม' });
    await page.locator('#stock-material-alternate-0-factor').fill('5');
    await page.locator('#stock-material-submit').click();

    // Its name holds that of กระดาษถ่ายเอกสาร A4: the save waits, the form locked, for "เป็นคนละรายการ" (MC-17, P4).
    const warning = page.locator('[data-testid="duplicate-candidate-warning"]');
    await expect(warning).toContainText('พบรายการที่อาจซ้ำ 1 รายการ');
    const candidate = warning.locator('tbody tr');
    await expect(candidate).toHaveCount(1);
    await expect(candidate.locator('td')).toHaveText(['กระดาษถ่ายเอกสาร A4', '-', 'Double A', '80 แกรม สีขาว', 'แผ่น', 'ใช้งานอยู่']);
    // Its page opens beside the form, which keeps what was typed.
    await expect(candidate.getByRole('link', { name: 'กระดาษถ่ายเอกสาร A4' })).toHaveAttribute('href', /^\/stock-materials\/[0-9a-f-]{36}$/);
    await expect(candidate.getByRole('link', { name: 'กระดาษถ่ายเอกสาร A4' })).toHaveAttribute('target', '_blank');
    await expect(page.locator('#stock-material-name')).toBeDisabled();
    await expect(page).toHaveURL(/\/stock-materials\/new$/);
    // "กลับไปแก้ไข" unlocks the form; the same save warns again.
    await page.locator('#duplicate-candidate-back').click();
    await expect(warning).toHaveCount(0);
    await expect(page.locator('#stock-material-name')).toBeEnabled();
    await page.locator('#stock-material-submit').click();
    await page.locator('#duplicate-candidate-confirm').click();

    await expect(page).toHaveURL(/\/stock-materials\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'กระดาษถ่ายเอกสาร A4 แบบกล่อง' })).toBeVisible();
    const units = page.locator('#stock-material-units tbody tr');
    await expect(units).toHaveCount(2);
    await expect(units.nth(0)).toContainText('รีม(หน่วยนับหลัก)');
    await expect(units.nth(1)).toContainText('1 กล่อง = 5 รีม');
    await expect(page.locator('[data-testid="stock-material-history-1"]')).toContainText('1 กล่อง = 5 รีม (นับเป็นจำนวนเต็มเท่านั้น)');

    // The Units editor: แผ่น becomes the Base Unit, which clears every factor and keeps รีม as an Alternate Unit.
    await page.locator('#stock-material-edit-units').click();
    await expect(page.locator('#stock-material-units-alternate-0-factor')).toHaveValue('5');
    await expect(page.locator('#stock-material-units-alternate-0-remove')).toHaveCount(0);
    await page.locator('#stock-material-units-base-unit').selectOption({ label: 'แผ่น' });
    await expect(page.locator('#stock-material-units-alternate-0-unit')).toHaveText('รีม');
    await expect(page.locator('#stock-material-units-alternate-0-factor')).toHaveValue('');
    await expect(page.locator('#stock-material-units-alternate-1-unit')).toHaveText('กล่อง');
    await expect(page.locator('#stock-material-units-alternate-1-factor')).toHaveValue('');
    // With no จำนวนขั้นต่ำ, there is none to state again (F008-T6, #182 decision 2).
    await expect(page.locator('#stock-material-units-minimum-stock')).toHaveCount(0);
    await page.locator('#stock-material-units-submit').click();
    await expect(page.locator('[data-testid="stock-material-units-form-error"]')).toContainText('กรุณากรอกอัตราแปลงของ รีม');
    // รีม is made Inactive with its factor unknown; กล่อง gets its factor to แผ่น.
    await page.locator('#stock-material-units-alternate-0-inactive').check();
    await page.locator('#stock-material-units-alternate-1-factor').fill('2500');
    await page.locator('#stock-material-units-submit').click();

    await expect(page.locator('#stock-material-units-form')).toHaveCount(0);
    await expect(units).toHaveCount(3);
    await expect(units.nth(0)).toContainText('แผ่น(หน่วยนับหลัก)');
    await expect(units.nth(1)).toContainText('1 กล่อง = 2500 แผ่น');
    await expect(units.nth(1).locator('[data-testid="stock-material-unit-inactive"]')).toHaveCount(0);
    await expect(units.nth(2)).toContainText('รีม');
    await expect(units.nth(2).locator('[data-testid="stock-material-unit-inactive"]')).toHaveText('หยุดใช้');
    const changed = page.locator('[data-testid="stock-material-history-2"]');
    await expect(changed).toContainText('แก้ไขหน่วยนับ');
    await expect(changed).toContainText('officer_material');
    await expect(changed.locator('s')).toContainText('หน่วยนับหลัก รีม');
    await expect(changed).toContainText('รีม: อัตราแปลง - (นับเป็นจำนวนเต็มเท่านั้น) (หยุดใช้)');
  });

  test('Journey F008-T4.1: a Supply Officer adds a Brand and a Material Category from the form, changes the Material Category and note without a reason, and finds the Stock Material by Brand and with "ไม่มีหมวด"', async ({ page, context }) => {
    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/new`);
    await page.locator('#stock-material-name').fill('ปากกาลูกลื่น');

    // The Brand list starts empty: Pentel is added from the form and chosen, and its name again is chosen, not added.
    await expect(page.locator('#stock-material-brand option')).toHaveCount(1);
    await page.locator('#stock-material-new-brand').fill('Pentel');
    await page.locator('#stock-material-new-brand-add').click();
    await expect(page.locator('[data-testid="stock-material-new-brand-message"]')).toContainText('เพิ่มยี่ห้อ "Pentel" แล้ว');
    await expect(page.locator('#stock-material-brand option:checked')).toHaveText('Pentel');
    await page.locator('#stock-material-brand').selectOption('');
    await page.locator('#stock-material-new-brand').fill(' pentel ');
    await page.locator('#stock-material-new-brand-add').click();
    await expect(page.locator('[data-testid="stock-material-new-brand-message"]')).toContainText('มียี่ห้อ "Pentel" อยู่แล้ว เลือกให้แล้ว');
    await expect(page.locator('#stock-material-brand option')).toHaveCount(2);
    await expect(page.locator('#stock-material-brand option:checked')).toHaveText('Pentel');

    // So does the Material Category list, which starts empty too (#175 Q3).
    await expect(page.locator('#stock-material-material-category option')).toHaveCount(1);
    await page.locator('#stock-material-new-material-category').fill('เครื่องเขียน');
    await page.locator('#stock-material-new-material-category-add').click();
    await expect(page.locator('[data-testid="stock-material-new-material-category-message"]')).toContainText('เพิ่มหมวดวัสดุ "เครื่องเขียน" แล้ว');
    await expect(page.locator('#stock-material-material-category option:checked')).toHaveText('เครื่องเขียน');

    await page.locator('#stock-material-new-unit').fill('ด้าม');
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('#stock-material-base-unit option:checked')).toHaveText('ด้าม');
    await page.locator('#stock-material-submit').click();

    // Its page shows the Brand and the Material Category, and its history records them.
    await expect(page).toHaveURL(/\/stock-materials\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'ปากกาลูกลื่น' })).toBeVisible();
    await expect(page.locator('[data-testid="stock-material-brand"]')).toHaveText('Pentel');
    await expect(page.locator('[data-testid="stock-material-material-category"]')).toHaveText('เครื่องเขียน');
    const created = page.locator('[data-testid="stock-material-history-1"]');
    await expect(created.locator('dt', { hasText: 'ยี่ห้อ' }).locator('+ dd')).toHaveText('Pentel');
    await expect(created.locator('dt', { hasText: 'หมวดวัสดุ' }).locator('+ dd')).toHaveText('เครื่องเขียน');

    // "แก้ไขข้อมูลอื่น": nothing changed is not sent; the Material Category is cleared and a note added, without a reason.
    await page.locator('#stock-material-edit-details').click();
    await expect(page.locator('#stock-material-details-material-category option:checked')).toHaveText('เครื่องเขียน');
    await page.locator('#stock-material-details-note').fill('  ');
    await page.locator('#stock-material-details-submit').click();
    await expect(page.locator('[data-testid="stock-material-details-form-error"]')).toContainText('ยังไม่มีข้อมูลที่เปลี่ยน');
    await page.locator('#stock-material-details-material-category').selectOption('');
    await page.locator('#stock-material-details-note').fill('ใช้ในห้องประชุม');
    await page.locator('#stock-material-details-submit').click();

    await expect(page.locator('#stock-material-details-form')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-material-category"]')).toHaveText('-');
    await expect(page.locator('[data-testid="stock-material-note"]')).toHaveText('ใช้ในห้องประชุม');
    const changed = page.locator('[data-testid="stock-material-history-2"]');
    await expect(changed).toContainText('แก้ไขข้อมูลอื่น');
    await expect(changed).toContainText('officer_material');
    await expect(changed.locator('s')).toHaveText('เครื่องเขียน');
    await expect(changed.locator('dt', { hasText: 'หมายเหตุ' }).locator('+ dd')).toHaveText('ใช้ในห้องประชุม');

    // The list finds it by its Brand, shows the Brand and no Material Category, and keeps it under "ไม่มีหมวด" only.
    await page.locator('#back-stock-material-list-link').click();
    await expect(page).toHaveURL(/\/stock-materials$/);
    await page.locator('#stock-material-search').fill('pentel');
    await page.locator('#stock-material-search-submit').click();
    await expect(page).toHaveURL(/\/stock-materials\?search=pentel$/);
    const rows = page.locator('#stock-material-list-table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('td').nth(0)).toHaveText('ปากกาลูกลื่น');
    await expect(rows.first().locator('td').nth(1)).toHaveText('Pentel');
    await expect(rows.first().locator('td').nth(4)).toHaveText('-');
    await page.locator('#stock-material-material-category-filter').selectOption({ label: 'ไม่มีหมวด' });
    await expect(page).toHaveURL(/\/stock-materials\?search=pentel&material_category_id=none$/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('ปากกาลูกลื่น');
    await page.locator('#stock-material-material-category-filter').selectOption({ label: 'เครื่องเขียน' });
    await expect(page).toHaveURL(/material_category_id=[0-9a-f-]{36}$/);
    await expect(page.locator('#stock-material-list-empty')).toContainText('ไม่พบวัสดุที่ค้นหา');
  });

  test('Journey F008-T6.1: a Supply Officer sets a Minimum Stock through other details, finds the Stock Material with the Minimum Stock filter, and states it again when the Base Unit changes', async ({ page, context }) => {
    const can = freshUnitName('กระป๋อง');
    const gallon = freshUnitName('แกลลอน');
    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/new`);
    await page.locator('#stock-material-name').fill('น้ำยาล้างจาน');
    await page.locator('#stock-material-new-unit').fill(can);
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('#stock-material-base-unit option:checked')).toHaveText(can);
    await page.locator('#stock-material-new-unit').fill(gallon);
    await page.locator('#stock-material-new-unit-add').click();
    await expect(page.locator('#stock-material-alternate-0-unit option:checked')).toHaveText(gallon);
    await page.locator('#stock-material-alternate-0-factor').fill('10');

    // The form's จำนวนขั้นต่ำ counts the Base Unit, whose whole-number rule the server holds it to (P3).
    await expect(page.locator('#stock-material-minimum-stock + span')).toHaveText(can);
    await page.locator('#stock-material-minimum-stock').fill('1.5');
    await page.locator('#stock-material-submit').click();
    await expect(page.locator('[data-testid="stock-material-form-error"]')).toContainText('minimum_stock must be a whole number');
    await page.locator('#stock-material-minimum-stock').fill('');
    await page.locator('#stock-material-submit').click();

    // Left blank, it stays blank: nothing is guessed (MC-20).
    await expect(page).toHaveURL(/\/stock-materials\/[0-9a-f-]{36}$/);
    const detailUrl = page.url();
    await expect(page.getByRole('heading', { level: 1, name: 'น้ำยาล้างจาน' })).toBeVisible();
    await expect(page.locator('[data-testid="stock-material-minimum-stock"]')).toHaveText('-');

    // The list finds it under "ยังไม่ตั้งจำนวนขั้นต่ำ", not under "ตั้งจำนวนขั้นต่ำแล้ว".
    await page.goto(`${targetBaseUrl}/stock-materials?search=${encodeURIComponent('น้ำยาล้างจาน')}`);
    const rows = page.locator('#stock-material-list-table tbody tr');
    await expect(rows).toHaveCount(1);
    await page.locator('#stock-material-minimum-stock-filter').selectOption({ label: 'ยังไม่ตั้งจำนวนขั้นต่ำ' });
    await expect(page).toHaveURL(/minimum_stock=not_set$/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('td').nth(6)).toHaveText('-');
    await page.locator('#stock-material-minimum-stock-filter').selectOption({ label: 'ตั้งจำนวนขั้นต่ำแล้ว' });
    await expect(page).toHaveURL(/minimum_stock=set$/);
    await expect(page.locator('#stock-material-list-empty')).toContainText('ไม่พบวัสดุที่ค้นหา');

    // "แก้ไขข้อมูลอื่น" sets 20 กระป๋อง without a reason; the same amount written otherwise is no change.
    await page.goto(detailUrl);
    await page.locator('#stock-material-edit-details').click();
    await expect(page.locator('#stock-material-details-minimum-stock + span')).toHaveText(can);
    await page.locator('#stock-material-details-minimum-stock').fill('20');
    await page.locator('#stock-material-details-submit').click();
    await expect(page.locator('#stock-material-details-form')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-minimum-stock"]')).toHaveText(`20 ${can}`);
    const set = page.locator('[data-testid="stock-material-history-2"]');
    await expect(set).toContainText('แก้ไขข้อมูลอื่น');
    await expect(set.locator('dt', { hasText: 'จำนวนขั้นต่ำ' }).locator('+ dd')).toHaveText('20');
    await page.locator('#stock-material-edit-details').click();
    await expect(page.locator('#stock-material-details-minimum-stock')).toHaveValue('20');
    await page.locator('#stock-material-details-minimum-stock').fill(' 20.00 ');
    await page.locator('#stock-material-details-submit').click();
    await expect(page.locator('[data-testid="stock-material-details-form-error"]')).toContainText('ยังไม่มีข้อมูลที่เปลี่ยน');
    await page.locator('#stock-material-details-cancel').click();

    // Now the list finds it under "ตั้งจำนวนขั้นต่ำแล้ว", with 20 กระป๋อง in its row.
    await page.goto(`${targetBaseUrl}/stock-materials?search=${encodeURIComponent('น้ำยาล้างจาน')}&minimum_stock=set`);
    await expect(page.locator('#stock-material-minimum-stock-filter option:checked')).toHaveText('ตั้งจำนวนขั้นต่ำแล้ว');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('td').nth(6)).toHaveText(`20 ${can}`);
    await page.locator('#stock-material-minimum-stock-filter').selectOption({ label: 'ยังไม่ตั้งจำนวนขั้นต่ำ' });
    await expect(page).toHaveURL(/minimum_stock=not_set$/);
    await expect(page.locator('#stock-material-list-empty')).toContainText('ไม่พบวัสดุที่ค้นหา');

    // The Units editor asks for จำนวนขั้นต่ำ again only once แกลลอน becomes the Base Unit, so that 20 กระป๋อง never
    // becomes 20 แกลลอน.
    await page.goto(detailUrl);
    await page.locator('#stock-material-edit-units').click();
    await expect(page.locator('#stock-material-units-minimum-stock')).toHaveCount(0);
    await page.locator('#stock-material-units-base-unit').selectOption({ label: gallon });
    await expect(page.locator('#stock-material-units-minimum-stock')).toHaveValue('');
    await expect(page.locator('#stock-material-units-minimum-stock + span')).toHaveText(gallon);
    await expect(page.locator('#stock-material-units-form')).toContainText(`จำนวนขั้นต่ำเดิม 20 ${can}`);
    await page.locator('#stock-material-units-base-unit-whole').uncheck();
    await page.locator('#stock-material-units-alternate-0-factor').fill('0.1');
    await page.locator('#stock-material-units-minimum-stock').fill('2');
    await page.locator('#stock-material-units-submit').click();

    await expect(page.locator('#stock-material-units-form')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-minimum-stock"]')).toHaveText(`2 ${gallon}`);
    const restated = page.locator('[data-testid="stock-material-history-3"]');
    await expect(restated).toContainText('แก้ไขหน่วยนับ');
    await expect(restated.locator('dt', { hasText: 'จำนวนขั้นต่ำ' }).locator('+ dd')).toHaveText('20 → 2');
  });

  test('Journey F008-T5.1: a Supply Officer makes a Material Correction with a reason, warned that a different item is a new Stock Material and of a Duplicate Candidate, and finds it in the history', async ({ page, context }) => {
    const tag = crypto.randomUUID().slice(0, 4);
    const cartridge = freshUnitName('ตลับ');
    const unit = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', cartridge, { retryToken: crypto.randomUUID() });
    const brand = await new CatalogListService({ db: pool }).add(officerUserId, 'brand', `HP ${tag}`, { retryToken: crypto.randomUUID() });
    const service = new StockMaterialService({ db: pool });
    const { stock_material_id: id } = await service.create(
      officerUserId,
      { name: `ผงหมึกเลเซอรื ${tag}`, model: 'CE258A', specification: 'สีดำ', base_unit: { unit_id: unit.id } },
      { retryToken: crypto.randomUUID() }
    );
    const { stock_material_id: twinId } = await service.create(
      officerUserId,
      { name: `ผงหมึกเลเซอร์ ${tag} สีดำ`, model: 'CF283A', base_unit: { unit_id: unit.id } },
      { retryToken: crypto.randomUUID() }
    );

    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/${id}`);
    await page.locator('#stock-material-correct').click();
    await expect(page.locator('#stock-material-correct')).toHaveCount(0);
    // A really different model or specification is a new Stock Material (MC-11, MC-18).
    await expect(page.locator('[data-testid="stock-material-correction-notice"]')).toContainText('ถ้าเป็นรุ่นหรือคุณลักษณะที่ต่างกันจริง ให้เพิ่มเป็นวัสดุรายการใหม่');
    const name = page.locator('#stock-material-correction-name');
    const brandSelect = page.locator('#stock-material-correction-brand');
    const model = page.locator('#stock-material-correction-model');
    const specification = page.locator('#stock-material-correction-specification');
    const submit = page.locator('#stock-material-correction-submit');
    const formError = page.locator('[data-testid="stock-material-correction-form-error"]');
    await expect(name).toHaveValue(`ผงหมึกเลเซอรื ${tag}`);

    // Nothing changed is not sent, the same text with other spaces around it included; nor is a blank name.
    await name.fill(` ผงหมึกเลเซอรื ${tag} `);
    await model.fill(' CE258A ');
    await specification.fill('สีดำ ');
    await submit.click();
    await expect(formError).toContainText('ยังไม่มีข้อมูลที่เปลี่ยน');
    await name.fill(' ');
    await submit.click();
    await expect(formError).toContainText('กรุณากรอกชื่อวัสดุ');
    // Each of the name, ยี่ห้อ, รุ่น and คุณลักษณะ alone is a change, which then needs a reason.
    await name.fill(`ผงหมึกเลเซอรื ${tag}`);
    await brandSelect.selectOption({ label: brand.name });
    await submit.click();
    await expect(formError).toContainText('กรุณากรอกเหตุผลที่แก้ไข');
    await brandSelect.selectOption('');
    await specification.fill('สีดำ ชนิดผง');
    await submit.click();
    await expect(formError).toContainText('กรุณากรอกเหตุผลที่แก้ไข');
    await specification.fill('สีดำ');
    await model.fill('CE285A');
    await submit.click();
    await expect(formError).toContainText('กรุณากรอกเหตุผลที่แก้ไข');
    await model.fill('CE258A');
    await name.fill(`ผงหมึกเลเซอร์ ${tag}`);
    await submit.click();
    await expect(formError).toContainText('กรุณากรอกเหตุผลที่แก้ไข');
    await model.fill('CE285A');
    await page.locator('#stock-material-correction-reason').fill('พิมพ์ชื่อและรุ่นผิดจากใบส่งของ');
    await submit.click();

    // The corrected name is held in another Stock Material's name; the Stock Material itself is left out (MC-17).
    const warning = page.locator('[data-testid="duplicate-candidate-warning"]');
    await expect(warning.locator('tbody tr')).toHaveCount(1);
    await expect(warning.locator(`[data-testid="duplicate-candidate-${twinId}"]`)).toContainText('CF283A');
    await expect(page.locator('#stock-material-correction-reason')).toBeDisabled();
    await page.locator('#duplicate-candidate-confirm').click();
    await expect(page.locator('#stock-material-correct')).toBeVisible();

    // The page shows the corrected values, and the history the reason with each value before and after.
    await expect(page.locator('#stock-material-correction-form')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: `ผงหมึกเลเซอร์ ${tag}` })).toBeVisible();
    await expect(page.locator('[data-testid="stock-material-model"]')).toHaveText('CE285A');
    const corrected = page.locator('[data-testid="stock-material-history-2"]');
    await expect(corrected).toContainText('แก้ไขรายการที่บันทึกผิด');
    await expect(corrected).toContainText('officer_material');
    await expect(page.locator('[data-testid="stock-material-history-2-reason"]')).toHaveText('เหตุผล: พิมพ์ชื่อและรุ่นผิดจากใบส่งของ');
    await expect(page.locator('[data-testid="stock-material-history-1-reason"]')).toHaveCount(0);
    await expect(corrected.locator('dt', { hasText: 'ชื่อวัสดุ' }).locator('+ dd')).toHaveText(`ผงหมึกเลเซอรื ${tag} → ผงหมึกเลเซอร์ ${tag}`);
    await expect(corrected.locator('dt', { hasText: 'รุ่น' }).locator('+ dd')).toHaveText('CE258A → CE285A');
  });

  test('Journey F008-T7.1: a Supply Officer makes a Stock Material Inactive with a note, finds it with the status filter and its "หยุดใช้" badge, and reactivates it as the same record, each refused as stale when another Supply Officer changed the status first', async ({ page, context }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    const box = freshUnitName('กล่อง');
    const unit = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', box, { retryToken: crypto.randomUUID() });
    const name = `ลวดเย็บกระดาษ ${tag}`;
    const service = new StockMaterialService({ db: pool });
    const { stock_material_id: id } = await service.create(
      officerUserId,
      { name, model: 'เบอร์ 10', base_unit: { unit_id: unit.id } },
      { retryToken: crypto.randomUUID() }
    );
    const status = page.locator('[data-testid="stock-material-status"]');
    const row = page.locator(`[data-testid="stock-material-row-${id}"]`);
    const badge = page.locator(`[data-testid="stock-material-inactive-badge-${id}"]`);
    const statusFilter = page.locator('#stock-material-status-filter');

    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/${id}`);
    await expect(status).toHaveText('ใช้งานอยู่');
    // The server offers "หยุดใช้" on a Stock Material in use, and not "เปิดใช้อีกครั้ง" (P9).
    await expect(page.locator('#stock-material-reactivate')).toHaveCount(0);
    await page.locator('#stock-material-inactivate').click();
    await expect(page.locator('#stock-material-inactivate')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-status-notice"]')).toContainText('เปิดใช้อีกครั้งได้ภายหลัง');
    // Cancelled, nothing changes.
    await page.locator('#stock-material-status-cancel').click();
    await expect(page.locator('#stock-material-status-form')).toHaveCount(0);
    await expect(status).toHaveText('ใช้งานอยู่');

    // Another Supply Officer makes it Inactive while the form is open: the save is refused as stale, and the page read
    // again offers "เปิดใช้อีกครั้ง" instead of the form (Q23, P9).
    await page.locator('#stock-material-inactivate').click();
    await service.inactivate(officerUserId, id, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    await page.locator('#stock-material-status-submit').click();
    await expect(page.locator('[data-testid="stock-material-status-form-error"]')).toContainText('มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่');
    await page.locator('#stock-material-status-reload').click();
    await expect(status).toHaveText('หยุดใช้');
    await expect(page.locator('#stock-material-status-form')).toHaveCount(0);
    await expect(page.locator('#stock-material-reactivate')).toBeVisible();
    await service.reactivate(officerUserId, id, { expected_version: 2 }, { retryToken: crypto.randomUUID() });
    await page.reload();
    await expect(status).toHaveText('ใช้งานอยู่');

    await page.locator('#stock-material-inactivate').click();
    await page.locator('#stock-material-status-note').fill(' เลิกใช้ เปลี่ยนเป็นรุ่นเบอร์ 35 ');
    await page.locator('#stock-material-status-submit').click();

    // The same page shows it Inactive, with "เปิดใช้อีกครั้ง" now, and the history who did it, when and the note.
    await expect(status).toHaveText('หยุดใช้');
    await expect(page.locator('#stock-material-status-form')).toHaveCount(0);
    await expect(page.locator('#stock-material-inactivate')).toHaveCount(0);
    await expect(page.locator('#stock-material-reactivate')).toBeVisible();
    const inactivated = page.locator('[data-testid="stock-material-history-4"]');
    await expect(inactivated.locator('div').first()).toHaveText('หยุดใช้');
    await expect(inactivated).toContainText('officer_material');
    await expect(inactivated.locator('time')).toBeVisible();
    await expect(page.locator('[data-testid="stock-material-history-4-note"]')).toHaveText('หมายเหตุ: เลิกใช้ เปลี่ยนเป็นรุ่นเบอร์ 35');
    await expect(inactivated.locator('dt', { hasText: 'สถานะ' }).locator('+ dd')).toHaveText('ใช้งานอยู่ → หยุดใช้');
    // Nothing else changed: the Model and the Unit are as they were.
    await expect(page.locator('[data-testid="stock-material-model"]')).toHaveText('เบอร์ 10');
    await expect(page.locator(`[data-testid="stock-material-unit-${unit.id}"]`)).toBeVisible();

    // The list shows the Stock Materials in use by default, so it is not there until the status filter finds it.
    await page.locator('#back-stock-material-list-link').click();
    await page.locator('#stock-material-search').fill(tag);
    await page.locator('#stock-material-search-submit').click();
    await expect(page).toHaveURL(/search=/);
    await expect(statusFilter).toHaveValue('');
    await expect(page.locator('#stock-material-list-empty')).toHaveText('ไม่พบวัสดุที่ค้นหา');
    await expect(row).toHaveCount(0);
    await statusFilter.selectOption({ label: 'หยุดใช้' });
    await expect(page).toHaveURL(/status=inactive/);
    await expect(row).toBeVisible();
    await expect(badge).toHaveText('หยุดใช้');
    await statusFilter.selectOption({ label: 'ทั้งหมด' });
    await expect(page).toHaveURL(/status=all/);
    await expect(badge).toHaveText('หยุดใช้');

    // Reactivated from its page, it is the same record with its whole history.
    await row.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`/stock-materials/${id}$`));
    // Reactivated by another Supply Officer while the form is open, the page read again offers "หยุดใช้" instead.
    await page.locator('#stock-material-reactivate').click();
    await service.reactivate(officerUserId, id, { expected_version: 4 }, { retryToken: crypto.randomUUID() });
    await page.locator('#stock-material-status-submit').click();
    await expect(page.locator('[data-testid="stock-material-status-form-error"]')).toContainText('มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่');
    await page.locator('#stock-material-status-reload').click();
    await expect(status).toHaveText('ใช้งานอยู่');
    await expect(page.locator('#stock-material-status-form')).toHaveCount(0);
    await expect(page.locator('#stock-material-inactivate')).toBeVisible();
    await service.inactivate(officerUserId, id, { expected_version: 5 }, { retryToken: crypto.randomUUID() });
    await page.reload();
    await expect(status).toHaveText('หยุดใช้');

    await page.locator('#stock-material-reactivate').click();
    await expect(page.locator('#stock-material-reactivate')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-status-notice"]')).toContainText('รายการเดิม');
    await expect(page.locator('#stock-material-status-note')).toHaveCount(0);
    await page.locator('#stock-material-status-submit').click();
    await expect(status).toHaveText('ใช้งานอยู่');
    await expect(page.locator('#stock-material-inactivate')).toBeVisible();
    await expect(page.locator('#stock-material-reactivate')).toHaveCount(0);
    const reactivated = page.locator('[data-testid="stock-material-history-7"]');
    await expect(reactivated.locator('div').first()).toHaveText('เปิดใช้อีกครั้ง');
    await expect(reactivated).toContainText('officer_material');
    await expect(reactivated.locator('dt', { hasText: 'สถานะ' }).locator('+ dd')).toHaveText('หยุดใช้ → ใช้งานอยู่');
    await expect(page.locator('[data-testid="stock-material-history-7-note"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="stock-material-history-1"]')).toBeVisible();

    // In use again, the default list shows it, with no badge.
    await page.goto(`${targetBaseUrl}/stock-materials?search=${encodeURIComponent(tag)}`);
    await expect(row).toBeVisible();
    await expect(badge).toHaveCount(0);
  });

  test('Journey F008-T1.2: a Read-only User reads the list and a Stock Material page with no action, and an Asset Custodian has no "วัสดุ" menu', async ({ page, context }) => {
    const bottle = freshUnitName('ขวด');
    const unit = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', bottle, { retryToken: crypto.randomUUID() });
    const { stock_material_id: id } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name: 'น้ำยาเช็ดกระจก', model: 'Glass Clean', specification: '500 มล.', base_unit: { unit_id: unit.id, whole_number_only: false } },
      { retryToken: crypto.randomUUID() }
    );

    await loginAs(context, readonlyUserId);
    await openDashboard(page);
    await page.locator('#nav-stock-material-list').click();
    await expect(page).toHaveURL(/\/stock-materials$/);
    const row = page.locator(`[data-testid="stock-material-row-${id}"]`);
    await expect(row).toContainText('Glass Clean');
    await expect(row).toContainText('500 มล.');
    await expect(row).toContainText(bottle);
    // The Supply Officer was offered "เพิ่มวัสดุ" on this list (Journey F008-T1.1).
    await expect(page.locator('#stock-material-add-action')).toHaveCount(0);

    await row.getByRole('link', { name: 'น้ำยาเช็ดกระจก' }).click();
    await expect(page).toHaveURL(new RegExp(`/stock-materials/${id}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'น้ำยาเช็ดกระจก' })).toBeVisible();
    await expect(page.locator(`[data-testid="stock-material-unit-${unit.id}"]`)).toContainText('ไม่ใช่ (มีเศษได้)');
    await expect(page.locator('[data-testid="stock-material-status"]')).toHaveText('ใช้งานอยู่');
    await expect(page.locator('[data-testid="stock-material-history-1"]')).toContainText(`หน่วยนับหลัก ${bottle}`);
    // The Supply Officer was offered "แก้ไขหน่วยนับ", "แก้ไขข้อมูลอื่น", "แก้ไขรายการที่บันทึกผิด", "หยุดใช้" and
    // "เปิดใช้อีกครั้ง" on a Stock Material page (Journeys F008-T3.1, T4.1, T5.1, T7.1).
    await expect(page.locator('#stock-material-edit-units')).toHaveCount(0);
    await expect(page.locator('#stock-material-edit-details')).toHaveCount(0);
    await expect(page.locator('#stock-material-correct')).toHaveCount(0);
    await expect(page.locator('#stock-material-inactivate')).toHaveCount(0);
    // Nor "เปิดใช้อีกครั้ง" on an Inactive one, whose page the Read-only User still reads.
    const service = new StockMaterialService({ db: pool });
    const { stock_material_id: inactiveId } = await service.create(
      officerUserId,
      { name: `น้ำยาเช็ดกระจก สูตรเก่า ${crypto.randomUUID().slice(0, 4)}`, base_unit: { unit_id: unit.id }, explicit_continuation: true },
      { retryToken: crypto.randomUUID() }
    );
    await service.inactivate(officerUserId, inactiveId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    await page.goto(`${targetBaseUrl}/stock-materials/${inactiveId}`);
    await expect(page.locator('[data-testid="stock-material-status"]')).toHaveText('หยุดใช้');
    await expect(page.locator('#stock-material-reactivate')).toHaveCount(0);
    await expect(page.locator('#stock-material-inactivate')).toHaveCount(0);

    // The form refuses a viewer without material:manage.
    await page.goto(`${targetBaseUrl}/stock-materials/new`);
    await expect(page.locator('#stock-material-create-forbidden')).toContainText('คุณไม่มีสิทธิ์เพิ่มวัสดุ');
    await expect(page.locator('#stock-material-form')).toHaveCount(0);

    // An Asset Custodian sees the Dashboard's other menus but no "วัสดุ", and the list refuses them.
    await switchActor(page, context, custodianUserId);
    await openDashboard(page);
    await expect(page.locator('#nav-repair-list')).toBeVisible();
    await expect(page.locator('#nav-material-section')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/stock-materials`);
    await expect(page.locator('#stock-material-list-error')).toContainText('คุณไม่มีสิทธิ์เข้าถึงรายการวัสดุ');
    await expect(page.locator('#stock-material-list-table')).toHaveCount(0);
  });
});
