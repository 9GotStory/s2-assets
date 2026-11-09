import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as crypto from 'node:crypto';
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
import { ReferenceService } from '../../../api/src/services/reference.service.ts';
import { LoanService } from '../../../api/src/services/loan.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F004-T1 (#75): lending an Asset from its page.
test.describe.serial('Loan journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let assetService: AssetService;
  let referenceService: ReferenceService;
  let loanService: LoanService;

  let custodianUserId: string;
  let readonlyUserId: string;
  let adminUserId: string;

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
    loanService = new LoanService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-loan-e2e',
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
    custodianUserId = await createUser('custodian_loan', 'ASSET_CUSTODIAN');
    readonlyUserId = await createUser('readonly_loan', 'READ_ONLY');
    adminUserId = await createUser('admin_loan', 'ADMINISTRATOR');

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

  const yesterday = () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  };

  test('Journey F004-T1.1: a Custodian lends an Asset from its page, and a Read-only User sees the Borrower, no phone number and no action', async ({ page, context }) => {
    const phone = '081-234-5678';
    const staff = await referenceService.create('persons', adminUserId, 'สมชาย ยืมในสำนักงาน');
    const departed = await referenceService.create('persons', adminUserId, 'สมศรี ลาออกแล้ว');
    await referenceService.update('persons', adminUserId, departed.id, { expected_version: departed.version, is_active: false });
    const { asset } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องฉาย E2E ยืม' } as any);

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${asset.id}`);
    const section = page.locator('#loan-section');
    await expect(section.getByRole('heading', { name: 'การยืม' })).toBeVisible();
    await expect(page.locator('[data-testid="loan-on-loan"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="loan-history-empty"]')).toBeVisible();

    await page.locator('#loan-action').click();

    // Condition defaults to ปกติ on the form.
    await expect(page.locator(`#loan-condition-${asset.id}`)).toHaveValue('NORMAL');

    // A deactivated Person is offered, labelled, only for a Loan Date before today.
    const personOptions = page.locator('#loan-borrower_person_id option');
    await expect(personOptions.filter({ hasText: 'สมชาย ยืมในสำนักงาน' })).toHaveCount(1);
    await expect(personOptions.filter({ hasText: 'สมศรี ลาออกแล้ว' })).toHaveCount(0);
    await page.locator('#loan-loan_date').fill(yesterday());
    await expect(personOptions.filter({ hasText: 'สมศรี ลาออกแล้ว (ปิดใช้งาน)' })).toHaveCount(1);
    await page.locator('#loan-borrower_person_id').selectOption(departed.id);

    // Back to today, the chosen entry is no longer offered and leaves the selection.
    await page.locator('#loan-loan_date').fill(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()));
    await expect(personOptions.filter({ hasText: 'สมศรี ลาออกแล้ว' })).toHaveCount(0);
    await expect(page.locator('#loan-borrower_person_id')).toHaveValue('');

    // The server decides, and the form says what it needs before asking.
    await page.locator('#loan-submit').click();
    await expect(page.locator('[data-testid="loan-form-error"]')).toBeVisible();

    await page.getByLabel('ผู้ยืมภายนอก').check();
    await page.locator('#loan-contact_name').fill('คุณสมหญิง ภายนอก');
    await page.locator('#loan-organization_name').fill('บริษัท ตัวอย่าง จำกัด');
    await page.locator('#loan-phone').fill(phone);
    await page.locator('#loan-due_date').fill('2099-12-31');
    await page.locator('#loan-document_reference').fill('บันทึก 9/2569');
    await page.locator('#loan-submit').click();

    // The Asset is On Loan, and the page links to the Loan instead of offering another.
    const onLoan = page.locator('[data-testid="loan-on-loan"]');
    await expect(onLoan).toContainText('คุณสมหญิง ภายนอก');
    await expect(onLoan).toContainText('บริษัท ตัวอย่าง จำกัด');
    await expect(onLoan).toContainText('31 ธันวาคม');
    await expect(page.locator('#loan-action')).toHaveCount(0);
    await expect(page.locator('[data-testid="loan-history"] li')).toHaveCount(1);

    // The Custodian's Loan page shows every fact, the phone number among them.
    await page.locator('#loan-current-link').click();
    await expect(page).toHaveURL(/\/loans\/[0-9a-f-]{36}$/);
    const loanUrl = page.url();
    await expect(page.locator('#loan-borrower')).toContainText('คุณสมหญิง ภายนอก');
    await expect(page.locator('#loan-borrower-phone')).toHaveText(phone);
    await expect(page.locator('#loan-document-reference')).toHaveText('บันทึก 9/2569');
    await expect(page.locator('#loan-recorded-by')).toHaveText('custodian_loan');
    const item = page.locator('[data-testid="loan-item"]');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('เครื่องฉาย E2E ยืม');
    await expect(item).toContainText('31 ธันวาคม');
    await expect(item).toContainText('ปกติ');

    // A Read-only User sees who holds it, without the phone number and without any action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${asset.id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณสมหญิง ภายนอก');
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('บริษัท ตัวอย่าง จำกัด');
    await expect(page.locator('#loan-action')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(phone);

    await page.goto(loanUrl);
    await expect(page.locator('#loan-borrower')).toContainText('คุณสมหญิง ภายนอก');
    await expect(page.locator('#loan-borrower-phone')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(phone);
    await expect(page.locator('main button')).toHaveCount(0);

    // A Loan stands when its Internal Borrower has left, and the name says so.
    const { asset: heldByDeparted } = await assetService.registerAsset(custodianUserId, { name: 'กล้อง E2E ยืม' } as any);
    const { loan_id: departedLoanId } = await loanService.start(
      custodianUserId,
      {
        assets: [{ asset_id: heldByDeparted.id, condition: 'NORMAL' }],
        borrower: { kind: 'INTERNAL', person_id: departed.id },
        loan_date: yesterday(),
        due_date: '2099-12-31',
      },
      { retryToken: crypto.randomUUID() }
    );
    await page.goto(`${targetBaseUrl}/assets/${heldByDeparted.id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('สมศรี ลาออกแล้ว (ปิดใช้งาน)');
    await page.goto(`${targetBaseUrl}/loans/${departedLoanId}`);
    await expect(page.locator('#loan-borrower')).toHaveText('สมศรี ลาออกแล้ว (ปิดใช้งาน)');
  });
});
