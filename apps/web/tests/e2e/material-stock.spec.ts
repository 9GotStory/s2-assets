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
import { StockMaterialService } from '../../../api/src/services/stock-material.service.ts';
import { CatalogListService } from '../../../api/src/services/catalog-list.service.ts';
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
test.describe.serial('Material Stock journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;

  let officerUserId: string;
  // Journey F010-T2.1's Stock Material and Draft, which Journey F010-T2.2 goes on with.
  let j1: { name: string; ream: string; materialId: string; draftUrl: string };

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

  // The session answers late, so that a page shows its facts before the CSRF token arrives: a write action waits for the
  // token, or a quick save would be refused as if the grant were gone (#135).
  const delaySessionCheck = (page: any) =>
    page.route('**/auth/session-check', async (route: any) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

  const { loginAs } = actorSwitch(() => sessionService, () => targetBaseUrl);

  test('Journey F010-T2.1: a Supply Officer sets a Minimum Stock, saves an Opening Balance Draft without ที่มาของยอด, and is refused its confirm with the rule named', async ({ page, context }) => {
    // The fact the journey needs, made here: a Stock Material counted in a whole-number Base Unit "รีม", with a
    // "กล่อง" of 5 รีม, no Minimum Stock and no Stock Movement.
    const tag = crypto.randomUUID().slice(0, 6);
    const name = `กระดาษถ่ายเอกสาร J1 ${tag}`;
    const ream = `รีม ${tag}`;
    const catalog = new CatalogListService({ db: pool });
    const reamUnit = await catalog.add(officerUserId, 'unit', ream, { retryToken: crypto.randomUUID() });
    const boxUnit = await catalog.add(officerUserId, 'unit', `กล่อง ${tag}`, { retryToken: crypto.randomUUID() });
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
    await page.unroute('**/auth/session-check');

    // "ยอดตั้งต้น" from the Dashboard's "วัสดุ" menu, then "เพิ่มยอดตั้งต้น".
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-opening-balance-list').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น', exact: true })).toBeVisible();
    await page.locator('#opening-balance-add-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'เพิ่มยอดตั้งต้น' })).toBeVisible();

    // A Draft saves without ที่มาของยอด: 1 กล่อง and 3 รีม would be 8 รีม, so the line counts 1 กล่อง.
    await page.locator('#opening-balance-as-of-date').fill('2026-09-30');
    await page.locator('#opening-balance-stock-material-search').fill(name);
    await page.locator('#opening-balance-stock-material-search-submit').click();
    await page.locator(`[data-testid="opening-balance-choose-${materialId}"]`).click();
    await expect(page.locator('[data-testid="opening-balance-line-0"]')).toContainText(name);
    await page.locator('#opening-balance-line-0-unit').selectOption({ label: `กล่อง ${tag}` });
    await page.locator('#opening-balance-line-0-quantity').fill('1');
    await page.locator('#opening-balance-draft-submit').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();
    await expect(page.locator('[data-testid="opening-balance-source"]')).toHaveText('-');

    // The confirm is refused with the rule it fails named, and nothing is recorded (Q25).
    await page.locator('#opening-balance-confirm-action').click();
    await page.locator('#opening-balance-confirm-submit').click();
    await expect(page.locator('[data-testid="opening-balance-confirm-problems"]')).toContainText('source is required');
    await page.locator('#opening-balance-confirm-cancel').click();
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();
    j1 = { name, ream, materialId, draftUrl: page.url() };
  });

  test('Journey F010-T2.2: the Supply Officer completes the Draft, confirms it below the Minimum Stock, and sees คงเหลือ and ต่ำกว่าขั้นต่ำ on the list, the Low Stock filter and the page', async ({ page, context }) => {
    const { name, ream, materialId, draftUrl } = j1;
    await loginAs(context, officerUserId);
    await page.goto(draftUrl);
    await expect(page.getByRole('heading', { level: 1, name: 'ยอดตั้งต้น ร่าง' })).toBeVisible();

    // "แก้ไขร่าง": ที่มาของยอด added, and the line moves to รีม: 7 รีม, below the Minimum Stock of 10.
    await page.locator('#opening-balance-edit-action').click();
    await expect(page.getByRole('heading', { level: 1, name: 'แก้ไขร่าง' })).toBeVisible();
    await expect(page.locator('#opening-balance-line-0-quantity')).toHaveValue('1');
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
    await expect(page.locator('[data-testid="opening-balance-line-0"]')).toContainText(`+7 ${ream}`);
    await expect(page.locator('#opening-balance-confirm-action')).toHaveCount(0);
    await expect(page.locator('#opening-balance-edit-action')).toHaveCount(0);

    // The Stock Material list shows คงเหลือ 7 รีม with ต่ำกว่าขั้นต่ำ, and the Low Stock filter finds it (MC-20, Q14).
    await page.goto(`${targetBaseUrl}/stock-materials?search=${encodeURIComponent(name)}`);
    await expect(page.locator('#stock-material-list-table tbody tr')).toHaveCount(1);
    await expect(page.locator(`[data-testid="stock-material-current-stock-${materialId}"]`)).toContainText(`7 ${ream}`);
    await expect(page.locator(`[data-testid="stock-material-low-stock-badge-${materialId}"]`)).toHaveText('ต่ำกว่าขั้นต่ำ');
    // The filters re-render with the list they read, so the click is checked against the list it brings.
    await page.locator('#stock-material-low-stock-filter').click();
    await expect(page).toHaveURL(/low_stock=true/);
    await expect(page.locator('#stock-material-low-stock-filter')).toBeChecked();
    await expect(page.locator(`[data-testid="stock-material-row-${materialId}"]`)).toBeVisible();

    // And so does its page.
    await page.goto(`${targetBaseUrl}/stock-materials/${materialId}`);
    await expect(page.locator('[data-testid="stock-material-current-stock"]')).toContainText(`7 ${ream}`);
    await expect(page.locator('[data-testid="stock-material-low-stock-badge"]')).toHaveText('ต่ำกว่าขั้นต่ำ');
  });
});
