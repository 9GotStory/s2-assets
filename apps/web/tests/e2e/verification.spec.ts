import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, pg, type FastifyInstance, type StartedPostgreSqlContainer } from '../../../api/tests/journey-deps.ts';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { buildApp } from '../../../api/src/app.ts';
import { UserService } from '../../../api/src/services/user.service.ts';
import { SessionService } from '../../../api/src/services/session.service.ts';
import { AssetService } from '../../../api/src/services/asset.service.ts';
import { ReferenceService } from '../../../api/src/services/reference.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F006-T1 (#126): an Asset Custodian opens a Verification Round and sees its Scope Snapshot; a Read-only User
// sees the Round with no action.
test.describe.serial('Verification journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let assetService: AssetService;
  let referenceService: ReferenceService;

  let adminUserId: string;
  let custodianUserId: string;
  let readonlyUserId: string;

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
    assetService = new AssetService({ db: pool });
    referenceService = new ReferenceService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-verification-e2e',
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
    adminUserId = await createUser('admin_verification', 'ADMINISTRATOR');
    custodianUserId = await createUser('custodian_verification', 'ASSET_CUSTODIAN');
    readonlyUserId = await createUser('readonly_verification', 'READ_ONLY');

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

  test('Journey F006-T1.1: a Custodian opens a Round with a Location filter and sees its Assets as "ยังไม่ได้ตรวจ"; a Read-only User then sees the Round with no action', async ({ page, context }) => {
    const meetingRoom = await referenceService.create('locations', adminUserId, 'ห้องประชุม E2E ตรวจ');
    const store = await referenceService.create('locations', adminUserId, 'ห้องเก็บของ E2E ตรวจ');
    const { asset: projector } = await assetService.registerAsset(custodianUserId, {
      name: 'โปรเจกเตอร์ E2E ตรวจ',
      asset_number: 'E2E-VR-001',
      serial_number: 'SN-PJ-01',
      location_id: meetingRoom.id,
      effective_date: '2026-01-05',
    } as any);
    const { asset: table } = await assetService.registerAsset(custodianUserId, { name: 'โต๊ะประชุม E2E ตรวจ', location_id: meetingRoom.id, effective_date: '2026-01-05' } as any);
    const { asset: shelf } = await assetService.registerAsset(custodianUserId, { name: 'ชั้นวาง E2E ตรวจ', location_id: store.id, effective_date: '2026-01-05' } as any);

    // The Dashboard links to the Round list, which has no Round yet.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-verification-round-list').click();
    await expect(page).toHaveURL(/\/verification-rounds$/);
    await expect(page.getByRole('heading', { name: 'รอบตรวจ', level: 1 })).toBeVisible();
    await expect(page.locator('#verification-round-list-empty')).toBeVisible();

    // The form says what it needs before asking the server.
    await page.locator('#verification-open-action').click();
    await page.locator('#verification-open-submit').click();
    await expect(page.locator('[data-testid="verification-open-form-error"]')).toContainText('ชื่อรอบตรวจ');

    await page.locator('#verification-open-name').fill('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await page.locator('#verification-open-fiscal_year').fill('2569');
    await page.locator('#verification-open-notes').fill('คณะกรรมการ:\nนาย ก');
    await page.locator(`#verification-open-location-${meetingRoom.id}`).check();
    await page.locator('#verification-open-submit').click();

    // The new Round is listed, open, covering the two Assets in the meeting room.
    const row = page.locator('[data-testid^="verification-round-row-"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await expect(row).toContainText('เปิดอยู่');
    await expect(page.locator('#verification-open-action')).toBeVisible();

    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/verification-rounds\/[0-9a-f-]{36}$/);
    const roundUrl = page.url();
    await expect(page.locator('#verification-round-name')).toHaveText('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await expect(page.locator('#verification-round-fiscal-year')).toHaveText('2569');
    await expect(page.locator('#verification-round-state')).toHaveText('เปิดอยู่');
    await expect(page.locator('#verification-round-scope')).toHaveText('สถานที่: ห้องประชุม E2E ตรวจ');
    await expect(page.locator('#verification-round-notes')).toHaveText('คณะกรรมการ:\nนาย ก');
    await expect(page.locator('#verification-round-opened-by')).toHaveText('custodian_verification');
    await expect(page.locator('[data-testid="verification-round-count-in-scope"]')).toContainText('2');
    await expect(page.locator('[data-testid="verification-round-count-not-yet-verified"]')).toContainText('2');
    await expect(page.locator('[data-testid="verification-round-history"] li')).toHaveCount(1);
    await expect(page.locator('[data-testid="verification-round-history"] li')).toContainText('เปิดรอบ โดย custodian_verification');

    // Each Asset of the snapshot is Not Yet Verified, with what the register showed, and links to its page.
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveText(['ยังไม่ได้ตรวจ', 'ยังไม่ได้ตรวจ']);
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toContainText('E2E-VR-001');
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toContainText('SN-PJ-01');
    await expect(page.locator(`[data-testid="scope-entry-assignment-${table.id}"]`)).toContainText('ห้องประชุม E2E ตรวจ');
    await expect(page.locator(`[data-testid="scope-entry-${shelf.id}"]`)).toHaveCount(0);

    // A search over the snapshot finds an Asset by its Serial Number.
    await page.locator('#scope-entry-search').fill('sn-pj');
    await page.locator('#scope-entry-search-submit').click();
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="scope-entry-${table.id}"]`)).toHaveCount(0);
    await page.locator(`[data-testid="scope-entry-${projector.id}"]`).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/assets/${projector.id}$`));

    // A second Round is refused while this one is open, naming it. The session answers late: the action waits for
    // its CSRF token, or a quick submit would be refused as if the grant were gone.
    await page.route('**/auth/session-check', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto(`${targetBaseUrl}/verification-rounds`);
    await page.locator('#verification-open-action').click();
    await page.locator('#verification-open-name').fill('รอบที่สอง');
    await page.locator('#verification-open-fiscal_year').fill('2569');
    await page.locator('#verification-open-submit').click();
    await expect(page.locator('[data-testid="verification-open-refused"]')).toContainText('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await page.unroute('**/auth/session-check');
    await page.locator('#verification-open-cancel').click();

    // A Read-only User sees the list and the Round, with no action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds`);
    await expect(page.locator('[data-testid^="verification-round-row-"]')).toHaveCount(1);
    await expect(page.locator('#verification-open-action')).toHaveCount(0);
    await page.goto(roundUrl);
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveText(['ยังไม่ได้ตรวจ', 'ยังไม่ได้ตรวจ']);
    await expect(page.locator('main button:not(#scope-entry-search-submit)')).toHaveCount(0);
  });
});
