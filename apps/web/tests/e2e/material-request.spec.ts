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
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// Feature 009 (#202, Seam B). F009-T1 (#203): Journey J1 starts: a Supply Officer creates the Requestable Material
// "กระดาษ A4" with Request Unit รีม and finds it in the list and on its page; T2 goes on with its Compatible Stock
// Materials.
test.describe.serial('Material Request journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;

  let officerUserId: string;

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
    await units.add(officerUserId, 'unit', 'รีม', { retryToken: crypto.randomUUID() });
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

    // The list finds it by its name, ignoring case and repeated spaces, with its Request Unit and status.
    await page.locator('#back-requestable-material-list-link').click();
    await expect(page).toHaveURL(/\/requestable-materials$/);
    await page.locator('#requestable-material-search').fill('กระดาษ   a4');
    await page.locator('#requestable-material-search-submit').click();
    await expect(page).toHaveURL(/\/requestable-materials\?search=/);
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
});
