import { test, expect } from '@playwright/test';
import { actorSwitch } from './support/actors.ts';
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
import { MaterialRequestService } from '../../../api/src/services/material-request.service.ts';
import { StockMaterialService } from '../../../api/src/services/stock-material.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// Feature 009 (#202, Seam B). F009-T1 (#203): Journey J1 starts: a Supply Officer creates the Requestable Material
// "กระดาษ A4" with Request Unit รีม and finds it in the list and on its page. F009-T2 (#204) completes it with its
// Compatible Stock Materials and the "ยังไม่มีวัสดุที่ใช้จ่าย" badge. F009-T4 (#206): Journey J2 starts: a Requester saves a
// Material Request of two Requested Items; F009-T5 (#207) completes it with their Cancels. F009-T7 (#209) grows J1 with
// "หยุดใช้" and "เปิดใช้อีกครั้ง", last, once J2 and J3 have left Pending Requested Items.
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

  const { loginAs, switchActor } = actorSwitch(() => sessionService, () => targetBaseUrl);

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
    // F009-T7: a status filter that finds nothing says so as a search does, and "ใช้งานอยู่" again leaves the URL bare.
    await page.locator('#requestable-material-status-filter').selectOption('inactive');
    await expect(page.locator('#requestable-material-list-empty')).toHaveText('ไม่พบวัสดุสำหรับขอเบิกที่ค้นหา');
    await page.locator('#requestable-material-status-filter').selectOption('');
    await expect(page).toHaveURL(/\/requestable-materials$/);
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
    await expect(taken).toHaveText('มีวัสดุสำหรับขอเบิกชื่อนี้อยู่แล้ว: กระดาษ A4');
    // F009-T7: one in use offers no "เปิดใช้อีกครั้ง".
    await expect(page.locator('#requestable-material-offer-reactivate')).toHaveCount(0);
    await taken.getByRole('link', { name: 'กระดาษ A4' }).click();
    await expect(page).toHaveURL(pageUrl);
  });

  test('Journey F009-T2.1: a Supply Officer sees "ยังไม่มีวัสดุที่ใช้จ่าย" on "กระดาษ A4", finds the Stock Material without รีม greyed with its reason, adds a Compatible Stock Material, which removes the badge, ends it and adds it again, and the Units form refuses making รีม Inactive on a Stock Material it is asked for in', async ({ page, context }) => {
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
    // An Inactive Requestable Material is not offered either, but shows no "ยังไม่มีวัสดุที่ใช้จ่าย" badge (#202 Q9).
    const { requestable_material_id: inkId } = await new RequestableMaterialService({ db: pool }).create(
      officerUserId,
      { name: 'หมึกพิมพ์เลิกขอ', request_unit_id: reamId },
      { retryToken: crypto.randomUUID() }
    );
    await new RequestableMaterialService({ db: pool }).inactivate(officerUserId, inkId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });

    await loginAs(context, officerUserId);
    // F009-T7: the list shows the active ones unless asked for all.
    await page.goto(`${targetBaseUrl}/requestable-materials?status=all`);
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
    // Every form but a Cancel's keeps "ยกเลิก" for closing it (#207 start decision 3).
    await expect(page.locator('#compatible-stock-material-end-cancel')).toHaveText('ยกเลิก');
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
    await switchActor(page, context, reader.rows[0].id);
    await page.goto(pageUrl);
    await expect(row).toContainText('ใช้อยู่');
    await expect(page.locator('#compatible-stock-material-table thead th')).toHaveText(['วัสดุ', 'สถานะวัสดุ', 'หน่วยนับ', 'การใช้จ่าย']);
    await expect(page.locator('#compatible-stock-material-add-action')).toHaveCount(0);
    await expect(page.locator(`[data-testid="compatible-stock-material-end-${copyPaperId}"]`)).toHaveCount(0);
    // F009-T7: nor "หยุดใช้".
    await expect(page.locator('#requestable-material-status-action')).toHaveCount(0);

    // F009-T3 (#205 start decision 1): the Units form refuses making รีม Inactive on a Stock Material that "กระดาษ A4"
    // is asked for in through it, naming "กระดาษ A4", and keeps the form open (#202 Q15, ADR 0002).
    const leaf = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', 'แผ่นกระดาษ', { retryToken: crypto.randomUUID() });
    const loosePaperId = (
      await stockMaterials.create(
        officerUserId,
        { name: 'กระดาษ A4 แบบแผ่น', base_unit: { unit_id: leaf.id }, alternate_units: [{ unit_id: reamId, conversion_factor: '500' }], explicit_continuation: true },
        { retryToken: crypto.randomUUID() }
      )
    ).stock_material_id;
    const paperRequestableId = pageUrl.split('/').at(-1)!;
    const { version: paperVersion } = (await pool.query('SELECT version FROM requestable_materials WHERE id = $1', [paperRequestableId])).rows[0];
    await new RequestableMaterialService({ db: pool }).addCompatibleStockMaterial(
      officerUserId,
      paperRequestableId,
      { stock_material_id: loosePaperId, expected_version: paperVersion },
      { retryToken: crypto.randomUUID() }
    );
    await switchActor(page, context, officerUserId);
    await page.goto(`${targetBaseUrl}/stock-materials/${loosePaperId}`);
    await page.locator('#stock-material-edit-units').click();
    await expect(page.locator('#stock-material-units-alternate-0-unit')).toHaveText('รีม');
    await page.locator('#stock-material-units-alternate-0-inactive').check();
    await page.locator('#stock-material-units-submit').click();
    await expect(page.locator('[data-testid="stock-material-units-form-error"]')).toContainText('"กระดาษ A4"');
    await expect(page.locator('#stock-material-units-form')).toBeVisible();
  });

  test('Journey F009-T4.1: a Requester opens "ขอเบิกวัสดุ" with no "วัสดุ" menu, finds only offered Requestable Materials, is refused a Requested Quantity that is not whole, naming its Requested Item, saves a Material Request of two Requested Items, sees its Request Number and "รอพิจารณา", and finds it in "คำขอของฉัน"', async ({ page, context }) => {
    // A second offered Requestable Material, counted in fractions; "ปากกาน้ำเงิน" has no Compatible Stock Material and
    // "หมึกพิมพ์เลิกขอ" is Inactive, so neither is offered (#202 Q9).
    const requestables = new RequestableMaterialService({ db: pool });
    const { requestable_material_id: envelopeId } = await requestables.create(
      officerUserId,
      { name: 'ซองจดหมายขอเบิก', request_unit_id: reamId, whole_number_only: false, description: 'ซองสีน้ำตาลขนาด A4' },
      { retryToken: crypto.randomUUID() }
    );
    const { stock_material_id: envelopeStockId } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name: 'ซองจดหมายสีน้ำตาล', base_unit: { unit_id: reamId }, explicit_continuation: true },
      { retryToken: crypto.randomUUID() }
    );
    await requestables.addCompatibleStockMaterial(officerUserId, envelopeId, { stock_material_id: envelopeStockId, expected_version: 1 }, { retryToken: crypto.randomUUID() });
    const requester = await pool.query(`INSERT INTO users (username, password_hash, is_active) VALUES ('requester_request', $1, true) RETURNING id`, [await UserService.hashPassword('Password123!')]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'REQUESTER')`, [requester.rows[0].id]);

    // The Supply Officer holds no material-request:create: once the Dashboard has asked, it shows no "ขอเบิกวัสดุ" (P9).
    await switchActor(page, context, officerUserId);
    const probedOfficer = page.waitForResponse((res: any) => res.url().includes('/my-material-requests?limit=1'));
    await openDashboard(page);
    await probedOfficer;
    await expect(page.locator('#nav-material-section')).toBeVisible();
    await expect(page.locator('#nav-material-request-section')).toHaveCount(0);

    // The Requester's Dashboard shows "ขอเบิกวัสดุ" and, once it has asked, no "วัสดุ" menu, which the Supply Officer
    // sees (#202 Q18, P9).
    await switchActor(page, context, requester.rows[0].id);
    const probedRequests = page.waitForResponse((res: any) => res.url().includes('/my-material-requests?limit=1'));
    await openDashboard(page);
    await probedRequests;
    await expect(page.locator('#nav-material-request-section')).toContainText('ขอเบิกวัสดุ');
    await expect(page.locator('#nav-material-section')).toHaveCount(0);

    await page.locator('#nav-my-material-request-list').click();
    await expect(page).toHaveURL(/\/my-material-requests$/);
    await expect(page.getByRole('heading', { level: 1, name: 'คำขอของฉัน' })).toBeVisible();
    await expect(page.locator('#material-request-list-empty')).toHaveText('ยังไม่มีคำขอเบิก');
    await expect(page.locator('#material-request-list-count')).toHaveCount(0);

    // The form waits for the CSRF token (#135).
    await delaySessionCheck(page);
    await page.locator('#material-request-create-action').click();
    await expect(page).toHaveURL(/\/my-material-requests\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'สร้างคำขอเบิก' })).toBeVisible();
    await expect(page.locator('#material-request-form')).toHaveCount(0);
    await expect(page.locator('#material-request-form')).toBeVisible();

    // Nothing is chosen for the Requester.
    await expect(page.locator('#material-request-rows-empty')).toHaveText('ยังไม่ได้เลือกวัสดุสำหรับขอเบิก');
    await page.locator('#material-request-submit').click();
    await expect(page.locator('[data-testid="material-request-form-error"]')).toContainText('กรุณาเลือกวัสดุสำหรับขอเบิกอย่างน้อย 1 รายการ');

    // Only the offered Requestable Materials are listed, each with its Request Unit and description; a search narrows
    // them.
    const choices = page.locator('#material-request-choices li');
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toContainText('กระดาษ A4 (รีม)');
    await expect(choices.nth(1)).toContainText('ซองจดหมายขอเบิก (รีม)ซองสีน้ำตาลขนาด A4');
    await expect(page.locator('#material-request-choices-empty')).toHaveCount(0);
    await expect(page.locator('#material-request-choices-more')).toHaveCount(0);
    await page.locator('#material-request-search').fill('กระดาษ');
    await page.locator('#material-request-search').press('Enter');
    await expect(choices).toHaveCount(1);
    await page.getByRole('button', { name: 'เลือก กระดาษ A4' }).click();
    await expect(page.getByRole('button', { name: 'เลือก กระดาษ A4' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'เลือก กระดาษ A4' })).toHaveText('เลือกแล้ว');
    await page.locator('#material-request-search').fill('ซอง');
    await page.locator('#material-request-search-submit').click();
    await expect(choices).toHaveCount(1);
    await page.getByRole('button', { name: 'เลือก ซองจดหมายขอเบิก' }).click();

    // Each Requested Quantity is entered in the Request Unit shown beside it (MRQ-28).
    await expect(page.locator('[data-testid="material-request-row-0"]')).toContainText('กระดาษ A4');
    await expect(page.locator('[data-testid="material-request-row-0"]')).toContainText('รีม');
    await page.getByRole('textbox', { name: 'จำนวนที่ขอ กระดาษ A4' }).fill('1.5');
    // Each Requested Item needs its Requested Quantity.
    await page.locator('#material-request-submit').click();
    await expect(page.locator('[data-testid="material-request-form-error"]')).toContainText('รายการที่ขอที่ 2: กรุณากรอกจำนวนที่ขอ');
    await page.getByRole('textbox', { name: 'จำนวนที่ขอ ซองจดหมายขอเบิก' }).fill('0.5');
    await page.getByRole('textbox', { name: 'หมายเหตุ กระดาษ A4' }).fill('สีขาว');
    await page.locator('#material-request-note').fill('ใช้ในงานประชุม');

    // "กระดาษ A4" counts in whole numbers: the save is refused, naming its Requested Item, and keeps the form (Q10).
    await page.locator('#material-request-submit').click();
    await expect(page.locator('[data-testid="material-request-refused-item"]')).toHaveText('รายการที่ขอที่ 1: จำนวนที่ขอต้องเป็นจำนวนเต็ม');
    await expect(page).toHaveURL(/\/my-material-requests\/new$/);

    await page.getByRole('textbox', { name: 'จำนวนที่ขอ กระดาษ A4' }).fill('2');
    await page.locator('#material-request-submit').click();

    // The Material Request's page: its Request Number, note, each Requested Item Pending in its Request Unit, and the
    // history (MRQ-04, Q13, Q14).
    await expect(page).toHaveURL(/\/material-requests\/[0-9a-f-]{36}$/);
    const requestNumber = (await page.locator('#material-request-number').textContent())!.trim();
    expect(requestNumber).toMatch(/^[1-9]\d*$/);
    await expect(page.getByRole('heading', { level: 1, name: `คำขอเบิก เลขที่คำขอ ${requestNumber}`, exact: true })).toBeVisible();
    await expect(page.locator('#material-request-state')).toHaveText('รอพิจารณา');
    await expect(page.locator('#material-request-note')).toHaveText('ใช้ในงานประชุม');
    const first = page.locator('[data-testid="requested-item-0"]');
    await expect(first).toContainText('กระดาษ A4');
    await expect(first).toContainText('2 รีม');
    await expect(first).toContainText('สีขาว');
    await expect(first).toContainText('รอพิจารณา');
    const second = page.locator('[data-testid="requested-item-1"]');
    await expect(second).toContainText('ซองจดหมายขอเบิก');
    await expect(second).toContainText('0.5 รีม');
    await expect(second).toContainText('รอพิจารณา');
    await expect(page.locator('[data-testid="material-request-history-1"]')).toContainText('requester_request');

    // "คำขอของฉัน" lists it with its Request Number, state and Requested Item count; the state filter narrows it.
    await page.locator('#back-material-request-list-link').click();
    await expect(page).toHaveURL(/\/my-material-requests$/);
    const listed = page.locator('#material-request-list-table tbody tr');
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText(requestNumber);
    await expect(listed).toContainText('รอพิจารณา');
    await expect(listed).toContainText('2 รายการ');
    await page.locator('#material-request-state-filter').selectOption('cancelled');
    await expect(page).toHaveURL(/\/my-material-requests\?state=cancelled$/);
    await expect(page.locator('#material-request-list-empty')).toHaveText('ไม่มีคำขอเบิกในสถานะนี้');
    await page.locator('#material-request-state-filter').selectOption('pending');
    await expect(page).toHaveURL(/\/my-material-requests\?state=pending$/);
    await expect(listed).toHaveCount(1);
    await listed.getByRole('link', { name: requestNumber }).click();
    await expect(page).toHaveURL(/\/material-requests\/[0-9a-f-]{36}$/);
    await expect(page.locator('#material-request-number')).toHaveText(requestNumber);
  });

  test('Journey F009-T4.2: the Requester\'s pages say when they are loading, fail closed when a read fails and offer it again, say what is refused, page "คำขอของฉัน", answer another person\'s Material Request as not found, refuse the Supply Officer, and sign out when the session ends', async ({ page, context }) => {
    const requesterId = (await pool.query(`SELECT id FROM users WHERE username = 'requester_request'`)).rows[0].id;
    const paperId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'กระดาษ A4'`)).rows[0].id;
    const envelopeId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'ซองจดหมายขอเบิก'`)).rows[0].id;
    const firstId = (await pool.query('SELECT id FROM material_requests WHERE requested_by = $1', [requesterId])).rows[0].id;
    const firstNumber = (await pool.query('SELECT request_number::text FROM material_requests WHERE id = $1', [firstId])).rows[0].request_number;
    // 25 more, so that "คำขอของฉัน" takes two pages; and another Requester's, which this one cannot read (#202 P5).
    const materialRequests = new MaterialRequestService({ db: pool });
    for (let n = 1; n <= 25; n++) {
      await materialRequests.create(requesterId, { requested_items: [{ requestable_material_id: paperId, requested_quantity: String(n) }] }, { retryToken: crypto.randomUUID() });
    }
    const other = await pool.query(`INSERT INTO users (username, password_hash, is_active) VALUES ('requester_other', $1, true) RETURNING id`, [await UserService.hashPassword('Password123!')]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'REQUESTER')`, [other.rows[0].id]);
    const { material_request_id: otherId } = await materialRequests.create(
      other.rows[0].id,
      { requested_items: [{ requestable_material_id: paperId, requested_quantity: '1' }] },
      { retryToken: crypto.randomUUID() }
    );
    // 11 offered Requestable Materials of one name, more than the picker's 10: the offered search is paged (#206). They
    // sort after ซองจดหมายขอเบิก, so the first page still holds the two this journey chooses.
    const requestables = new RequestableMaterialService({ db: pool });
    const envelopeStockId = (await pool.query('SELECT stock_material_id FROM compatible_stock_materials WHERE requestable_material_id = $1 AND is_current', [envelopeId])).rows[0].stock_material_id;
    for (let n = 1; n <= 11; n++) {
      const { requestable_material_id: id } = await requestables.create(officerUserId, { name: `หมวดขอเบิก ${n}`, request_unit_id: reamId, whole_number_only: true }, { retryToken: crypto.randomUUID() });
      await requestables.addCompatibleStockMaterial(officerUserId, id, { stock_material_id: envelopeStockId, expected_version: 1 }, { retryToken: crypto.randomUUID() });
    }
    // React Query reads again on the window's visibilitychange, which a page coming back to view sends.
    const readAgain = () => page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

    await loginAs(context, requesterId);
    // "คำขอของฉัน" says it is loading, newest first, 25 to a page.
    const listUrl = /\/my-material-requests\?/;
    let releaseList = () => {};
    const listHeld = new Promise<void>((resolve) => (releaseList = resolve));
    await page.route(listUrl, async (route: any) => {
      await listHeld;
      await route.continue();
    });
    await page.goto(`${targetBaseUrl}/my-material-requests`);
    await expect(page.getByText('กำลังโหลดคำขอของฉัน...')).toBeVisible();
    releaseList();
    const listed = page.locator('#material-request-list-table tbody tr');
    await expect(listed).toHaveCount(25);
    await page.unroute(listUrl);
    await expect(page.locator('#material-request-list-count')).toHaveText('รายการที่ 1–25 จาก 26');
    await expect(listed.first()).toContainText(String(Number(firstNumber) + 25));
    await expect(page.locator('#material-request-list-previous')).toBeDisabled();
    await page.locator('#material-request-list-next').click();
    await expect(page).toHaveURL(/\/my-material-requests\?offset=25$/);
    await expect(page.locator('#material-request-list-count')).toHaveText('รายการที่ 26–26 จาก 26');
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText(firstNumber);
    await expect(page.locator('#material-request-list-next')).toBeDisabled();
    await page.locator('#material-request-list-previous').click();
    await expect(page).toHaveURL(/\/my-material-requests$/);
    await expect(listed).toHaveCount(25);
    // A new state starts at the first page.
    await page.locator('#material-request-list-next').click();
    await expect(page).toHaveURL(/\?offset=25$/);
    await page.locator('#material-request-state-filter').selectOption('pending');
    await expect(page).toHaveURL(/\/my-material-requests\?state=pending$/);
    await expect(page.locator('#material-request-list-count')).toHaveText('รายการที่ 1–25 จาก 26');
    // The next page keeps the state.
    await page.locator('#material-request-list-next').click();
    await expect(page).toHaveURL(/\/my-material-requests\?state=pending&offset=25$/);
    // An offset typed into the URL that is no page starts at the first.
    for (const offset of ['abc', '-25']) {
      await page.goto(`${targetBaseUrl}/my-material-requests?offset=${offset}`);
      await expect(page.locator('#material-request-list-count')).toHaveText('รายการที่ 1–25 จาก 26');
    }

    // A read that fails hides what the last one showed and offers it again.
    await page.route(listUrl, (route: any) => route.fulfill({ status: 500, body: '{}' }));
    await readAgain();
    await expect(page.locator('#material-request-list-error')).toContainText('เกิดข้อผิดพลาดในการโหลดคำขอของฉัน');
    await expect(page.locator('#material-request-list-table')).toHaveCount(0);
    await page.unroute(listUrl);
    await page.locator('#material-request-list-retry').click();
    await expect(listed).toHaveCount(25);

    // A Material Request's page says it is loading, fails closed and offers the read again.
    const detailUrl = new RegExp(`/material-requests/${firstId}$`);
    let releaseDetail = () => {};
    const detailHeld = new Promise<void>((resolve) => (releaseDetail = resolve));
    await page.route(detailUrl, async (route: any) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      await detailHeld;
      await route.continue();
    });
    await page.goto(`${targetBaseUrl}/material-requests/${firstId}`);
    await expect(page.getByText('กำลังโหลดข้อมูลคำขอเบิก...')).toBeVisible();
    releaseDetail();
    await expect(page.locator('#material-request-number')).toHaveText(firstNumber);
    await page.unroute(detailUrl);
    await page.route(detailUrl, (route: any) => (route.request().resourceType() === 'fetch' ? route.fulfill({ status: 500, body: '{}' }) : route.continue()));
    await readAgain();
    await expect(page.locator('#material-request-error')).toContainText('เกิดข้อผิดพลาดในการโหลดข้อมูลคำขอเบิก');
    await expect(page.locator('#material-request-number')).toHaveCount(0);
    await page.unroute(detailUrl);
    await page.locator('#material-request-retry').click();
    await expect(page.locator('#material-request-number')).toHaveText(firstNumber);
    // Another person's Material Request is not found, as one that does not exist; neither is offered again (#202 P5).
    await page.goto(`${targetBaseUrl}/material-requests/${otherId}`);
    await expect(page.locator('#material-request-error')).toContainText('ไม่พบคำขอเบิกที่ระบุ (404 Not Found)');
    await expect(page.locator('#material-request-retry')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/material-requests/not-a-material-request`);
    await expect(page.locator('#material-request-error')).toHaveText('ไม่พบคำขอเบิกที่ระบุ');
    await expect(page.locator('#material-request-retry')).toHaveCount(0);

    // "สร้างคำขอเบิก" says it is loading, and a failed read of the offered list says so.
    const grantUrl = /\/offered-requestable-materials\?limit=1$/;
    let releaseGrant = () => {};
    const grantHeld = new Promise<void>((resolve) => (releaseGrant = resolve));
    await page.route(grantUrl, async (route: any) => {
      await grantHeld;
      await route.continue();
    });
    await page.goto(`${targetBaseUrl}/my-material-requests/new`);
    await expect(page.getByText('กำลังโหลด...', { exact: true })).toBeVisible();
    releaseGrant();
    await expect(page.locator('#material-request-form')).toBeVisible();
    await page.unroute(grantUrl);
    await page.route(grantUrl, (route: any) => route.fulfill({ status: 500, body: '{}' }));
    await page.reload();
    await expect(page.locator('#material-request-create-forbidden')).toHaveText('เกิดข้อผิดพลาดในการโหลดรายการวัสดุสำหรับขอเบิก');
    await expect(page.locator('#material-request-form')).toHaveCount(0);
    await page.unroute(grantUrl);
    await page.reload();

    // A search that finds more than a page says how many it found.
    await page.locator('#material-request-search').fill('หมวดขอเบิก');
    await page.locator('#material-request-search-submit').click();
    await expect(page.locator('#material-request-choices-more')).toHaveText('แสดง 10 รายการแรกจาก 11 รายการ ค้นหาให้แคบลงเพื่อดูรายการอื่น');
    await expect(page.locator('#material-request-choices li')).toHaveCount(10);

    // A search that finds nothing, or fails, says so.
    const choicesUrl = /\/offered-requestable-materials\?limit=10/;
    await page.locator('#material-request-search').fill('ไม่มีวัสดุนี้');
    await page.locator('#material-request-search-submit').click();
    await expect(page.locator('#material-request-choices-empty')).toHaveText('ไม่พบวัสดุสำหรับขอเบิกที่เปิดให้ขอเบิก');
    await page.route(choicesUrl, (route: any) => route.fulfill({ status: 500, body: '{}' }));
    await page.locator('#material-request-search').fill('ซอง');
    await page.locator('#material-request-search-submit').click();
    await expect(page.locator('#material-request-choices-error')).toContainText('ค้นหาวัสดุสำหรับขอเบิกไม่สำเร็จ');
    await page.unroute(choicesUrl);
    await page.locator('#material-request-search').fill('');
    await page.locator('#material-request-search-submit').click();
    await page.getByRole('button', { name: 'เลือก กระดาษ A4' }).click();
    await page.getByRole('button', { name: 'เลือก ซองจดหมายขอเบิก' }).click();
    await page.getByRole('textbox', { name: 'จำนวนที่ขอ กระดาษ A4' }).fill('3');
    await page.getByRole('textbox', { name: 'จำนวนที่ขอ ซองจดหมายขอเบิก' }).fill('1');

    // A refusal of a Requested Item's other field names it in the server's words; one that names none says what it is.
    const saveUrl = /\/material-requests$/;
    await page.route(saveUrl, (route: any) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'VALIDATION_FAILED', message: 'requested_items[1].note must not contain control characters' }) })
        : route.continue()
    );
    await page.locator('#material-request-submit').click();
    await expect(page.locator('[data-testid="material-request-refused-item"]')).toHaveText('รายการที่ขอที่ 2: must not contain control characters');
    await page.unroute(saveUrl);
    await page.route(saveUrl, (route: any) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'VALIDATION_FAILED', message: 'note must be at most 2000 characters' }) })
        : route.continue()
    );
    await page.locator('#material-request-submit').click();
    await expect(page.locator('[data-testid="material-request-form-error"]')).toContainText('note must be at most 2000 characters');
    await expect(page.locator('[data-testid="material-request-refused-item"]')).toHaveCount(0);
    await page.unroute(saveUrl);

    // A Requestable Material no longer offered when the Requester saves is refused, naming its Requested Item (#202 Q9).
    const { version: envelopeVersion } = (await pool.query('SELECT version FROM requestable_materials WHERE id = $1', [envelopeId])).rows[0];
    await requestables.endCompatibleStockMaterial(officerUserId, envelopeId, envelopeStockId, { expected_version: envelopeVersion }, { retryToken: crypto.randomUUID() });
    await page.locator('#material-request-submit').click();
    await expect(page.locator('[data-testid="material-request-refused-item"]')).toHaveText('รายการที่ขอที่ 2: วัสดุสำหรับขอเบิกนี้ไม่เปิดให้ขอเบิกแล้ว');

    // A save after the session ended signs the Requester out; so does a search, and opening the form.
    await context.clearCookies();
    await page.locator('#material-request-submit').click();
    await expect(page).toHaveURL(/\/login$/);
    await switchActor(page, context, requesterId);
    await page.goto(`${targetBaseUrl}/my-material-requests/new`);
    await expect(page.locator('#material-request-form')).toBeVisible();
    await context.clearCookies();
    // A new search, so that it is read and not taken from the last.
    await page.locator('#material-request-search').fill('กระดาษ');
    await page.locator('#material-request-search-submit').click();
    await expect(page).toHaveURL(/\/login$/);
    for (const url of ['/my-material-requests/new', '/my-material-requests', `/material-requests/${firstId}`]) {
      await page.goto(`${targetBaseUrl}${url}`);
      await expect(page).toHaveURL(/\/login$/);
    }

    // The Supply Officer holds no material-request:create: the Requester's pages refuse them, offering nothing again
    // (P9). The Material Request page opens to them through material-request:view (Journey F009-T6.1).
    await switchActor(page, context, officerUserId);
    await page.goto(`${targetBaseUrl}/my-material-requests`);
    await expect(page.locator('#material-request-list-error')).toHaveText('คุณไม่มีสิทธิ์เข้าถึงคำขอของฉัน (403 Forbidden) ');
    await expect(page.locator('#material-request-list-retry')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/my-material-requests/new`);
    await expect(page.locator('#material-request-create-forbidden')).toHaveText('คุณไม่มีสิทธิ์สร้างคำขอเบิก');
    await expect(page.locator('#material-request-form')).toHaveCount(0);
  });

  test('Journey F009-T5.1: a Requester Cancels one Requested Item of their Material Request with a note, then the whole Material Request, which shows "ยกเลิกแล้ว" with who Cancelled each and when, on its page, in its history and in "คำขอของฉัน"', async ({ page, context }) => {
    // The Material Request Journey F009-T4.1 saved (J2).
    const requesterId = (await pool.query(`SELECT id FROM users WHERE username = 'requester_request'`)).rows[0].id;
    const saved = (await pool.query(`SELECT id, request_number::text FROM material_requests WHERE note = 'ใช้ในงานประชุม'`)).rows[0];
    await loginAs(context, requesterId);

    // The Cancels wait for the CSRF token (#135).
    await delaySessionCheck(page);
    await page.goto(`${targetBaseUrl}/material-requests/${saved.id}`);
    await expect(page.locator('#material-request-state')).toHaveText('รอพิจารณา');
    await expect(page.locator('[data-testid="requested-item-cancel-0"]')).toHaveCount(0);
    await expect(page.locator('#material-request-cancel-action')).toHaveCount(0);
    await expect(page.locator('[data-testid="requested-item-cancel-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="requested-item-cancel-1"]')).toHaveText('ยกเลิก');
    await expect(page.locator('#material-request-cancel-action')).toHaveText('ยกเลิกคำขอเบิก');
    await expect(page.locator('[data-testid="requested-item-cancelled-0"]')).toHaveCount(0);

    // One Cancel form at a time: opening one hides every other Cancel, and "ปิด" closes it with nothing Cancelled.
    await page.getByRole('button', { name: 'ยกเลิก กระดาษ A4' }).click();
    await expect(page.getByRole('heading', { level: 3, name: 'ยกเลิกรายการที่ขอ กระดาษ A4' })).toBeVisible();
    await expect(page.locator('[data-testid="requested-item-cancel-notice"]')).toHaveText('รายการที่ขอนี้จะยังแสดงพร้อมจำนวนที่ขอ ผู้ยกเลิก และเวลาที่ยกเลิก');
    await expect(page.locator('[data-testid="requested-item-cancel-0"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="requested-item-cancel-1"]')).toHaveCount(0);
    await expect(page.locator('#material-request-cancel-action')).toHaveCount(0);
    await expect(page.locator('#requested-item-cancel-cancel')).toHaveText('ปิด');
    await page.locator('#requested-item-cancel-cancel').click();
    await expect(page.locator('#requested-item-cancel-form')).toHaveCount(0);
    await expect(page.locator('[data-testid="requested-item-0"]')).toContainText('รอพิจารณา');
    await expect(page.locator('#material-request-cancel-action')).toBeVisible();

    // A Requested Item's Cancel with a note: it keeps its Requested Quantity and shows who Cancelled it, when and why;
    // the Material Request stays Pending while another Requested Item is (#202 P4, Q13).
    await page.getByRole('button', { name: 'ยกเลิก กระดาษ A4' }).click();
    await page.getByLabel('หมายเหตุการยกเลิก (ไม่บังคับ)').fill('ใช้ไม่ทันแล้ว');
    await expect(page.locator('#requested-item-cancel-submit')).toHaveText('ยืนยันการยกเลิก');
    await page.locator('#requested-item-cancel-submit').click();
    await expect(page.locator('#requested-item-cancel-form')).toHaveCount(0);
    const first = page.locator('[data-testid="requested-item-0"]');
    await expect(first).toContainText('ยกเลิกแล้ว');
    await expect(first).toContainText('2 รีม');
    await expect(page.locator('[data-testid="requested-item-cancelled-0"]')).toContainText('โดย requester_request เมื่อ');
    await expect(page.locator('[data-testid="requested-item-cancelled-0"]')).toContainText('หมายเหตุ: ใช้ไม่ทันแล้ว');
    await expect(page.locator('[data-testid="requested-item-cancel-0"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="requested-item-1"]')).toContainText('รอพิจารณา');
    await expect(page.locator('[data-testid="requested-item-cancelled-1"]')).toHaveCount(0);
    await expect(page.locator('#material-request-state')).toHaveText('รอพิจารณา');
    const itemEntry = page.locator('[data-testid="material-request-history-2"]');
    await expect(itemEntry).toContainText('ยกเลิกรายการที่ขอ');
    await expect(itemEntry).toContainText('รายการที่ขอ: กระดาษ A4');
    await expect(itemEntry).toContainText('หมายเหตุ: ใช้ไม่ทันแล้ว');
    await expect(itemEntry).toContainText('โดย requester_request');
    await expect(page.locator('[data-testid="material-request-history-1"]')).not.toContainText('รายการที่ขอ');
    await expect(page.locator('[data-testid="material-request-history-1"]')).not.toContainText('หมายเหตุ');

    // The whole Material Request's Cancel takes every Requested Item still Pending, and it is Cancelled (MRQ-19, Q12).
    await page.locator('#material-request-cancel-action').click();
    await expect(page.getByRole('heading', { level: 3, name: `ยกเลิกคำขอเบิก เลขที่คำขอ ${saved.request_number}` })).toBeVisible();
    await expect(page.locator('[data-testid="material-request-cancel-notice"]')).toHaveText('รายการที่ขอที่รอพิจารณาทั้ง 1 รายการจะถูกยกเลิก');
    await expect(page.locator('[data-testid="requested-item-cancel-1"]')).toHaveCount(0);
    await expect(page.locator('#material-request-cancel-action')).toHaveCount(0);
    await page.getByLabel('หมายเหตุการยกเลิก (ไม่บังคับ)').fill('ไม่ต้องใช้แล้ว');
    await page.locator('#material-request-cancel-submit').click();
    await expect(page.locator('#material-request-cancel-form')).toHaveCount(0);
    await expect(page.locator('#material-request-state')).toHaveText('ยกเลิกแล้ว');
    await expect(page.locator('[data-testid="requested-item-1"]')).toContainText('ยกเลิกแล้ว');
    await expect(page.locator('[data-testid="requested-item-1"]')).toContainText('0.5 รีม');
    await expect(page.locator('[data-testid="requested-item-cancelled-1"]')).toContainText('โดย requester_request เมื่อ');
    await expect(page.locator('[data-testid="requested-item-cancelled-1"]')).toContainText('หมายเหตุ: ไม่ต้องใช้แล้ว');
    await expect(page.locator('[data-testid="requested-item-cancelled-0"]')).toContainText('หมายเหตุ: ใช้ไม่ทันแล้ว');
    await expect(page.locator('[data-testid="requested-item-cancel-1"]')).toHaveCount(0);
    await expect(page.locator('#material-request-cancel-action')).toHaveCount(0);
    const requestEntry = page.locator('[data-testid="material-request-history-3"]');
    await expect(requestEntry).toContainText('ยกเลิกคำขอเบิก');
    await expect(requestEntry).toContainText('รายการที่ขอ: ซองจดหมายขอเบิก');
    await expect(requestEntry).toContainText('หมายเหตุ: ไม่ต้องใช้แล้ว');
    await expect(requestEntry).toContainText('โดย requester_request');

    // "คำขอของฉัน" shows it Cancelled, and its state filter finds it there alone.
    await page.locator('#back-material-request-list-link').click();
    await expect(page).toHaveURL(/\/my-material-requests$/);
    await page.locator('#material-request-state-filter').selectOption('cancelled');
    await expect(page).toHaveURL(/\/my-material-requests\?state=cancelled$/);
    const listed = page.locator('#material-request-list-table tbody tr');
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText(saved.request_number);
    await expect(listed).toContainText('ยกเลิกแล้ว');
  });

  test('Journey F009-T5.2: a Cancel sent after the Material Request changed is refused as stale and offers the latest, which closes a form left with nothing to Cancel and offers the other Cancels again, and a Cancel after the grant went fails closed', async ({ page, context }) => {
    const requesterId = (await pool.query(`SELECT id FROM users WHERE username = 'requester_request'`)).rows[0].id;
    const paperId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'กระดาษ A4'`)).rows[0].id;
    const folderId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'หมวดขอเบิก 1'`)).rows[0].id;
    const materialRequests = new MaterialRequestService({ db: pool });
    // A Material Request of two Pending Requested Items, and the ids of its Requested Items.
    const pendingRequest = async () => {
      const { material_request_id: id } = await materialRequests.create(
        requesterId,
        { requested_items: [{ requestable_material_id: paperId, requested_quantity: '1' }, { requestable_material_id: folderId, requested_quantity: '2' }] },
        { retryToken: crypto.randomUUID() }
      );
      const items = (await pool.query('SELECT id FROM requested_items WHERE material_request_id = $1 ORDER BY position', [id])).rows.map(({ id: itemId }: any) => itemId);
      return { id, items };
    };
    await loginAs(context, requesterId);

    // The whole Material Request is Cancelled in another tab while its form is open: the save is refused as stale, and
    // the latest read closes the form, as nothing is left to Cancel.
    const whole = await pendingRequest();
    await page.goto(`${targetBaseUrl}/material-requests/${whole.id}`);
    await page.locator('#material-request-cancel-action').click();
    await expect(page.locator('#material-request-cancel-form')).toBeVisible();
    await materialRequests.cancelMaterialRequest(requesterId, whole.id, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    await page.locator('#material-request-cancel-submit').click();
    await expect(page.locator('[data-testid="material-request-cancel-form-error"]')).toContainText('คำขอเบิกนี้เปลี่ยนไปหลังจากเปิดฟอร์ม กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง');
    await page.locator('#material-request-cancel-reload').click();
    await expect(page.locator('#material-request-cancel-form')).toHaveCount(0);
    await expect(page.locator('#material-request-state')).toHaveText('ยกเลิกแล้ว');
    await expect(page.locator('#material-request-cancel-action')).toHaveCount(0);
    // Cancelled with no note: who and when, and no note.
    await expect(page.locator('[data-testid="requested-item-cancelled-0"]')).toContainText('โดย requester_request เมื่อ');
    await expect(page.locator('[data-testid="requested-item-cancelled-0"]')).not.toContainText('หมายเหตุ');
    await expect(page.locator('[data-testid="material-request-history-2"]')).toContainText('รายการที่ขอ: กระดาษ A4, หมวดขอเบิก 1');
    await expect(page.locator('[data-testid="material-request-history-2"]')).not.toContainText('หมายเหตุ');

    // A Requested Item is Cancelled in another tab while its form is open: the latest read closes the form and offers
    // the Cancels still open.
    const one = await pendingRequest();
    await page.goto(`${targetBaseUrl}/material-requests/${one.id}`);
    await page.getByRole('button', { name: 'ยกเลิก กระดาษ A4' }).click();
    await expect(page.locator('#requested-item-cancel-form')).toBeVisible();
    await materialRequests.cancelRequestedItem(requesterId, one.id, one.items[0], { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    await page.locator('#requested-item-cancel-submit').click();
    await expect(page.locator('[data-testid="requested-item-cancel-form-error"]')).toContainText('คำขอเบิกนี้เปลี่ยนไปหลังจากเปิดฟอร์ม');
    await page.locator('#requested-item-cancel-reload').click();
    await expect(page.locator('#requested-item-cancel-form')).toHaveCount(0);
    await expect(page.locator('[data-testid="requested-item-0"]')).toContainText('ยกเลิกแล้ว');
    await expect(page.locator('[data-testid="requested-item-cancel-0"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="requested-item-cancel-1"]')).toBeVisible();
    await expect(page.locator('#material-request-cancel-action')).toBeVisible();

    // The grant goes while a form is open: the Cancel is refused, and the page, read again, fails closed (P9).
    await page.getByRole('button', { name: 'ยกเลิก หมวดขอเบิก 1' }).click();
    await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'REQUESTER'`, [requesterId]);
    try {
      await page.locator('#requested-item-cancel-submit').click();
      await expect(page.locator('#material-request-error')).toContainText('คุณไม่มีสิทธิ์เข้าถึงข้อมูลคำขอเบิก (403 Forbidden)');
      await expect(page.locator('#requested-item-cancel-form')).toHaveCount(0);
    } finally {
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'REQUESTER')`, [requesterId]);
    }
    expect((await pool.query('SELECT cancelled_at FROM requested_items WHERE id = $1', [one.items[1]])).rows[0].cancelled_at).toBeNull();
  });

  test('Journey F009-T6.1: a Supply Officer opens "คำขอเบิก" from its menu, finds every Material Request with its Requester and state, filters it by state, and opens a Pending one read-only, with no Cancel and the way back to "คำขอเบิก"; the Requester sees neither "คำขอเบิก" nor "วัสดุ" and is refused "คำขอเบิก"', async ({ page, context }) => {
    // J3: the Material Request Journey F009-T4.1 saved and F009-T5.1 Cancelled, and a Pending one of the same Requester.
    const requesterId = (await pool.query(`SELECT id FROM users WHERE username = 'requester_request'`)).rows[0].id;
    const saved = (await pool.query(`SELECT id, request_number::text FROM material_requests WHERE note = 'ใช้ในงานประชุม'`)).rows[0];
    const paperId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'กระดาษ A4'`)).rows[0].id;
    const folderId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'หมวดขอเบิก 1'`)).rows[0].id;
    const { material_request_id: pendingId, request_number: pendingNumber } = await new MaterialRequestService({ db: pool }).create(
      requesterId,
      { note: 'ขอใช้ในการอบรม', requested_items: [{ requestable_material_id: paperId, requested_quantity: '3' }, { requestable_material_id: folderId, requested_quantity: '1' }] },
      { retryToken: crypto.randomUUID() }
    );
    // "คำขอเบิก" is read at /material-requests; "คำขอของฉัน" at /my-material-requests holds that text too.
    const isAllMaterialRequests = (res: any) => new URL(res.url()).pathname === '/material-requests';

    // The Supply Officer's Dashboard shows "คำขอเบิก" once it has asked, and still no "ขอเบิกวัสดุ" (P9).
    await loginAs(context, officerUserId);
    const probedOfficer = page.waitForResponse(isAllMaterialRequests);
    await openDashboard(page);
    await probedOfficer;
    await expect(page.locator('#nav-all-material-request-section')).toContainText('คำขอเบิก');
    await expect(page.locator('#nav-material-request-section')).toHaveCount(0);

    await page.locator('#nav-all-material-request-list').click();
    await expect(page).toHaveURL(/\/material-requests$/);
    await expect(page.getByRole('heading', { level: 1, name: 'คำขอเบิก' })).toBeVisible();
    const pendingRow = page.locator(`[data-testid="material-request-row-${pendingId}"]`);
    const savedRow = page.locator(`[data-testid="material-request-row-${saved.id}"]`);
    await expect(pendingRow.locator('td')).toHaveText([pendingNumber, 'requester_request', /\S/, 'รอพิจารณา', '2 รายการ']);
    await expect(page.locator('#material-request-list-table tbody tr').first()).toHaveAttribute('data-testid', `material-request-row-${pendingId}`);
    // Read-only: with its rows shown, the list offers no "สร้างคำขอเบิก".
    await expect(page.locator('#material-request-create-action')).toHaveCount(0);

    // The state filter keeps its choice in the URL (Q19).
    const stateCells = page.locator('#material-request-list-table tbody td:nth-child(4)');
    await page.locator('#material-request-state-filter').selectOption('cancelled');
    await expect(page).toHaveURL(/\/material-requests\?state=cancelled$/);
    await expect(pendingRow).toHaveCount(0);
    await expect(stateCells.first()).toHaveText('ยกเลิกแล้ว');
    await expect(stateCells.filter({ hasNotText: 'ยกเลิกแล้ว' })).toHaveCount(0);
    // The journeys before saved more than a page: J2's Material Request, the oldest, is the last Cancelled one.
    const cancelledCount: number = (await (await page.request.get(`${targetBaseUrl}/material-requests?state=cancelled&limit=1`)).json()).total_count;
    await page.goto(`${targetBaseUrl}/material-requests?state=cancelled&offset=${cancelledCount - 1}`);
    await expect(savedRow.locator('td')).toHaveText([saved.request_number, 'requester_request', /\S/, 'ยกเลิกแล้ว', '2 รายการ']);
    await page.locator('#material-request-state-filter').selectOption('pending');
    await expect(pendingRow).toBeVisible();
    await expect(savedRow).toHaveCount(0);
    await page.locator('#material-request-state-filter').selectOption('all');
    await expect(page).toHaveURL(/\/material-requests$/);

    // The Pending Material Request's page shows every field, Requested Item and its history, and no Cancel once the
    // session, and with it the CSRF token, has arrived (Q12, P9).
    const sessionChecked = page.waitForResponse((res: any) => res.url().includes('/auth/session-check'));
    await pendingRow.getByRole('link', { name: pendingNumber }).click();
    await expect(page).toHaveURL(new RegExp(`/material-requests/${pendingId}\\?from=all$`));
    await expect(page.getByRole('heading', { level: 1, name: `คำขอเบิก เลขที่คำขอ ${pendingNumber}` })).toBeVisible();
    await sessionChecked;
    await expect(page.locator('#material-request-state')).toHaveText('รอพิจารณา');
    await expect(page.locator('dl')).toContainText('requester_request');
    await expect(page.locator('#material-request-note')).toHaveText('ขอใช้ในการอบรม');
    await expect(page.locator('[data-testid="requested-item-0"]')).toContainText('กระดาษ A4');
    await expect(page.locator('[data-testid="requested-item-0"]')).toContainText('รอพิจารณา');
    await expect(page.locator('[data-testid="requested-item-1"]')).toContainText('หมวดขอเบิก 1');
    await expect(page.locator('[data-testid="material-request-history-1"]')).toContainText('requester_request');
    await expect(page.locator('[data-testid^="requested-item-cancel-"]')).toHaveCount(0);
    await expect(page.locator('#material-request-cancel-action')).toHaveCount(0);

    // The way back leads to "คำขอเบิก", after a reload too (#208 start decision 2).
    await page.reload();
    await expect(page.locator('#back-material-request-list-link')).toHaveText('← กลับสู่คำขอเบิก');
    await page.locator('#back-material-request-list-link').click();
    await expect(page).toHaveURL(/\/material-requests$/);
    await expect(page.getByRole('heading', { level: 1, name: 'คำขอเบิก' })).toBeVisible();
    await expect(pendingRow).toBeVisible();

    // The Requester's Dashboard shows "ขอเบิกวัสดุ" and, once it has asked, neither "คำขอเบิก" nor "วัสดุ" (Q4, Q18, P9).
    await switchActor(page, context, requesterId);
    const probedRequester = Promise.all([page.waitForResponse(isAllMaterialRequests), page.waitForResponse((res: any) => res.url().includes('/my-material-requests?limit=1'))]);
    await openDashboard(page);
    await probedRequester;
    await expect(page.locator('#nav-material-request-section')).toContainText('ขอเบิกวัสดุ');
    await expect(page.locator('#nav-all-material-request-section')).toHaveCount(0);
    await expect(page.locator('#nav-material-section')).toHaveCount(0);

    // "คำขอเบิก" refuses the Requester, offering nothing again; their own Material Request's page, opened from
    // "คำขอของฉัน", still offers its Cancels and leads back there.
    await page.goto(`${targetBaseUrl}/material-requests`);
    await expect(page.locator('#material-request-list-error')).toHaveText('คุณไม่มีสิทธิ์เข้าถึงคำขอเบิก (403 Forbidden) ');
    await expect(page.locator('#material-request-list-retry')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/my-material-requests`);
    await page.locator(`[data-testid="material-request-row-${pendingId}"]`).getByRole('link', { name: pendingNumber }).click();
    await expect(page).toHaveURL(new RegExp(`/material-requests/${pendingId}$`));
    await expect(page.locator('#material-request-cancel-action')).toBeVisible();
    await expect(page.locator('#back-material-request-list-link')).toHaveText('← กลับสู่คำขอของฉัน');
  });

  test('Journey F009-T7.1: a Supply Officer sees how many Pending Requested Items ask for "กระดาษ A4" before ending its last Compatible Stock Material and before "หยุดใช้", makes it Inactive, finds it with its "หยุดใช้" badge only under the Inactive filter, is offered "เปิดใช้อีกครั้ง" by a create of its name, and reactivates it', async ({ page, context }) => {
    const paperId = (await pool.query(`SELECT id FROM requestable_materials WHERE name = 'กระดาษ A4'`)).rows[0].id;
    // The Pending Requested Items J2 and J3 left on it (#202 Q16, P6).
    const pending: number = (await pool.query('SELECT count(*)::int AS n FROM requested_items WHERE requestable_material_id = $1 AND cancelled_at IS NULL', [paperId])).rows[0].n;
    expect(pending).toBeGreaterThan(1);
    const pendingLine = `มีรายการที่ขอ ${pending} รายการที่ยังรอพิจารณา ซึ่งจะยังรอพิจารณาต่อไป`;
    // The two current Compatible Stock Materials J1 left on it: ending the first is not ending the last.
    const current = await pool.query('SELECT stock_material_id FROM compatible_stock_materials WHERE requestable_material_id = $1 AND is_current ORDER BY stock_material_id', [paperId]);
    expect(current.rows).toHaveLength(2);
    const [endedId, lastId] = current.rows.map(({ stock_material_id }: { stock_material_id: string }) => stock_material_id);

    await loginAs(context, officerUserId);
    await delaySessionCheck(page);
    await page.goto(`${targetBaseUrl}/requestable-materials/${paperId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'กระดาษ A4' })).toBeVisible();

    // Ending one of two current ones shows no count; ending the last one does (#209 start decision 3).
    await page.locator(`[data-testid="compatible-stock-material-end-${endedId}"]`).click();
    await expect(page.locator('[data-testid="compatible-stock-material-end-notice"]')).toBeVisible();
    await expect(page.locator('[data-testid="compatible-stock-material-end-pending-count"]')).toHaveCount(0);
    await page.locator('#compatible-stock-material-end-submit').click();
    await expect(page.locator(`[data-testid="compatible-stock-material-row-${endedId}"]`)).toContainText('เลิกแล้ว');
    await page.locator(`[data-testid="compatible-stock-material-end-${lastId}"]`).click();
    await expect(page.locator('[data-testid="compatible-stock-material-end-pending-count"]')).toHaveText(pendingLine);
    await page.locator('#compatible-stock-material-end-cancel').click();
    await expect(page.locator(`[data-testid="compatible-stock-material-row-${lastId}"]`)).toContainText('ใช้อยู่');

    // "หยุดใช้" shows the same count first; its Pending Requested Items stay Pending (Q16).
    await page.locator('#requestable-material-status-action').click();
    await expect(page.locator('#requestable-material-status-form')).toContainText('หยุดใช้');
    await expect(page.locator('[data-testid="requestable-material-status-pending-count"]')).toHaveText(pendingLine);
    await expect(page.locator('[data-testid="requestable-material-status-notice"]')).toContainText('ผู้ขอเบิกจะไม่เห็นวัสดุนี้อีก');
    await expect(page.locator('#requestable-material-status-action')).toHaveCount(0);
    await page.locator('#requestable-material-status-submit').click();
    await expect(page.locator('[data-testid="requestable-material-status"]')).toHaveText('หยุดใช้');
    await expect(page.locator('#requestable-material-status-action')).toHaveText('เปิดใช้อีกครั้ง');
    // An Inactive one shows no "ยังไม่มีวัสดุที่ใช้จ่าย" badge (Q9).
    await expect(page.locator('[data-testid="requestable-material-no-compatible-badge"]')).toHaveCount(0);
    const historyEntries = page.locator('#requestable-material-history > li');
    await expect(historyEntries.last()).toContainText('หยุดใช้');
    await expect(historyEntries.last()).toContainText('สถานะหยุดใช้');
    await expect(historyEntries.last()).toContainText('officer_request');

    // The list hides it by default and shows it with its "หยุดใช้" badge under the Inactive filter, and under all.
    await page.locator('#back-requestable-material-list-link').click();
    await page.locator('#requestable-material-search').fill('กระดาษ A4');
    await page.locator('#requestable-material-search-submit').click();
    await expect(page.locator('#requestable-material-list-empty')).toHaveText('ไม่พบวัสดุสำหรับขอเบิกที่ค้นหา');
    await page.locator('#requestable-material-status-filter').selectOption('inactive');
    await expect(page).toHaveURL(/status=inactive/);
    const paperRow = page.locator(`[data-testid="requestable-material-row-${paperId}"]`);
    await expect(page.locator(`[data-testid="requestable-material-inactive-badge-${paperId}"]`)).toHaveText('หยุดใช้');
    await expect(paperRow).not.toContainText('ยังไม่มีวัสดุที่ใช้จ่าย');
    await page.locator('#requestable-material-status-filter').selectOption('all');
    await expect(page.locator(`[data-testid="requestable-material-inactive-badge-${paperId}"]`)).toBeVisible();
    await page.locator('#requestable-material-status-filter').selectOption('');
    await expect(page.locator('#requestable-material-list-empty')).toBeVisible();

    // A create of its name, in another case, is refused naming it and offers "เปิดใช้อีกครั้ง", which opens its page
    // with the confirmation open (Q6, #209 start decision 2).
    await page.goto(`${targetBaseUrl}/requestable-materials/new`);
    await page.locator('#requestable-material-name').fill('กระดาษ a4');
    await page.locator('#requestable-material-request-unit').selectOption({ label: 'รีม' });
    await page.locator('#requestable-material-submit').click();
    await expect(page.locator('[data-testid="requestable-material-name-taken"]')).toContainText('มีวัสดุสำหรับขอเบิกชื่อนี้อยู่แล้ว: กระดาษ A4 ซึ่งถูกหยุดใช้อยู่');
    await page.locator('#requestable-material-offer-reactivate').click();
    await expect(page).toHaveURL(new RegExp(`/requestable-materials/${paperId}$`));
    await expect(page.locator('#requestable-material-status-form')).toContainText('เปิดใช้อีกครั้ง');
    await expect(page.locator('[data-testid="requestable-material-status-pending-count"]')).toHaveCount(0);
    await page.locator('#requestable-material-status-submit').click();

    // Reactivated as the same record, offered again with its Compatible Stock Material.
    await expect(page.locator('[data-testid="requestable-material-status"]')).toHaveText('ใช้งานอยู่');
    await expect(page.locator('#requestable-material-status-action')).toHaveText('หยุดใช้');
    await expect(historyEntries.last()).toContainText('เปิดใช้อีกครั้ง');
    await expect(historyEntries.last()).toContainText('สถานะใช้งานอยู่');
    await expect(page.locator('[data-testid="requestable-material-no-compatible-badge"]')).toHaveCount(0);
  });
});
