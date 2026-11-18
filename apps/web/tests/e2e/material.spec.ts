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
import { UnitService } from '../../../api/src/services/unit.service.ts';
import { StockMaterialService } from '../../../api/src/services/stock-material.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F008-T1 (#176): Journey J1 starts (a Supply Officer creates a Stock Material with a new Unit and finds it), and
// Journey J3 (a Read-only User reads the catalog with no action; an Asset Custodian has no "วัสดุ" menu).
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

  test('Journey F008-T1.2: a Read-only User reads the list and a Stock Material page with no action, and an Asset Custodian has no "วัสดุ" menu', async ({ page, context }) => {
    const unit = await new UnitService({ db: pool }).add(officerUserId, 'ขวด', { retryToken: crypto.randomUUID() });
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
    await expect(row).toContainText('ขวด');
    // The Supply Officer was offered "เพิ่มวัสดุ" on this list (Journey F008-T1.1).
    await expect(page.locator('#stock-material-add-action')).toHaveCount(0);

    await row.getByRole('link', { name: 'น้ำยาเช็ดกระจก' }).click();
    await expect(page).toHaveURL(new RegExp(`/stock-materials/${id}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'น้ำยาเช็ดกระจก' })).toBeVisible();
    await expect(page.locator(`[data-testid="stock-material-unit-${unit.id}"]`)).toContainText('ไม่ใช่ (มีเศษได้)');
    await expect(page.locator('[data-testid="stock-material-history-1"]')).toContainText('หน่วยนับหลัก ขวด');
    await expect(page.locator('main button')).toHaveCount(0);

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
