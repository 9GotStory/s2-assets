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
import { CatalogListService } from '../../../api/src/services/catalog-list.service.ts';
import { RequestableMaterialService } from '../../../api/src/services/requestable-material.service.ts';
import { StockMaterialService } from '../../../api/src/services/stock-material.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// Feature 009 (#202, Seam B). F009-T1 (#203): Journey J1 starts: a Supply Officer creates the Requestable Material
// "กระดาษ A4" with Request Unit รีม and finds it in the list and on its page. F009-T2 (#204) completes it with its
// Compatible Stock Materials and the "ยังไม่มีวัสดุที่ใช้จ่าย" badge.
test.describe.serial('Material Request journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;

  let officerUserId: string;
  let reamId: string;

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
      cookieSecret: 'test-secret-at-least-32-chars-long-material-request-e2e',
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
    officerUserId = await createUser('officer_request', 'SUPPLY_OFFICER');
    // The Unit list the Supply Officer chooses from: รีม, and แผ่น made Inactive, which is not offered (#202 Q15).
    const units = new CatalogListService({ db: pool });
    reamId = (await units.add(officerUserId, 'unit', 'รีม', { retryToken: crypto.randomUUID() })).id;
    const sheet = await units.add(officerUserId, 'unit', 'แผ่น', { retryToken: crypto.randomUUID() });
    await units.inactivate(officerUserId, 'unit', sheet.id, { expected_version: sheet.version }, { retryToken: crypto.randomUUID() });

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

  // The session answers late, so that a page shows its facts before the CSRF token arrives: a write action waits for the
  // token, or a quick save would be refused as if the grant were gone (#135).
  const delaySessionCheck = (page: any) =>
    page.route('**/auth/session-check', async (route: any) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

  const loginAs = async (context: any, userId: string) => {
    const session = await sessionService.createSession(userId);
    await context.addCookies([{ name: 'session', value: session.token, url: targetBaseUrl }]);
  };

  // Opens the Dashboard and waits until it has asked whether the viewer may read the catalog.
  const openDashboard = async (page: any) => {
    const probed = page.waitForResponse((res: any) => res.url().includes('/stock-materials?limit=1'));
    await page.goto(`${targetBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await probed;
  };

  test('Journey F009-T1.1: a Supply Officer opens "วัสดุสำหรับขอเบิก" in the "วัสดุ" menu, creates "กระดาษ A4" with Request Unit รีม, finds it in the list and on its page, and is refused a second one of that name', async ({ page, context }) => {
    await loginAs(context, officerUserId);
    await openDashboard(page);
    await page.locator('#nav-requestable-material-list').click();
    await expect(page).toHaveURL(/\/requestable-materials$/);
    await expect(page.getByRole('heading', { level: 1, name: 'วัสดุสำหรับขอเบิก' })).toBeVisible();
    await expect(page.locator('#requestable-material-list-empty')).toContainText('ยังไม่มีวัสดุสำหรับขอเบิก');

    await delaySessionCheck(page);
    await page.locator('#requestable-material-add-action').click();
    await expect(page).toHaveURL(/\/requestable-materials\/new$/);

    // Neither a name nor a Request Unit is optional; only the active Unit รีม is offered.
    await page.locator('#requestable-material-submit').click();
    await expect(page.locator('[data-testid="requestable-material-form-error"]')).toContainText('กรุณากรอกชื่อ');
    await page.locator('#requestable-material-name').fill('กระดาษ A4');
    await page.locator('#requestable-material-submit').click();
    await expect(page.locator('[data-testid="requestable-material-form-error"]')).toContainText('กรุณาเลือกหน่วยที่ขอ');
    await expect(page.locator('#requestable-material-request-unit option')).toHaveText(['-- เลือกหน่วยที่ขอ --', 'รีม']);
    await page.locator('#requestable-material-request-unit').selectOption({ label: 'รีม' });
    // Whole-number-only starts switched on (#202 Q5).
    await expect(page.locator('#requestable-material-whole-number-only')).toBeChecked();
    await page.locator('#requestable-material-description').fill('กระดาษถ่ายเอกสารขนาด A4');
    await page.locator('#requestable-material-submit').click();

    // Its page shows every field and its creation in the history.
    await expect(page).toHaveURL(/\/requestable-materials\/[0-9a-f-]{36}$/);
    const pageUrl = page.url();
    await expect(page.getByRole('heading', { level: 1, name: 'กระดาษ A4' })).toBeVisible();
    await expect(page.locator('[data-testid="requestable-material-request-unit"]')).toHaveText('รีม');
    await expect(page.locator('[data-testid="requestable-material-whole-number-only"]')).toHaveText('ใช่');
    await expect(page.locator('[data-testid="requestable-material-description"]')).toHaveText('กระดาษถ่ายเอกสารขนาด A4');
    await expect(page.locator('[data-testid="requestable-material-status"]')).toHaveText('ใช้งานอยู่');
    const created = page.locator('[data-testid="requestable-material-history-1"]');
    await expect(created).toContainText('สร้างรายการ');
    await expect(created).toContainText('officer_request');
    await expect(created).toContainText('หน่วยที่ขอรีม');
    await expect(created).toContainText('นับเป็นจำนวนเต็มเท่านั้นใช่');
    await expect(created).toContainText('รายละเอียดกระดาษถ่ายเอกสารขนาด A4');

    // Another Supply Officer's entry, whose quantities may have fractions and which has no description.
    const { requestable_material_id: penId } = await new RequestableMaterialService({ db: pool }).create(
      officerUserId,
      { name: 'ปากกาน้ำเงิน', request_unit_id: reamId, whole_number_only: false },
      { retryToken: crypto.randomUUID() }
    );

    // The list shows both by name, each with its Request Unit, whole-number setting and status.
    await page.locator('#back-requestable-material-list-link').click();
    await expect(page).toHaveURL(/\/requestable-materials$/);
    const pen = page.locator(`[data-testid="requestable-material-row-${penId}"]`);
    await expect(page.locator('#requestable-material-list-table tbody tr')).toHaveCount(2);
    await expect(pen).toContainText('ปากกาน้ำเงิน');
    await expect(pen).toContainText('ไม่ใช่ (มีเศษได้)');
    await pen.getByRole('link', { name: 'ปากกาน้ำเงิน' }).click();
    await expect(page).toHaveURL(new RegExp(`/requestable-materials/${penId}$`));
    await expect(page.locator('[data-testid="requestable-material-whole-number-only"]')).toHaveText('ไม่ใช่ (มีเศษได้)');
    await expect(page.locator('[data-testid="requestable-material-description"]')).toHaveText('-');
    await page.locator('#back-requestable-material-list-link').click();
    await expect(page).toHaveURL(/\/requestable-materials$/);

    // A search finds by name, ignoring case and repeated spaces, or finds nothing.
    await page.locator('#requestable-material-search').fill('ดินสอ');
    await page.locator('#requestable-material-search-submit').click();
    await expect(page).toHaveURL(/\/requestable-materials\?search=/);
    await expect(page.locator('#requestable-material-list-empty')).toContainText('ไม่พบวัสดุสำหรับขอเบิกที่ค้นหา');
    await page.locator('#requestable-material-search').fill('กระดาษ   a4');
    await page.locator('#requestable-material-search-submit').click();
    await expect(page).toHaveURL(/\/requestable-materials\?search=%E0%B8%81/);
    const rows = page.locator('#requestable-material-list-table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('กระดาษ A4');
    await expect(rows.first()).toContainText('รีม');
    await expect(rows.first()).toContainText('ใช้งานอยู่');

    // A second "กระดาษ a4" is refused, naming the one that holds the name (#202 Q6).
    await page.locator('#requestable-material-add-action').click();
    await expect(page).toHaveURL(/\/requestable-materials\/new$/);
    await page.locator('#requestable-material-name').fill('กระดาษ a4');
    await page.locator('#requestable-material-request-unit').selectOption({ label: 'รีม' });
    await page.locator('#requestable-material-submit').click();
    const taken = page.locator('[data-testid="requestable-material-name-taken"]');
    await expect(taken).toContainText('มีวัสดุสำหรับขอเบิกชื่อนี้อยู่แล้ว: กระดาษ A4');
    await taken.getByRole('link', { name: 'กระดาษ A4' }).click();
    await expect(page).toHaveURL(pageUrl);
  });

  test('Journey F009-T2.1: a Supply Officer sees "ยังไม่มีวัสดุที่ใช้จ่าย" on "กระดาษ A4", finds the Stock Material without รีม greyed with its reason, adds a Compatible Stock Material, which removes the badge, ends it and adds it again', async ({ page, context }) => {
    // A Stock Material counted in รีม, with กล่อง as an Inactive Alternate Unit; one with no รีม among its Units; and
    // 25 others, more than the picker shows at once.
    const box = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', 'กล่อง', { retryToken: crypto.randomUUID() });
    const stockMaterials = new StockMaterialService({ db: pool });
    const copyPaperId = (
      await stockMaterials.create(officerUserId, { name: 'กระดาษถ่ายเอกสาร A4 80 แกรม', base_unit: { unit_id: reamId } }, { retryToken: crypto.randomUUID() })
    ).stock_material_id;
    await stockMaterials.replaceUnits(
      officerUserId,
      copyPaperId,
      { expected_version: 1, base_unit: { unit_id: reamId }, alternate_units: [{ unit_id: box.id, conversion_factor: '5', is_active: false }] },
      { retryToken: crypto.randomUUID() }
    );
    // A choice names its Brand and Model beside its name.
    const brandId = (await pool.query(`INSERT INTO brands (name, created_by, updated_by) VALUES ('ตราการ์ด', $1, $1) RETURNING id`, [officerUserId])).rows[0].id;
    const cardPaperId = (
      await stockMaterials.create(
        officerUserId,
        { name: 'กระดาษการ์ดสี A4', brand_id: brandId, model: 'CC-160', base_unit: { unit_id: box.id }, explicit_continuation: true },
        { retryToken: crypto.randomUUID() }
      )
    ).stock_material_id;
    for (let n = 1; n <= 25; n++) {
      await stockMaterials.create(officerUserId, { name: `แฟ้มเอกสาร ${n}`, base_unit: { unit_id: box.id }, explicit_continuation: true }, { retryToken: crypto.randomUUID() });
    }
    // An Inactive Requestable Material is not offered either, but shows no badge (#202 Q9): what F009-T7's write leaves.
    const { requestable_material_id: inkId } = await new RequestableMaterialService({ db: pool }).create(
      officerUserId,
      { name: 'หมึกพิมพ์เลิกขอ', request_unit_id: reamId },
      { retryToken: crypto.randomUUID() }
    );
    await pool.query('UPDATE requestable_materials SET is_active = false, version = version + 1 WHERE id = $1', [inkId]);

    await loginAs(context, officerUserId);
    await page.goto(`${targetBaseUrl}/requestable-materials`);
    const paperRow = page.locator('#requestable-material-list-table tbody tr').filter({ hasText: 'กระดาษ A4' });
    const penRow = page.locator('#requestable-material-list-table tbody tr').filter({ hasText: 'ปากกาน้ำเงิน' });
    // Neither has a Compatible Stock Material yet (#202 Q9).
    await expect(paperRow).toContainText('ยังไม่มีวัสดุที่ใช้จ่าย');
    await expect(penRow).toContainText('ยังไม่มีวัสดุที่ใช้จ่าย');
    const inkRow = page.locator(`[data-testid="requestable-material-row-${inkId}"]`);
    await expect(inkRow).toContainText('หยุดใช้');
    await expect(inkRow).not.toContainText('ยังไม่มีวัสดุที่ใช้จ่าย');

    await delaySessionCheck(page);
    await paperRow.getByRole('link', { name: 'กระดาษ A4' }).click();
    await expect(page).toHaveURL(/\/requestable-materials\/[0-9a-f-]{36}$/);
    const pageUrl = page.url();
    await expect(page.locator('[data-testid="requestable-material-no-compatible-badge"]')).toHaveText('ยังไม่มีวัสดุที่ใช้จ่าย');
    await expect(page.locator('#compatible-stock-material-empty')).toHaveText('ยังไม่มีวัสดุที่ใช้จ่าย');
    // The add waits for the CSRF token (#135).
    await expect(page.locator('#compatible-stock-material-add-action')).toHaveCount(0);

    // The picker lists the active Stock Materials; the one without รีม is greyed with its reason and cannot be chosen
    // (#202 Q19, ADR 0002).
    // Its first read fails, and says so; the next shows the first 25 of the 27 active Stock Materials.
    // Every read fails until the page says so: StrictMode may abort the first and send it again.
    const choicesUrl = /\/stock-material-choices\?/;
    await page.route(choicesUrl, (route: any) => route.fulfill({ status: 500, body: '{}' }));
    await page.locator('#compatible-stock-material-add-action').click();
    // One action at a time.
    await expect(page.locator('#compatible-stock-material-add-action')).toHaveCount(0);
    await expect(page.locator('#compatible-stock-material-choices-error')).toContainText('เกิดข้อผิดพลาดในการโหลดรายการวัสดุ');
    await page.unroute(choicesUrl);
    await page.locator('#compatible-stock-material-search-submit').click();
    await expect(page.locator('#compatible-stock-material-choices li')).toHaveCount(25);
    await expect(page.locator('#compatible-stock-material-add-form')).toContainText('แสดง 25 รายการแรกจาก 27 รายการ');
    // A search finds nothing, or narrows the list; Enter searches. A search still being read says so.
    let releaseSearch = () => {};
    const searchHeld = new Promise<void>((resolve) => (releaseSearch = resolve));
    await page.route(choicesUrl, async (route: any) => {
      await searchHeld;
      await route.continue();
    });
    await page.locator('#compatible-stock-material-search').fill('ดินสอ');
    await page.locator('#compatible-stock-material-search-submit').click();
    await expect(page.getByText('กำลังโหลดรายการวัสดุ...')).toBeVisible();
    releaseSearch();
    await expect(page.locator('#compatible-stock-material-choices-empty')).toHaveText('ไม่พบวัสดุที่ใช้งานอยู่ที่ค้นหา');
    await expect(page.getByText('กำลังโหลดรายการวัสดุ...')).toHaveCount(0);
    await page.unroute(choicesUrl);
    await page.locator('#compatible-stock-material-search').fill('กระดาษ');
    await page.locator('#compatible-stock-material-search').press('Enter');
    await expect(page.locator('#compatible-stock-material-choices li')).toHaveCount(2);
    await expect(page.locator('#compatible-stock-material-add-form')).not.toContainText('รายการแรกจาก');
    const card = page.locator(`[data-testid="stock-material-choice-${cardPaperId}"]`);
    const copy = page.locator(`[data-testid="stock-material-choice-${copyPaperId}"]`);
    await expect(card).toContainText('กระดาษการ์ดสี A4 · ตราการ์ด · CC-160');
    await expect(page.locator(`[data-testid="stock-material-choice-reason-${cardPaperId}"]`)).toHaveText('(ไม่มีหน่วย รีม)');
    await expect(card.getByRole('radio')).toBeDisabled();
    await expect(copy.getByRole('radio')).toBeEnabled();
    await expect(page.locator(`[data-testid="stock-material-choice-reason-${copyPaperId}"]`)).toHaveCount(0);
    // Nothing is chosen for the Supply Officer (MRQ-26).
    await page.locator('#compatible-stock-material-add-submit').click();
    await expect(page.locator('[data-testid="compatible-stock-material-add-form-error"]')).toContainText('กรุณาเลือกวัสดุ');
    await copy.getByRole('radio').check();
    await page.locator('#compatible-stock-material-add-submit').click();

    // The badge is gone; the Compatible Stock Material shows current with its status and Units, and the add is in
    // the history under its name.
    await expect(page.locator(`[data-testid="compatible-stock-material-row-${copyPaperId}"]`)).toContainText('ใช้อยู่');
    await expect(page.locator('[data-testid="requestable-material-no-compatible-badge"]')).toHaveCount(0);
    const row = page.locator(`[data-testid="compatible-stock-material-row-${copyPaperId}"]`);
    await expect(row).toContainText('กระดาษถ่ายเอกสาร A4 80 แกรม');
    await expect(row).toContainText('ใช้งานอยู่');
    await expect(row.locator('td').nth(2)).toHaveText('รีม (หน่วยนับหลัก), กล่อง (หยุดใช้)');
    const added = page.locator('[data-testid="requestable-material-history-2"]');
    await expect(added).toContainText('เพิ่มวัสดุที่ใช้จ่ายได้');
    await expect(added).toContainText('วัสดุที่ใช้จ่ายได้กระดาษถ่ายเอกสาร A4 80 แกรม');
    await expect(added).toContainText('officer_request');

    // In the list, only "ปากกาน้ำเงิน" still has no Compatible Stock Material.
    await page.locator('#back-requestable-material-list-link').click();
    await expect(page).toHaveURL(/\/requestable-materials$/);
    await expect(penRow).toContainText('ยังไม่มีวัสดุที่ใช้จ่าย');
    await expect(paperRow).toContainText('ใช้งานอยู่');
    await expect(paperRow).not.toContainText('ยังไม่มีวัสดุที่ใช้จ่าย');

    // Ending it keeps it as ended and brings the badge back; adding it again makes the same one current (P1).
    await page.goto(pageUrl);
    await page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`).click();
    await expect(page.locator('[data-testid="compatible-stock-material-end-notice"]')).toContainText('เพิ่มกลับได้ภายหลัง');
    await expect(page.locator('#compatible-stock-material-add-action')).toHaveCount(0);
    await expect(page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`)).toHaveCount(0);
    await page.locator('#compatible-stock-material-end-submit').click();
    await expect(row).toContainText('เลิกแล้ว');
    await expect(page.locator('[data-testid="requestable-material-no-compatible-badge"]')).toHaveText('ยังไม่มีวัสดุที่ใช้จ่าย');
    await expect(page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`)).toHaveCount(0);
    const ended = page.locator('[data-testid="requestable-material-history-3"]');
    await expect(ended).toContainText('เลิกวัสดุที่ใช้จ่ายได้');
    await expect(ended).toContainText('วัสดุที่ใช้จ่ายได้กระดาษถ่ายเอกสาร A4 80 แกรม');

    await page.locator('#compatible-stock-material-add-action').click();
    await copy.getByRole('radio').check();
    await page.locator('#compatible-stock-material-add-submit').click();
    await expect(row).toContainText('ใช้อยู่');
    await expect(page.locator('#compatible-stock-material-table tbody tr')).toHaveCount(1);
    await expect(page.locator('[data-testid="requestable-material-no-compatible-badge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="requestable-material-history-4"]')).toContainText('เพิ่มวัสดุที่ใช้จ่ายได้');

    // An added one shows "ใช้อยู่" in the picker and cannot be chosen again.
    await page.locator('#compatible-stock-material-add-action').click();
    await expect(page.locator(`[data-testid="stock-material-choice-reason-${copyPaperId}"]`)).toHaveText('(ใช้อยู่)');
    await expect(copy.getByRole('radio')).toBeDisabled();

    // A save after the grant went is refused, and the page read again offers no action (P9).
    await page.locator('#compatible-stock-material-add-cancel').click();
    await page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`).click();
    await pool.query(`UPDATE user_roles SET role_id = 'READ_ONLY' WHERE user_id = $1 AND role_id = 'SUPPLY_OFFICER'`, [officerUserId]);
    try {
      await page.locator('#compatible-stock-material-end-submit').click();
      await expect(page.locator('#compatible-stock-material-end-form')).toHaveCount(0);
      await expect(row).toContainText('ใช้อยู่');
      await expect(page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`)).toHaveCount(0);
      await expect(page.locator('#compatible-stock-material-add-action')).toHaveCount(0);
    } finally {
      await pool.query(`UPDATE user_roles SET role_id = 'SUPPLY_OFFICER' WHERE user_id = $1 AND role_id = 'READ_ONLY'`, [officerUserId]);
    }

    // A save after the session ended signs the Supply Officer out.
    await page.reload();
    await page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`).click();
    await context.clearCookies();
    await page.locator('#compatible-stock-material-end-submit').click();
    await expect(page).toHaveURL(/\/login$/);

    // A Read-only User sees the Compatible Stock Materials and no action on them (#202 Q18, P9).
    const reader = await pool.query(`INSERT INTO users (username, password_hash, is_active) VALUES ('reader_request', $1, true) RETURNING id`, [await UserService.hashPassword('Password123!')]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')`, [reader.rows[0].id]);
    await loginAs(context, reader.rows[0].id);
    await page.goto(pageUrl);
    await expect(row).toContainText('ใช้อยู่');
    await expect(page.locator('#compatible-stock-material-table thead th')).toHaveText(['วัสดุ', 'สถานะวัสดุ', 'หน่วยนับ', 'การใช้จ่าย']);
    await expect(page.locator('#compatible-stock-material-add-action')).toHaveCount(0);
    await expect(page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`)).toHaveCount(0);
  });
});
