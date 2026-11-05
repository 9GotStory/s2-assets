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
import { AssetService } from '../../../api/src/services/asset.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';
import jsQR from 'jsqr';

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
        ('admin_e2e', '${passwordHash}', true),
        ('maintainer_e2e', '${passwordHash}', true)
      RETURNING id, username;
    `);

    custodianUserId = usersRes.rows.find((r) => r.username === 'custodian_e2e')!.id;
    readonlyUserId = usersRes.rows.find((r) => r.username === 'readonly_e2e')!.id;
    adminUserId = usersRes.rows.find((r) => r.username === 'admin_e2e')!.id;
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
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')`,
      [adminUserId]
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SYSTEM_MAINTAINER')`,
      [maintainerUserId]
    );

    // 5. Start Vite dev server proxying to Fastify using actual repository proxy config
    const testProxy: Record<string, any> = {};
    for (const [route, opts] of Object.entries(repositoryProxyConfig)) {
      testProxy[route] = {
        ...opts,
        target: `http://127.0.0.1:${fastifyPort}`,
      };
    }

    viteServer = await createServer({
      root: webRoot,
      configFile: path.resolve(webRoot, 'vite.config.ts'),
      server: {
        port: 0,
        strictPort: false,
        proxy: testProxy,
      },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    targetBaseUrl =
      typeof address === 'object' && address ? `http://localhost:${address.port}` : 'http://localhost:5173';
    (fastifyApp as any).publicAppOrigin = targetBaseUrl;
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

  // Switches the actor for a fresh page load. The API renews the session cookie on every response,
  // so a request still in flight from the previous actor's page can restore that actor's cookie
  // after addCookies; Journey 12 flaked that way. Leaving the page first settles those requests.
  // A switch under a mounted page, which the actor-switch journeys test, keeps using loginAs.
  const switchActor = async (page: any, context: any, userId: string) => {
    await page.goto('about:blank');
    await loginAs(page, context, userId);
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

  test('Journey 16: Immediate capability revocation during correction unmounts form and renders read-only notice while preserving history', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องสำรองไฟฟ้า APC', 'APC-2026-01', 'SN-APC-01', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'เครื่องสำรองไฟฟ้า APC' })]
    );

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('เครื่องสำรองไฟฟ้า APC');
    await expect(page.locator('#asset-correction-form')).toBeVisible();

    // Mock capability revocation: POST returns 403 Forbidden
    await page.route(`**/assets/${testAssetId}/correct`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 403,
          code: 'FORBIDDEN',
          error: 'FORBIDDEN',
          message: 'User does not possess required capability: asset:correct',
        }),
      });
    });

    await page.locator('#asset-correction-form input#name').fill('เครื่องสำรองไฟฟ้า APC Smart 1500');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขชื่อรุ่น');
    await page.locator('button#submit-correct-btn').click();

    // Verify form is immediately unmounted and read-only notice is displayed
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();
    await expect(page.locator('[data-testid="read-only-notice"]')).toBeVisible();
    await expect(page.locator('[data-testid="read-only-notice"]')).toContainText(
      'ผู้ใช้ปัจจุบันมีสิทธิ์อ่านอย่างเดียว ไม่สามารถแก้ไขข้อมูลครุภัณฑ์ได้'
    );

    // Verify history timeline remains visible and intact
    await expect(page.locator('#history-heading')).toBeVisible();
    await expect(page.locator('table')).toContainText('REGISTERED');
  });

  test('Journey 17: Candidate duplicate review supports pagination via load-more button', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องคอมพิวเตอร์ลูกข่าย', 'PC-CLIENT-00', 'SN-PC-00', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'เครื่องคอมพิวเตอร์ลูกข่าย' })]
    );

    // Seed 12 duplicate assets with asset_number DUP-PAGE-TAG
    for (let i = 1; i <= 12; i++) {
      const dupId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
        [dupId, `เครื่องคอมพิวเตอร์ชุดที่ ${i}`, 'DUP-PAGE-TAG', `SN-DUP-${i}`, custodianUserId]
      );
      await pool.query(
        `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
         VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
        [crypto.randomUUID(), dupId, custodianUserId, JSON.stringify({ name: `เครื่องคอมพิวเตอร์ชุดที่ ${i}` })]
      );
    }

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    // Fill duplicate asset_number
    await page.locator('#asset-correction-form input#asset_number').fill('DUP-PAGE-TAG');
    await page.locator('button#check-duplicate-btn').click();

    // Verify first page of 10 items shown out of 12
    const warningRegion = page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]');
    await expect(warningRegion).toBeVisible();
    await expect(warningRegion).toContainText('แสดง 10 จากทั้งหมด 12 รายการ');

    // Click load more
    const loadMoreBtn = page.locator('button#load-more-candidates-btn');
    await expect(loadMoreBtn).toBeVisible();
    await loadMoreBtn.click();

    // Verify all 12 items now shown and load-more button disappears
    await expect(warningRegion).toContainText('แสดง 12 จากทั้งหมด 12 รายการ');
    await expect(loadMoreBtn).not.toBeVisible();
  });

  test('Journey 18: Network failure enters immutable uncertain state freezing inputs and allowing retry via retry-uncertain button', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องปรับอากาศ Daikin', 'AC-DAIKIN-01', 'SN-AC-01', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'เครื่องปรับอากาศ Daikin' })]
    );

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    await page.locator('#asset-correction-form input#name').fill('เครื่องปรับอากาศ Daikin Inverter');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขข้อมูลเทคโนโลยี Inverter');

    let abortedFirstAttempt = false;
    let tokenAttempt1: string | null = null;
    let tokenAttempt2: string | null = null;

    await page.route(`**/assets/${testAssetId}/correct`, async (route) => {
      const headers = route.request().headers();
      if (!abortedFirstAttempt) {
        abortedFirstAttempt = true;
        tokenAttempt1 = headers['x-retry-token'];
        await route.abort('failed');
        return;
      }
      tokenAttempt2 = headers['x-retry-token'];
      await route.continue();
    });

    // Submit form -> network aborts
    await page.locator('button#submit-correct-btn').click();

    // Verify error banner appears with retry button
    const errorBanner = page.locator('[data-testid="correction-error-message"]');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(
      'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย ท่านสามารถกดบันทึกซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย'
    );
    const retryUncertainBtn = page.locator('button#retry-uncertain-btn');
    await expect(retryUncertainBtn).toBeVisible();

    // Verify inputs are frozen (disabled) during uncertain state
    await expect(page.locator('#asset-correction-form input#name')).toBeDisabled();
    await expect(page.locator('#asset-correction-form input#asset_number')).toBeDisabled();
    await expect(page.locator('#asset-correction-form input#serial_number')).toBeDisabled();
    await expect(page.locator('#asset-correction-form textarea#reason')).toBeDisabled();

    // Click retry-uncertain button
    await retryUncertainBtn.click();

    // Success displayed and same token transmitted
    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );
    expect(tokenAttempt1).toBeTruthy();
    expect(tokenAttempt2).toBe(tokenAttempt1);

    // Inputs are enabled again
    await expect(page.locator('#asset-correction-form input#name')).toBeEnabled();
  });

  test('Journey 19: Cache eviction and data suppression when asset access returns 403 Forbidden', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'อุปกรณ์รักษาความปลอดภัย Firewall', 'FW-001', 'SN-FW-001', custodianUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, custodianUserId, JSON.stringify({ name: 'อุปกรณ์รักษาความปลอดภัย Firewall' })]
    );

    // Mock GET /assets/:id as 403 Forbidden for API fetches
    await page.route(`**/assets/${testAssetId}`, async (route) => {
      const isHtmlNav =
        route.request().isNavigationRequest() ||
        route.request().headers()['accept']?.includes('text/html');

      if (isHtmlNav) {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 403,
          code: 'FORBIDDEN',
          error: 'FORBIDDEN',
          message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)',
        }),
      });
    });

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    // Verify error screen is rendered and asset details/form are suppressed
    await expect(page.locator('div[role="alert"]')).toContainText(
      'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)'
    );
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();
  });

  test('Journey 20: Session and role lifecycle transitions: correction-only revocation preserves read-only viewing; full revocation evicts protected cache', async ({
    page,
    context,
  }) => {
    // 1. Seed dedicated user with ADMINISTRATOR role
    const passwordHash = await UserService.hashPassword('Password123!');
    const userRes = await pool.query(
      `INSERT INTO users (username, password_hash, is_active) VALUES ('lifecycle_user_e2e', '${passwordHash}', true) RETURNING id;`
    );
    const userId = userRes.rows[0].id;
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')", [userId]);

    // 2. Create test asset
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องแม่ข่าย Lifecycle Server', 'SRV-LC-01', 'SN-LC-01', userId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, userId, JSON.stringify({ name: 'เครื่องแม่ข่าย Lifecycle Server' })]
    );

    // 3. Login as administrator and open asset detail page
    await loginAs(page, context, userId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    // Verify detail and correction form are visible
    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-correction-form')).toBeVisible();

    // 4. Downgrade user in PostgreSQL: remove ADMINISTRATOR, grant READ_ONLY (retains asset:view, loses asset:correct)
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')", [userId]);

    // 5. Fill out and submit correction form -> Fastify returns 403 Forbidden
    await page.locator('#asset-correction-form input#name').fill('เครื่องแม่ข่าย Downgraded Name');
    await page.locator('#asset-correction-form textarea#reason').fill('ทดสอบการเพิกถอนสิทธิ์');
    await page.locator('button#submit-correct-btn').click();

    // 6. Verify: correction form unmounts, read-only notice appears, but read-only detail remains visible because user still has asset:view
    await expect(page.locator('[data-testid="read-only-notice"]')).toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toContainText('เครื่องแม่ข่าย Lifecycle Server');

    // 7. Full view revocation: remove all roles in PostgreSQL
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);

    // 8. Trigger reload / revalidation
    await page.reload();

    // 9. Verify 403 Forbidden alert is rendered and no protected asset facts or history are exposed
    await expect(page.locator('div[role="alert"]')).toContainText(
      'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)'
    );
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    expect(await page.locator('text=เครื่องแม่ข่าย Lifecycle Server').count()).toBe(0);
  });

  test('Journey 21: Confirmed commit awaiting refresh (COMMITTED_AWAITING_REFRESH): blocks changed edit, releases on fresh refetch with single audit', async ({
    page,
    context,
  }) => {
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องสำรองไฟ UPS', 'UPS-001', 'SN-UPS-001', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, adminUserId, JSON.stringify({ name: 'เครื่องสำรองไฟ UPS' })]
    );

    await loginAs(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    // Intercept GET /assets/:id: fail refresh following correction mutation
    let failRefresh = false;

    await page.route(`**/assets/${testAssetId}`, async (route) => {
      const isHtmlNav =
        route.request().isNavigationRequest() ||
        route.request().headers()['accept']?.includes('text/html');

      if (isHtmlNav) {
        await route.continue();
        return;
      }

      if (failRefresh) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Simulated refresh network error' }),
        });
        return;
      }
      await route.continue();
    });

    // Fill form
    await page.locator('#asset-correction-form input#name').fill('เครื่องสำรองไฟ UPS True Online');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขประเภท UPS ให้ถูกต้อง');

    // Enable refresh failure
    failRefresh = true;

    // Submit form -> POST succeeds, but parent refetch fails
    await page.locator('button#submit-correct-btn').click();

    // Verify COMMITTED_AWAITING_REFRESH banner appears
    const committedBanner = page.locator('[data-testid="committed-awaiting-refresh-banner"]');
    await expect(committedBanner).toBeVisible();
    await expect(committedBanner).toContainText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ แต่การดึงข้อมูลล่าสุดล้มเหลว กรุณากดปุ่มเพื่อโหลดข้อมูลใหม่'
    );

    // Verify inputs and submit button are locked
    await expect(page.locator('#asset-correction-form input#name')).toBeDisabled();
    await expect(page.locator('#asset-correction-form input#asset_number')).toBeDisabled();
    await expect(page.locator('#asset-correction-form input#serial_number')).toBeDisabled();
    await expect(page.locator('#asset-correction-form textarea#reason')).toBeDisabled();
    await expect(page.locator('button#submit-correct-btn')).toBeDisabled();

    // Verify parent error alert with retry button is visible
    const retryRefreshBtn = page.locator('button#retry-refresh-btn');
    await expect(retryRefreshBtn).toBeVisible();

    // Allow refresh to succeed now
    failRefresh = false;

    // Click retry refresh button
    await retryRefreshBtn.click();

    // Form reconciles and unlocks with new baseline
    await expect(committedBanner).not.toBeVisible();
    await expect(page.locator('#asset-correction-form input#name')).toBeEnabled();
    await expect(page.locator('#asset-correction-form input#name')).toHaveValue('เครื่องสำรองไฟ UPS True Online');

    // Verify DB state: exactly 1 CORRECTED history row
    const histRes = await pool.query(
      "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
      [testAssetId]
    );
    expect(histRes.rows[0].count).toBe(1);
  });

  test('Journey 22: POST warning pagination 50→60: advances correctly from automatic warning without gaps or overlaps (with unchanged identifier and inverse fixtures)', async ({
    page,
    context,
  }) => {
    // 1. Create primary target asset
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'ครุภัณฑ์หลักสำหรับทดสอบ Warning Pagination', 'ORIGINAL-PAG-00', 'SN-ORIG-00', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, adminUserId, JSON.stringify({ name: 'ครุภัณฑ์หลัก' })]
    );

    // 1b. Extra asset sharing unchanged serial_number 'SN-ORIG-00'
    const extraAssetId1 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [extraAssetId1, 'ครุภัณฑ์เลขซีเรียลเดียวกันแต่เลขครุภัณฑ์ต่าง', 'OTHER-ASSET-01', 'SN-ORIG-00', adminUserId]
    );

    // 2. Insert 60 conflicting assets with the same asset_number 'PAG-DUP-60'
    const batchValues: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const pad = String(i).padStart(2, '0');
      const cid = crypto.randomUUID();
      batchValues.push(
        `('${cid}', 'เครื่องคอมพิวเตอร์ทดสอบ ${pad}', 'PAG-DUP-60', 'SN-DUP-${pad}', '${adminUserId}', now(), now(), now())`
      );
    }
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ${batchValues.join(',\n')}`
    );

    // 3. Login and navigate to target asset
    await loginAs(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);

    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    // 4. Directly enter duplicate asset_number and submit WITHOUT clicking preview
    await page.locator('#asset-correction-form input#asset_number').fill('PAG-DUP-60');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขเลขครุภัณฑ์ชนกัน 60 รายการ');

    await page.locator('button#submit-correct-btn').click();

    // 5. Verify automatic POST 409 warning renders 50 items and load more button (excluding extra asset on unchanged serial)
    const warningRegion = page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]');
    await expect(warningRegion).toBeVisible();
    await expect(warningRegion).toContainText('แสดง 50 จากทั้งหมด 60 รายการ');

    const loadMoreBtn = page.locator('button#load-more-candidates-btn');
    await expect(loadMoreBtn).toBeVisible();

    // Count rows before load more: 50 rows in tbody
    const rowsBefore = await warningRegion.locator('tbody tr').count();
    expect(rowsBefore).toBe(50);

    // 6. Click load more button -> advances offset from 50
    await loadMoreBtn.click();

    // 7. Verify all 60 items are now displayed without gaps or overlaps
    await expect(warningRegion).toContainText('แสดง 60 จากทั้งหมด 60 รายการ');
    const rowsAfter = await warningRegion.locator('tbody tr').count();
    expect(rowsAfter).toBe(60);
    await expect(loadMoreBtn).not.toBeVisible();

    // 8. Confirm acknowledgement checkbox and submit
    await page.locator('#asset-correction-form input#explicit_continuation').check();
    await page.locator('button#submit-correct-btn').click();

    // 9. Success!
    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );

    // 10. Inverse fixture: unchanged asset_number, changed serial_number 50→60
    const invAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [invAssetId, 'ครุภัณฑ์หลักสำหรับทดสอบ Inverse Pagination', 'ORIGINAL-INV-00', 'SN-ORIG-INV', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), invAssetId, adminUserId, JSON.stringify({ name: 'ครุภัณฑ์ผกผัน' })]
    );

    // Extra asset sharing unchanged asset_number 'ORIGINAL-INV-00'
    const extraAssetId2 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [extraAssetId2, 'ครุภัณฑ์เลขครุภัณฑ์เดียวกันแต่เลขซีเรียลต่าง', 'ORIGINAL-INV-00', 'SN-OTHER-99', adminUserId]
    );

    // Insert 60 conflicting assets with the same serial_number 'SN-DUP-INV-60'
    const invBatchValues: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const pad = String(i).padStart(2, '0');
      const cid = crypto.randomUUID();
      invBatchValues.push(
        `('${cid}', 'อุปกรณ์เครือข่ายผกผัน ${pad}', 'PAG-INV-${pad}', 'SN-DUP-INV-60', '${adminUserId}', now(), now(), now())`
      );
    }
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ${invBatchValues.join(',\n')}`
    );

    await page.goto(`${targetBaseUrl}/assets/${invAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    // Edit ONLY serial_number to 'SN-DUP-INV-60' (asset_number stays unchanged)
    await page.locator('#asset-correction-form input#serial_number').fill('SN-DUP-INV-60');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขซีเรียลผกผัน 60 รายการ');
    await page.locator('button#submit-correct-btn').click();

    // Verify automatic POST 409 warning renders 50 items and load more button (excluding extra asset on unchanged asset_number)
    const invWarningRegion = page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]');
    await expect(invWarningRegion).toBeVisible();
    await expect(invWarningRegion).toContainText('แสดง 50 จากทั้งหมด 60 รายการ');

    const invLoadMoreBtn = page.locator('button#load-more-candidates-btn');
    await expect(invLoadMoreBtn).toBeVisible();
    expect(await invWarningRegion.locator('tbody tr').count()).toBe(50);

    // Click load more button -> advances offset from 50
    await invLoadMoreBtn.click();

    // Verify all 60 items are now displayed without gaps or overlaps
    await expect(invWarningRegion).toContainText('แสดง 60 จากทั้งหมด 60 รายการ');
    expect(await invWarningRegion.locator('tbody tr').count()).toBe(60);
    await expect(invLoadMoreBtn).not.toBeVisible();

    // Confirm acknowledgement checkbox and submit
    await page.locator('#asset-correction-form input#explicit_continuation').check();
    await page.locator('button#submit-correct-btn').click();

    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );

    // 11. Inconsistent continuation / empty page test
    const stallAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [stallAssetId, 'ครุภัณฑ์ทดสอบ Continuation Stall', 'ORIG-STALL-00', 'SN-STALL-00', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), stallAssetId, adminUserId, JSON.stringify({ name: 'ครุภัณฑ์ทดสอบ Stall' })]
    );

    const stallBatch: string[] = [];
    for (let i = 1; i <= 55; i++) {
      const pad = String(i).padStart(2, '0');
      stallBatch.push(
        `('${crypto.randomUUID()}', 'เครื่องทดสอบ Stall ${pad}', 'STALL-DUP-55', 'SN-STALL-${pad}', '${adminUserId}', now(), now(), now())`
      );
    }
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ${stallBatch.join(',\n')}`
    );

    await page.goto(`${targetBaseUrl}/assets/${stallAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    await page.locator('#asset-correction-form input#asset_number').fill('STALL-DUP-55');
    await page.locator('#asset-correction-form textarea#reason').fill('ทดสอบ empty continuation page');
    await page.locator('button#submit-correct-btn').click();

    const stallWarningRegion = page.locator('div[role="region"][aria-label="การแจ้งเตือนข้อมูลซ้ำ"]');
    await expect(stallWarningRegion).toBeVisible();
    await expect(stallWarningRegion).toContainText('แสดง 50 จากทั้งหมด 55 รายการ');

    let returnEmptyContinuation = true;
    await page.route(`**/assets/${stallAssetId}/duplicate-candidates*`, async (route) => {
      const url = route.request().url();
      if (returnEmptyContinuation && url.includes('offset=50')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: [],
            total_count: 55,
            has_more: false,
            limit: 10,
            offset: 50,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('button#load-more-candidates-btn').click();

    const errorBanner = page.locator('[data-testid="duplicate-pagination-error"]');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText('ไม่พบข้อมูลรายการซ้ำเพิ่มเติมจากเซิร์ฟเวอร์');
    const retryLoadMoreBtn = page.locator('button#retry-load-more-btn');
    await expect(retryLoadMoreBtn).toBeVisible();

    returnEmptyContinuation = false;
    await retryLoadMoreBtn.click();

    await expect(errorBanner).not.toBeVisible();
    await expect(stallWarningRegion).toContainText('แสดง 55 จากทั้งหมด 55 รายการ');
    expect(await stallWarningRegion.locator('tbody tr').count()).toBe(55);
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
    await switchActor(page, context, readonlyUserId);
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
    await expect(page.locator('tbody tr')).not.toHaveCount(1);
    expect(await page.locator('tbody tr').count()).toBeGreaterThanOrEqual(7);
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

  test('Journey 23 (F-01): dirty edit + competing committed correction without manual refresh fails closed with stale 409 conflict, preserves dirty inputs on read failure, and reconciles baseline on authoritative read', async ({
    page,
    context,
  }) => {
    // 1. Seed base asset
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องแม่ข่ายเซิร์ฟเวอร์ก่อนแก้ไข', 'SRV-ORIG-999', 'SN-ORIG-999', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, adminUserId, JSON.stringify({ name: 'เครื่องแม่ข่ายเซิร์ฟเวอร์ก่อนแก้ไข' })]
    );

    // 2. Login as admin and navigate to asset detail
    await loginAs(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('เครื่องแม่ข่ายเซิร์ฟเวอร์ก่อนแก้ไข');

    // 3. User begins editing the form (making it dirty)
    await page.locator('#asset-correction-form input#name').fill('ชื่อใหม่โดยผู้ใช้คนแรก (Dirty Edit)');
    await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขข้อมูลพัสดุ');

    // 4. Competitor in background commits a conflicting update via production AssetService
    const competitorRetryToken = crypto.randomUUID();
    const assetService = new AssetService({ db: pool });
    await assetService.correctAsset(
      custodianUserId,
      testAssetId,
      {
        name: 'ชื่อที่แก้ไขโดยผู้แข่งขัน (Competitor Win)',
        asset_number: 'SRV-ORIG-999',
        serial_number: 'SN-ORIG-999',
        expected_name: 'เครื่องแม่ข่ายเซิร์ฟเวอร์ก่อนแก้ไข',
        expected_asset_number: 'SRV-ORIG-999',
        expected_serial_number: 'SN-ORIG-999',
        reason: 'Competitor committed change',
      },
      { retryToken: competitorRetryToken }
    );

    // 5. NO preparatory manual refresh! User directly submits dirty form
    const staleReqPromise = page.waitForRequest(
      (req) => req.url().includes(`/assets/${testAssetId}/correct`) && req.method() === 'POST'
    );
    await page.locator('button#submit-correct-btn').click();
    const staleReq = await staleReqPromise;
    const staleRetryToken =
      staleReq.postDataJSON()?.retry_token || staleReq.headers()['x-retry-token'];
    expect(staleRetryToken).toBeTruthy();

    // 6. Verify stale 409 conflict is displayed with stale reload button
    const errorRegion = page.locator('[data-testid="correction-error-message"]');
    await expect(errorRegion).toBeVisible();
    await expect(errorRegion).toContainText('409 Conflict');
    await expect(errorRegion).toContainText('ข้อมูลครุภัณฑ์ถูกแก้ไขโดยผู้อื่นแล้ว');

    const staleReloadBtn = page.locator('button#stale-reload-btn');
    await expect(staleReloadBtn).toBeVisible();

    // 7. Authoritative read failure: preserve dirty intent, do not rebase baseline, report error
    let failRead = true;
    await page.route(`**/assets/${testAssetId}`, async (route) => {
      const isHtmlNav =
        route.request().isNavigationRequest() ||
        route.request().headers()['accept']?.includes('text/html');

      if (isHtmlNav) {
        await route.continue();
        return;
      }

      if (failRead) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Internal Server Error' }),
        });
        return;
      }

      await route.continue();
    });

    await staleReloadBtn.click();

    // Verify error message indicates read failure and dirty input is preserved!
    await expect(errorRegion).toContainText('ไม่สามารถดึงข้อมูลล่าสุดได้ กรุณาลองใหม่อีกครั้ง');
    await expect(page.locator('#asset-correction-form input#name')).toHaveValue(
      'ชื่อใหม่โดยผู้ใช้คนแรก (Dirty Edit)'
    );

    // 8. Unmock route: authoritative read succeeds, adopts competitor baseline and reconciles form
    failRead = false;
    await staleReloadBtn.click();

    // Form reconciles with latest baseline without re-submitting stale data
    await expect(errorRegion).not.toBeVisible();
    await expect(page.locator('#asset-correction-form input#name')).toHaveValue(
      'ชื่อที่แก้ไขโดยผู้แข่งขัน (Competitor Win)'
    );

    // 9. Competitor's data in database is retained, and no losing audit entry is created
    const dbAsset = await pool.query('SELECT name FROM assets WHERE id = $1', [testAssetId]);
    expect(dbAsset.rows[0].name).toBe('ชื่อที่แก้ไขโดยผู้แข่งขัน (Competitor Win)');

    const histCount = await pool.query(
      "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
      [testAssetId]
    );
    expect(histCount.rows[0].count).toBe(1); // Only competitor's 1 CORRECTED row

    // F-01: Direct scoped query on registration_retry_tokens confirming zero losing retry ledger writes
    const exactOp = `asset:correct:${testAssetId}`;
    const losingTokenRes = await pool.query(
      'SELECT count(*)::int as count FROM registration_retry_tokens WHERE actor_id = $1 AND operation = $2 AND token = $3',
      [adminUserId, exactOp, staleRetryToken]
    );
    expect(losingTokenRes.rows[0].count).toBe(0); // Zero losing retry-ledger writes for stale request

    // Positive control: identical scoped query finds competitor's successfully committed correction token
    const committedTokenRes = await pool.query(
      'SELECT count(*)::int as count, response_status FROM registration_retry_tokens WHERE actor_id = $1 AND operation = $2 AND token = $3 GROUP BY response_status',
      [custodianUserId, exactOp, competitorRetryToken]
    );
    expect(committedTokenRes.rows[0].count).toBe(1);
    expect(committedTokenRes.rows[0].response_status).toBe(200);
  });

  test('Journey 24 (F-03): no-op 200 followed by refresh failure and identical authorized GET unlocks the form with zero no-op writes and zero recovery POST', async ({
    page,
    context,
  }) => {
    // 1. Seed base asset
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องสำรองไฟ UPS คงเดิม', 'UPS-NOOP-001', 'SN-NOOP-001', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, adminUserId, JSON.stringify({ name: 'เครื่องสำรองไฟ UPS คงเดิม' })]
    );

    // 2. Login as admin and navigate to asset detail
    await loginAs(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    // 3. Set up route interception: let POST /correct return 200 (no-op), but fail the subsequent GET /assets/:id refresh
    let failRefresh = false;
    let postCallCount = 0;

    await page.route(`**/assets/${testAssetId}/correct`, async (route) => {
      postCallCount++;
      await route.continue();
    });

    await page.route(`**/assets/${testAssetId}`, async (route) => {
      const isHtmlNav =
        route.request().isNavigationRequest() ||
        route.request().headers()['accept']?.includes('text/html');

      if (isHtmlNav) {
        await route.continue();
        return;
      }

      if (failRefresh) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Simulated refresh network error' }),
        });
        return;
      }

      await route.continue();
    });

    // 4. Submit form without changing any identifiers or name (pure no-op)
    failRefresh = true;
    await page.locator('button#submit-correct-btn').click();

    // 5. Verify form locks in COMMITTED_AWAITING_REFRESH
    const committedBanner = page.locator('[data-testid="committed-awaiting-refresh-banner"]');
    await expect(committedBanner).toBeVisible();
    await expect(page.locator('button#submit-correct-btn')).toBeDisabled();
    expect(postCallCount).toBe(1);

    // 6. DB check: zero CORRECTED history rows written for no-op
    const noopHist = await pool.query(
      "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
      [testAssetId]
    );
    expect(noopHist.rows[0].count).toBe(0);

    // 7. Allow refresh now and click retry refresh button
    failRefresh = false;
    const retryRefreshBtn = page.locator('button#retry-refresh-btn');
    await expect(retryRefreshBtn).toBeVisible();
    await retryRefreshBtn.click();

    // 8. Form reconciles on identical authorized read and unlocks!
    await expect(committedBanner).not.toBeVisible();
    await expect(page.locator('button#submit-correct-btn')).toBeEnabled();

    // 9. Valid next correction creates exactly one audit and one retry token
    await page.locator('#asset-correction-form input#name').fill('เครื่องสำรองไฟ UPS รุ่นใหม่');
    await page.locator('#asset-correction-form textarea#reason').fill('อัปเกรดรุ่น UPS');
    await page.locator('button#submit-correct-btn').click();

    await expect(page.locator('[data-testid="correction-success-message"]')).toHaveText(
      'บันทึกการแก้ไขครุภัณฑ์สำเร็จ'
    );
    expect(postCallCount).toBe(2); // Only the initial no-op and this valid correction, zero recovery POST!

    const validHist = await pool.query(
      "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
      [testAssetId]
    );
    expect(validHist.rows[0].count).toBe(1); // Exactly one audit record
  });

  test('Journey 25 (F-02): observed 401 and 403 suppress protected detail, deterministic supersession guards fail-closed against denied/permitted outcomes', async ({
    page,
    context,
  }) => {
    // Helper to create a deferred promise for deterministic request coordination
    const createDeferred = () => {
      let resolve!: () => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    // 1. Seed base asset
    const testAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [testAssetId, 'เครื่องสแกนบาร์โค้ด Auth Test', 'SCAN-AUTH-001', 'SN-AUTH-001', adminUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), testAssetId, adminUserId, JSON.stringify({ name: 'เครื่องสแกนบาร์โค้ด' })]
    );

    // 2. Login as admin and navigate to asset detail
    await loginAs(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    // Part A: Duplicate preview 401 immediately triggers auth loss redirect
    await page.route(`**/assets/${testAssetId}/duplicate-candidates*`, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Session expired' }),
      });
    });

    // Trigger duplicate preview check by changing asset_number
    await page.locator('#asset-correction-form input#asset_number').fill('SCAN-AUTH-002');
    await page.locator('button#check-duplicate-btn').click();

    // Form immediately handles 401 auth loss and redirects to /login!
    await page.waitForURL('**/login', { timeout: 10_000 });
    expect(page.url()).toContain('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // Part B: Duplicate preview 403 suppresses form and triggers reauthorization
    await switchActor(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    await page.route(`**/assets/${testAssetId}/duplicate-candidates*`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Forbidden' }),
      });
    });

    await page.locator('#asset-correction-form input#asset_number').fill('SCAN-AUTH-003');
    await page.locator('button#check-duplicate-btn').click();

    // Form suppresses correction form and displays read-only notice
    await expect(page.locator('[data-testid="read-only-notice"]')).toBeVisible();

    // Part C: Mutation 401 immediately redirects without entering uncertain retry
    await switchActor(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    await page.route(`**/assets/${testAssetId}/correct`, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Session expired' }),
      });
    });

    await page.locator('#asset-correction-form input#name').fill('ชื่อใหม่ไม่ผ่าน 401');
    await page.locator('#asset-correction-form textarea#reason').fill('เหตุผลทดสอบ 401');
    await page.locator('button#submit-correct-btn').click();

    // Must NOT enter uncertain retry state! Must redirect to /login!
    await page.waitForURL('**/login', { timeout: 10_000 });
    expect(page.url()).toContain('/login');
    await expect(page.locator('button#retry-uncertain-btn')).not.toBeVisible();

    // Part D: Mutation 403 immediately suppresses form without entering uncertain retry
    await switchActor(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    await page.route(`**/assets/${testAssetId}/correct`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Forbidden' }),
      });
    });

    await page.locator('#asset-correction-form input#name').fill('ชื่อใหม่ไม่ผ่าน 403');
    await page.locator('#asset-correction-form textarea#reason').fill('เหตุผลทดสอบ 403');
    await page.locator('button#submit-correct-btn').click();

    // 403 suppresses form and replaces it with read-only notice without uncertain retry button!
    await expect(page.locator('[data-testid="read-only-notice"]')).toBeVisible();
    await expect(page.locator('button#retry-uncertain-btn')).not.toBeVisible();

    // Part E: Deterministic RED->GREEN test: Held reauthorization superseded by focus -> DENIED outcome
    // Dedicated user for denial test
    const deniedUserRes = await pool.query(
      `INSERT INTO users (username, password_hash, is_active)
       VALUES ('denied_actor_${crypto.randomUUID().slice(0, 8)}', '${await UserService.hashPassword('Pass123!')}', true)
       RETURNING id;`
    );
    const deniedUserId = deniedUserRes.rows[0].id;
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')", [deniedUserId]);

    const deniedAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [deniedAssetId, 'เครื่องแม่ข่ายทดสอบ Supersession Denied', 'DENIED-001', 'SN-DENIED-001', deniedUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), deniedAssetId, deniedUserId, JSON.stringify({ name: 'เครื่องแม่ข่ายทดสอบ Denied' })]
    );

    await switchActor(page, context, deniedUserId);
    await page.goto(`${targetBaseUrl}/assets/${deniedAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-correction-form')).toBeVisible();

    // Now remove ALL roles in PostgreSQL so subsequent GET /assets/:id returns 403
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [deniedUserId]);

    const reauth1Started = createDeferred();
    const reauth1Release = createDeferred();
    const focus2Started = createDeferred();
    const focus2Release = createDeferred();
    let sessionCallSeq = 0;

    await page.route('**/auth/session-check', async (route) => {
      sessionCallSeq++;
      if (sessionCallSeq === 1) {
        reauth1Started.resolve();
        await reauth1Release.promise;
        await route.continue();
        return;
      }
      if (sessionCallSeq === 2) {
        focus2Started.resolve();
        await focus2Release.promise;
        await route.continue();
        return;
      }
      await route.continue();
    });

    // Trigger reauthorization by submitting correction (fails with real 403 on server)
    await page.locator('#asset-correction-form input#name').fill('ชื่อแก้ไขที่ถูกปฏิเสธ');
    await page.locator('#asset-correction-form textarea#reason').fill('เหตุผลทดสอบ');
    await page.locator('button#submit-correct-btn').click();

    // Wait for Reauthorization #1's session-check to start and hold it
    await reauth1Started.promise;

    // Verify protected detail is immediately suppressed while awaiting authorization
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();

    // Dispatch focus event while session-check #1 is held
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    // Wait for Focus session-check #2 to start and hold it
    await focus2Started.promise;

    // Release session-check #1 (which was superseded / aborted by session-check #2)
    reauth1Release.resolve();

    // CRITICAL ASSERTION: Protected data MUST REMAIN HIDDEN even after session-check #1 is released/aborted!
    // In unpatched code, releasing check 1 improperly dropped isReauthorizing to false, exposing protected data!
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();
    await expect(page.locator('[role="status"]')).toBeVisible();

    // Now release focus session-check #2 (the surviving owner)
    focus2Release.resolve();

    // Check #2 completes -> triggers refetch() for asset:view -> returns 403 Forbidden
    // Terminal 403 alert must appear and protected facts must NEVER be exposed
    await expect(page.locator('div[role="alert"]')).toContainText(
      'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)'
    );
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    expect(await page.locator('text=เครื่องแม่ข่ายทดสอบ Supersession Denied').count()).toBe(0);

    // Part F: Deterministic test: Held reauthorization superseded by focus -> PERMITTED outcome
    const permUserRes = await pool.query(
      `INSERT INTO users (username, password_hash, is_active)
       VALUES ('perm_actor_${crypto.randomUUID().slice(0, 8)}', '${await UserService.hashPassword('Pass123!')}', true)
       RETURNING id;`
    );
    const permUserId = permUserRes.rows[0].id;
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')", [permUserId]);

    const permAssetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [permAssetId, 'เครื่องแม่ข่ายทดสอบ Supersession Permitted', 'PERM-001', 'SN-PERM-001', permUserId]
    );
    await pool.query(
      `INSERT INTO asset_history (id, asset_id, action, actor_id, payload, recorded_at, created_at)
       VALUES ($1, $2, 'REGISTERED', $3, $4, now(), now())`,
      [crypto.randomUUID(), permAssetId, permUserId, JSON.stringify({ name: 'เครื่องแม่ข่ายทดสอบ Permitted' })]
    );

    await switchActor(page, context, permUserId);
    await page.goto(`${targetBaseUrl}/assets/${permAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-correction-form')).toBeVisible();

    // Downgrade user in PostgreSQL to READ_ONLY (retains asset:view, loses asset:correct)
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [permUserId]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')", [permUserId]);

    const perm1Started = createDeferred();
    const perm1Release = createDeferred();
    const perm2Started = createDeferred();
    const perm2Release = createDeferred();
    let permCallSeq = 0;

    await page.route('**/auth/session-check', async (route) => {
      permCallSeq++;
      if (permCallSeq === 1) {
        perm1Started.resolve();
        await perm1Release.promise;
        await route.continue();
        return;
      }
      if (permCallSeq === 2) {
        perm2Started.resolve();
        await perm2Release.promise;
        await route.continue();
        return;
      }
      await route.continue();
    });

    // Submit correction -> returns real 403 on server (since user is READ_ONLY)
    await page.locator('#asset-correction-form input#name').fill('ชื่อใหม่ไม่ผ่านสิทธิ์แก้ไข');
    await page.locator('#asset-correction-form textarea#reason').fill('เหตุผลทดสอบ');
    await page.locator('button#submit-correct-btn').click();

    // Wait for session-check #1 to start and hold it
    await perm1Started.promise;

    // Verify protected detail is immediately suppressed while awaiting authorization
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();

    // Dispatch focus event
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    // Wait for focus session-check #2 to start and hold it
    await perm2Started.promise;

    // Release session-check #1
    perm1Release.resolve();

    // Protected detail MUST REMAIN HIDDEN while check #2 is unverified
    await expect(page.locator('#asset-detail-heading')).not.toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();

    // Release session-check #2 (surviving owner)
    perm2Release.resolve();

    // Check #2 completes -> refetch() succeeds with 200 (since user has READ_ONLY role)
    // Read-only detail view reappears with read-only notice!
    await expect(page.locator('[data-testid="read-only-notice"]')).toBeVisible();
    await expect(page.locator('#asset-correction-form')).not.toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toContainText(
      'เครื่องแม่ข่ายทดสอบ Supersession Permitted'
    );

    // Part G: Mounted AssetDetailContent held session-check released after navigation does not redirect to /login
    // Uses explicit request-start/release/completion coordination instead of arbitrary sleep
    await switchActor(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/assets/${testAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    const navSessionStarted = createDeferred();
    const navSessionRelease = createDeferred();
    const navSessionCompleted = createDeferred();
    let navHoldFirst = true;

    await page.route('**/auth/session-check', async (route) => {
      if (navHoldFirst) {
        navHoldFirst = false;
        navSessionStarted.resolve();
        await navSessionRelease.promise;
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Delayed session expiration' }),
        });
        navSessionCompleted.resolve();
        return;
      }
      await route.continue();
    });

    // Trigger session check via window focus event while on AssetDetail
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    // Explicitly await browser sending the request before navigation
    await navSessionStarted.promise;

    // Navigate to /dashboard while session check is held
    await page.locator('#nav-dashboard-link').click();
    await page.waitForURL(`${targetBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();

    // Explicitly release the held session check (which returns 401)
    navSessionRelease.resolve();

    // Deterministically await completion of the held session check request
    await navSessionCompleted.promise;

    expect(page.url()).toBe(`${targetBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).not.toBeVisible();

    await page.unroute('**/auth/session-check');
  });

  test('T8 Seam B: Explicit QR generation, canvas extraction, jsQR decoding, single-page print layout, T2 correction re-fetch, pre-print revocation suppression, and zero business mutations', async ({
    page,
    context,
  }) => {
    // 1. Initial Ledger & Snapshot Helper
    const countQuery = async () => {
      const assetsCount = await pool.query('SELECT COUNT(*) FROM assets');
      const historyCount = await pool.query('SELECT COUNT(*) FROM asset_history');
      const retryCount = await pool.query('SELECT COUNT(*) FROM registration_retry_tokens');
      return {
        assets: Number(assetsCount.rows[0].count),
        history: Number(historyCount.rows[0].count),
        retry: Number(retryCount.rows[0].count),
      };
    };

    const getAssetSnapshot = async (id: string) => {
      const res = await pool.query('SELECT * FROM assets WHERE id = $1', [id]);
      return res.rows[0];
    };

    // 2. Seed a test asset in the database with long Thai name and missing serial_number (NULL)
    const insertRes = await pool.query(
      `INSERT INTO assets (
        name, asset_number, serial_number, registered_by, category
      ) VALUES (
        'จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (พัสดุและงานเทคนิคกลาง)', 'MON-DELL-QR-888', NULL, $1, NULL
      ) RETURNING id;`,
      [custodianUserId]
    );
    const qrAssetId = insertRes.rows[0].id;

    // 3. Login as Custodian and navigate to AssetDetail
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${qrAssetId}`);

    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toContainText(
      'จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (พัสดุและงานเทคนิคกลาง)'
    );

    // 4. Assert explicit generation requirement (card is NOT fetched automatically on mount)
    await expect(page.locator('[data-testid="asset-qr-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="generate-qr-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeHidden();

    // Click explicit generate action
    await page.locator('[data-testid="generate-qr-btn"]').click();
    await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeVisible();

    // Assert truthful identifiers: long Thai text, exact UUID, and missing identifier displays 'ไม่ระบุในทะเบียน' (never '-')
    await expect(page.locator('[data-testid="asset-qr-name"]')).toContainText(
      'จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (พัสดุและงานเทคนิคกลาง)'
    );
    await expect(page.locator('[data-testid="asset-qr-number"]')).toContainText(
      'MON-DELL-QR-888'
    );
    await expect(page.locator('[data-testid="asset-qr-serial"]')).toContainText(
      'ไม่ระบุในทะเบียน'
    );
    await expect(page.locator('[data-testid="asset-qr-uuid"]')).toContainText(qrAssetId);
    await expect(page.locator('[data-testid="asset-qr-locator"]')).toContainText(
      `${targetBaseUrl}/assets/${qrAssetId}`
    );

    // 5. Extract SVG pixel data from browser DOM onto canvas and decode with jsQR
    await expect(page.locator('[data-testid="asset-qr-svg"]')).toBeVisible();

    const qrPixels = await page.evaluate(async () => {
      const svg = document.querySelector('[data-testid="asset-qr-code-wrapper"] svg');
      if (!svg) return null;
      const svgXml = new XMLSerializer().serializeToString(svg);
      const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgXml);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = svgDataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width || 128;
      canvas.height = img.height || 128;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height: canvas.height,
        data: Array.from(imageData.data),
      };
    });

    expect(qrPixels).not.toBeNull();
    const uint8Clamped = new Uint8ClampedArray(qrPixels!.data);
    const decoded = jsQR(uint8Clamped, qrPixels!.width, qrPixels!.height);

    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(`${targetBaseUrl}/assets/${qrAssetId}`);

    // 6. Visual Artifact Capture: Take screenshot of the rendered printable QR card
    const screenshotBuffer = await page.locator('[data-testid="asset-qr-label-card"]').screenshot();
    expect(screenshotBuffer).toBeDefined();
    expect(screenshotBuffer.byteLength).toBeGreaterThan(1000);

    // 7. Minimal single-label print view validation (scoped under body.t8-print-active)
    await page.evaluate(() => document.body.classList.add('t8-print-active'));
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="print-qr-label-btn"]')).toBeHidden();
    await expect(page.locator('[data-testid="generate-qr-btn"]')).toBeHidden();
    await expect(page.locator('[data-testid="asset-qr-locator"]')).toBeHidden();
    await expect(page.locator('#nav-dashboard-link')).toBeHidden();

    // Verify print layout gives details column usable width and UUID fits on single line
    const detailsBox = await page.locator('.asset-qr-details').boundingBox();
    expect(detailsBox).not.toBeNull();
    expect(detailsBox!.width).toBeGreaterThan(180);

    const uuidBox = await page.locator('[data-testid="asset-qr-uuid"] .mono').boundingBox();
    expect(uuidBox).not.toBeNull();
    expect(uuidBox!.height).toBeLessThan(25); // Unbroken single line height

    // Save and verify actual A4 PDF generates EXACTLY 1 page (no blank 2nd page)
    const pdfBuffer = await page.pdf({ format: 'A4' });
    expect(pdfBuffer).toBeDefined();
    expect(pdfBuffer.byteLength).toBeGreaterThan(1000);
    const pdfStr = pdfBuffer.toString('latin1');
    const pageMatches = pdfStr.match(/\/Type\s*\/Page[^s]/g);
    const pageCount = pageMatches ? pageMatches.length : 0;
    expect(pageCount).toBe(1);

    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => document.body.classList.remove('t8-print-active'));

    // 8. Test authoritative pre-print fetch and window.print invocation
    await page.evaluate(() => {
      (window as any).__printed = false;
      window.print = () => {
        (window as any).__printed = true;
      };
    });

    await page.locator('[data-testid="print-qr-label-btn"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBe(true);

    // 9. Real T2 Metadata Correction Mutation & Retirement of Older Pending Pre-Print Response:
    // User clicks print with old facts; hold the pre-print fetch in route intercept
    await page.evaluate(() => {
      (window as any).__printNames = [];
      (window as any).__qrSettled = false;
      window.print = () => {
        (window as any).__printNames.push(
          document.querySelector('[data-testid="asset-qr-name"]')?.textContent
        );
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        try {
          return await originalFetch(...args);
        } finally {
          if (String(args[0]).endsWith('/qr-label')) {
            (window as any).__qrSettled = true;
          }
        }
      };
    });

    let startPrePrint!: () => void;
    let releasePrePrint!: () => void;
    let completePrePrint!: () => void;
    const prePrintStarted = new Promise<void>((r) => (startPrePrint = r));
    const prePrintReleased = new Promise<void>((r) => (releasePrePrint = r));
    const prePrintCompleted = new Promise<void>((r) => (completePrePrint = r));

    await page.route(`**/assets/${qrAssetId}/qr-label`, async (route) => {
      const response = await route.fetch();
      startPrePrint();
      await prePrintReleased;
      await route.fulfill({ response }).catch(() => {});
      completePrePrint();
    });

    try {
      // Trigger pre-print fetch and wait until it is in-flight
      await page.locator('[data-testid="print-qr-label-btn"]').click();
      await prePrintStarted;

      // Perform a real T2 correction on the asset while the pre-print response is held
      await expect(page.locator('#asset-correction-form')).toBeVisible();
      await page.locator('#asset-correction-form input#name').fill('จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (แก้ไข)');
      await page.locator('#asset-correction-form input#asset_number').fill('MON-DELL-QR-888-CORRECTED');
      await page.locator('#asset-correction-form input#serial_number').fill('SN-DELL-QR-888-CORRECTED');
      await page.locator('#asset-correction-form textarea#reason').fill('แก้ไขข้อมูลตามรายงานตรวจนับพัสดุ');
      await page.locator('#asset-correction-form button[type="submit"]').click();

      await expect(page.locator('[data-testid="correction-success-message"]')).toBeVisible();
      await expect(page.locator('#asset-detail-heading')).toContainText('จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (แก้ไข)');

      // Release the held pre-print response that carried old facts
      releasePrePrint();
      await prePrintCompleted;
      await expect.poll(() => page.evaluate(() => (window as any).__qrSettled)).toBe(true);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

      // Obsolete pre-print response must NOT print old facts or restore card
      const printNames = await page.evaluate(() => (window as any).__printNames);
      expect(printNames, 'The old QR response must not print after an acknowledged correction').toEqual([]);
      await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeHidden();
    } finally {
      releasePrePrint();
      await page.unroute(`**/assets/${qrAssetId}/qr-label`);
    }

    // Re-generate QR label; assert fresh facts are committed to the DOM
    await page.locator('[data-testid="generate-qr-btn"]').click();
    await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeVisible();

    await expect(page.locator('[data-testid="asset-qr-name"]')).toContainText(
      'จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (แก้ไข)'
    );
    await expect(page.locator('[data-testid="asset-qr-number"]')).toContainText(
      'MON-DELL-QR-888-CORRECTED'
    );
    await expect(page.locator('[data-testid="asset-qr-serial"]')).toContainText(
      'SN-DELL-QR-888-CORRECTED'
    );
    // Stable UUID and locator URL remain invariant
    await expect(page.locator('[data-testid="asset-qr-uuid"]')).toContainText(qrAssetId);
    await expect(page.locator('[data-testid="asset-qr-locator"]')).toContainText(
      `${targetBaseUrl}/assets/${qrAssetId}`
    );

    // 10. Follow the decoded QR locator URL and verify destination reflects corrected metadata
    await page.goto(decoded!.data);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();
    await expect(page.locator('#asset-detail-heading')).toContainText(
      'จอมอนิเตอร์ Dell 27 นิ้ว UltraSharp (แก้ไข)'
    );
    expect(page.url()).toBe(`${targetBaseUrl}/assets/${qrAssetId}`);

    // 11. Access Control Enforcement on locator URL
    // A. Unauthenticated access redirects to /login
    const unauthContext = await context.browser()!.newContext();
    const unauthPage = await unauthContext.newPage();
    await unauthPage.goto(`${targetBaseUrl}/assets/${qrAssetId}`);
    await unauthPage.waitForURL(`${targetBaseUrl}/login`);
    await expect(unauthPage.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();
    await unauthContext.close();

    // B. Maintainer role (lacks asset:view) is denied with boundary error
    const maintainerContext = await context.browser()!.newContext();
    const maintainerPage = await maintainerContext.newPage();
    await loginAs(maintainerPage, maintainerContext, maintainerUserId);
    await maintainerPage.goto(`${targetBaseUrl}/assets/${qrAssetId}`);
    await expect(maintainerPage.locator('#detail-boundary-error')).toBeVisible();
    await expect(maintainerPage.locator('#detail-boundary-error')).toContainText(
      'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)'
    );
    await maintainerContext.close();

    // 12. Test pre-print revocation suppression: genuine grant loss on 403 suppresses protected detail & QR
    await page.locator('[data-testid="generate-qr-btn"]').click();
    await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeVisible();

    await page.evaluate(() => {
      (window as any).__prints = 0;
      window.print = () => {
        (window as any).__prints++;
      };
    });

    // Revoke user role in PostgreSQL to test genuine grant loss
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [custodianUserId]);
    try {
      const deniedResponse = page.waitForResponse(
        (r) => r.url().includes(`/assets/${qrAssetId}/qr-label`) && r.status() === 403
      );
      await page.locator('[data-testid="print-qr-label-btn"]').click();
      await deniedResponse;

      // Verify window.print is NOT called, and protected card & detail are suppressed
      expect(await page.evaluate(() => (window as any).__prints)).toBe(0);
      await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeHidden();
      await expect(
        page.locator('#asset-detail-heading'),
        'A genuine asset:view denial must retire protected detail as well as the QR'
      ).toBeHidden();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('403 Forbidden');
    } finally {
      // Restore user role for subsequent checks
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
        custodianUserId,
        'ASSET_CUSTODIAN',
      ]);
    }

    // 13. Test error & reauthorization suppression on 503
    // Navigate back to restore fresh asset view
    await page.goto(`${targetBaseUrl}/assets/${qrAssetId}`);
    await expect(page.locator('#asset-detail-heading')).toBeVisible();

    await page.route(`**/assets/${qrAssetId}/qr-label`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Public application origin is not configured',
        }),
      });
    });

    await page.evaluate(() => {
      (window as any).__printed = false;
    });

    // Attempt generate under 503
    await page.locator('[data-testid="generate-qr-btn"]').click();
    await expect(page.locator('[data-testid="asset-qr-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="asset-qr-error"]')).toContainText(
      '503 Service Unavailable'
    );

    await page.unroute(`**/assets/${qrAssetId}/qr-label`);

    // 14. Database Zero Business Mutation Invariant:
    // Capture post-correction baseline for row counts, persistent field values, and update timestamps
    const baselineCounts = await countQuery();
    const baselineAsset = await getAssetSnapshot(qrAssetId);

    // Perform successful QR generation and print invocation
    await page.locator('[data-testid="generate-qr-btn"]').click();
    await expect(page.locator('[data-testid="asset-qr-label-card"]')).toBeVisible();

    await page.evaluate(() => {
      (window as any).__printed = false;
      window.print = () => {
        (window as any).__printed = true;
      };
    });
    await page.locator('[data-testid="print-qr-label-btn"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBe(true);

    // Verify row counts and persistent field values/timestamps in assets table are strictly unchanged
    const finalCounts = await countQuery();
    const finalAsset = await getAssetSnapshot(qrAssetId);

    expect(finalCounts.assets).toBe(baselineCounts.assets);
    expect(finalCounts.history).toBe(baselineCounts.history);
    expect(finalCounts.retry).toBe(baselineCounts.retry);
    expect(finalAsset).toEqual(baselineAsset);
  });

  test('Journey 12: Lightweight Acquisition lifecycle (Seam B) -> create acquisition -> link two assets -> verify whole-acquisition total separation and truthful details', async ({ page, context }) => {
    // 1. Login as Asset Custodian
    await loginAs(page, context, custodianUserId);

    // 2. Navigate to Dashboard and verify Acquisition section exists
    await page.goto(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#acquisition-heading')).toBeVisible();
    await expect(page.locator('#nav-acquisition-create')).toBeVisible();

    // 3. Navigate to Acquisition Create page
    await page.locator('#nav-acquisition-create').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/acquisitions/new`);
    await expect(page.locator('#create-acquisition-heading')).toBeVisible();

    // Fill acquisition facts
    await page.locator('input#acquisition_type').fill('จัดซื้อปกติ');
    await page.locator('input#acquisition_date').fill('2026-03-20');
    await page.locator('input#total_amount').fill('120000.00');
    await page.locator('input#source_reference').fill('PO-2026-BATCH-01');
    await page.locator('textarea#notes').fill('จัดซื้อคอมพิวเตอร์พร้อมใช้งานจำนวน 2 เครื่อง');

    // Submit acquisition
    await page.locator('#submit-acquisition-btn').click();

    // 4. Verify redirected to Acquisition Detail page
    await expect(page).toHaveURL(new RegExp(`${targetBaseUrl}/acquisitions/[0-9a-f-]{36}`));
    const acqUrl = page.url();
    const acqIdMatch = acqUrl.match(/\/acquisitions\/([0-9a-f-]{36})/);
    expect(acqIdMatch).not.toBeNull();
    const createdAcqId = acqIdMatch![1];

    // Verify facts on page
    await expect(page.locator('#acquisition-detail-heading')).toBeVisible();
    await expect(page.locator('#fact-id')).toContainText(createdAcqId);
    await expect(page.locator('#fact-type')).toContainText('จัดซื้อปกติ');
    await expect(page.locator('#fact-date')).toContainText('2026-03-20');
    await expect(page.locator('#fact-amount')).toContainText('120000.00 THB');
    await expect(page.locator('#fact-reference')).toContainText('PO-2026-BATCH-01');
    await expect(page.locator('#fact-notes')).toContainText('จัดซื้อคอมพิวเตอร์พร้อมใช้งานจำนวน 2 เครื่อง');

    // Verify Whole Total Warning banner
    await expect(page.locator('#whole-total-warning')).toBeVisible();
    await expect(page.locator('#whole-total-warning')).toContainText('คำเตือนเรื่องมูลค่ารวม: มูลค่า 120000.00 THB');
    await expect(page.locator('#whole-total-warning')).toContainText('ยอดรวมของการได้มาทั้งชุด (Whole-Acquisition Total)');

    // Verify empty linked assets notice initially
    await expect(page.locator('#no-linked-assets-notice')).toBeVisible();

    // 5. Click link to register an asset pre-linked to this acquisition
    await page.locator('#register-linked-asset-btn').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/assets/register?acquisition_id=${createdAcqId}`);
    await expect(page.locator('input#acquisition_id')).toHaveValue(createdAcqId);

    // Register Asset 1
    await page.locator('input#name').fill('Office Workstation Alpha');
    await page.locator('input#asset_number').fill('E2E-ACQ-AST-01');
    await page.locator('input#serial_number').fill('E2E-ACQ-SN-01');
    await page.locator('#submit-register-btn').click();

    // Navigates to Asset 1 Detail
    await expect(page).toHaveURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const asset1Url = page.url();
    const asset1IdMatch = asset1Url.match(/\/assets\/([0-9a-f-]{36})/);
    expect(asset1IdMatch).not.toBeNull();
    const asset1Id = asset1IdMatch![1];

    // Verify acquisition linkage link is displayed on Asset 1 Detail
    await expect(page.locator('#link-to-acquisition')).toBeVisible();
    await expect(page.locator('#link-to-acquisition')).toContainText(createdAcqId);

    // 6. Click link-to-acquisition to return to Acquisition Detail
    await page.locator('#link-to-acquisition').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/acquisitions/${createdAcqId}`);

    // Verify linked assets table now contains Asset 1
    await expect(page.locator('#linked-assets-table')).toBeVisible();
    await expect(page.locator('#linked-assets-table')).toContainText('E2E-ACQ-AST-01');
    await expect(page.locator('#linked-assets-table')).toContainText('Office Workstation Alpha');

    // 7. Register Asset 2 linked to the same acquisition
    await page.locator('#register-linked-asset-btn').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/assets/register?acquisition_id=${createdAcqId}`);

    await page.locator('input#name').fill('Office Workstation Beta');
    await page.locator('input#asset_number').fill('E2E-ACQ-AST-02');
    await page.locator('input#serial_number').fill('E2E-ACQ-SN-02');
    await page.locator('#submit-register-btn').click();

    // Navigates to Asset 2 Detail
    await expect(page).toHaveURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    await expect(page.locator('#link-to-acquisition')).toBeVisible();
    await page.locator('#link-to-acquisition').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/acquisitions/${createdAcqId}`);

    // 8. Verify both assets appear in the Acquisition Detail table
    await expect(page.locator('#linked-assets-heading')).toContainText('2 รายการ');
    await expect(page.locator('#linked-assets-table')).toContainText('E2E-ACQ-AST-01');
    await expect(page.locator('#linked-assets-table')).toContainText('E2E-ACQ-AST-02');

    // Verify Total Separation: total_amount on acquisition remains untouched (120000.00 THB)
    await expect(page.locator('#fact-amount')).toContainText('120000.00 THB');

    // 9. Read-only user access: can view acquisition facts and linked assets
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${createdAcqId}`);
    await expect(page.locator('#acquisition-detail-heading')).toBeVisible();
    await expect(page.locator('#fact-amount')).toContainText('120000.00 THB');
    await expect(page.locator('#linked-assets-table')).toContainText('E2E-ACQ-AST-01');

    // 10. Maintainer user access: denied with 403 Forbidden
    await switchActor(page, context, maintainerUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${createdAcqId}`);
    await expect(page.locator('#acquisition-error-alert')).toBeVisible();
    await expect(page.locator('#acquisition-error-alert')).toContainText('403 Forbidden');
  });

  test('Lead T5: repository DEV proxy must route acquisition requests to the actual API and bypass HTML to SPA', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    const auth = await (await page.request.get(`${targetBaseUrl}/auth/session-check`)).json();
    const cookie = (await context.cookies()).map((x: any) => `${x.name}=${x.value}`).join('; ');

    // Direct API positive control
    const control = await fastifyApp.inject({
      method: 'POST',
      url: '/acquisitions',
      headers: { cookie, 'x-csrf-token': auth.csrfToken, 'x-retry-token': crypto.randomUUID() },
      payload: { notes: 'Direct API positive control' },
    });
    expect(control.statusCode).toBe(201);

    // Via Vite proxy
    const viaProxy = await page.request.post(`${targetBaseUrl}/acquisitions`, {
      headers: { 'x-csrf-token': auth.csrfToken, 'x-retry-token': crypto.randomUUID() },
      data: { notes: 'Repository DEV proxy path' },
    });
    expect(viaProxy.status(), 'Actual application DEV routing must reach the Acquisition API').toBe(201);

    // HTML navigation SPA bypass
    const htmlReq = await page.request.get(`${targetBaseUrl}/acquisitions/new`, {
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    expect(htmlReq.status()).toBe(200);
    const htmlText = await htmlReq.text();
    expect(htmlText.toLowerCase()).toContain('<!doctype html>');
    expect(htmlText).toContain('<div id="root"></div>');
  });

  test('Lead T5: browser transmits and persists exact decimal amount (NUMERIC(18,2) capacity)', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/new`);
    await page.locator('#notes').fill('Exact sourced total; no allocation');
    await page.locator('#total_amount').fill('1234567890123456.78');

    const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/acquisitions'));
    const completed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/acquisitions'));

    await page.locator('#submit-acquisition-btn').click();

    const req = await sent;
    const response = await completed;
    expect(response.status()).toBe(201);

    const created = await response.json();
    const stored = (await pool.query('SELECT total_amount::text AS amount FROM acquisitions WHERE id=$1', [created.id])).rows[0].amount;

    expect(req.postDataJSON().total_amount).toBe('1234567890123456.78');
    expect(stored).toBe('1234567890123456.78');

    await expect(page.locator('#fact-amount')).toContainText('1234567890123456.78 THB');

    // Test rejection of excess precision (> 2 decimal places) without rounding
    await page.goto(`${targetBaseUrl}/acquisitions/new`);
    await page.locator('#notes').fill('Excess precision test');
    await page.locator('#total_amount').fill('100.555');
    await page.locator('#submit-acquisition-btn').click();
    await expect(page.locator('main')).toContainText('ทศนิยมไม่เกิน 2 ตำแหน่ง');
  });

  test('Lead T5: current permission loss suppresses protected acquisition facts on focus immediately during reauthorization', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    const auth = await (await page.request.get(`${targetBaseUrl}/auth/session-check`)).json();

    const res = await page.request.post(`${targetBaseUrl}/acquisitions`, {
      headers: { 'x-csrf-token': auth.csrfToken, 'x-retry-token': crypto.randomUUID() },
      data: { notes: 'Sensitive group fact', total_amount: '9876.54', currency: 'THB' },
    });
    expect(res.status()).toBe(201);
    const a = await res.json();

    await context.clearCookies();
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${a.id}`);
    await expect(page.locator('#fact-amount')).toContainText('9876.54');

    await pool.query('DELETE FROM user_roles WHERE user_id=$1', [readonlyUserId]);

    try {
      let fulfillHeld: (() => void) | null = null;
      const heldPromise = new Promise<void>((resolve) => {
        fulfillHeld = resolve;
      });

      // Intercept revalidation request and hold it
      await page.route(`**/acquisitions/${a.id}*`, async (route) => {
        await heldPromise;
        await route.continue();
      });

      // Trigger focus and visibilitychange
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // While request is held in-flight, protected facts MUST be suppressed immediately!
      await expect(page.locator('#fact-amount'), 'Protected facts must be suppressed immediately during pending reauthorization').toBeHidden();

      // Release the held route
      if (fulfillHeld) {
        (fulfillHeld as () => void)();
      }

      // After 403 finishes, facts remain hidden and 403 alert is displayed
      await expect(page.locator('#fact-amount')).toBeHidden();
      await expect(page.locator('#acquisition-error-alert')).toBeVisible();
      await expect(page.locator('#acquisition-error-alert')).toContainText('403 Forbidden');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await pool.query("INSERT INTO user_roles(user_id, role_id) VALUES($1, 'READ_ONLY')", [readonlyUserId]);
    }
  });

  test('Lead T5: obsolete submit completion during pending actor/session verification cannot navigate or mutate active route', async ({ page, context }) => {
    // 1. Log in as Custodian and navigate to AcquisitionCreate
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/new`);
    await expect(page.locator('#submit-acquisition-btn')).toBeEnabled();

    // Fill in dirty form intent
    await page.locator('#notes').fill('Obsolescence test during pending verification');
    await page.locator('#total_amount').fill('99999.00');

    let resolvePost!: () => void;
    const postHeldPromise = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });

    let interceptedPost = false;
    let committedAcquisitionId: string | null = null;
    await page.route('**/acquisitions', async (route) => {
      const req = route.request();
      if (req.method() === 'POST' && !interceptedPost) {
        interceptedPost = true;
        // Fetch real response (201) from backend (commits to PG)
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        const bodyText = await response.text();
        const bodyJson = JSON.parse(bodyText);
        committedAcquisitionId = bodyJson.id;
        // Hold response delivery to browser
        await postHeldPromise;
        const headers = { ...response.headers() };
        delete headers['set-cookie'];
        try {
          await route.fulfill({ response, headers, body: bodyText });
        } catch {
          // Client may have aborted the request
        }
        return;
      }
      await route.continue();
    });

    // 2. Custodian submits -> POST is in flight
    await page.locator('#submit-acquisition-btn').click();

    // 3. Switch cookies to Read-only actor
    await context.clearCookies();
    await loginAs(page, context, readonlyUserId);

    let resolveSession!: () => void;
    const sessionHeldPromise = new Promise<void>((resolve) => {
      resolveSession = resolve;
    });

    // Intercept session-check to hold the pending verification
    await page.route('**/auth/session-check', async (route) => {
      await sessionHeldPromise;
      await route.continue();
    });

    // Trigger focus and visibilitychange to start revalidation
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 4. Verify form is gated while session verification is pending
    await expect(page.locator('#submit-acquisition-btn'), 'Submit button must be disabled while session verification is pending').toBeDisabled();
    await expect(page.locator('#verifying-session-indicator')).toBeVisible();

    // 5. Release the old successful POST response while the new verification remains held
    resolvePost();
    await page.waitForTimeout(100);

    // 6. Assert: obsolete submit completion CANNOT supersede current verification or navigate!
    expect(page.url()).toBe(`${targetBaseUrl}/acquisitions/new`);
    await expect(page.locator('#submit-acquisition-btn')).toBeDisabled();
    await expect(page.locator('#verifying-session-indicator')).toBeVisible();

    // 7. Release the held session check and wait for verification indicator to clear
    resolveSession();
    await expect(page.locator('#verifying-session-indicator')).not.toBeVisible();

    // 8. Assert: browser is STILL on /acquisitions/new, not navigated away to old acquisition id
    expect(page.url()).toBe(`${targetBaseUrl}/acquisitions/new`);
    if (committedAcquisitionId) {
      expect(page.url()).not.toContain(committedAcquisitionId);
    }

    // 9. Verify dirty form intent is preserved in fields without silent transfer or data mutation
    await expect(page.locator('#notes')).toHaveValue('Obsolescence test during pending verification');
    await expect(page.locator('#total_amount')).toHaveValue('99999.00');

    // 10. Read-only actor attempts submit -> rejected with 403 Forbidden, shows alert and disables submit
    await loginAs(page, context, readonlyUserId);
    await page.locator('#submit-acquisition-btn').click();
    await expect(page.locator('#forbidden-alert')).toBeVisible();
    await expect(page.locator('#submit-acquisition-btn')).toBeDisabled();

    // Independent database check: the original Custodian transaction committed
    if (committedAcquisitionId) {
      const dbCheck = await pool.query('SELECT id, created_by FROM acquisitions WHERE id = $1', [committedAcquisitionId]);
      expect(dbCheck.rows.length).toBe(1);
      expect(dbCheck.rows[0].created_by).toBe(custodianUserId);
    }

    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('Lead T5: in-flight submit unmounted via SPA link cannot redirect active route or cause error upon completion', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/new`);
    await page.locator('#notes').fill('SPA unmount submit test');

    let resolveSubmit!: () => void;
    const submitHeldPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });

    let interceptedPost = false;
    await page.route('**/acquisitions', async (route) => {
      if (route.request().method() === 'POST' && !interceptedPost) {
        interceptedPost = true;
        const response = await route.fetch();
        const bodyText = await response.text();
        await submitHeldPromise;
        try {
          await route.fulfill({ response, body: bodyText });
        } catch {
          // Component unmounted and request aborted
        }
        return;
      }
      await route.continue();
    });

    await page.locator('#submit-acquisition-btn').click();

    // While submit is held, click actual SPA link to navigate to Dashboard (unmounting AcquisitionCreate)
    await page.locator('#back-to-dashboard-link').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#create-acquisition-heading')).not.toBeVisible();

    // Release held submit response
    resolveSubmit();
    await page.waitForTimeout(100);

    // Ensure we deterministically remain on dashboard and obsolete completion did not redirect back
    await expect(page).toHaveURL(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#create-acquisition-heading')).not.toBeVisible();

    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('T6 Journey 1: Navigation shortcuts to Bulk Register (Dashboard and Acquisition Detail)', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    // 1. From Dashboard to Bulk Register
    await page.goto(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#nav-asset-bulk-register')).toBeVisible();
    await page.locator('#nav-asset-bulk-register').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/assets/bulk-register`);
    await expect(page.locator('#bulk-register-heading')).toBeVisible();

    // 2. Create an acquisition in DB to verify shortcut on detail page
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, total_amount, source_reference, notes, created_by)
      VALUES ('จัดซื้อปกติ', '2026-03-22', '50000.00', 'PO-BULK-NAV-01', 'Acquisition for bulk shortcut test', $1)
      RETURNING id
    `, [custodianUserId]);
    const seededAcqId = acqRes.rows[0].id;

    // 3. From Acquisition Detail to Bulk Register prefilled with acquisition_id
    await page.goto(`${targetBaseUrl}/acquisitions/${seededAcqId}`);
    await expect(page.locator('#bulk-register-linked-asset-btn')).toBeVisible();
    await page.locator('#bulk-register-linked-asset-btn').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/assets/bulk-register?acquisition_id=${seededAcqId}`);
    await expect(page.locator('#bulk-register-heading')).toBeVisible();
    await expect(page.locator('#shared-acquisition-id')).toHaveValue(seededAcqId);
  });

  test('T6 Journey 2: Atomic bulk registration of multiple assets with shared acquisition', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    // Seed acquisition for link
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, total_amount, source_reference, notes, created_by)
      VALUES ('จัดซื้อปกติ', '2026-03-22', '80000.00', 'PO-BULK-2026-A', 'Shared batch acquisition', $1)
      RETURNING id
    `, [custodianUserId]);
    const sharedAcqId = acqRes.rows[0].id;

    await page.goto(`${targetBaseUrl}/assets/bulk-register?acquisition_id=${sharedAcqId}`);
    await expect(page.locator('#shared-acquisition-id')).toHaveValue(sharedAcqId);

    // Fill Item 1
    await page.locator('#item-name-0').fill('Workstation Server Alpha');
    await page.locator('#item-asset-number-0').fill('AST-E2E-BLK-001');
    await page.locator('#item-serial-number-0').fill('SN-E2E-BLK-001');
    await page.locator('#item-source-ref-0').fill('PO-BULK-2026-A');

    // Add Item 2
    await page.locator('#add-row-btn').click();
    await expect(page.locator('#bulk-item-row-1')).toBeVisible();
    await page.locator('#item-name-1').fill('Workstation Server Beta');
    await page.locator('#item-asset-number-1').fill('AST-E2E-BLK-002');
    await page.locator('#item-serial-number-1').fill('SN-E2E-BLK-002');
    await page.locator('#item-source-ref-1').fill('PO-BULK-2026-A');

    // Submit registration
    await page.locator('#submit-bulk-register-btn').click();

    // Verify success result screen
    await expect(page.locator('#bulk-register-success')).toBeVisible();
    await expect(page.locator('#total-registered-count')).toHaveText('2');
    await expect(page.locator('#registered-asset-link-0')).toBeVisible();
    await expect(page.locator('#registered-asset-link-1')).toBeVisible();
    await expect(page.locator('#linked-acquisition-link')).toHaveText(sharedAcqId);

    // Database verification: both assets committed atomically with shared acquisition_id
    const dbAssets = await pool.query(
      `SELECT * FROM assets WHERE asset_number IN ('AST-E2E-BLK-001', 'AST-E2E-BLK-002') ORDER BY asset_number ASC`
    );
    expect(dbAssets.rows).toHaveLength(2);
    expect(dbAssets.rows[0].name).toBe('Workstation Server Alpha');
    expect(dbAssets.rows[0].acquisition_id).toBe(sharedAcqId);
    expect(dbAssets.rows[1].name).toBe('Workstation Server Beta');
    expect(dbAssets.rows[1].acquisition_id).toBe(sharedAcqId);

    // Verify asset history records
    const assetIds = dbAssets.rows.map((r: any) => r.id);
    const dbHistory = await pool.query(
      `SELECT * FROM asset_history WHERE asset_id = ANY($1) AND action = 'REGISTERED'`,
      [assetIds]
    );
    expect(dbHistory.rows).toHaveLength(2);

    // Follow link to registered asset detail
    await page.locator('#registered-asset-link-0').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/assets/${assetIds[0]}`);
    await expect(page.locator('#asset-detail-heading')).toHaveText('Workstation Server Alpha');
    await expect(page.locator(`dd:has-text("AST-E2E-BLK-001")`)).toBeVisible();
  });

  test('T6 Journey 3: Duplicate candidate detection and explicit continuation flow', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);

    // Enter an item that duplicates AST-E2E-BLK-001 from previous test
    await page.locator('#item-name-0').fill('Duplicate Unit Test');
    await page.locator('#item-asset-number-0').fill('AST-E2E-BLK-001');

    // Submit registration without explicit continuation
    await page.locator('#submit-bulk-register-btn').click();

    // Verify duplicate warning banner appears
    await expect(page.locator('#duplicate-warnings-banner')).toBeVisible();
    await expect(page.locator('#explicit-continuation-checkbox')).toBeVisible();
    await expect(page.locator('#explicit-continuation-checkbox')).not.toBeChecked();

    // Verify no new asset was created in database
    const dbCheckBefore = await pool.query(
      `SELECT * FROM assets WHERE name = 'Duplicate Unit Test'`
    );
    expect(dbCheckBefore.rows).toHaveLength(0);

    // Now check explicit continuation checkbox and submit again
    await page.locator('#explicit-continuation-checkbox').check();
    await page.locator('#submit-bulk-register-btn').click();

    // Verify successful registration after explicit confirmation
    await expect(page.locator('#bulk-register-success')).toBeVisible();
    await expect(page.locator('#total-registered-count')).toHaveText('1');

    // Verify new asset now exists in database with identical asset_number
    const dbCheckAfter = await pool.query(
      `SELECT * FROM assets WHERE name = 'Duplicate Unit Test'`
    );
    expect(dbCheckAfter.rows).toHaveLength(1);
    expect(dbCheckAfter.rows[0].asset_number).toBe('AST-E2E-BLK-001');
  });

  test('T6 Journey 4: Role capability enforcement for non-custodian (Read-Only user)', async ({ page, context }) => {
    await loginAs(page, context, readonlyUserId);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);

    await page.locator('#item-name-0').fill('Unauthorized Bulk Item');
    await page.locator('#item-asset-number-0').fill('AST-UNAUTH-001');

    // Attempt submission
    await page.locator('#submit-bulk-register-btn').click();

    // Verify 403 Forbidden alert message appears
    await expect(page.locator('#bulk-error-message, #forbidden-alert').first()).toBeVisible();
    await expect(page.locator('#bulk-error-message, #forbidden-alert').first()).toContainText('ไม่มีสิทธิ์');

    // Verify asset was not registered in database
    const dbCheck = await pool.query(
      `SELECT * FROM assets WHERE asset_number = 'AST-UNAUTH-001'`
    );
    expect(dbCheck.rows).toHaveLength(0);
  });

  test('T6 Journey 5: In-flight bulk submit unmounted via SPA link cannot redirect active route or cause error upon completion', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('In-Flight Unmount Bulk Asset');
    await page.locator('#item-asset-number-0').fill('AST-E2E-UNMOUNT-001');

    let resolveSubmit!: () => void;
    const submitHeldPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    let resolveFulfill!: () => void;
    const fulfillDonePromise = new Promise<void>((resolve) => {
      resolveFulfill = resolve;
    });

    let interceptedPost = false;
    await page.route('**/assets/bulk-register', async (route) => {
      if (route.request().method() === 'POST' && !interceptedPost) {
        interceptedPost = true;
        const response = await route.fetch();
        const bodyText = await response.text();
        await submitHeldPromise;
        try {
          await route.fulfill({ response, body: bodyText });
        } catch {
          // Component unmounted and request aborted
        } finally {
          resolveFulfill();
        }
        return;
      }
      await route.continue();
    });

    await page.locator('#submit-bulk-register-btn').click();

    // While submit is held, click actual SPA link to navigate to Dashboard (unmounting AssetBulkRegister)
    await page.locator('#back-to-dashboard-link').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#bulk-register-heading')).not.toBeVisible();

    // Release held submit response and deterministically wait for fulfill completion
    resolveSubmit();
    await fulfillDonePromise;

    // Ensure we deterministically remain on dashboard and obsolete completion did not redirect back
    await expect(page).toHaveURL(`${targetBaseUrl}/dashboard`);
    await expect(page.locator('#bulk-register-heading')).not.toBeVisible();

    // Confirm that the server transaction committed
    const dbCheck = await pool.query(
      `SELECT * FROM assets WHERE asset_number = 'AST-E2E-UNMOUNT-001'`
    );
    expect(dbCheck.rows).toHaveLength(1);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('T6 Journey 6: Verbatim preservation of padded and whitespace-inclusive identifiers', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Verbatim Identifier Asset');
    await page.locator('#item-asset-number-0').fill('   AST-VERBATIM-001   ');
    await page.locator('#item-serial-number-0').fill('   SN-VERBATIM-001   ');

    await page.locator('#submit-bulk-register-btn').click();

    await expect(page.locator('#bulk-register-success')).toBeVisible();
    await expect(page.locator('#total-registered-count')).toHaveText('1');

    // Confirm in PostgreSQL database that leading/trailing spaces are preserved verbatim
    const dbCheck = await pool.query(
      `SELECT asset_number, serial_number FROM assets WHERE name = 'Verbatim Identifier Asset'`
    );
    expect(dbCheck.rows).toHaveLength(1);
    expect(dbCheck.rows[0].asset_number).toBe('   AST-VERBATIM-001   ');
    expect(dbCheck.rows[0].serial_number).toBe('   SN-VERBATIM-001   ');
  });

  test('T6 Journey 7: Duplicate candidate review with links, 3+ pages load-more, and intent acknowledgment reset', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    // Seed 110 existing assets for 3 pages of duplicate candidates (50 + 50 + 10)
    await pool.query(`
      INSERT INTO assets (name, asset_number, registered_by)
      SELECT 'Candidate Asset ' || i, 'AST-E2E-DUP-PAGINATION', '${custodianUserId}'
      FROM generate_series(1, 110) i;
    `);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Review Subject Unit');
    await page.locator('#item-asset-number-0').fill('AST-E2E-DUP-PAGINATION');

    // Submit -> triggers duplicate warning
    await page.locator('#submit-bulk-register-btn').click();

    await expect(page.locator('#duplicate-warnings-banner')).toBeVisible();
    await expect(page.locator('#duplicate-warning-item-0')).toBeVisible();

    // Check candidate link
    const candidateLink = page.locator('a[id^="dup-candidate-link-"]').first();
    await expect(candidateLink).toBeVisible();
    await expect(candidateLink).toHaveAttribute('href', /\/assets\/[0-9a-f-]{36}/);

    // Page 1 initial state: 50 items displayed, button indicates 50/110
    const loadMoreBtn = page.locator('#load-more-candidates-btn-0');
    await expect(loadMoreBtn).toBeVisible();
    await expect(loadMoreBtn).toHaveText(/50\/110/);

    // Click load more -> fetches Page 2 (offset 50)
    await loadMoreBtn.click();
    await expect(loadMoreBtn).toHaveText(/100\/110/);

    // Click load more again -> fetches Page 3 (offset 100)
    await loadMoreBtn.click();
    // All 110 items loaded -> has_more is false and load more button disappears
    await expect(loadMoreBtn).not.toBeVisible();

    // Check acknowledgment checkbox
    await page.locator('#explicit-continuation-checkbox').check();
    await expect(page.locator('#explicit-continuation-checkbox')).toBeChecked();

    // Modifying form input immediately resets acknowledgment and dismisses warnings banner
    await page.locator('#item-name-0').fill('Review Subject Unit Modified');
    await expect(page.locator('#duplicate-warnings-banner')).not.toBeVisible();
    await expect(page.locator('#explicit-continuation-checkbox')).not.toBeAttached();

    // Re-submitting without checkbox produces duplicate warning again
    await page.locator('#submit-bulk-register-btn').click();
    await expect(page.locator('#duplicate-warnings-banner')).toBeVisible();
    await expect(page.locator('#explicit-continuation-checkbox')).not.toBeChecked();

    // Check checkbox and re-submit -> succeeds
    await page.locator('#explicit-continuation-checkbox').check();
    await page.locator('#submit-bulk-register-btn').click();

    await expect(page.locator('#bulk-register-success')).toBeVisible();
    await expect(page.locator('#total-registered-count')).toHaveText('1');
  });

  test('T6 Journey 8: Committed-but-lost recovery across permission loss: denied replay retains quarantined intent, restored authority replays exact UUIDs', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Committed Lost Recovery Asset');
    await page.locator('#item-asset-number-0').fill('AST-COMMITTED-LOST-01');

    // Intercept POST /assets/bulk-register:
    // Forward request to backend server (route.fetch()) so server COMMITS the transaction in DB,
    // but abort network delivery to the page to simulate connection drop after server commit.
    let dropResponseOnce = true;
    await page.route('**/assets/bulk-register', async (route) => {
      if (route.request().method() === 'POST' && dropResponseOnce) {
        dropResponseOnce = false;
        // Execute request on the backend so PostgreSQL commits the row!
        await route.fetch();
        // Drop the network response before the browser receives it
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.locator('#submit-bulk-register-btn').click();

    // Verify uncertain state alert is rendered and inputs are locked
    await expect(page.locator('#uncertain-state-alert')).toBeVisible();
    await expect(page.locator('#item-name-0')).toBeDisabled();
    await expect(page.locator('#item-asset-number-0')).toBeDisabled();
    await expect(page.locator('#submit-bulk-register-btn')).toBeDisabled();
    await expect(page.locator('#retry-uncertain-btn')).toBeVisible();
    await expect(page.locator('#discard-uncertain-btn')).toBeVisible();

    // Confirm PostgreSQL ALREADY committed the asset
    const initialDbCheck = await pool.query(
      `SELECT id, asset_number FROM assets WHERE asset_number = 'AST-COMMITTED-LOST-01'`
    );
    expect(initialDbCheck.rows).toHaveLength(1);
    const committedAssetId = initialDbCheck.rows[0].id;

    // 1. Revoke ASSET_CUSTODIAN role while in uncertain state
    await pool.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ASSET_CUSTODIAN'`,
      [custodianUserId]
    );

    try {
      // 2. Click retry while permission is revoked -> receives 403 Forbidden
      await page.locator('#retry-uncertain-btn').click();

      // Verify forbidden alert is visible, but quarantined intent is NOT destroyed: form remains locked!
      await expect(page.locator('#forbidden-alert')).toBeVisible();
      await expect(page.locator('#item-name-0')).toBeDisabled();
      await expect(page.locator('#submit-bulk-register-btn')).toBeDisabled();
    } finally {
      // 3. Restore ASSET_CUSTODIAN role
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
        [custodianUserId]
      );
    }

    // 4. Trigger window focus event to revalidate session
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // Verify forbidden alert clears and retry button is available again
    await expect(page.locator('#forbidden-alert')).not.toBeVisible();
    await expect(page.locator('#uncertain-state-alert')).toBeVisible();
    await expect(page.locator('#retry-uncertain-btn')).toBeEnabled();

    // 5. Retry using the exact stored snapshot via #retry-uncertain-btn
    await page.locator('#retry-uncertain-btn').click();

    // Verifies successful recovery without duplicating or creating invalid state
    await expect(page.locator('#bulk-register-success')).toBeVisible();
    await expect(page.locator('#total-registered-count')).toHaveText('1');
    await expect(page.locator('#registered-asset-link-0')).toHaveAttribute(
      'href',
      `/assets/${committedAssetId}`
    );

    // Verify strictly one asset, one history, one token in DB
    const finalDbCheck = await pool.query(
      `SELECT id FROM assets WHERE asset_number = 'AST-COMMITTED-LOST-01'`
    );
    expect(finalDbCheck.rows).toHaveLength(1);

    const historyCheck = await pool.query(
      `SELECT id FROM asset_history WHERE asset_id = $1`,
      [committedAssetId]
    );
    expect(historyCheck.rows).toHaveLength(1);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('T6 Journey 9: In-place actor switch in mounted component clears draft and pending intent', async ({ page, context }) => {
    // 1. Custodian Alice logs in and enters draft data
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Custodian Draft Secret');
    await expect(page.locator('#item-name-0')).toHaveValue('Custodian Draft Secret');

    // 2. Create another custodian user (Bob)
    const otherCustodianPass = await UserService.hashPassword('Password123!');
    const userRes = await pool.query(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES ('other_custodian_inplace', '${otherCustodianPass}', true)
      RETURNING id;
    `);
    const otherCustodianId = userRes.rows[0].id;
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
      [otherCustodianId]
    );

    // 3. Switch login session in-place via API login using same cookie jar (WITHOUT page navigation!)
    await page.request.post(`${targetBaseUrl}/auth/login`, {
      data: {
        username: 'other_custodian_inplace',
        password: 'Password123!',
      },
    });

    // 4. Trigger window focus event on the still-mounted page to fire verifySession()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // 5. Verify the mounted component retired the previous actor draft without page navigation
    await expect(page.locator('#item-name-0')).toHaveValue('');
  });

  test('T6 Journey 10: Suppresses protected duplicate warnings and facts during session verification and after 403', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    // Seed duplicate asset
    await pool.query(`
      INSERT INTO assets (name, asset_number, registered_by)
      VALUES ('Protected Fact Asset', 'AST-PROTECTED-SUPPRESS-01', '${custodianUserId}')
    `);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Attempting Unit');
    await page.locator('#item-asset-number-0').fill('AST-PROTECTED-SUPPRESS-01');

    // Submit to trigger duplicate warning banner
    await page.locator('#submit-bulk-register-btn').click();
    await expect(page.locator('#duplicate-warnings-banner')).toBeVisible();

    // Part A: Intercept /auth/session-check to hold it pending
    let fulfillSessionCheck: (() => void) | null = null;
    await page.route('**/auth/session-check', async (route) => {
      await new Promise<void>((resolve) => {
        fulfillSessionCheck = () => {
          route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Forbidden' }),
          });
          resolve();
        };
      });
    });

    // Trigger focus to start verification
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // While session check is in-flight, verifying indicator is visible AND duplicate warnings banner is suppressed!
    await expect(page.locator('#verifying-session-indicator')).toBeVisible();
    await expect(page.locator('#duplicate-warnings-banner')).not.toBeVisible();

    // Now resolve session check with 403 Forbidden
    fulfillSessionCheck!();

    // After 403, forbidden alert is visible and duplicate warnings remain suppressed
    await expect(page.locator('#forbidden-alert')).toBeVisible();
    await expect(page.locator('#duplicate-warnings-banner')).not.toBeVisible();

    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // Part B: Unmocked regression: genuine same-actor DB role revocation (ASSET_CUSTODIAN -> READ_ONLY)
    // with exact whitespace-only duplicate candidate (F1)
    // Seed an asset with whitespace-only asset_number = '   '
    const wsAssetRes = await pool.query(`
      INSERT INTO assets (name, asset_number, registered_by)
      VALUES ('Whitespace Existing Asset', '   ', '${custodianUserId}')
      RETURNING id
    `);
    const wsAssetId = wsAssetRes.rows[0].id;

    // Reset form and enter whitespace asset_number
    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Whitespace Test Unit');
    await page.locator('#item-asset-number-0').fill('   ');

    // Submit as authorized Custodian -> positive control: Fastify API returns 409 DUPLICATE_CANDIDATES_FOUND
    await page.locator('#submit-bulk-register-btn').click();
    await expect(page.locator('#duplicate-warnings-banner')).toBeVisible();
    await expect(page.locator('#duplicate-warnings-banner')).toContainText('Whitespace Existing Asset');
    await expect(page.locator(`#dup-candidate-link-${wsAssetId}`)).toBeVisible();

    // Now revoke ASSET_CUSTODIAN in PostgreSQL and set READ_ONLY
    await pool.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'ASSET_CUSTODIAN'`,
      [custodianUserId]
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'READ_ONLY')`,
      [custodianUserId]
    );

    try {
      // Trigger focus revalidation: real /auth/session-check returns 200 for same actor,
      // and real /assets/duplicate-candidates?asset_number=%20%20%20 denies with 403 Forbidden!
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
      });

      // Verify that whitespace-only candidate facts are purged, warnings banner is not visible,
      // candidate link is not visible, and forbidden alert is rendered
      await expect(page.locator('#forbidden-alert')).toBeVisible();
      await expect(page.locator('#duplicate-warnings-banner')).not.toBeVisible();
      await expect(page.locator(`#dup-candidate-link-${wsAssetId}`)).not.toBeVisible();
      await expect(page.locator('text=Whitespace Existing Asset')).not.toBeVisible();
    } finally {
      // Restore role in DB
      await pool.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'READ_ONLY'`,
        [custodianUserId]
      );
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
        [custodianUserId]
      );
    }
  });

  test('T6 Journey 11: Candidate pagination preserves raw offset across overlapping records, deterministic error on repeated page, and retry recovery', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Pagination Candidate Subject');
    await page.locator('#item-asset-number-0').fill('AST-PAG-RAW-OFFSET-01');

    // Intercept initial bulk register 409 DUPLICATE_CANDIDATES response
    const mockCandidatesPage1 = Array.from({ length: 50 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      name: `Candidate ${i + 1}`,
      asset_number: 'AST-PAG-RAW-OFFSET-01',
      serial_number: null,
    }));

    await page.route('**/assets/bulk-register', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'DUPLICATE_CANDIDATES_FOUND',
            warnings: [
              {
                item_key: 'item-0',
                field: 'asset_number',
                value: 'AST-PAG-RAW-OFFSET-01',
                intra_batch: false,
                candidates: mockCandidatesPage1,
                total_count: 120,
                has_more: true,
                limit: 50,
                offset: 0,
              },
            ],
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('#submit-bulk-register-btn').click();
    await expect(page.locator('#duplicate-warnings-banner')).toBeVisible();
    const loadMoreBtn = page.locator('#load-more-candidates-btn-0');
    await expect(loadMoreBtn).toBeVisible();

    // Track offsets requested by client
    const requestedOffsets: number[] = [];
    await page.route('**/assets/duplicate-candidates*', async (route) => {
      const url = new URL(route.request().url());
      const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10);
      requestedOffsets.push(offsetParam);

      if (offsetParam === 50) {
        // Page 2: returns 50 records with 10 overlaps (IDs 41..50 overlap, 51..90 are new)
        const mockPage2 = [
          ...mockCandidatesPage1.slice(40), // 10 overlapping items
          ...Array.from({ length: 40 }, (_, i) => ({
            id: `00000000-0000-4000-8000-${String(i + 51).padStart(12, '0')}`,
            name: `Candidate ${i + 51}`,
            asset_number: 'AST-PAG-RAW-OFFSET-01',
            serial_number: null,
          })),
        ];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: mockPage2,
            total_count: 120,
            has_more: true,
            limit: 50,
            offset: 50,
          }),
        });
        return;
      }

      if (offsetParam === 100) {
        // Page 3: server reports has_more = true, but returns 0 new unique items (stall/repeated page)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: mockCandidatesPage1.slice(0, 5), // old items only -> 0 new unique items
            total_count: 120,
            has_more: true,
            limit: 50,
            offset: 100,
          }),
        });
        return;
      }

      if (offsetParam === 150) {
        // Page 4 (Recovery): returns remaining 20 new items (IDs 91..110) with has_more = false
        const mockPage4 = Array.from({ length: 20 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i + 91).padStart(12, '0')}`,
          name: `Candidate ${i + 91}`,
          asset_number: 'AST-PAG-RAW-OFFSET-01',
          serial_number: null,
        }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: mockPage4,
            total_count: 120,
            has_more: false,
            limit: 50,
            offset: 150,
          }),
        });
        return;
      }

      await route.continue();
    });

    // Click load more for page 2
    await loadMoreBtn.click();

    // Display shows 90 unique items (50 initial + 40 new), NOT 100
    await expect(loadMoreBtn).toBeVisible();
    await expect(page.locator('#bulk-error-message')).not.toBeVisible();

    // Click load more for page 3 (returns 0 new unique items)
    await loadMoreBtn.click();

    // Verify raw requested offsets: offset 50 was followed by offset 100 (NOT offset 90!)
    expect(requestedOffsets).toEqual([50, 100]);

    // On repeated page with 0 new progress:
    // 1. Recoverable continuation error is surfaced with explicit message
    await expect(page.locator('#bulk-error-message')).toBeVisible();
    await expect(page.locator('#bulk-error-message')).toContainText(
      'ไม่พบข้อมูลรายการซ้ำเพิ่มเติมจากเซิร์ฟเวอร์ (หน้าซ้ำ) กรุณากดลองโหลดใหม่อีกครั้ง'
    );
    // 2. Load more button remains attached and visible (NOT silently hidden, has_more preserved)
    await expect(loadMoreBtn).toBeVisible();

    // 3. Retry recovery: clicking load more for page 4 delivers new records, recovers cleanly,
    // clears error message, and updates candidate count
    await loadMoreBtn.click();
    expect(requestedOffsets).toEqual([50, 100, 150]);
    await expect(page.locator('#bulk-error-message')).not.toBeVisible();
    await expect(loadMoreBtn).not.toBeVisible(); // has_more became false!

    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  // =========================================================================
  // T7: Shared Evidence Metadata/Reference Linkage Journeys (Seam B)
  // =========================================================================

  test('Journey T7.1: Shared evidence creation and cross-view visibility', async ({ page, context }) => {
    // 1. Seed Acquisition and two linked assets in PostgreSQL
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-05', 'PO-T7-E2E-001', 'T7 E2E Main Acquisition', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    const ast1Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Node Alpha', 'AST-T7-E2E-1', 'SN-T7-E2E-1', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const ast1Id = ast1Res.rows[0].id;

    const ast2Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Node Beta', 'AST-T7-E2E-2', 'SN-T7-E2E-2', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const ast2Id = ast2Res.rows[0].id;

    await loginAs(page, context, custodianUserId);

    // 2. Open Acquisition detail page
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();

    // 3. Create evidence linking Acquisition and both Assets
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await expect(page.locator('[data-testid="evidence-create-form"]')).toBeVisible();

    await page.locator('[data-testid="create-ref-type-input"]').fill('Tax Invoice');
    await page.locator('[data-testid="create-ref-text-input"]').fill('INV-T7-E2E-999');
    await page.locator('[data-testid="create-desc-input"]').fill('Core server delivery invoice for both nodes');
    await page.locator('[data-testid="create-additional-assets-input"]').fill(`${ast1Id}, ${ast2Id}`);

    await page.locator('[data-testid="create-evidence-submit-btn"]').click();

    // 4. Verify evidence appears in Acquisition detail
    await expect(page.locator('[data-testid="evidence-table"]')).toBeVisible();
    await expect(page.getByText('INV-T7-E2E-999')).toBeVisible();
    await expect(page.getByText('Core server delivery invoice for both nodes')).toBeVisible();

    // 5. Navigate to Asset 1 detail: same evidence must appear
    await page.goto(`${targetBaseUrl}/assets/${ast1Id}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();
    await expect(page.getByText('INV-T7-E2E-999')).toBeVisible();
    await expect(page.getByText('Tax Invoice')).toBeVisible();

    // 6. Navigate to Asset 2 detail: same evidence must appear
    await page.goto(`${targetBaseUrl}/assets/${ast2Id}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();
    await expect(page.getByText('INV-T7-E2E-999')).toBeVisible();
  });

  test('Journey T7.2: Reasoned link correction, unlink, and history trace (D8)', async ({ page, context }) => {
    // 1. Seed Acquisition and two linked assets with an initial evidence record
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-06', 'PO-T7-E2E-002', 'T7 Correction Acquisition', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    const ast1Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Server Prime', 'AST-T7-CORR-1', 'SN-T7-CORR-1', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const ast1Id = ast1Res.rows[0].id;

    const ast2Res = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Server Secondary', 'AST-T7-CORR-2', 'SN-T7-CORR-2', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const ast2Id = ast2Res.rows[0].id;

    // Seed initial evidence record with links to both assets
    const evRes = await pool.query(`
      INSERT INTO evidence_records (reference_type, reference_text, description, acquisition_id, version, created_by)
      VALUES ('Bill of Lading', 'BOL-T7-CORR-01', 'Initial consignment note', '${acqId}', 1, '${custodianUserId}')
      RETURNING id;
    `);
    const evId = evRes.rows[0].id;

    await pool.query(`
      INSERT INTO evidence_asset_links (evidence_id, asset_id) VALUES
        ('${evId}', '${ast1Id}'),
        ('${evId}', '${ast2Id}');
    `);

    await pool.query(`
      INSERT INTO evidence_history (evidence_id, version, action, actor_id, reason, after_state)
      VALUES ('${evId}', 1, 'CREATED', '${custodianUserId}', NULL, '{"reference_text": "BOL-T7-CORR-01"}');
    `);

    await loginAs(page, context, custodianUserId);

    // 2. Open Asset 1 detail
    await page.goto(`${targetBaseUrl}/assets/${ast1Id}`);
    await expect(page.locator(`[data-testid="evidence-row-${evId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="evidence-version-${evId}"]`)).toHaveText('v1');

    // 3. Open correction form
    await page.locator(`[data-testid="correct-evidence-btn-${evId}"]`).click();
    await expect(page.locator('[data-testid="evidence-correct-form"]')).toBeVisible();

    // 4. Submit correction: update text, unlink ast2Id, provide mandatory reason
    await page.locator('[data-testid="correct-reason-input"]').fill(
      'Re-routing secondary server to different facility; updating bill of lading reference'
    );
    await page.locator('[data-testid="correct-ref-text-input"]').fill('BOL-T7-CORR-01-REV2');

    // Unconditionally target and check unlink checkbox for ast2Id (Lead requirement)
    const unlinkCheckbox = page.locator(`[data-testid="correct-remove-asset-checkbox-${ast2Id}"]`);
    await expect(unlinkCheckbox).toBeVisible();
    await unlinkCheckbox.check();

    await page.locator('[data-testid="correct-evidence-submit-btn"]').click();

    // 5. Verify version incremented to v2 and text updated on Asset 1
    await expect(page.locator(`[data-testid="evidence-version-${evId}"]`)).toHaveText('v2');
    await expect(page.locator(`[data-testid="evidence-ref-text-${evId}"]`)).toHaveText('BOL-T7-CORR-01-REV2');

    // 6. View history and verify D8 mandatory reason is displayed
    await page.locator(`[data-testid="view-history-btn-${evId}"]`).click();
    await expect(page.getByText('Re-routing secondary server to different facility; updating bill of lading reference')).toBeVisible();

    // 7. Verify Asset 2 no longer lists this evidence
    await page.goto(`${targetBaseUrl}/assets/${ast2Id}`);
    await expect(page.locator(`[data-testid="evidence-row-${evId}"]`)).not.toBeVisible();

    // 8. Verify Acquisition still lists the surviving evidence
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator(`[data-testid="evidence-row-${evId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="evidence-version-${evId}"]`)).toHaveText('v2');
  });

  test('Journey T7.3: Asset-only evidence on legacy asset', async ({ page, context }) => {
    // Seed legacy asset without acquisition
    const legacyRes = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Legacy Switch Unit', 'AST-T7-LEGACY-01', 'SN-T7-LEG-01', '${custodianUserId}', NULL)
      RETURNING id;
    `);
    const legacyId = legacyRes.rows[0].id;

    await loginAs(page, context, custodianUserId);

    await page.goto(`${targetBaseUrl}/assets/${legacyId}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();

    // Create asset-only evidence
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-type-input"]').fill('Warranty Card');
    await page.locator('[data-testid="create-ref-text-input"]').fill('WAR-LEGACY-2026-99');
    await page.locator('[data-testid="create-desc-input"]').fill('Original legacy maintenance agreement');
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();

    // Verify evidence created and displayed
    await expect(page.locator('[data-testid="evidence-table"]')).toBeVisible();
    await expect(page.getByText('WAR-LEGACY-2026-99')).toBeVisible();
  });

  test('Journey T7.4: Role permissions & dynamic revocation in browser', async ({ page, context }) => {
    // 1. Seed Asset
    const astRes = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by)
      VALUES ('Protected Sensor', 'AST-T7-PROT-1', 'SN-T7-PROT-1', '${custodianUserId}')
      RETURNING id;
    `);
    const assetId = astRes.rows[0].id;

    // Seed an evidence record on it
    await pool.query(`
      WITH ins AS (
        INSERT INTO evidence_records (reference_text, created_by)
        VALUES ('Calibration Certificate #CAL-001', '${custodianUserId}')
        RETURNING id
      )
      INSERT INTO evidence_asset_links (evidence_id, asset_id)
      SELECT id, '${assetId}' FROM ins;
    `);

    // 2. Read-only user can view but not create or correct
    await loginAs(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.getByText('Calibration Certificate #CAL-001')).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).not.toBeVisible();
    await expect(page.locator('[data-testid^="correct-evidence-btn-"]')).not.toBeVisible();

    // 3. Dynamic role revocation test:
    // Create new temporary custodian
    const pw = await UserService.hashPassword('Pass123!');
    const tempUserRes = await pool.query(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES ('temp_custodian_e2e', '${pw}', true)
      RETURNING id;
    `);
    const tempUserId = tempUserRes.rows[0].id;
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ('${tempUserId}', 'ASSET_CUSTODIAN')`
    );

    await switchActor(page, context, tempUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeVisible();

    // Revoke role in DB
    await pool.query(`DELETE FROM user_roles WHERE user_id = '${tempUserId}'`);

    // Click add evidence and attempt submit
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill('Unauthorized after revocation');
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();

    // Should surface 403 Forbidden error in UI
    await expect(page.locator('[data-testid="evidence-create-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="evidence-create-error"]')).toContainText('Forbidden');
  });

  test('Journey T7.5: Uncertain mutation recovery, focus revalidation & relationship pagination', async ({ page, context }) => {
    // 1. Seed Acquisition and 30 Assets
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-07', 'PO-T7-E2E-005', 'T7 Recovery & Pagination Acquisition', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    const assetIds: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const aRes = await pool.query(`
        INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
        VALUES ('Paging Node ${i}', 'AST-T7-PAG-${i}', 'SN-T7-PAG-${i}', '${custodianUserId}', '${acqId}')
        RETURNING id;
      `);
      assetIds.push(aRes.rows[0].id);
    }

    // Seed Evidence linking all 30 assets
    const evRes = await pool.query(`
      INSERT INTO evidence_records (reference_text, acquisition_id, created_by)
      VALUES ('Paging Master Consignment', '${acqId}', '${custodianUserId}')
      RETURNING id;
    `);
    const evId = evRes.rows[0].id;

    for (const aId of assetIds) {
      await pool.query(`
        INSERT INTO evidence_asset_links (evidence_id, asset_id) VALUES ('${evId}', '${aId}');
      `);
    }

    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="evidence-table"]')).toBeVisible();

    // 2. Relationship pagination: verify load more button visible and clickable
    await expect(page.locator(`[data-testid="load-more-assets-btn-${evId}"]`)).toBeVisible();
    await page.locator(`[data-testid="load-more-assets-btn-${evId}"]`).click();
    await expect(page.locator(`[data-testid="unlink-asset-btn-${assetIds[29]}"]`)).toBeVisible();

    // 3. Uncertain create & focus revalidation:
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill('Uncertain Focus Recovery E2E');

    let finishAbort: () => void = () => {};
    const abortDone = new Promise<void>((r) => { finishAbort = r; });
    await page.route('**/evidence', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      try {
        await route.fetch();
        await route.abort('failed');
      } finally {
        finishAbort();
      }
    });

    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await abortDone;
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });

    // Trigger focus revalidation: alert must remain visible
    const refetched = page.waitForResponse((r) => new URL(r.url()).pathname === `/acquisitions/${acqId}`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refetched;
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();

    // Click retry: should commit successfully and dismiss alert
    await page.locator('[data-testid="retry-mutation-btn"]').click();
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).not.toBeVisible();
    await expect(page.getByText('Uncertain Focus Recovery E2E')).toBeVisible();
  });

  test('Journey T7.6: Cookie actor switch draft isolation & pending focus protected facts masking', async ({ page, context }) => {
    // 1. Seed Acquisition with sensitive amount and facts
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, total_amount, currency, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-08', '500000.00', 'THB', 'PO-T7-CONF-999', 'Confidential pricing notes', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    // Login as custodian
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);

    // Verify warning banner and amount are visible when fully loaded
    await expect(page.locator('#whole-total-warning')).toBeVisible();
    await expect(page.locator('#fact-amount')).toContainText('500000.00 THB');

    // Open create form and enter an unsaved draft
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill('Custodian Secret Unsaved Draft');

    // Create a second custodian user for testing actor switch in mounted component
    const pwdHash = await UserService.hashPassword('Password123!');
    const secondRes = await pool.query(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES ('second_custodian_e2e_${Date.now()}', '${pwdHash}', true)
      RETURNING id;
    `);
    const secondCustodianId = secondRes.rows[0].id;
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`,
      [secondCustodianId]
    );

    // Switch actor cookie to second custodian while page remains mounted
    await loginAs(page, context, secondCustodianId);
    const newSession = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/session-check');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await newSession;

    // Form was open, but on actor switch it must be closed
    await expect(page.locator('[data-testid="evidence-create-form"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeVisible();

    // Open create form as second custodian: draft must be clean / empty
    await page.locator('[data-testid="add-evidence-btn"]').click();
    const draftValue = await page.locator('[data-testid="create-ref-text-input"]').inputValue();
    expect(draftValue).toBe('');

    // Test pending focus masking: intercept acquisition read and delay it
    let resumeFetch: () => void = () => {};
    const fetchHeld = new Promise<void>((r) => { resumeFetch = r; });
    await page.route(`**/acquisitions/${acqId}*`, async (route) => {
      if (route.request().method() === 'GET') {
        await fetchHeld;
        await route.fulfill({ status: 403, json: { message: 'Forbidden' } });
      } else {
        await route.continue();
      }
    });

    // Trigger focus revalidation: while request is pending, facts must be masked
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#whole-total-warning')).not.toBeVisible();
    await expect(page.locator('#fact-amount')).not.toBeVisible();
    await expect(page.locator('#fact-reference')).not.toBeVisible();

    // Release held response
    resumeFetch();
    await expect(page.locator('#acquisition-error-alert')).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.7: Preflight response held across focus revalidation drops mutation, preserves version 1, then succeeds in new epoch (F3)', async ({
    page,
    context,
  }) => {
    // 1. Seed Acquisition and Asset
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-09', 'PO-T7-E2E-007', 'T7 Preflight Focus Test', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    const assetRes = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Preflight Target Asset', 'AST-T7-PRE-1', 'SN-T7-PRE-1', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const assetId = assetRes.rows[0].id;

    // 2. Seed unlinked evidence (acquisition_id NULL, linked to asset)
    const evRes = await pool.query(`
      INSERT INTO evidence_records (reference_text, description, acquisition_id, version, created_by)
      VALUES ('REF-PREFLIGHT-001', 'Initial unlinked preflight evidence', NULL, 1, '${custodianUserId}')
      RETURNING id;
    `);
    const evId = evRes.rows[0].id;

    await pool.query(`
      INSERT INTO evidence_asset_links (evidence_id, asset_id)
      VALUES ('${evId}', '${assetId}');
    `);
    await pool.query(`
      INSERT INTO evidence_history (evidence_id, version, action, actor_id, after_state)
      VALUES ('${evId}', 1, 'CREATED', '${custodianUserId}', '{"reference_text": "REF-PREFLIGHT-001"}');
    `);

    // 3. Login as custodian and navigate to acquisition page
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();

    // 4. Install async-only barrier holding the parsed preflight JSON body
    await page.evaluate((targetId) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const u = new URL(typeof args[0] === 'string' ? args[0] : (args[0] as any).url, location.href);
        if (
          u.pathname === `/evidence/${targetId}` &&
          (!args[1]?.method || args[1].method === 'GET') &&
          (window as any).shouldHoldPreflight
        ) {
          (window as any).shouldHoldPreflight = false;
          const read = response.json.bind(response);
          response.json = async () => {
            const parsed = await read();
            (window as any).leadBodyHeld = true;
            await new Promise((resolve) => {
              (window as any).leadReleaseBody = resolve;
            });
            return parsed;
          };
        }
        return response;
      };
    }, evId);

    // Track POST requests to /evidence/:id/correct
    let latePostCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes(`/evidence/${evId}/correct`)) {
        latePostCount++;
      }
    });

    // 5. Open Link Existing form and fill inputs
    await page.locator('[data-testid="link-existing-evidence-btn"]').click();
    await expect(page.locator('[data-testid="link-existing-evidence-form"]')).toBeVisible();
    await page.locator('[data-testid="link-existing-id-input"]').fill(evId);
    await page.locator('[data-testid="link-existing-reason-input"]').fill('Attach the known reference to its acquisition');

    // Arm the barrier
    await page.evaluate(() => {
      (window as any).shouldHoldPreflight = true;
    });

    // 6. Click submit: triggers GET /evidence/:id and enters the held response.json() barrier
    await page.locator('[data-testid="submit-link-existing-btn"]').click();
    await page.waitForFunction(() => (window as any).leadBodyHeld === true);

    // 7. Trigger and complete focus verification
    const focusSession = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/session-check');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await focusSession;

    // Prove form is retired/closed and evidence table is visible
    await expect(page.locator('[data-testid="link-existing-evidence-form"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="link-existing-evidence-btn"]')).toBeVisible();

    // 8. Assert pre-release state in DB: version 1, acquisition_id remains NULL
    const checkBefore = await pool.query(
      'SELECT acquisition_id, version FROM evidence_records WHERE id = $1',
      [evId]
    );
    expect(checkBefore.rows[0].version).toBe(1);
    expect(checkBefore.rows[0].acquisition_id).toBeNull();

    // 9. Release the held response body
    await page.evaluate(() => (window as any).leadReleaseBody?.());

    // Wait to confirm zero late POST requests
    await page.waitForTimeout(500);
    expect(latePostCount).toBe(0);

    const checkAfterRelease = await pool.query(
      'SELECT acquisition_id, version FROM evidence_records WHERE id = $1',
      [evId]
    );
    expect(checkAfterRelease.rows[0].version).toBe(1);
    expect(checkAfterRelease.rows[0].acquisition_id).toBeNull();

    // 10. Start a separate explicit legitimate action in the current authorized epoch
    await page.locator('[data-testid="link-existing-evidence-btn"]').click();
    await expect(page.locator('[data-testid="link-existing-evidence-form"]')).toBeVisible();
    await page.locator('[data-testid="link-existing-id-input"]').fill(evId);
    await page.locator('[data-testid="link-existing-reason-input"]').fill('Attach in current authorized epoch');
    await page.locator('[data-testid="submit-link-existing-btn"]').click();

    // Form closes on success and evidence row appears
    await expect(page.locator('[data-testid="link-existing-evidence-form"]')).not.toBeVisible();
    expect(latePostCount).toBe(1);

    await expect(page.locator(`[data-testid="evidence-row-${evId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="evidence-version-${evId}"]`)).toHaveText('v2');

    // Verify DB state: version 2, acquisition_id updated to acqId
    const checkFinal = await pool.query(
      'SELECT acquisition_id, version FROM evidence_records WHERE id = $1',
      [evId]
    );
    expect(checkFinal.rows[0].version).toBe(2);
    expect(checkFinal.rows[0].acquisition_id).toBe(acqId);

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.8: Committed POST response held across focus revalidation enters visible quarantine, blocks new draft, resolves via same-token retry, and allows fresh-token new action (F3)', async ({
    page,
    context,
  }) => {
    const createDeferred = () => {
      let resolve: any, reject: any;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    // 1. Seed Acquisition and Asset
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-10', 'PO-T7-E2E-008', 'T7 Held Submit Intent Test', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    const assetRes = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Intent Target Asset', 'AST-T7-INT-1', 'SN-T7-INT-1', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const assetId = assetRes.rows[0].id;

    // 2. Login as custodian and navigate to acquisition page
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeVisible();

    // 3. Open Add Evidence form and fill reference text
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await expect(page.locator('[data-testid="evidence-create-form"]')).toBeVisible();
    await page.locator('[data-testid="create-ref-text-input"]').fill('R5 committed held focus');

    // 4. Install network route: hold delivery AFTER Fastify/PG commits 201
    const committedStarted = createDeferred();
    const releaseDelivery = createDeferred();
    let initialToken: string | undefined;

    await page.route('**/evidence', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      initialToken = route.request().headers()['x-retry-token'];
      const response = await route.fetch();
      committedStarted.resolve(response.status());
      await releaseDelivery.promise;
      try {
        await route.fulfill({ response });
      } catch {}
    });

    // 5. Submit form
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();

    // Wait for Fastify to return 201 to the route handler
    const serverStatus = await committedStarted.promise;
    expect(serverStatus).toBe(201);
    expect(initialToken).toBeDefined();

    // Independently verify PostgreSQL committed the row
    const rowCheckBefore = await pool.query(
      'SELECT count(*)::int as count FROM evidence_records WHERE reference_text = $1',
      ['R5 committed held focus']
    );
    expect(rowCheckBefore.rows[0].count).toBe(1);

    // 6. Trigger and complete focus revalidation while delivery is held
    const focusRefetch = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/evidence' &&
        new URL(r.url()).searchParams.get('acquisition_id') === acqId
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await focusRefetch;

    // 7. Release held delivery
    releaseDelivery.resolve(true);
    await page.unroute('**/evidence');

    // 8. Assert visible quarantine state:
    // - uncertain-mutation-alert is visible
    // - add-evidence-btn is disabled (mutation-blocking quarantine prevents starting phantom new action)
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeDisabled();

    // 9. Resolve quarantine via same-actor retry: click Retry Mutation
    let retryTokenSent: string | undefined;
    let retryBodySent: any;
    const retryRequestPromise = page.waitForRequest((req) => {
      if (req.method() === 'POST' && req.url().endsWith('/evidence')) {
        retryTokenSent = req.headers()['x-retry-token'];
        retryBodySent = req.postDataJSON();
        return true;
      }
      return false;
    });

    await page.locator('[data-testid="retry-mutation-btn"]').click();
    await retryRequestPromise;

    // Assert retry sent the EXACT unchanged token and unchanged payload
    expect(retryTokenSent).toBe(initialToken);
    expect(retryBodySent.reference_text).toBe('R5 committed held focus');

    // 10. Once resolved:
    // - uncertain-mutation-alert disappears
    // - add-evidence-btn is re-enabled
    // - original evidence row is displayed
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText('R5 committed held focus');

    // 11. Now start an explicit NEW action with a NEW reference
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await expect(page.locator('[data-testid="evidence-create-form"]')).toBeVisible();
    await page.locator('[data-testid="create-ref-text-input"]').fill('R5 genuinely new intended reference');

    let newTokenSent: string | undefined;
    let newBodySent: any;
    const newRequestPromise = page.waitForRequest((req) => {
      if (req.method() === 'POST' && req.url().endsWith('/evidence')) {
        newTokenSent = req.headers()['x-retry-token'];
        newBodySent = req.postDataJSON();
        return true;
      }
      return false;
    });

    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await newRequestPromise;

    // Assert new submission used a FRESH token and its own new immutable payload
    expect(newTokenSent).toBeDefined();
    expect(newTokenSent).not.toBe(initialToken);
    expect(newBodySent.reference_text).toBe('R5 genuinely new intended reference');

    // Form closes on success and new row is visible
    await expect(page.locator('[data-testid="evidence-create-form"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText('R5 genuinely new intended reference');

    // 12. Independently verify PostgreSQL has precisely 1 row for each intent
    const rowCheckFinal = await pool.query(
      'SELECT reference_text FROM evidence_records WHERE reference_text IN ($1, $2) ORDER BY reference_text',
      ['R5 committed held focus', 'R5 genuinely new intended reference']
    );
    expect(rowCheckFinal.rows.length).toBe(2);
    expect(rowCheckFinal.rows[0].reference_text).toBe('R5 committed held focus');
    expect(rowCheckFinal.rows[1].reference_text).toBe('R5 genuinely new intended reference');

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.9: Real Actor A->B cookie switch under mounted live document isolates Actor B from Actor A held mutation, enables Actor B independent mutation, and restores Actor A recovery on switch back (F3 ARCH-A1 D1-D4)', async ({
    page,
    context,
  }) => {
    const createDeferred = () => {
      let resolve: any, reject: any;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    // 1. Seed second custodian user (Actor B)
    const passwordHash = await UserService.hashPassword('Password123!');
    const userBRes = await pool.query(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES ('custodian_b_${Date.now()}', '${passwordHash}', true)
      RETURNING id;
    `);
    const actorBId = userBRes.rows[0].id;
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`, [actorBId]);

    // 2. Seed Acquisition and Asset
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-11', 'PO-T7-E2E-009', 'T7 Actor Switch Isolation Test', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    // 3. Login as Actor A (custodianUserId) and navigate to acquisition page
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeVisible();

    // 4. Actor A opens create form and enters reference
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await expect(page.locator('[data-testid="evidence-create-form"]')).toBeVisible();
    await page.locator('[data-testid="create-ref-text-input"]').fill('R5 Actor A held delivery');

    // 5. Install network barrier: hold POST /evidence AFTER Fastify/PG commits 201
    const committedStarted = createDeferred();
    const releaseDelivery = createDeferred();
    let actorAToken: string | undefined;

    await page.route('**/evidence', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      actorAToken = route.request().headers()['x-retry-token'];
      const response = await route.fetch();
      committedStarted.resolve(response.status());
      await releaseDelivery.promise;
      try {
        await route.fulfill({ response });
      } catch {}
    });

    // 6. Actor A clicks submit: server commits 201, delivery is held
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    const serverStatus = await committedStarted.promise;
    expect(serverStatus).toBe(201);
    expect(actorAToken).toBeDefined();

    // Verify DB has Actor A's committed record
    const checkDbA = await pool.query(
      'SELECT id FROM evidence_records WHERE reference_text = $1',
      ['R5 Actor A held delivery']
    );
    expect(checkDbA.rowCount).toBe(1);

    // 7. Switch session cookies in browser context to Actor B
    const sessionB = await sessionService.createSession(actorBId);
    await context.addCookies([
      {
        name: 'session',
        value: sessionB.token,
        url: targetBaseUrl,
      },
    ]);

    // 8. Trigger focus revalidation on the SAME mounted document
    const sessionResponseB = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/session-check');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const sessionDataB = await (await sessionResponseB).json();
    expect(sessionDataB.user.id).toBe(actorBId);

    // 9. Assert Actor B's state:
    // - Actor B's action controls are enabled and immediately usable
    // - Actor B sees NO uncertain-mutation-alert
    // - Actor B sees NO draft data from Actor A
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="link-existing-evidence-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="evidence-create-form"]')).not.toBeVisible();

    // 10. Release Actor A's held delivery response
    releaseDelivery.resolve(true);
    await page.unroute('**/evidence');
    await page.waitForTimeout(200);

    // Assert Actor B remains completely unpoisoned:
    // - Controls remain enabled
    // - NO alert banner appears
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).not.toBeVisible();

    // 11. Actor B performs a valid independent mutation
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await expect(page.locator('[data-testid="evidence-create-form"]')).toBeVisible();
    await page.locator('[data-testid="create-ref-text-input"]').fill('R5 Actor B independent evidence');

    let actorBToken: string | undefined;
    const requestBPromise = page.waitForRequest((req) => {
      if (req.method() === 'POST' && req.url().endsWith('/evidence')) {
        actorBToken = req.headers()['x-retry-token'];
        return true;
      }
      return false;
    });

    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await requestBPromise;

    // Form closes on success and table shows Actor B's row
    await expect(page.locator('[data-testid="evidence-create-form"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText('R5 Actor B independent evidence');
    expect(actorBToken).toBeDefined();
    expect(actorBToken).not.toBe(actorAToken);

    // Verify DB has both records
    const checkBoth = await pool.query(
      'SELECT reference_text, created_by FROM evidence_records WHERE reference_text IN ($1, $2) ORDER BY reference_text',
      ['R5 Actor A held delivery', 'R5 Actor B independent evidence']
    );
    expect(checkBoth.rowCount).toBe(2);
    expect(checkBoth.rows[0].created_by).toBe(custodianUserId);
    expect(checkBoth.rows[1].created_by).toBe(actorBId);

    // 12. Switch session cookies back to Actor A on the same mounted document
    const sessionA2 = await sessionService.createSession(custodianUserId);
    await context.addCookies([
      {
        name: 'session',
        value: sessionA2.token,
        url: targetBaseUrl,
      },
    ]);

    const sessionResponseA = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/session-check');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const sessionDataA = await (await sessionResponseA).json();
    expect(sessionDataA.user.id).toBe(custodianUserId);

    // 13. Assert Actor A's state:
    // - Actor A's confirmed/unresolved operation is restored
    // - uncertain-mutation-alert is visible for Actor A
    // - add-evidence-btn is disabled for Actor A (quarantined)
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeDisabled();

    // 14. Actor A clicks retry-mutation-btn to acknowledge/recover
    let retryTokenSent: string | undefined;
    const retryReqPromise = page.waitForRequest((req) => {
      if (req.method() === 'POST' && req.url().endsWith('/evidence')) {
        retryTokenSent = req.headers()['x-retry-token'];
        return true;
      }
      return false;
    });

    await page.locator('[data-testid="retry-mutation-btn"]').click();
    await retryReqPromise;
    expect(retryTokenSent).toBe(actorAToken);

    // Banner disappears and controls are usable again
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.10: SPA navigation unmount and remount retains unresolved operation in memory without persistent storage and permits clean recovery (F3 ARCH-A1 D1-D4)', async ({
    page,
    context,
  }) => {
    const createDeferred = () => {
      let resolve: any, reject: any;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    // 1. Seed Acquisition and Asset
    const acqRes = await pool.query(`
      INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
      VALUES ('Purchase Order', '2026-03-12', 'PO-T7-E2E-010', 'T7 Unmount Remount Test', '${custodianUserId}')
      RETURNING id;
    `);
    const acqId = acqRes.rows[0].id;

    const assetRes = await pool.query(`
      INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
      VALUES ('Unmount Test Asset', 'AST-T7-UNM-1', 'SN-T7-UNM-1', '${custodianUserId}', '${acqId}')
      RETURNING id;
    `);
    const assetId = assetRes.rows[0].id;

    // 2. Login as custodian and open acquisition page
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();

    // 3. Open create form and enter reference
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await expect(page.locator('[data-testid="evidence-create-form"]')).toBeVisible();
    await page.locator('[data-testid="create-ref-text-input"]').fill('R5 SPA unmount remount evidence');

    // 4. Install route holding delivery AFTER commit
    const committedStarted = createDeferred();
    const releaseDelivery = createDeferred();
    let originalToken: string | undefined;

    await page.route('**/evidence', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      originalToken = route.request().headers()['x-retry-token'];
      const response = await route.fetch();
      committedStarted.resolve(response.status());
      await releaseDelivery.promise;
      try {
        await route.fulfill({ response });
      } catch {}
    });

    // 5. Submit form
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    const status = await committedStarted.promise;
    expect(status).toBe(201);
    expect(originalToken).toBeDefined();

    // 6. Client-side navigate to asset detail page (unmounting EvidencePanel for acquisition)
    await page.locator(`a[href="/assets/${assetId}"]`).first().click();
    await expect(page.locator(`a[href="/acquisitions/${acqId}"]`).first()).toBeVisible();

    // 7. Release held delivery while EvidencePanel for acquisition was unmounted
    releaseDelivery.resolve(true);
    await page.unroute('**/evidence');
    await page.waitForTimeout(200);

    // 8. Client-side navigate back to acquisition page
    await page.locator(`a[href="/acquisitions/${acqId}"]`).first().click();
    await expect(page.locator('[data-testid="evidence-panel-section"]')).toBeVisible();

    // 9. Assert EvidencePanel restored the unresolved/confirmed operation from in-memory coordinator:
    // - uncertain-mutation-alert is visible
    // - add-evidence-btn is disabled
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeDisabled();

    // 10. Click retry to recover and settle
    let retryTokenSent: string | undefined;
    const retryPromise = page.waitForRequest((req) => {
      if (req.method() === 'POST' && req.url().endsWith('/evidence')) {
        retryTokenSent = req.headers()['x-retry-token'];
        return true;
      }
      return false;
    });

    await page.locator('[data-testid="retry-mutation-btn"]').click();
    await retryPromise;
    expect(retryTokenSent).toBe(originalToken);

    // 11. Assert resolved state:
    // - uncertain-mutation-alert not visible
    // - add-evidence-btn enabled
    // - row visible in table
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText('R5 SPA unmount remount evidence');

    // 12. Verify exactly-once in PG
    const checkDb = await pool.query(
      'SELECT count(*)::int as count FROM evidence_records WHERE reference_text = $1',
      ['R5 SPA unmount remount evidence']
    );
    expect(checkDb.rows[0].count).toBe(1);

    await page.unrouteAll({ behavior: 'wait' });
  });

  // ---------------------------------------------------------------------------------------------
  // ARCH-A2 (SF1-SF4, #28 comment 6436826247) regressions for F3 H1-H4.
  // Faults are labeled: TRANSPORT faults let the server really commit and then drop or rewrite
  // the delivered response; the DECODER barrier is test instrumentation of window.fetch that
  // holds a response body. Authorization, sessions and actor changes are always real.
  // ---------------------------------------------------------------------------------------------

  const deferred = <T = unknown>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };

  const seedCustodianActor = async (label: string): Promise<string> => {
    const passwordHash = await UserService.hashPassword('Password123!');
    const res = await pool.query(
      `INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id`,
      [`${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, passwordHash]
    );
    const id = res.rows[0].id as string;
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')`, [id]);
    return id;
  };

  const seedAcquisitionFor = async (actorId: string, sourceReference: string): Promise<string> => {
    const res = await pool.query(
      `INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, notes, created_by)
       VALUES ('Purchase Order', '2026-03-20', $1, 'T7 ARCH-A2 regression', $2) RETURNING id`,
      [sourceReference, actorId]
    );
    return res.rows[0].id as string;
  };

  const revokeRoles = (actorId: string) => pool.query('DELETE FROM user_roles WHERE user_id = $1', [actorId]);
  const restoreCustodian = (actorId: string) =>
    pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN') ON CONFLICT DO NOTHING`,
      [actorId]
    );

  // Lets the page learn the current cookie actor through its own focus revalidation.
  const refocus = async (page: any, expectedActorId: string) => {
    const check = page.waitForResponse((r: any) => new URL(r.url()).pathname === '/auth/session-check');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const data = await (await check).json();
    expect(data.user.id).toBe(expectedActorId);
  };

  const countEvidence = async (referenceText: string, createdBy?: string): Promise<number> => {
    const res = createdBy
      ? await pool.query(
          'SELECT count(*)::int AS n FROM evidence_records WHERE reference_text = $1 AND created_by = $2',
          [referenceText, createdBy]
        )
      : await pool.query('SELECT count(*)::int AS n FROM evidence_records WHERE reference_text = $1', [referenceText]);
    return res.rows[0].n as number;
  };

  const isEvidenceMutation = (req: any) =>
    req.method() === 'POST' && /^\/evidence(\/[^/]+\/correct)?$/.test(new URL(req.url()).pathname);

  // TRANSPORT fault (one shot): the server commits the next create, the browser never receives
  // the response. Later requests pass through untouched.
  const loseNextCreateDelivery = async (page: any) => {
    const committed = deferred<{ status: number; token: string }>();
    const matcher = (url: URL) => url.pathname === '/evidence';
    let used = false;
    await page.route(matcher, async (route: any) => {
      if (route.request().method() !== 'POST' || used) return route.fallback();
      used = true;
      const token = route.request().headers()['x-retry-token'];
      const response = await route.fetch();
      committed.resolve({ status: response.status(), token });
      await route.abort('failed');
    });
    return { committed: committed.promise, unroute: () => page.unroute(matcher) };
  };

  // TRANSPORT fault (one shot): the server processes the next mutation on `pathname`; the
  // browser receives a rewritten status/body instead of the real one.
  const rewriteNextMutationDelivery = async (
    page: any,
    pathname: string,
    rewrite: (status: number, body: any) => { status: number; body: string }
  ) => {
    const served = deferred<{ status: number; body: any; token: string }>();
    const matcher = (url: URL) => url.pathname === pathname;
    let used = false;
    await page.route(matcher, async (route: any) => {
      if (route.request().method() !== 'POST' || used) return route.fallback();
      used = true;
      const token = route.request().headers()['x-retry-token'];
      const response = await route.fetch();
      const status = response.status();
      const body = await response.json();
      served.resolve({ status, body, token });
      const out = rewrite(status, body);
      await route.fulfill({ status: out.status, contentType: 'application/json', body: out.body });
    });
    return { served: served.promise, unroute: () => page.unroute(matcher) };
  };

  // DECODER barrier: holds the body decode of the next matching fetch response until released;
  // mode 'malformed' then fails the decode. `__e2eBodyConsumed` turns true one task after the
  // held body reaches the app, so the app's continuation has run.
  const installDecoderBarrier = async (page: any) => {
    await page.addInitScript(() => {
      const w = window as any;
      const original = w.fetch.bind(w);
      w.fetch = async (input: any, init?: any) => {
        const res = await original(input, init);
        const rule = w.__e2eBodyBarrier;
        const method = (init && init.method) || 'GET';
        const url = new URL(typeof input === 'string' ? input : input.url, w.location.href);
        if (!rule || rule.method !== method || rule.path !== url.pathname) return res;
        w.__e2eBodyBarrier = null;
        w.__e2eBodyConsumed = false;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        w.__e2eReleaseBody = release;
        w.__e2eBodyHeldStatus = res.status;
        const text = rule.mode === 'malformed' ? '{"id":' : await res.text();
        const deliver = async () => {
          await gate;
          setTimeout(() => (w.__e2eBodyConsumed = true), 0);
          return text;
        };
        return new Proxy(res, {
          get(target: any, prop: any) {
            if (prop === 'json') return async () => JSON.parse(await deliver());
            if (prop === 'text') return deliver;
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    });
  };

  // Waits until a held body reached the app and the next frame rendered its continuation.
  const releaseHeldBody = async (page: any) => {
    await page.evaluate(() => (window as any).__e2eReleaseBody());
    await expect.poll(() => page.evaluate(() => (window as any).__e2eBodyConsumed)).toBe(true);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };

  test('Journey T7.11 (ARCH-A2 H1): replays denied after revocation, before and at the POST, keep the committed-unknown create quarantined; restored rights and the same-token replay settle exactly one Evidence', async ({
    page,
    context,
  }) => {
    const actorA = await seedCustodianActor('a2_h1');
    const acqId = await seedAcquisitionFor(actorA, 'PO-T7-A2-H1');
    const ref = `A2 H1 committed then lost ${Date.now()}`;
    const mutationTokens: string[] = [];
    page.on('request', (req: any) => {
      if (isEvidenceMutation(req)) mutationTokens.push(req.headers()['x-retry-token']);
    });
    const alert = page.locator('[data-testid="uncertain-mutation-alert"]');
    const suspended = page.locator('[data-testid="uncertain-mutation-auth-suspended"]');
    const retry = page.locator('[data-testid="retry-mutation-btn"]');

    await loginAs(page, context, actorA);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(ref);

    const lost = await loseNextCreateDelivery(page);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    const { status, token: originalToken } = await lost.committed;
    expect(status).toBe(201);
    await lost.unroute();
    await expect(alert).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeDisabled();
    await expect(page.locator('[data-testid="link-existing-evidence-btn"]')).toBeDisabled();
    expect(await countEvidence(ref)).toBe(1);

    // 1. Real revocation; the replay's grant pre-check is denied, so nothing is sent.
    await revokeRoles(actorA);
    await retry.click();
    await expect(suspended).toBeVisible();
    await expect(alert).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toHaveCount(0);
    expect(mutationTokens).toEqual([originalToken]);

    // 2. Rights return, then disappear again between the pre-check and the POST: the replay POST
    //    itself gets a real 403, and the earlier attempt still counts as possibly committed.
    await restoreCustodian(actorA);
    await refocus(page, actorA);
    await expect(alert).toBeVisible();
    const checkMatcher = (url: URL) => url.pathname === '/auth/session-check';
    let revokedAtCheck = false;
    await page.route(checkMatcher, async (route: any) => {
      if (!revokedAtCheck) {
        revokedAtCheck = true;
        await revokeRoles(actorA);
      }
      await route.fallback();
    });
    const deniedReplay = page.waitForResponse((r: any) => isEvidenceMutation(r.request()));
    await retry.click();
    expect((await deniedReplay).status()).toBe(403);
    await page.unroute(checkMatcher);
    await expect(suspended).toBeVisible();
    await expect(alert).toBeVisible();
    expect(mutationTokens).toEqual([originalToken, originalToken]);
    expect(await countEvidence(ref)).toBe(1);

    // 3. Rights return for good. A double Retry claims one attempt only; the replay settles.
    await restoreCustodian(actorA);
    await refocus(page, actorA);
    await expect(alert).toBeVisible();
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeDisabled();
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="retry-mutation-btn"]') as HTMLButtonElement;
      button.click();
      button.click();
    });
    await expect(alert).toHaveCount(0);
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText(ref);
    expect(mutationTokens).toEqual([originalToken, originalToken, originalToken]);

    // Independent PostgreSQL observer: one Evidence, one history row, one create receipt.
    const ev = await pool.query('SELECT id, created_by FROM evidence_records WHERE reference_text = $1', [ref]);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].created_by).toBe(actorA);
    const history = await pool.query('SELECT count(*)::int AS n FROM evidence_history WHERE evidence_id = $1', [
      ev.rows[0].id,
    ]);
    expect(history.rows[0].n).toBe(1);
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM registration_retry_tokens WHERE actor_id = $1 AND operation = 'evidence:create'`,
      [actorA]
    );
    expect(receipts.rows[0].n).toBe(1);

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.12 (ARCH-A2 H2): with actor B logged in but no focus, actor A Retry verifies the session, sends zero A-intent POST and shields A facts; B stays usable and verified A recovers with the original token', async ({
    page,
    context,
  }) => {
    const actorA = await seedCustodianActor('a2_h2_a');
    const actorB = await seedCustodianActor('a2_h2_b');
    const acqId = await seedAcquisitionFor(actorA, 'PO-T7-A2-H2');
    const refVisible = `A2 H2 actor A visible fact ${Date.now()}`;
    const refA = `A2 H2 actor A intent ${Date.now()}`;
    const refB = `A2 H2 actor B own ${Date.now()}`;

    await loginAs(page, context, actorA);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(refVisible);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText(refVisible);

    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(refA);
    const lost = await loseNextCreateDelivery(page);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    const { token: tokenA } = await lost.committed;
    await lost.unroute();
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();

    // Real actor B login in the same browser context, without focus or revalidation: the page
    // still renders actor A and A's Retry button.
    await loginAs(page, context, actorB);
    const tokensAfterSwitch: string[] = [];
    const sessionActorsAfterSwitch: string[] = [];
    page.on('request', (req: any) => {
      if (isEvidenceMutation(req)) tokensAfterSwitch.push(req.headers()['x-retry-token']);
    });
    page.on('response', async (res: any) => {
      if (new URL(res.url()).pathname === '/auth/session-check') {
        sessionActorsAfterSwitch.push((await res.json().catch(() => null))?.user?.id ?? 'none');
      }
    });

    await page.locator('[data-testid="retry-mutation-btn"]').click();
    await expect(page.locator('[data-testid="uncertain-mutation-notice"]')).toContainText('ผู้ใช้อื่น');

    // Zero A-intent mutation under B's cookie, no B-owned record of A's intent, A's facts shielded.
    expect(tokensAfterSwitch).toEqual([]);
    expect(sessionActorsAfterSwitch).toContain(actorB);
    expect(await countEvidence(refA, actorB)).toBe(0);
    expect(await countEvidence(refA, actorA)).toBe(1);
    await expect(page.locator('[data-testid="evidence-panel-section"]')).not.toContainText(refVisible);

    // B's own, independently authorized workflow works once the page learns about B.
    await refocus(page, actorB);
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toHaveCount(0);
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(refB);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText(refB);
    expect(await countEvidence(refB, actorB)).toBe(1);

    // Positive control: verified actor A retries with the original token and current CSRF.
    await loginAs(page, context, actorA);
    await refocus(page, actorA);
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toBeVisible();
    const replay = page.waitForRequest((req: any) => isEvidenceMutation(req));
    await page.locator('[data-testid="retry-mutation-btn"]').click();
    expect((await replay).headers()['x-retry-token']).toBe(tokenA);
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toHaveCount(0);
    expect(await countEvidence(refA)).toBe(1);
    expect(await countEvidence(refA, actorA)).toBe(1);

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.13 (ARCH-A2 H3): actor A late 403, 201 and undecodable bodies released after actor B login leave B projection, controls and mutations intact; A recovers its own committed intent', async ({
    page,
    context,
  }) => {
    await installDecoderBarrier(page);
    for (const mode of ['403', '201', 'malformed'] as const) {
      const actorA = await seedCustodianActor(`a2_h3_${mode}_a`);
      const actorB = await seedCustodianActor(`a2_h3_${mode}_b`);
      const acqId = await seedAcquisitionFor(actorA, `PO-T7-A2-H3-${mode}`);
      const refA = `A2 H3 ${mode} actor A ${Date.now()}`;
      const refB1 = `A2 H3 ${mode} actor B before release ${Date.now()}`;
      const refB2 = `A2 H3 ${mode} actor B after release ${Date.now()}`;

      await loginAs(page, context, actorA);
      await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
      await page.locator('[data-testid="add-evidence-btn"]').click();
      await page.locator('[data-testid="create-ref-text-input"]').fill(refA);

      // A's POST gets a real response whose body decode is held: a real 403 after revocation, or
      // a real committed 201 delivered intact or undecodable.
      if (mode === '403') await revokeRoles(actorA);
      await page.evaluate((m: string) => {
        (window as any).__e2eBodyBarrier = { method: 'POST', path: '/evidence', mode: m === 'malformed' ? 'malformed' : 'hold' };
      }, mode);
      const served = page.waitForResponse(
        (r: any) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/evidence'
      );
      await page.locator('[data-testid="create-evidence-submit-btn"]').click();
      expect((await served).status(), mode).toBe(mode === '403' ? 403 : 201);
      await expect.poll(() => page.evaluate(() => (window as any).__e2eBodyHeldStatus)).toBe(mode === '403' ? 403 : 201);

      // Real actor B login, verified B UI and a successful B mutation while A's body is held.
      await loginAs(page, context, actorB);
      await refocus(page, actorB);
      await expect(page.locator('[data-testid="add-evidence-btn"]'), mode).toBeEnabled();
      await page.locator('[data-testid="add-evidence-btn"]').click();
      await page.locator('[data-testid="create-ref-text-input"]').fill(refB1);
      await page.locator('[data-testid="create-evidence-submit-btn"]').click();
      await expect(page.locator('[data-testid="evidence-table"]'), mode).toContainText(refB1);

      // Release A's stale body into the live document and let its continuation finish.
      await releaseHeldBody(page);

      // B's projection, controls and banners are untouched.
      await expect(page.locator('[data-testid="evidence-table"]'), mode).toContainText(refB1);
      await expect(page.locator('[data-testid="add-evidence-btn"]'), mode).toBeEnabled();
      await expect(page.locator('[data-testid="evidence-fetch-error"]'), mode).toHaveCount(0);
      await expect(page.locator('[data-testid="uncertain-mutation-alert"]'), mode).toHaveCount(0);

      // B can still mutate.
      await page.locator('[data-testid="add-evidence-btn"]').click();
      await page.locator('[data-testid="create-ref-text-input"]').fill(refB2);
      await page.locator('[data-testid="create-evidence-submit-btn"]').click();
      await expect(page.locator('[data-testid="evidence-table"]'), mode).toContainText(refB2);
      expect(await countEvidence(refB1, actorB), mode).toBe(1);
      expect(await countEvidence(refB2, actorB), mode).toBe(1);

      if (mode === '403') {
        expect(await countEvidence(refA), mode).toBe(0);
        await restoreCustodian(actorA);
        continue;
      }

      // A committed: back as A, the held operation is A's to recover, exactly once.
      expect(await countEvidence(refA, actorA), mode).toBe(1);
      await loginAs(page, context, actorA);
      await refocus(page, actorA);
      await expect(page.locator('[data-testid="uncertain-mutation-alert"]'), mode).toBeVisible();
      await page.locator('[data-testid="retry-mutation-btn"]').click();
      await expect(page.locator('[data-testid="uncertain-mutation-alert"]'), mode).toHaveCount(0);
      await expect(page.locator('[data-testid="evidence-table"]'), mode).toContainText(refA);
      expect(await countEvidence(refA), mode).toBe(1);
    }

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.14 (ARCH-A2 H4): only a receipt matching the operation settles it; rewritten 2xx bodies keep the original token in recovery until a valid replay', async ({
    page,
    context,
  }) => {
    const actorA = await seedCustodianActor('a2_h4');
    const acqId = await seedAcquisitionFor(actorA, 'PO-T7-A2-H4');
    const stamp = Date.now();
    await loginAs(page, context, actorA);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();

    const alert = page.locator('[data-testid="uncertain-mutation-alert"]');

    const replayAndSettle = async (expectedToken: string) => {
      const replay = page.waitForRequest((req: any) => isEvidenceMutation(req));
      await page.locator('[data-testid="retry-mutation-btn"]').click();
      expect((await replay).headers()['x-retry-token']).toBe(expectedToken);
      await expect(alert).toHaveCount(0);
    };

    // Create receipts: genuine 201, version 1, non-null history UUID.
    const createCases: Array<[string, (status: number, body: any) => { status: number; body: string }]> = [
      ['null body', () => ({ status: 201, body: 'null' })],
      ['malformed JSON', () => ({ status: 201, body: '{"id":' })],
      ['wrong status', (_s, b) => ({ status: 200, body: JSON.stringify(b) })],
      ['non-UUID id', (_s, b) => ({ status: 201, body: JSON.stringify({ ...b, id: 'not-a-uuid' }) })],
      ['missing id', (_s, b) => ({ status: 201, body: JSON.stringify({ version: b.version, history_id: b.history_id }) })],
      ['missing version', (_s, b) => ({ status: 201, body: JSON.stringify({ id: b.id, history_id: b.history_id }) })],
      ['version 2', (_s, b) => ({ status: 201, body: JSON.stringify({ ...b, version: 2 }) })],
      ['null history', (_s, b) => ({ status: 201, body: JSON.stringify({ ...b, history_id: null }) })],
    ];
    for (const [label, rewrite] of createCases) {
      const ref = `A2 H4 create ${label} ${stamp}`;
      await page.locator('[data-testid="add-evidence-btn"]').click();
      await page.locator('[data-testid="create-ref-text-input"]').fill(ref);
      const rewritten = await rewriteNextMutationDelivery(page, '/evidence', rewrite);
      await page.locator('[data-testid="create-evidence-submit-btn"]').click();
      const { status, token } = await rewritten.served;
      expect(status, label).toBe(201);
      await rewritten.unroute();
      await expect(alert, label).toBeVisible();
      await expect(page.locator('[data-testid="add-evidence-btn"]'), label).toBeDisabled();
      await replayAndSettle(token);
      expect(await countEvidence(ref), label).toBe(1);
    }

    // Positive control: a genuine create receipt settles on the first delivery.
    const baseRef = `A2 H4 correction target ${stamp}`;
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(baseRef);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText(baseRef);
    await expect(alert).toHaveCount(0);
    const target = await pool.query('SELECT id FROM evidence_records WHERE reference_text = $1', [baseRef]);
    const evidenceId = target.rows[0].id as string;
    const correctPath = `/evidence/${evidenceId}/correct`;
    const dbVersion = async () =>
      (await pool.query('SELECT version FROM evidence_records WHERE id = $1', [evidenceId])).rows[0].version as number;

    const openCorrection = async (reason: string, description: string | null) => {
      await page.locator(`[data-testid="correct-evidence-btn-${evidenceId}"]`).click();
      await expect(page.locator('[data-testid="evidence-correct-form"]')).toBeVisible();
      await page.locator('[data-testid="correct-reason-input"]').fill(reason);
      if (description !== null) await page.locator('[data-testid="correct-desc-input"]').fill(description);
    };

    // Changed-correction receipts: 200, the same id, version expected+1, history UUID.
    const correctionCases: Array<[string, (status: number, body: any) => { status: number; body: string }]> = [
      ['foreign id', (_s, b) => ({ status: 200, body: JSON.stringify({ ...b, id: crypto.randomUUID() }) })],
      ['unchanged version', (_s, b) => ({ status: 200, body: JSON.stringify({ ...b, version: b.version - 1 }) })],
      ['null history', (_s, b) => ({ status: 200, body: JSON.stringify({ ...b, history_id: null }) })],
      ['wrong status', (_s, b) => ({ status: 201, body: JSON.stringify(b) })],
    ];
    for (const [label, rewrite] of correctionCases) {
      const before = await dbVersion();
      await openCorrection(`A2 H4 reason ${label}`, `A2 H4 description ${label} ${stamp}`);
      const rewritten = await rewriteNextMutationDelivery(page, correctPath, rewrite);
      await page.locator('[data-testid="correct-evidence-submit-btn"]').click();
      const { status, body, token } = await rewritten.served;
      expect(status, label).toBe(200);
      expect(body.version, label).toBe(before + 1);
      await rewritten.unroute();
      await expect(alert, label).toBeVisible();
      await replayAndSettle(token);
      expect(await dbVersion(), label).toBe(before + 1);
    }

    // Positive control: a genuine no-op correction (200, same version, null history) settles.
    const beforeNoOp = await dbVersion();
    const historyBefore = await pool.query('SELECT count(*)::int AS n FROM evidence_history WHERE evidence_id = $1', [
      evidenceId,
    ]);
    await openCorrection('A2 H4 no-op reason', null);
    const noOp = page.waitForResponse(
      (r: any) => r.request().method() === 'POST' && new URL(r.url()).pathname === correctPath
    );
    await page.locator('[data-testid="correct-evidence-submit-btn"]').click();
    const noOpBody = await (await noOp).json();
    expect(noOpBody.history_id).toBeNull();
    expect(noOpBody.version).toBe(beforeNoOp);
    await expect(page.locator('[data-testid="evidence-correct-form"]')).toHaveCount(0);
    await expect(alert).toHaveCount(0);
    const historyAfter = await pool.query('SELECT count(*)::int AS n FROM evidence_history WHERE evidence_id = $1', [
      evidenceId,
    ]);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
    expect(await dbVersion()).toBe(beforeNoOp);

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.15 (ARCH-A2 H4): once a valid receipt is known, a replay settles only on that exact receipt even after the record moved on', async ({
    page,
    context,
    browser,
  }) => {
    const actorA = await seedCustodianActor('a2_h4h_a');
    const actorB = await seedCustodianActor('a2_h4h_b');
    const acqId = await seedAcquisitionFor(actorA, 'PO-T7-A2-H4H');
    const ref = `A2 H4 history target ${Date.now()}`;

    await loginAs(page, context, actorA);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(ref);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText(ref);
    const evidenceId = (await pool.query('SELECT id FROM evidence_records WHERE reference_text = $1', [ref])).rows[0]
      .id as string;
    const correctPath = `/evidence/${evidenceId}/correct`;
    const alert = page.locator('[data-testid="uncertain-mutation-alert"]');

    // A's correction commits (v2). Its genuine receipt arrives after the panel's auth epoch moved
    // (a visibilitychange dispatched on window reaches only the panel, so no reauthorization
    // aborts the POST): the receipt becomes known, the operation stays unsettled.
    await page.locator(`[data-testid="correct-evidence-btn-${evidenceId}"]`).click();
    await page.locator('[data-testid="correct-reason-input"]').fill('A2 H4 A correction');
    await page.locator('[data-testid="correct-desc-input"]').fill('A2 H4 A description');
    const committed = deferred<{ body: any; token: string }>();
    const release = deferred<void>();
    const heldMatcher = (url: URL) => url.pathname === correctPath;
    let held = false;
    await page.route(heldMatcher, async (route: any) => {
      if (route.request().method() !== 'POST' || held) return route.fallback();
      held = true;
      const response = await route.fetch();
      committed.resolve({ body: await response.json(), token: route.request().headers()['x-retry-token'] });
      await release.promise;
      await route.fulfill({ response });
    });
    await page.locator('[data-testid="correct-evidence-submit-btn"]').click();
    const { body: originalReceipt, token } = await committed.promise;
    expect(originalReceipt.version).toBe(2);
    expect(originalReceipt.history_id).toEqual(expect.any(String));

    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    const delivered = page.waitForResponse((r: any) => isEvidenceMutation(r.request()));
    release.resolve();
    expect((await delivered).status()).toBe(200);
    await page.unroute(heldMatcher);
    await expect(alert).toBeVisible();

    // Actor B, in a separate browser context, moves the record on to v3.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await loginAs(pageB, contextB, actorB);
    await pageB.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await pageB.locator(`[data-testid="correct-evidence-btn-${evidenceId}"]`).click();
    await pageB.locator('[data-testid="correct-reason-input"]').fill('A2 H4 B correction');
    await pageB.locator('[data-testid="correct-desc-input"]').fill('A2 H4 B description');
    await pageB.locator('[data-testid="correct-evidence-submit-btn"]').click();
    await expect(pageB.locator(`[data-testid="evidence-version-${evidenceId}"]`)).toHaveText('v3');
    await contextB.close();

    // A replay whose receipt differs from the known one only in its history id passes every
    // version rule; the known receipt alone must refuse it.
    const rewritten = await rewriteNextMutationDelivery(page, correctPath, (_s, b) => ({
      status: 200,
      body: JSON.stringify({ ...b, history_id: crypto.randomUUID() }),
    }));
    await page.locator('[data-testid="retry-mutation-btn"]').click();
    const { body: replayed } = await rewritten.served;
    expect(replayed).toEqual(originalReceipt);
    await rewritten.unroute();
    await expect(page.locator('[data-testid="uncertain-mutation-notice"]')).toBeVisible();
    await expect(alert).toBeVisible();

    // The genuine replay returns the exact known receipt and settles.
    const replay = page.waitForRequest((req: any) => isEvidenceMutation(req));
    await page.locator('[data-testid="retry-mutation-btn"]').click();
    expect((await replay).headers()['x-retry-token']).toBe(token);
    await expect(alert).toHaveCount(0);
    const row = await pool.query('SELECT version FROM evidence_records WHERE id = $1', [evidenceId]);
    expect(row.rows[0].version).toBe(3);
    const history = await pool.query('SELECT count(*)::int AS n FROM evidence_history WHERE evidence_id = $1', [
      evidenceId,
    ]);
    expect(history.rows[0].n).toBe(3);

    await page.unrouteAll({ behavior: 'wait' });
  });

  test('Journey T7.16 (ARCH-A2 SF2): a first submit whose session check is overtaken by a focus revalidation sends nothing; the resubmitted intent commits once', async ({
    page,
    context,
  }) => {
    const actorA = await seedCustodianActor('a2_unsent');
    const acqId = await seedAcquisitionFor(actorA, 'PO-T7-A2-UNSENT');
    const ref = `A2 unsent preflight ${Date.now()}`;
    const mutationTokens: string[] = [];
    page.on('request', (req: any) => {
      if (isEvidenceMutation(req)) mutationTokens.push(req.headers()['x-retry-token']);
    });

    await loginAs(page, context, actorA);
    await page.goto(`${targetBaseUrl}/acquisitions/${acqId}`);
    await page.locator('[data-testid="add-evidence-btn"]').click();
    await page.locator('[data-testid="create-ref-text-input"]').fill(ref);

    // Hold the panel's own session check (the first one after submit).
    const checkMatcher = (url: URL) => url.pathname === '/auth/session-check';
    const checkHeld = deferred<any>();
    const releaseCheck = deferred<void>();
    let heldOnce = false;
    await page.route(checkMatcher, async (route: any) => {
      if (heldOnce) return route.fallback();
      heldOnce = true;
      checkHeld.resolve(route.request());
      await releaseCheck.promise;
      await route.fallback().catch(() => {});
    });
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    const heldRequest = await checkHeld.promise;
    // The held check ends either way: answered, or aborted by the page's reauthorization.
    const heldDone = new Promise<void>((resolve) => {
      const done = (req: any) => {
        if (req === heldRequest) resolve();
      };
      page.on('requestfinished', done);
      page.on('requestfailed', done);
    });

    // A focus revalidation (the page's own session check passes through) moves the auth epoch.
    await refocus(page, actorA);
    releaseCheck.resolve();
    await heldDone;
    await page.unroute(checkMatcher);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    expect(mutationTokens).toEqual([]);
    expect(await countEvidence(ref)).toBe(0);
    await expect(page.locator('[data-testid="uncertain-mutation-alert"]')).toHaveCount(0);

    // The actor submits again in the new epoch: one fresh-token POST, one Evidence.
    await expect(page.locator('[data-testid="add-evidence-btn"]')).toBeEnabled();
    if ((await page.locator('[data-testid="evidence-create-form"]').count()) === 0) {
      await page.locator('[data-testid="add-evidence-btn"]').click();
    }
    await page.locator('[data-testid="create-ref-text-input"]').fill(ref);
    await page.locator('[data-testid="create-evidence-submit-btn"]').click();
    await expect(page.locator('[data-testid="evidence-table"]')).toContainText(ref);
    expect(mutationTokens.length).toBe(1);
    expect(await countEvidence(ref)).toBe(1);

    await page.unrouteAll({ behavior: 'wait' });
  });

  // T4 (#25, D7-A / D3): reference lists and Asset reference context through the real SPA.
  test('Journey T4.1: an Administrator maintains the flat reference lists; other viewers read them without controls', async ({ page, context }) => {
    await loginAs(page, context, adminUserId);
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-reference-lists').click();
    await page.waitForURL(`${targetBaseUrl}/admin/references`);

    // Every list starts empty: nothing is invented (D7).
    await expect(page.locator('#reference-empty')).toBeVisible();

    await page.locator('#reference-new-name').fill('Store Room E2E');
    await page.locator('#reference-add-btn').click();
    await expect(page.locator('#reference-message')).toHaveText('เพิ่มรายการแล้ว');
    await expect(page.locator('#reference-table')).toContainText('Store Room E2E');

    // Names are unique ignoring case and surrounding spaces.
    await page.locator('#reference-new-name').fill('  store room e2e ');
    await page.locator('#reference-add-btn').click();
    await expect(page.locator('#reference-message')).toContainText('มีชื่อนี้อยู่แล้ว');

    const storeRoom = await pool.query(`SELECT id FROM locations WHERE name = 'Store Room E2E'`);
    const storeRoomId = storeRoom.rows[0].id;
    await page.locator(`#reference-edit-${storeRoomId}`).click();
    await page.locator(`#reference-rename-${storeRoomId}`).fill('Store Room E2E North');
    await page.locator(`#reference-save-${storeRoomId}`).click();
    await expect(page.locator('#reference-message')).toHaveText('แก้ชื่อแล้ว');
    await expect(page.getByTestId(`reference-row-${storeRoomId}`)).toContainText('Store Room E2E North');

    await page.locator('#reference-new-name').fill('Old Annex E2E');
    await page.locator('#reference-add-btn').click();
    await expect(page.locator('#reference-table')).toContainText('Old Annex E2E');
    const annexId = (await pool.query(`SELECT id FROM locations WHERE name = 'Old Annex E2E'`)).rows[0].id;
    await page.locator(`#reference-toggle-${annexId}`).click();
    await expect(page.locator('#reference-message')).toHaveText('ปิดใช้งานแล้ว');
    await expect(page.getByTestId(`reference-row-${annexId}`)).toContainText('ปิดใช้งาน');

    await page.locator('#reference-tab-organization-units').click();
    await expect(page.locator('#reference-empty')).toBeVisible();
    await page.locator('#reference-new-name').fill('Finance Unit E2E');
    await page.locator('#reference-add-btn').click();
    await expect(page.locator('#reference-table')).toContainText('Finance Unit E2E');

    await page.locator('#reference-tab-persons').click();
    await page.locator('#reference-new-name').fill('Somchai E2E');
    await page.locator('#reference-add-btn').click();
    await expect(page.locator('#reference-table')).toContainText('Somchai E2E');

    // Each entry keeps its maintenance history: who, when, before → after (#25 PO decision 3).
    await page.locator('#reference-tab-locations').click();
    await page.locator(`#reference-history-${storeRoomId}`).click();
    const storeRoomHistory = page.getByTestId(`reference-history-panel-${storeRoomId}`);
    await expect(storeRoomHistory).toContainText('เพิ่มรายการ (ฉบับที่ 1): ชื่อ: “Store Room E2E”, สถานะ: ใช้งาน');
    await expect(storeRoomHistory).toContainText('แก้ไขรายการ (ฉบับที่ 2): ชื่อ: “Store Room E2E” → “Store Room E2E North”');
    await expect(storeRoomHistory).toContainText('โดย admin_e2e');
    await page.locator(`#reference-history-${annexId}`).click();
    await expect(page.getByTestId(`reference-history-panel-${annexId}`)).toContainText('สถานะ: ใช้งาน → ปิดใช้งาน');

    // There is no delete: every entry is still stored.
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM locations)::int AS l, (SELECT count(*) FROM organization_units)::int AS o, (SELECT count(*) FROM persons)::int AS p`
    );
    expect(counts.rows[0]).toEqual({ l: 2, o: 1, p: 1 });

    // A Read-only User sees the lists, without maintenance controls.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/admin/references`);
    await expect(page.getByTestId('reference-read-only-notice')).toBeVisible();
    await expect(page.locator('#reference-table')).toContainText('Store Room E2E North');
    await expect(page.locator('#reference-add-form')).toHaveCount(0);
    await expect(page.locator(`#reference-edit-${storeRoomId}`)).toHaveCount(0);
    await page.locator(`#reference-history-${storeRoomId}`).click();
    await expect(page.getByTestId(`reference-history-panel-${storeRoomId}`)).toContainText('“Store Room E2E North”');
  });

  // Today's Asia/Bangkok date, the default Effective Date of an ordinary registration (F003 Q11).
  const bangkokToday = () => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date())
        .map(({ type, value }) => [type, value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };

  test('Journey T4.2: a Custodian registers with optional context, sees it on detail, and finds it by each dimension and by legacy text', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/register`);
    await page.locator('input#name').fill('Projector T4');

    // Only active entries can be chosen at registration.
    const locationSelect = page.locator('#register-location_id');
    await expect(locationSelect.locator('option')).toHaveText(['— ไม่ระบุ —', 'Store Room E2E North']);
    // The Initial Assignment's Effective Date appears once a dimension is filled (F003 Q17).
    await expect(page.locator('#register-effective_date')).toHaveCount(0);
    await locationSelect.selectOption({ label: 'Store Room E2E North' });
    await page.locator('#register-organization_unit_id').selectOption({ label: 'Finance Unit E2E' });
    // A shared Asset needs no Responsible Person; the old record's text is kept as recorded.
    await page.locator('#register-legacy_responsible_person_text').fill('คุณสมชาย (ทะเบียนเดิม)');
    // An ordinary registration starts from today's date.
    await expect(page.locator('#register-effective_date')).toHaveValue(bangkokToday());
    await expect(page.locator('#register-effective_date_unknown')).not.toBeChecked();
    await page.locator('button#submit-register-btn').click();

    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const assetId = page.url().split('/assets/')[1];
    await expect(page.locator('#assignment-heading')).toHaveText('สถานที่ หน่วยงาน และผู้รับผิดชอบ');
    await expect(page.locator('#detail-location')).toHaveText('Store Room E2E North');
    await expect(page.locator('#detail-organization_unit')).toHaveText('Finance Unit E2E');
    await expect(page.locator('#detail-responsible_person')).toHaveText('ข้อความเดิม: คุณสมชาย (ทะเบียนเดิม)');
    await expect(page.getByTestId('assignment-timeline')).toContainText('กำหนดครั้งแรก');

    const stored = await pool.query(
      `SELECT e.effective_date::text AS effective_date, c.new_person_id, c.new_legacy_text,
              (SELECT count(*)::int FROM persons) AS persons
       FROM assignment_events e JOIN assignment_changes c ON c.event_id = e.id
       WHERE e.asset_id = $1 AND c.dimension = 'RESPONSIBLE_PERSON'`,
      [assetId]
    );
    expect(stored.rows[0].effective_date).toBe(bangkokToday());
    expect(stored.rows[0].new_person_id).toBeNull();
    expect(stored.rows[0].new_legacy_text).toBe('คุณสมชาย (ทะเบียนเดิม)');
    expect(stored.rows[0].persons).toBe(1); // no person invented from the legacy text

    // Search: each dimension filters on its own; together they combine with AND.
    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-filter-location_id').selectOption({ label: 'Store Room E2E North' });
    await page.locator('#search-submit-btn').click();
    await expect(page.getByTestId(`search-result-row-${assetId}`)).toBeVisible();
    await expect(page.getByTestId(`search-result-reference-${assetId}`)).toContainText('Store Room E2E North');
    await expect(page.getByTestId(`search-result-reference-${assetId}`)).toContainText('Finance Unit E2E');

    await page.locator('#search-filter-responsible_person_id').selectOption({ label: 'Somchai E2E' });
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#no-results-message')).toBeVisible();

    // Each legacy text is searched on its own: an old person text is no old location text.
    await page.locator('#search-reset-btn').click();
    await page.locator('#search-field').selectOption('legacy_responsible_person_text');
    await page.locator('#search-value').fill('สมชาย');
    await page.locator('#search-submit-btn').click();
    await expect(page.getByTestId(`search-result-row-${assetId}`)).toBeVisible();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 1 รายการ');
    await expect(page.getByTestId(`search-result-reference-${assetId}`)).toContainText('ข้อความเดิม: คุณสมชาย (ทะเบียนเดิม)');
    await page.locator('#search-field').selectOption('legacy_location_text');
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#no-results-message')).toBeVisible();
  });

  // #25 D3 as amended by F003 Q1 (ADR 0001): the registry correction no longer changes the context.
  test('Journey T4.3: bulk registration shares one Initial Assignment; the correction form leaves it to its own section; a deactivated entry stays shown', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/bulk-register`);
    await page.locator('#item-name-0').fill('Chair T4 A');
    await page.locator('#add-row-btn').click();
    await page.locator('#item-name-1').fill('Chair T4 B');
    await page.locator('#bulk-location_id').selectOption({ label: 'Store Room E2E North' });
    await page.locator('#bulk-organization_unit_id').selectOption({ label: 'Finance Unit E2E' });
    await expect(page.locator('#bulk-effective_date')).toHaveValue(bangkokToday());
    await page.locator('#bulk-document_reference').fill('ใบส่งของ E2E-77');
    await page.locator('#submit-bulk-register-btn').click();
    await expect(page.locator('#total-registered-count')).toHaveText('2');

    const chairs = await pool.query(
      `SELECT a.id, a.name, l.name AS location, e.effective_date::text AS effective_date, e.document_reference
       FROM assets a
       JOIN assignment_events e ON e.asset_id = a.id
       JOIN assignment_changes c ON c.event_id = e.id AND c.dimension = 'LOCATION'
       JOIN locations l ON l.id = c.new_location_id
       WHERE a.name IN ('Chair T4 A', 'Chair T4 B') ORDER BY a.name`
    );
    expect(chairs.rows.map((row) => [row.location, row.effective_date, row.document_reference])).toEqual([
      ['Store Room E2E North', bangkokToday(), 'ใบส่งของ E2E-77'],
      ['Store Room E2E North', bangkokToday(), 'ใบส่งของ E2E-77'],
    ]);
    const chairId = chairs.rows[0].id;

    // The registry correction offers no dimension field and points to the assignment section.
    await page.goto(`${targetBaseUrl}/assets/${chairId}`);
    await expect(page.locator('#detail-location')).toHaveText('Store Room E2E North');
    await expect(page.locator('#asset-correction-form')).toBeVisible();
    for (const field of ['location_id', 'organization_unit_id', 'responsible_person_id', 'legacy_location_text']) {
      await expect(page.locator(`#correction-${field}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('correction-assignment-note')).toContainText('สถานที่ หน่วยงาน และผู้รับผิดชอบ');
    await expect(page.getByTestId('correction-assignment-note').locator('a')).toHaveAttribute('href', '#assignment-heading');

    // A name correction leaves the Initial Assignment as recorded.
    await page.locator('#asset-correction-form input#name').fill('Chair T4 A (แก้ชื่อ)');
    await page.locator('#reason').fill('ชื่อตามป้ายจริง');
    await page.locator('#submit-correct-btn').click();
    await expect(page.getByTestId('correction-success-message')).toBeVisible();
    await expect(page.locator('#detail-location')).toHaveText('Store Room E2E North');
    const history = await pool.query(`SELECT payload FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'`, [chairId]);
    expect(history.rows.map((row) => Object.keys(row.payload.changes))).toEqual([['name']]);

    // An entry deactivated after assignment stays the Current Assignment, shown as inactive.
    await pool.query(`UPDATE organization_units SET is_active = false, version = version + 1 WHERE name = 'Finance Unit E2E'`);
    await page.reload();
    await expect(page.locator('#detail-organization_unit')).toHaveText('Finance Unit E2E (ปิดใช้งาน)');
    await expect(page.getByTestId('assignment-timeline')).toContainText('Finance Unit E2E (ปิดใช้งาน)');
  });

  // F003-T1 (#51, Q11): a legacy registration starts its Initial Assignment at "ไม่ทราบ".
  test('Journey F003-T1: a legacy Asset is registered with an Initial Assignment whose Effective Date is unknown, and every viewer sees it', async ({ page, context }) => {
    await loginAs(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/register`);
    await page.locator('#register-location_id').selectOption({ label: 'Store Room E2E North' });

    // The default follows the legacy choice until a date is chosen: today for an ordinary item ...
    await expect(page.locator('#register-effective_date')).toHaveValue(bangkokToday());
    await page.locator('#is_legacy').check();
    // ... and "ไม่ทราบ" for a legacy item, so no date is invented.
    await expect(page.locator('#register-effective_date_unknown')).toBeChecked();
    await expect(page.locator('#register-effective_date')).toBeDisabled();
    await page.locator('#register-legacy_organization_unit_text').fill('กองพัสดุ (ทะเบียนปี 2540)');
    await page.locator('#register-document_reference').fill('สมุดทะเบียนครุภัณฑ์ เล่ม 3');
    await page.locator('button#submit-register-btn').click();

    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}`));
    const assetId = page.url().split('/assets/')[1];
    const stored = await pool.query(
      `SELECT kind, effective_date, provenance, document_reference FROM assignment_events WHERE asset_id = $1`,
      [assetId]
    );
    expect(stored.rows).toEqual([
      { kind: 'INITIAL', effective_date: null, provenance: 'RECORDED', document_reference: 'สมุดทะเบียนครุภัณฑ์ เล่ม 3' },
    ]);

    for (const viewer of [custodianUserId, readonlyUserId]) {
      await switchActor(page, context, viewer);
      await page.goto(`${targetBaseUrl}/assets/${assetId}`);
      await expect(page.locator('#detail-location')).toHaveText('Store Room E2E North');
      await expect(page.locator('#detail-organization_unit')).toHaveText('ข้อความเดิม: กองพัสดุ (ทะเบียนปี 2540)');
      await expect(page.locator('#detail-responsible_person')).toHaveText('ไม่ระบุ');
      const timeline = page.getByTestId('assignment-timeline');
      await expect(timeline).toContainText('กำหนดครั้งแรก');
      await expect(timeline).toContainText('ไม่ทราบวันที่ (บันทึกเมื่อ');
      await expect(timeline).toContainText('custodian_e2e');
      await expect(timeline).toContainText('เอกสารอ้างอิง: สมุดทะเบียนครุภัณฑ์ เล่ม 3');
    }
    // The Read-only User sees no correction form.
    await expect(page.locator('#asset-correction-form')).toHaveCount(0);
  });
});
