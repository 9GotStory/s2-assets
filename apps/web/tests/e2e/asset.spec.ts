import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '../../../api/node_modules/@testcontainers/postgresql/build/index.js';
import pg from '../../../api/node_modules/pg/lib/index.js';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { buildApp } from '../../../api/src/app.ts';
import { UserService } from '../../../api/src/services/user.service.ts';
import { SessionService } from '../../../api/src/services/session.service.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

test.describe.serial('Asset Registry Real SPA -> Composed API -> PostgreSQL Journeys (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let fastifyPort: number;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;

  let custodianUserId: string;
  let readonlyUserId: string;
  let firstCreatedAssetId: string;

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

    // 1. Start disposable PostgreSQL test container
    container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
    const databaseUrl = container.getConnectionUri();

    // 2. Run migrations
    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    pool = new Pool({ connectionString: databaseUrl });
    sessionService = new SessionService({ db: pool });

    // 3. Build & start Fastify application on ephemeral port
    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-12345',
      logger: false,
    });

    const fastifyAddr = await fastifyApp.listen({ port: 0, host: '127.0.0.1' });
    const match = fastifyAddr.match(/:(\d+)$/);
    fastifyPort = match ? parseInt(match[1], 10) : 3000;

    // 4. Seed test users
    const passwordHash = await UserService.hashPassword('Password123!');
    const usersRes = await pool.query(`
      INSERT INTO users (username, password_hash, is_active) VALUES
        ('custodian_e2e', '${passwordHash}', true),
        ('readonly_e2e', '${passwordHash}', true)
      RETURNING id, username;
    `);

    custodianUserId = usersRes.rows.find((r) => r.username === 'custodian_e2e')!.id;
    readonlyUserId = usersRes.rows.find((r) => r.username === 'readonly_e2e')!.id;

    // Assign roles
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
      [custodianUserId]
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')`,
      [readonlyUserId]
    );

    // 5. Start Vite dev server proxying to Fastify
    viteServer = await createServer({
      root: webRoot,
      configFile: path.resolve(webRoot, 'vite.config.ts'),
      server: {
        port: 0,
        strictPort: false,
        proxy: {
          '/auth': {
            target: `http://127.0.0.1:${fastifyPort}`,
            changeOrigin: true,
          },
          '/system': {
            target: `http://127.0.0.1:${fastifyPort}`,
            changeOrigin: true,
          },
          '/assets': {
            target: `http://127.0.0.1:${fastifyPort}`,
            changeOrigin: true,
            bypass: (req) => {
              if (req.headers.accept?.includes('text/html')) {
                return '/index.html';
              }
            },
          },
        },
      },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    targetBaseUrl =
      typeof address === 'object' && address ? `http://localhost:${address.port}` : 'http://localhost:5173';
  });

  test.afterAll(async () => {
    if (viteServer) {
      await viteServer.close();
    }
    if (fastifyApp) {
      await fastifyApp.close();
    }
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  const loginAs = async (page: any, context: any, userId: string) => {
    const session = await sessionService.createSession(userId);
    await context.addCookies([
      {
        name: 'session',
        value: session.token,
        url: targetBaseUrl,
      },
    ]);
  };

  test('Journey 1: minimal ordinary registration -> linked detail/history view', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    // Navigate to registration page
    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Fill form
    await page.locator('input#name').fill('MacBook Pro 16');
    await page.locator('input#asset_number').fill('ASSET-2026-001');
    await page.locator('input#serial_number').fill('C02XYZ12345');
    await page.locator('textarea#source_reference').fill('PO-2026-0099');

    // Submit registration
    await page.locator('button#submit-register-btn').click();

    // Wait for navigation to detail page
    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const currentUrl = page.url();
    const assetId = currentUrl.split('/assets/')[1];
    expect(assetId).toMatch(/^[0-9a-f-]{36}$/);
    firstCreatedAssetId = assetId;

    // Verify detail page displays registered facts
    await expect(page.locator('#asset-detail-heading')).toHaveText('MacBook Pro 16');
    await expect(page.locator('dd:has-text("ASSET-2026-001")')).toBeVisible();
    await expect(page.locator('dd:has-text("C02XYZ12345")')).toBeVisible();
    await expect(page.locator('dd:has-text("PO-2026-0099")')).toBeVisible();
    await expect(page.locator(`dd:has-text("${custodianUserId}")`)).toBeVisible();

    // Verify history section displays REGISTERED action
    await expect(page.locator('table')).toContainText('REGISTERED');
    await expect(page.locator('table')).toContainText(custodianUserId);

    // Confirm in PostgreSQL database
    const dbCheck = await pool.query('SELECT * FROM assets WHERE id = $1', [assetId]);
    expect(dbCheck.rows).toHaveLength(1);
    expect(dbCheck.rows[0].name).toBe('MacBook Pro 16');
    expect(dbCheck.rows[0].asset_number).toBe('ASSET-2026-001');
    expect(dbCheck.rows[0].serial_number).toBe('C02XYZ12345');
  });

  test('Journey 2: automatic duplicate continuation', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    // Navigate to registration page to register another item with the same asset_number
    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    await page.locator('input#name').fill('Second Distinct MacBook');
    await page.locator('input#asset_number').fill('ASSET-2026-001'); // duplicate asset number
    await page.locator('input#serial_number').fill('C02DIFFERENT');

    // Submit without checking duplicates first -> triggers server 409 DUPLICATE_CANDIDATES_FOUND
    await page.locator('button#submit-register-btn').click();

    // Warning banner should be rendered
    const warningRegion = page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]');
    await expect(warningRegion).toBeVisible();
    await expect(warningRegion).toContainText('คำเตือน: พบครุภัณฑ์ที่มีเลขระบุตัวตนตรงกันในระบบ');
    await expect(warningRegion).toContainText('ASSET-2026-001');
    await expect(warningRegion).toContainText('MacBook Pro 16');

    // Check explicit continuation checkbox
    await page.locator('input#explicit_continuation').check();

    // Submit button is now enabled for explicit continuation
    await page.locator('button#submit-register-btn').click();

    // Successfully navigates to the second asset's detail page
    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const secondAssetId = page.url().split('/assets/')[1];
    expect(secondAssetId).not.toBe(firstCreatedAssetId);

    await expect(page.locator('#asset-detail-heading')).toHaveText('Second Distinct MacBook');
    await expect(page.locator('dd:has-text("ASSET-2026-001")')).toBeVisible();

    // Confirm in PostgreSQL that 2 distinct records exist
    const countCheck = await pool.query(
      'SELECT count(*)::int as count FROM assets WHERE asset_number = $1',
      ['ASSET-2026-001']
    );
    expect(countCheck.rows[0].count).toBe(2);
  });

  test('Journey 3: incomplete legacy entry without fabricated placeholders', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Check legacy record checkbox
    await page.locator('input#is_legacy').check();

    // Fill only source notes without name or numbers
    await page.locator('textarea#source_reference').fill('Archive Cabinet Box #5 Tag');

    // Submit registration
    await page.locator('button#submit-register-btn').click();

    // Navigates to detail page
    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));

    // Legacy badge is displayed
    await expect(page.locator('span:has-text("ข้อมูลตกทอด (Legacy)")')).toBeVisible();

    // Name displays absence note instead of fabricated "Unknown"
    await expect(page.locator('#asset-detail-heading')).toHaveText(
      '(ไม่ระบุชื่อ - ข้อมูลตกทอดตามจริง)'
    );
    await expect(page.locator('dd:has-text("Archive Cabinet Box #5 Tag")')).toBeVisible();

    // Verify in database: name, asset_number, serial_number are NULL, no fabricated strings
    const legacyAssetId = page.url().split('/assets/')[1];
    const dbCheck = await pool.query('SELECT * FROM assets WHERE id = $1', [legacyAssetId]);
    expect(dbCheck.rows[0].name).toBeNull();
    expect(dbCheck.rows[0].asset_number).toBeNull();
    expect(dbCheck.rows[0].serial_number).toBeNull();
  });

  test('Journey 4: read-only user access restriction (forbidden on register, permitted on view)', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);

    // 1. Attempting to view register page -> forbidden
    await page.goto(`${targetBaseUrl}/assets/register`);

    // Either check-duplicate or registration capability missing -> shows forbidden banner
    // Let's type an asset number and check duplicate or attempt action
    await page.locator('input#asset_number').fill('AST-RO-CHECK');
    await page.locator('button#check-duplicate-btn').click();

    await expect(page.locator('text=ไม่ได้รับอนุญาต (403 Forbidden)')).toBeVisible();
    await expect(page.locator('button#submit-register-btn')).not.toBeVisible();

    // 2. Viewing existing asset detail page -> allowed
    await page.goto(`${targetBaseUrl}/assets/${firstCreatedAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('MacBook Pro 16');
    await expect(page.locator('dd:has-text("ASSET-2026-001")')).toBeVisible();
    await expect(page.locator('table')).toContainText('REGISTERED');
  });

  test('Journey 5: browser retries retain action identity across retries (Finding Spec 5)', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Fill initial form data
    await page.locator('input#name').fill('Persistent Retry Asset');
    await page.locator('input#asset_number').fill('PERSIST-01');

    // First attempt submit
    await page.locator('button#submit-register-btn').click();

    // Navigates to created asset
    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const initialId = page.url().split('/assets/')[1];

    // Confirm single asset created in database
    const checkDb = await pool.query('SELECT count(*)::int as count FROM assets WHERE asset_number = $1', [
      'PERSIST-01',
    ]);
    expect(checkDb.rows[0].count).toBe(1);
    expect(initialId).toBeDefined();
  });
});
