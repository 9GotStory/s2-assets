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
  let maintainerUserId: string;
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
        ('readonly_e2e', '${passwordHash}', true),
        ('maintainer_e2e', '${passwordHash}', true)
      RETURNING id, username;
    `);

    custodianUserId = usersRes.rows.find((r) => r.username === 'custodian_e2e')!.id;
    readonlyUserId = usersRes.rows.find((r) => r.username === 'readonly_e2e')!.id;
    maintainerUserId = usersRes.rows.find((r) => r.username === 'maintainer_e2e')!.id;

    // Assign roles
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
      [custodianUserId]
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')`,
      [readonlyUserId]
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SYSTEM_MAINTAINER')`,
      [maintainerUserId]
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

  test('Journey 5: browser retries retain action identity across committed-but-unreceived retries (Finding Spec 5)', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Fill initial form data
    await page.locator('input#name').fill('Persistent Retry Asset');
    await page.locator('input#asset_number').fill('PERSIST-01');

    let attemptedFirstPost = false;
    let interceptedRetryToken: string | null = null;
    let committedResponseStatus: number | null = null;
    let resolveFirstAbort!: () => void;
    const firstAbortPromise = new Promise<void>((resolve) => {
      resolveFirstAbort = resolve;
    });

    // Route interception: on first POST /assets, execute request on backend (commits to PG),
    // but abort network connection before browser receives the response
    await page.route('**/assets', async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && !attemptedFirstPost) {
        attemptedFirstPost = true;
        const postData = request.postDataJSON();
        interceptedRetryToken = postData?.retry_token || null;

        // Fetch to backend server: executes in Fastify & commits to PostgreSQL
        const response = await route.fetch();
        committedResponseStatus = response.status();

        // Simulate network connection abort before response reaches browser
        await route.abort('failed');
        resolveFirstAbort();
        return;
      }
      await route.continue();
    });

    // First attempt submit -> browser encounters network error
    await page.locator('button#submit-register-btn').click();
    await firstAbortPromise;

    // Expect the first backend request to have succeeded (201) and committed
    expect(attemptedFirstPost).toBe(true);
    expect(committedResponseStatus).toBe(201);
    expect(interceptedRetryToken).toBeTruthy();

    // Error message displayed to user, but form stays filled with same retry token
    await expect(page.locator('div[role="alert"]')).toContainText(
      'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง'
    );
    await expect(page.locator('input#name')).toHaveValue('Persistent Retry Asset');
    await expect(page.locator('input#asset_number')).toHaveValue('PERSIST-01');

    // Verify in database: exactly 1 asset was inserted, retry token was recorded
    const midCheck = await pool.query(
      'SELECT id, name, asset_number FROM assets WHERE asset_number = $1',
      ['PERSIST-01']
    );
    expect(midCheck.rows).toHaveLength(1);
    const initialAssetId = midCheck.rows[0].id;

    const tokenCheck = await pool.query(
      'SELECT * FROM registration_retry_tokens WHERE token = $1',
      [interceptedRetryToken]
    );
    expect(tokenCheck.rows).toHaveLength(1);
    expect(tokenCheck.rows[0].response_status).toBe(201);

    // User clicks submit again without modifying form -> reuse same retry token
    let secondPostToken: string | null = null;
    page.on('request', (req) => {
      if (req.url().includes('/assets') && req.method() === 'POST' && attemptedFirstPost) {
        try {
          secondPostToken = req.postDataJSON()?.retry_token;
        } catch {
          // ignore
        }
      }
    });

    await page.locator('button#submit-register-btn').click();

    // Browser now navigates successfully to the created asset detail page
    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const finalAssetId = page.url().split('/assets/')[1];

    // Verify Stable ID is identical to the one created in the first commit
    expect(finalAssetId).toBe(initialAssetId);
    expect(secondPostToken).toBe(interceptedRetryToken);

    // Verify database integrity: still exactly 1 asset, 1 history fact, 1 retry token entry
    const finalAssetRows = await pool.query(
      'SELECT * FROM assets WHERE asset_number = $1',
      ['PERSIST-01']
    );
    expect(finalAssetRows.rows).toHaveLength(1);

    const historyRows = await pool.query(
      'SELECT * FROM asset_history WHERE asset_id = $1',
      [initialAssetId]
    );
    expect(historyRows.rows).toHaveLength(1);
    expect(historyRows.rows[0].action).toBe('REGISTERED');

    const finalTokenRows = await pool.query(
      'SELECT * FROM registration_retry_tokens WHERE token = $1',
      [interceptedRetryToken]
    );
    expect(finalTokenRows.rows).toHaveLength(1);
  });

  test('Journey 6: changing identifier immediately resets stale duplicate candidates and acknowledgement', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Type duplicate asset number and check duplicates
    await page.locator('input#asset_number').fill('ASSET-2026-001');
    await page.locator('button#check-duplicate-btn').click();

    // Duplicate warning banner appears
    const warningRegion = page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]');
    await expect(warningRegion).toBeVisible();

    // Check explicit continuation
    await page.locator('input#explicit_continuation').check();
    await expect(page.locator('input#explicit_continuation')).toBeChecked();

    // Now change asset number
    await page.locator('input#asset_number').fill('ASSET-NEW-UNIQUE-999');

    // Warning banner immediately disappears and continuation is reset
    await expect(warningRegion).not.toBeVisible();
    await expect(page.locator('input#explicit_continuation')).not.toBeVisible();
  });

  test('Journey 7: truthful legacy badge displayed on named legacy records', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, custodianUserId);

    // 1. Register a named legacy item
    await page.goto(`${targetBaseUrl}/assets/register`);
    await page.locator('input#name').fill('โต๊ะทำงานไม้สักทองโบราณ');
    await page.locator('input#is_legacy').check();
    await page.locator('textarea#source_reference').fill('เอกสารสำรวจพัสดุตกทอดปี 2540');
    await page.locator('button#submit-register-btn').click();

    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const legacyAssetId = page.url().split('/assets/')[1];

    // Detail page shows the truthful name AND the legacy badge
    await expect(page.locator('#asset-detail-heading')).toHaveText('โต๊ะทำงานไม้สักทองโบราณ');
    await expect(page.locator('span:has-text("ข้อมูลตกทอด (Legacy)")')).toBeVisible();
    await expect(page.locator('span:has-text("ปกติ")')).not.toBeVisible();

    // Verify in database: name is preserved, history fact has is_legacy: true
    const dbAsset = await pool.query('SELECT * FROM assets WHERE id = $1', [legacyAssetId]);
    expect(dbAsset.rows[0].name).toBe('โต๊ะทำงานไม้สักทองโบราณ');

    const dbHistory = await pool.query('SELECT * FROM asset_history WHERE asset_id = $1', [
      legacyAssetId,
    ]);
    expect(dbHistory.rows[0].payload.is_legacy).toBe(true);
  });

  test('Journey 8: editing identifier during in-flight lookup recovers check button and discards obsolete response', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Fill identifier A
    await page.locator('input#asset_number').fill('ASSET-2026-001');

    let resolvePendingGet!: () => void;
    const pendingGetPromise = new Promise<void>((resolve) => {
      resolvePendingGet = resolve;
    });

    let interceptedFirstGet = false;
    await page.route('**/assets/duplicate-candidates*', async (route) => {
      if (!interceptedFirstGet && route.request().url().includes('asset_number=ASSET-2026-001')) {
        interceptedFirstGet = true;
        // Hold the response until identifier is edited
        await pendingGetPromise;
      }
      await route.continue();
    });

    // Click check duplicate button -> enters in-flight state
    await page.locator('button#check-duplicate-btn').click();
    await expect(page.locator('button#check-duplicate-btn')).toHaveText('กำลังตรวจสอบ...');
    await expect(page.locator('button#check-duplicate-btn')).toBeDisabled();

    // Now edit identifier to B while GET is in-flight
    await page.locator('input#asset_number').fill('ASSET-NEW-999');

    // Check button should recover immediately and NOT remain stuck on disabled / "กำลังตรวจสอบ..."
    await expect(page.locator('button#check-duplicate-btn')).toHaveText('🔍 ตรวจสอบข้อมูลซ้ำ');
    await expect(page.locator('button#check-duplicate-btn')).toBeEnabled();

    // Release the held GET response for A
    resolvePendingGet();

    // Ensure the stale response for A does not populate candidate table for B
    await expect(page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]')).not.toBeVisible();
    await expect(page.locator('button#check-duplicate-btn')).toBeEnabled();
  });

  test('Journey 9: delayed POST warning response cannot populate candidates or permit acknowledgement after identifier change', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Seed duplicate candidate A in DB
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now(), now())`,
      [crypto.randomUUID(), 'Existing A Asset', 'ID-A-DUPLICATE', custodianUserId]
    );

    // Seed duplicate candidate B in DB
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now(), now())`,
      [crypto.randomUUID(), 'Existing B Asset', 'ID-B-DUPLICATE', custodianUserId]
    );

    // Form starts with name and duplicate identifier A (ID-A-DUPLICATE)
    await page.locator('input#name').fill('Test Asset Cross Stale');
    await page.locator('input#asset_number').fill('ID-A-DUPLICATE');

    let resolvePostA!: () => void;
    const postAHoldPromise = new Promise<void>((resolve) => {
      resolvePostA = resolve;
    });

    let interceptedPostA = false;
    await page.route('**/assets', async (route) => {
      const req = route.request();
      if (req.method() === 'POST' && !interceptedPostA) {
        interceptedPostA = true;
        // Fetch real response (409) from Fastify
        const response = await route.fetch();
        expect(response.status()).toBe(409);
        // Hold response until we edit the identifier
        await postAHoldPromise;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    const postResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/assets') && res.request().method() === 'POST'
    );

    // Submit for A -> triggers POST
    await page.locator('button#submit-register-btn').click();

    // While POST for A is in flight, edit identifier to B
    await page.locator('input#asset_number').fill('ID-B-DUPLICATE');

    // Release held 409 response for A and wait for browser to receive it
    resolvePostA();
    await postResponsePromise;

    // The obsolete 409 response for A must NOT populate candidates for B!
    // Warning region must NOT be visible with candidate A
    await expect(page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]')).not.toBeVisible();
    await expect(page.locator('input#explicit_continuation')).not.toBeVisible();
  });

  test('Journey 10 (T3): discover search from Dashboard -> browse and exact identifier search -> open detail', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);

    // 1. Start on dashboard and click Search link
    await page.goto(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#nav-asset-search')).toBeVisible();
    await page.locator('#nav-asset-search').click();

    // 2. Navigates to /assets/search
    await page.waitForURL(`${targetBaseUrl}/assets/search`);
    await expect(page.getByRole('heading', { level: 1, name: 'ค้นหาและตรวจสอบครุภัณฑ์ (Asset Search)' })).toBeVisible();

    // 3. Initial browse loads items registered in earlier journeys
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).not.toHaveCount(0);

    // 4. Perform exact identifier search on asset_number
    await page.locator('select#search-field').selectOption('asset_number');
    await page.locator('input#search-value').fill('ASSET-2026-001');
    await page.locator('button#search-submit-btn').click();

    // 5. Results table updates to matches
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // 6. Click Stable ID link to navigate to asset detail page
    const detailLink = page.locator(`a#asset-link-${firstCreatedAssetId}`);
    await expect(detailLink).toBeVisible();
    await detailLink.click();

    // 7. Navigates to /assets/:id
    await page.waitForURL(`${targetBaseUrl}/assets/${firstCreatedAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('MacBook Pro 16');
  });

  test('Journey 11 (T3): case-insensitive substring name search and empty state', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);

    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.getByRole('heading', { level: 1, name: 'ค้นหาและตรวจสอบครุภัณฑ์ (Asset Search)' })).toBeVisible();

    // Search by case-insensitive name substring
    await page.locator('select#search-field').selectOption('name');
    await page.locator('input#search-value').fill('distinct');
    await page.locator('button#search-submit-btn').click();

    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr td:has-text("Second Distinct MacBook")')).toBeVisible();

    // Search for nonexistent query
    await page.locator('input#search-value').fill('NONEXISTENT_QUERY_99999');
    await page.locator('button#search-submit-btn').click();

    await expect(page.locator('#no-results-message')).toBeVisible();
    await expect(page.locator('#no-results-message')).toContainText('ไม่พบข้อมูลครุภัณฑ์ตามเงื่อนไขที่ระบุ');
  });

  test('Journey 12 (T3): unauthenticated access redirects to login and clears protected state', async ({
    page,
    context,
  }) => {
    // Clear cookies to simulate unauthenticated user
    await context.clearCookies();

    // Attempt direct navigation to /assets/search
    await page.goto(`${targetBaseUrl}/assets/search`);

    // Must be redirected to /login immediately
    await page.waitForURL(`${targetBaseUrl}/login`);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();
  });

  test('Journey 13 (T3 F2): whitespace-only identifier search is exact match, not broadened to browse; whitespace-only name search triggers validation error', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);

    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.getByRole('heading', { level: 1, name: 'ค้นหาและตรวจสอบครุภัณฑ์ (Asset Search)' })).toBeVisible();

    // 1. Exact whitespace search on asset_number does NOT browse all items
    await page.locator('select#search-field').selectOption('asset_number');
    await page.locator('input#search-value').fill('   ');
    await page.locator('button#search-submit-btn').click();

    // Must show no-results message and NOT browse table with items
    await expect(page.locator('#no-results-message')).toBeVisible();
    await expect(page.locator('#no-results-message')).toContainText('ไม่พบข้อมูลครุภัณฑ์ตามเงื่อนไขที่ระบุ');
    await expect(page.locator('#asset-search-table')).not.toBeVisible();

    // 2. Whitespace-only search on name triggers validation error
    await page.locator('select#search-field').selectOption('name');
    await page.locator('input#search-value').fill('   ');
    await page.locator('button#search-submit-btn').click();

    // Validation alert must be visible
    await expect(page.locator('#search-error-alert')).toBeVisible();
    await expect(page.locator('#search-error-alert')).toContainText('Search value for name must not be whitespace-only');
    await expect(page.locator('#asset-search-table')).not.toBeVisible();

    // 3. Reset or browse all recovers full list
    await page.locator('button#search-reset-btn').click();
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).not.toHaveCount(0);
  });

  test('Journey 14 (T3 F3): actor transition and session revocation unmount detail page and clear protected search state on focus return', async ({
    page,
    context,
  }) => {
    // 1. Mount detail page with authenticated session
    await loginAs(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${firstCreatedAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('MacBook Pro 16');

    // 2. Revoke session by clearing cookies
    await context.clearCookies();

    // 3. Simulate focus return
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    // 4. Must be redirected to /login and detail must be completely unmounted
    await page.waitForURL(`${targetBaseUrl}/login`);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();

    // 5. Test search page session revocation on focus
    await loginAs(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.locator('#asset-search-table')).toBeVisible();

    // Revoke session and trigger focus return
    await context.clearCookies();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    // Must be redirected to /login and table unmounted
    await page.waitForURL(`${targetBaseUrl}/login`);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();
    await expect(page.locator('#asset-search-table')).not.toBeVisible();
  });

  test('Journey 15 (T3 F3): detail boundary preflight blocks unauthorized role (maintainer without asset:view) with 403 Forbidden without mounting AssetDetail', async ({
    page,
    context,
  }) => {
    // 1. Login as maintainer_e2e who has valid session but role SYSTEM_MAINTAINER (lacks asset:view)
    await loginAs(page, context, maintainerUserId);

    // 2. Navigate to asset detail page
    await page.goto(`${targetBaseUrl}/assets/${firstCreatedAssetId}`);

    // 3. Preflight GET /assets/:id returns 403 Forbidden; detail boundary catches 403 and halts
    await expect(page.locator('#detail-boundary-error')).toBeVisible();
    await expect(page.locator('#detail-boundary-error')).toContainText('คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)');

    // 4. AssetDetail component is never mounted
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    await expect(page.locator('#detail-verifying-boundary')).not.toBeVisible();

    // 5. Back button navigates to dashboard
    await page.locator('#back-dashboard-btn').click();
    await page.waitForURL(`${targetBaseUrl}/dashboard`);
  });

  test('Journey 16 (T3 F3): actor switch on search page resets search criteria and prevents stale data leakage', async ({
    page,
    context,
  }) => {
    // 1. Login as readonly_e2e (Actor A)
    await loginAs(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.locator('#asset-search-table')).toBeVisible();

    // 2. Perform filtered search for 'distinct' -> 1 match
    await page.locator('select#search-field').selectOption('name');
    await page.locator('input#search-value').fill('distinct');
    await page.locator('button#search-submit-btn').click();
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr td:has-text("Second Distinct MacBook")')).toBeVisible();

    // 3. Switch actor to custodian_e2e (Actor B) by swapping session cookie
    const sessionB = await sessionService.createSession(custodianUserId);
    await context.addCookies([
      {
        name: 'session',
        value: sessionB.token,
        url: targetBaseUrl,
      },
    ]);

    // 4. Trigger blur/focus event (revalidation)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    // 5. Revalidation detects actor switch: criteria must reset to 'all' / '' and table shows all rows
    await expect(page.locator('select#search-field')).toHaveValue('all');
    await expect(page.locator('input#search-value')).toHaveValue('');
    await expect(page.locator('#asset-search-table')).toBeVisible();
    // Table shows full browse results, not just the 1 filtered row of Actor A
    await expect(page.locator('tbody tr')).toHaveCount(7);
  });

  test('Journey 17 (T3 F3): stale out-of-order session-check response is discarded and cannot clear or redirect a newer valid search', async ({
    page,
    context,
  }) => {
    // 1. Login as readonly_e2e
    await loginAs(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.locator('#asset-search-table')).toBeVisible();

    // 2. Set up controlled delay on the first session-check request
    let resolveFirstSessionCheck!: () => void;
    const firstCheckHold = new Promise<void>((resolve) => {
      resolveFirstSessionCheck = resolve;
    });

    let checkCount = 0;
    await page.route('**/auth/session-check', async (route) => {
      checkCount++;
      if (checkCount === 1) {
        // Hold the first session check
        await firstCheckHold;
        // Fulfill with 401 Unauthorized (simulating stale session failure)
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }),
        });
        return;
      }
      // Subsequent session checks proceed normally
      await route.continue();
    });

    // 3. Trigger first search (Request 1 - session check is held)
    await page.locator('select#search-field').selectOption('name');
    await page.locator('input#search-value').fill('MacBook');
    await page.locator('button#search-submit-btn').click();

    // Verify data is hidden during revalidation
    await expect(page.locator('#search-loading-indicator')).toBeVisible();
    await expect(page.locator('#asset-search-table')).not.toBeVisible();

    // 4. Trigger second search (Request 2) before Request 1 finishes, advancing searchGenRef
    await page.locator('input#search-value').fill('Second Distinct');
    await page.locator('button#search-submit-btn').click();

    // Request 2 completes and displays results
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr td:has-text("Second Distinct MacBook")')).toBeVisible();

    // 5. Now release the obsolete Request 1 session check (which returns 401)
    resolveFirstSessionCheck();
    // Allow any event loop cycles to process
    await page.waitForTimeout(500);

    // 6. Assert obsolete 401 does NOT redirect to /login and does NOT clear Request 2's results
    expect(page.url()).toBe(`${targetBaseUrl}/assets/search`);
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).not.toBeVisible();
  });

  test('Journey 18 (T3 F3): in-flight search execution hides protected data until response arrives', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.locator('#asset-search-table')).toBeVisible();

    let resolveSearchReq!: () => void;
    const searchHold = new Promise<void>((resolve) => {
      resolveSearchReq = resolve;
    });

    let interceptedSearch = false;
    await page.route('**/assets/search*', async (route) => {
      if (!interceptedSearch) {
        interceptedSearch = true;
        await searchHold;
      }
      await route.continue();
    });

    // Trigger search
    await page.locator('button#search-submit-btn').click();

    // While search is in-flight:
    // Loading indicator must be visible and table rows must be completely hidden
    await expect(page.locator('#search-loading-indicator')).toBeVisible();
    await expect(page.locator('#asset-search-table')).not.toBeVisible();

    // Release search request
    resolveSearchReq();

    // Results reappear once search finishes
    await expect(page.locator('#asset-search-table')).toBeVisible();
    await expect(page.locator('#search-loading-indicator')).not.toBeVisible();
  });

  test('Journey 19 (T3 F3 Pass 3 RED/GREEN): unmounting search page during session verification retires ownership and cannot redirect newly mounted route to login', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);

    // Instrument browser fetch: when simulating unmount body abort, headers succeed immediately (200 OK),
    // but body json() rejects with AbortError when unmount cleanup calls abortController.abort()
    await page.addInitScript(() => {
      const origFetch = window.fetch;
      (window as any).__origFetch = origFetch;
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (url.includes('/auth/session-check') && location.pathname.includes('/assets/search')) {
          const signal: AbortSignal | undefined = args[1]?.signal;
          return {
            ok: true,
            status: 200,
            json: () =>
              new Promise((resolve, reject) => {
                if (signal?.aborted) {
                  reject(new DOMException('The user aborted a request.', 'AbortError'));
                } else {
                  signal?.addEventListener('abort', () => {
                    reject(new DOMException('The user aborted a request.', 'AbortError'));
                  });
                }
              }),
          } as any;
        }
        return origFetch(...args);
      };
    });

    // 1. Navigate to search page directly
    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.locator('#back-dashboard-link')).toBeVisible();

    // 2. Click back to dashboard while body parsing is pending
    // This unmounts AssetSearch, calling its cleanup: abortController.abort()
    await page.locator('#back-dashboard-link').click();

    // Wait for microtask / obsolete continuation
    await page.waitForTimeout(1000);

    // 3. In unpatched code, the obsolete completion navigates to /login
    // The user must remain safely on /dashboard!
    expect(page.url()).toBe(`${targetBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).not.toBeVisible();
  });

  test('Journey 20 (T3 F3 Pass 3 RED/GREEN): unmounting detail boundary during session verification retires ownership and cannot redirect newly mounted route to login', async ({
    page,
    context,
  }) => {
    await loginAs(page, context, readonlyUserId);

    // Instrument browser fetch: when simulating unmount body abort, headers succeed immediately (200 OK),
    // but body json() rejects with AbortError when unmount cleanup calls abortController.abort()
    await page.addInitScript(() => {
      const origFetch = window.fetch;
      (window as any).__origFetch = origFetch;
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (url.includes('/auth/session-check') && location.pathname.includes('/assets/')) {
          const signal: AbortSignal | undefined = args[1]?.signal;
          return {
            ok: true,
            status: 200,
            json: () =>
              new Promise((resolve, reject) => {
                if (signal?.aborted) {
                  reject(new DOMException('The user aborted a request.', 'AbortError'));
                } else {
                  signal?.addEventListener('abort', () => {
                    reject(new DOMException('The user aborted a request.', 'AbortError'));
                  });
                }
              }),
          } as any;
        }
        return origFetch(...args);
      };
    });

    // 1. Navigate to detail page directly
    await page.goto(`${targetBaseUrl}/assets/${firstCreatedAssetId}`);
    await expect(page.locator('#detail-boundary-back-link')).toBeVisible();

    // 2. Click back to dashboard while body parsing is pending
    // This unmounts ProtectedDetailBoundary, calling its cleanup: abortController.abort()
    await page.locator('#detail-boundary-back-link').click();

    // Wait for microtask / obsolete continuation
    await page.waitForTimeout(1000);

    // 3. In unpatched code, the obsolete completion navigates to /login
    // The user must remain safely on /dashboard!
    expect(page.url()).toBe(`${targetBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).not.toBeVisible();
  });
});
