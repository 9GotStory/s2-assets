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
  let adminUserId: string;
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
        ('admin_e2e', '${passwordHash}', true)
      RETURNING id, username;
    `);

    custodianUserId = usersRes.rows.find((r) => r.username === 'custodian_e2e')!.id;
    readonlyUserId = usersRes.rows.find((r) => r.username === 'readonly_e2e')!.id;
    adminUserId = usersRes.rows.find((r) => r.username === 'admin_e2e')!.id;

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
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')`,
      [adminUserId]
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

  test('Journey 10: Successful correction by Administrator / Custodian preserves Stable ID and registration fact in history', async ({
    page,
    context,
  }) => {
    // 1. Create an asset directly in PostgreSQL
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องฉายโปรเจคเตอร์เดิม', 'PROJ-ORIG-001', 'SN-ORIG-001', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [
        crypto.randomUUID(),
        testAssetId,
        custodianUserId,
        JSON.stringify({
          name: 'เครื่องฉายโปรเจคเตอร์เดิม',
          asset_number: 'PROJ-ORIG-001',
          serial_number: 'SN-ORIG-001',
        }),
      ]
    );

    // 2. Login as Administrator
    await loginAs(page, context, adminUserId);

    // 3. Navigate to Asset Detail page
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('เครื่องฉายโปรเจคเตอร์เดิม');
    await expect(page.locator('p:has-text("Stable ID:")')).toContainText(testAssetId);

    // Form is visible for Administrator
    await expect(page.locator('#asset-correction-form')).toBeVisible();

    // 4. Fill correction form
    await page.locator('#asset-correction-form input#name').fill('เครื่องฉายโปรเจคเตอร์ 4K (แก้ไข)');
    await page.locator('#asset-correction-form input#asset_number').fill('PROJ-NEW-4K-001');
    await page.locator('#asset-correction-form input#serial_number').fill('SN-NEW-4K-001');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขข้อมูลตามรายงานตรวจนับพัสดุ');

    // 5. Submit correction
    await page.locator('button#submit-correct-btn').click();

    // 6. Verify success message and updated details
    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );
    await expect(page.locator('#asset-detail-heading')).toHaveText('เครื่องฉายโปรเจคเตอร์ 4K (แก้ไข)');
    await expect(page.locator('p:has-text("Stable ID:")')).toContainText(testAssetId);

    // 7. Verify timeline history table contains both REGISTERED and CORRECTED
    await expect(page.locator('td:has-text("ลงทะเบียนครุภัณฑ์ (REGISTERED)")')).toBeVisible();
    await expect(page.locator('td:has-text("แก้ไขข้อมูลครุภัณฑ์ (CORRECTED)")')).toBeVisible();
    await expect(page.getByText('เหตุผล: แก้ไขข้อมูลตามรายงานตรวจนับพัสดุ')).toBeVisible();

    // 8. Verify database state
    const dbAsset = await pool.query('SELECT * FROM assets WHERE id = $1', [testAssetId]);
    expect(dbAsset.rows[0].name).toBe('เครื่องฉายโปรเจคเตอร์ 4K (แก้ไข)');
    expect(dbAsset.rows[0].asset_number).toBe('PROJ-NEW-4K-001');
    expect(dbAsset.rows[0].serial_number).toBe('SN-NEW-4K-001');

    const dbHistory = await pool.query(
      'SELECT * FROM asset_history WHERE asset_id = $1 ORDER BY recorded_at ASC',
      [testAssetId]
    );
    expect(dbHistory.rows).toHaveLength(2);
    expect(dbHistory.rows[0].action).toBe('REGISTERED');
    expect(dbHistory.rows[1].action).toBe('CORRECTED');
    expect(dbHistory.rows[1].actor_id).toBe(adminUserId);
    expect(dbHistory.rows[1].payload.reason).toBe('แก้ไขข้อมูลตามรายงานตรวจนับพัสดุ');
    expect(dbHistory.rows[1].payload.changes.name.before).toBe('เครื่องฉายโปรเจคเตอร์เดิม');
    expect(dbHistory.rows[1].payload.changes.name.after).toBe('เครื่องฉายโปรเจคเตอร์ 4K (แก้ไข)');
  });

  test('Journey 11: Read-only user sees correction history but cannot see/submit correction form', async ({
    page,
    context,
  }) => {
    // Create an asset with correction history
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'จอภาพ LED ห้องประชุม', 'MON-001', 'SN-MON-001', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'จอภาพ LED ห้องประชุม' })]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'CORRECTED', $3, $4, now(), now())`,
      [
        crypto.randomUUID(),
        testAssetId,
        custodianUserId,
        JSON.stringify({
          changes: {
            serial_number: { before: 'SN-MON-OLD', after: 'SN-MON-001' },
          },
          reason: 'ปรับปรุง serial number ที่ถูกต้อง',
        }),
      ]
    );

    // Login as Read-only user
    await loginAs(page, context, readonlyUserId);

    // Navigate to Asset Detail page
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('จอภาพ LED ห้องประชุม');

    // Both history facts are visible
    await expect(page.locator('td:has-text("ลงทะเบียนครุภัณฑ์ (REGISTERED)")')).toBeVisible();
    await expect(page.locator('td:has-text("แก้ไขข้อมูลครุภัณฑ์ (CORRECTED)")')).toBeVisible();
    await expect(page.getByText('เหตุผล: ปรับปรุง serial number ที่ถูกต้อง')).toBeVisible();

    // Correction form is NOT visible
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();
    await expect(page.locator('[data-testid="read-only-notice"]')).toBeVisible();
  });

  test('Journey 12: Duplicate candidate warning and explicit continuation in correction form', async ({
    page,
    context,
  }) => {
    // 1. Seed existing asset X with asset_number 'CONFLICT-NUM-100'
    const existingAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [existingAssetId, 'เครื่องพิมพ์ตั้งโต๊ะเดิม', 'CONFLICT-NUM-100', 'SN-PRN-001', custodianUserId]
    );

    // 2. Create asset Y to be corrected
    const targetAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [targetAssetId, 'เครื่องพิมพ์เป้าหมาย', 'PRN-TARGET-999', 'SN-PRN-999', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), targetAssetId, custodianUserId, JSON.stringify({ name: 'เครื่องพิมพ์เป้าหมาย' })]
    );

    // Login as Custodian
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${targetAssetId}`);

    // Fill identifier to match existing asset X
    await page.locator('#asset-correction-form input#asset_number').fill('CONFLICT-NUM-100');
    await page.locator('#asset-correction-form textarea#reason').fill('ทดสอบการยืนยันข้อมูลซ้ำ');

    // Click check duplicate button
    await page.locator('button#check-duplicate-btn').click();

    // Duplicate candidate warning region appears with the conflict candidate
    await expect(page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]')).toBeVisible();
    await expect(page.locator('td:has-text("เครื่องพิมพ์ตั้งโต๊ะเดิม")')).toBeVisible();

    // Attempt submit without checking explicit continuation -> validation warning
    await page.locator('button#submit-correct-btn').click();
    await expect(page.locator('[data-testid="correction-error-message"]')).toContainText(
      'พบข้อมูลซ้ำในระบบ โปรดตรวจสอบและยืนยันการบันทึกการแก้ไขก่อนดำเนินการต่อ'
    );

    // Check explicit continuation checkbox
    await page.locator('input#explicit_continuation').check();

    // Submit correction
    await page.locator('button#submit-correct-btn').click();

    // Verify success
    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );

    // Verify DB
    const dbAsset = await pool.query('SELECT asset_number FROM assets WHERE id = $1', [targetAssetId]);
    expect(dbAsset.rows[0].asset_number).toBe('CONFLICT-NUM-100');
  });

  test('Journey 13: Committed response loss injection via page.route followed by UI retry using identical token', async ({
    page,
    context,
  }) => {
    // 1. Create asset
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องสำรองไฟห้องเซิร์ฟเวอร์', 'UPS-001', 'SN-UPS-001', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'เครื่องสำรองไฟห้องเซิร์ฟเวอร์' })]
    );

    // Login as Custodian
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    // Fill form
    await page.locator('#asset-correction-form input#name').fill('เครื่องสำรองไฟ Smart UPS 3000VA');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขชื่อรุ่นให้ตรงกับฉลากสินค้า');

    let interceptedFirstAttempt = false;
    let firstTokenUsed: string | null = null;
    let secondTokenUsed: string | null = null;

    await page.route(`**/assets/${testAssetId}/correct`, async (route) => {
      const headers = route.request().headers();
      const retryToken = headers['x-retry-token'];

      if (!interceptedFirstAttempt) {
        interceptedFirstAttempt = true;
        firstTokenUsed = retryToken;
        // Fetch real response from server (which completes the DB transaction committed)
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        // Inject transport loss: abort response to browser so client sees network error
        await route.abort('failed');
        return;
      }

      // Second attempt (retry)
      secondTokenUsed = retryToken;
      await route.continue();
    });

    // 2. Click submit -> triggers first attempt which gets network error
    await page.locator('button#submit-correct-btn').click();

    // 3. Client UI displays network error and suggests retry
    await expect(page.locator('[data-testid="correction-error-message"]')).toContainText(
      'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย ท่านสามารถกดบันทึกซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย'
    );

    // 4. Click submit again (manual UI retry)
    await page.locator('button#submit-correct-btn').click();

    // 5. Success is displayed on replay
    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );

    // Verify identical retry token was transmitted on retry
    expect(firstTokenUsed).toBeTruthy();
    expect(secondTokenUsed).toBe(firstTokenUsed);

    // 6. Verify in database: exactly ONE history record for CORRECTED
    const dbHistory = await pool.query(
      'SELECT * FROM asset_history WHERE asset_id = $1 AND action = $2',
      [testAssetId, 'CORRECTED']
    );
    expect(dbHistory.rows).toHaveLength(1);
    expect(dbHistory.rows[0].payload.reason).toBe('แก้ไขชื่อรุ่นให้ตรงกับฉลากสินค้า');
  });

  test('Journey 14: Refresh failure after correction discloses committed success + refresh failure, offering manual retry', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องตรวจวัดสภาพอากาศ', 'WEA-001', 'SN-WEA-001', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'เครื่องตรวจวัดสภาพอากาศ' })]
    );

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('เครื่องตรวจวัดสภาพอากาศ');

    let postSucceeded = false;
    let injectedRefetchError = false;

    await page.route(`**/assets/${testAssetId}`, async (route) => {
      if (route.request().method() === 'GET' && postSucceeded && !injectedRefetchError) {
        injectedRefetchError = true;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Simulated refetch network glitch' }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('#asset-correction-form input#name').fill('เครื่องตรวจวัดสภาพอากาศ IoT (รุ่นใหม่)');
    await page.locator('#asset-correction-form textarea#reason').fill('อัปเกรดชื่อรุ่น');

    // Submit form
    postSucceeded = true;
    await page.locator('button#submit-correct-btn').click();

    // Verify refresh error banner appears offering retry button
    await expect(page.locator('[data-testid="refresh-error-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="refresh-error-banner"]')).toContainText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ แต่การดึงข้อมูลล่าสุดล้มเหลว'
    );
    await expect(page.locator('button#retry-refresh-btn')).toBeVisible();

    // Click retry button -> second GET will not be intercepted with 500
    await page.locator('button#retry-refresh-btn').click();

    // Verify refresh succeeds and error banner clears
    await expect(page.locator('[data-testid="refresh-error-banner"]')).not.toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toHaveText('เครื่องตรวจวัดสภาพอากาศ IoT (รุ่นใหม่)');
  });

  test('Journey 15: Legitimate clearing of erroneous asset_number in UI without blanket prohibition', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'โต๊ะทำงานพับได้', 'WRONG-TAG-999', 'SN-DESK-01', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'โต๊ะทำงานพับได้' })]
    );

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    // Clear asset_number
    await page.locator('#asset-correction-form input#asset_number').fill('');
    await page.locator('#asset-correction-form textarea#reason').fill('ลบเลขครุภัณฑ์เนื่องจากบันทึกผิดพลาด แท้จริงไม่มีเลขติดครุภัณฑ์');

    await page.locator('button#submit-correct-btn').click();

    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );

    // Verify in database: asset_number is NULL
    const dbAsset = await pool.query('SELECT asset_number FROM assets WHERE id = $1', [testAssetId]);
    expect(dbAsset.rows[0].asset_number).toBeNull();
  });
});
