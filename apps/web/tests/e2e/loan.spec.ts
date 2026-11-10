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
import { AssignmentRecordingService } from '../../../api/src/services/assignment-recording.service.ts';
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

  const daysAgo = (days: number) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  };

  const yesterday = () => daysAgo(1);

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
    await page.locator('#loan-loan_date').fill('2025-01-15');
    await page.locator('#loan-due_date').fill('2099-12-31');
    await page.locator('#loan-authorizer_person_id').selectOption(staff.id);
    await page.locator('#loan-document_reference').fill('บันทึก 9/2569');
    await page.locator('#loan-assignment_remark').fill('ใช้งานนอกสถานที่');
    const beforeRecording = Date.now();
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
    await expect(page.locator('#loan-date')).toHaveText('15 มกราคม 2568');
    await expect(page.locator('#loan-authorizer')).toHaveText('สมชาย ยืมในสำนักงาน');
    await expect(page.locator('#loan-document-reference')).toHaveText('บันทึก 9/2569');
    await expect(page.locator('#loan-remark')).toHaveText('ใช้งานนอกสถานที่');
    await expect(page.locator('#loan-recorded-by')).toHaveText('custodian_loan');
    await expect(page.locator('#loan-recorded-at')).not.toBeEmpty();
    const recordedAt = Date.parse((await page.locator('#loan-recorded-at time').getAttribute('datetime'))!);
    expect(recordedAt).toBeGreaterThanOrEqual(beforeRecording);
    expect(recordedAt).toBeLessThanOrEqual(Date.now());
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

    // Nor is the action offered on an Asset free to lend, where the Custodian saw it above.
    const { asset: free } = await assetService.registerAsset(custodianUserId, { name: 'ลำโพง E2E ยืม' } as any);
    await page.goto(`${targetBaseUrl}/assets/${free.id}`);
    await expect(page.locator('[data-testid="loan-history-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="loan-on-loan"]')).toHaveCount(0);
    await expect(page.locator('#loan-action')).toHaveCount(0);

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

  // F004-T2 (#76): a partial Loan Return with Condition, after which the returned Asset can be lent again.
  test('Journey F004-T2.1: a Custodian records a partial Loan Return, and the returned Asset can be lent again at once', async ({ page, context }) => {
    const room = await referenceService.create('locations', adminUserId, 'ห้องเก็บของ E2E คืน');
    const reassignedTo = await referenceService.create('locations', adminUserId, 'ห้องใหม่ E2E คืน');
    const place = { location_id: room.id, effective_date: '2024-01-01' };
    const { asset: damaged } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องฉาย E2E คืนชำรุด', ...place } as any);
    const { asset: stillOut } = await assetService.registerAsset(custodianUserId, { name: 'กล้อง E2E ยังไม่คืน', ...place } as any);
    const { loan_id: loanId } = await loanService.start(
      custodianUserId,
      {
        assets: [damaged, stillOut].map(({ id }) => ({ asset_id: id, condition: 'NORMAL' as const })),
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม E2E คืน' },
        loan_date: daysAgo(2),
        due_date: '2099-12-31',
      },
      { retryToken: crypto.randomUUID() }
    );
    const { rows: [{ assignment_version: assignmentVersion }] } = await pool.query('SELECT assignment_version FROM assets WHERE id = $1', [damaged.id]);
    await new AssignmentRecordingService({ db: pool }).record(
      custodianUserId,
      damaged.id,
      { kind: 'REASSIGNMENT', expected_assignment_version: assignmentVersion, location_id: reassignedTo.id, effective_date: yesterday() },
      { retryToken: crypto.randomUUID() }
    );
    const loan = await loanService.read(loanId, { includePhone: false });
    const itemOf = (assetId: string) => loan!.items.find(({ asset }) => asset.id === assetId)!.id;
    const [damagedItem, stillOutItem] = [itemOf(damaged.id), itemOf(stillOut.id)];

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/loans/${loanId}`);
    await expect(page.locator('#loan-status')).toContainText('ยังไม่คืน');
    await page.locator('#loan-return-action').click();

    // The form says where each item goes back to on the Return Date, as the server derives it: the
    // Reassignment made during the Loan stands, and the values from the Loan's start do not come back.
    const assignmentOnReturnDate = page.locator(`[data-testid="loan-return-assignment-${damagedItem}"]`);
    await expect(assignmentOnReturnDate).toContainText('ห้องใหม่ E2E คืน');
    await expect(page.locator(`[data-testid="loan-return-assignment-${stillOutItem}"]`)).toContainText('ห้องเก็บของ E2E คืน');

    // While the values of another Return Date are being read, those of the last date are not shown under it.
    let answerRead = () => {};
    const held = new Promise<void>((resolve) => { answerRead = resolve; });
    await page.route(`**/loans/${loanId}?return_date=${daysAgo(2)}`, async (route) => {
      await held;
      await route.continue();
    });
    await page.locator('#loan-return-return_date').fill(daysAgo(2));
    await expect(assignmentOnReturnDate).toHaveCount(0);
    answerRead();
    await expect(assignmentOnReturnDate).toContainText('ห้องเก็บของ E2E คืน');
    await page.locator('#loan-return-return_date').fill(daysAgo(0));
    await expect(assignmentOnReturnDate).toContainText('ห้องใหม่ E2E คืน');

    // The Condition has no default, and the form says what it needs before asking.
    await expect(page.locator(`#loan-return-condition-${damagedItem}`)).toHaveValue('');
    await page.locator('#loan-return-submit').click();
    await expect(page.locator('[data-testid="loan-return-form-error"]')).toContainText('กรุณาเลือกรายการที่คืน');
    await page.locator(`#loan-return-select-${damagedItem}`).check();
    await page.locator('#loan-return-submit').click();
    await expect(page.locator('[data-testid="loan-return-form-error"]')).toContainText('กรุณาเลือกสภาพ');

    // The button sets every item to ปกติ, and one is then changed by hand.
    await page.locator('#loan-return-all-normal').click();
    await expect(page.locator(`#loan-return-condition-${damagedItem}`)).toHaveValue('NORMAL');
    await expect(page.locator(`#loan-return-condition-${stillOutItem}`)).toHaveValue('NORMAL');
    await page.locator(`#loan-return-condition-${damagedItem}`).selectOption('DAMAGED');
    await page.locator(`#loan-return-condition-note-${damagedItem}`).fill('เลนส์มีรอยแตก');
    await page.locator('#loan-return-document_reference').fill('บันทึกคืน 4/2569');
    await page.locator('#loan-return-assignment_remark').fill('คุณสมชายนำมาคืนแทน');
    await page.locator('#loan-return-submit').click();

    // Only the item picked came back: the rest of the Loan stays open.
    await expect(page.locator('#loan-return-form')).toHaveCount(0);
    await expect(page.locator('#loan-status')).toContainText('คืนบางส่วน');
    await expect(page.locator('#loan-status')).toContainText('คืนแล้ว 1 จาก 2 รายการ');
    const returned = page.locator('[data-testid="loan-item"]').filter({ hasText: 'เครื่องฉาย E2E คืนชำรุด' });
    await expect(returned.locator('[data-testid="loan-item-return"]')).toContainText('ชำรุด (เลนส์มีรอยแตก)');
    await expect(returned.locator('[data-testid="loan-item-return"]')).toContainText('บันทึกคืน 4/2569');
    await expect(returned.locator('[data-testid="loan-item-return"]')).toContainText('คุณสมชายนำมาคืนแทน');
    await expect(returned.locator('[data-testid="loan-item-return"]')).toContainText('custodian_loan');
    await expect(page.locator('[data-testid="loan-item"]').filter({ hasText: 'กล้อง E2E ยังไม่คืน' }).locator('[data-testid="loan-item-outstanding"]')).toHaveText('ยังไม่คืน');

    // A Read-only User sees the outcome and no action, on a Loan where the Custodian has one.
    await expect(page.locator('#loan-return-action')).toBeVisible();
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/loans/${loanId}`);
    await expect(page.locator('#loan-status')).toContainText('คืนบางส่วน');
    await expect(page.locator('#loan-return-action')).toHaveCount(0);
    await expect(page.locator('main button')).toHaveCount(0);

    // The item still out keeps its Asset On Loan.
    await switchActor(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${stillOut.id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณผู้ยืม E2E คืน');
    await expect(page.locator('#loan-action')).toHaveCount(0);

    // The returned Asset can be lent at once, and the form warns of its last Condition without blocking.
    await page.goto(`${targetBaseUrl}/assets/${damaged.id}`);
    await expect(page.locator('[data-testid="loan-history"]')).toContainText('ชำรุด (เลนส์มีรอยแตก)');
    await expect(page.locator('[data-testid="loan-on-loan"]')).toHaveCount(0);
    await page.locator('#loan-action').click();
    await expect(page.locator(`[data-testid="loan-damaged-warning-${damaged.id}"]`)).toBeVisible();
    await page.getByLabel('ผู้ยืมภายนอก').check();
    await page.locator('#loan-contact_name').fill('คุณผู้ยืมรายใหม่ E2E');
    await page.locator('#loan-due_date').fill('2099-12-31');
    await page.locator('#loan-submit').click();
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณผู้ยืมรายใหม่ E2E');

    // The last item back closes the Loan, and the action goes with it.
    await page.goto(`${targetBaseUrl}/loans/${loanId}`);
    await page.locator('#loan-return-action').click();
    await page.locator(`#loan-return-select-${stillOutItem}`).check();
    await page.locator(`#loan-return-condition-${stillOutItem}`).selectOption('NORMAL');
    await page.locator('#loan-return-submit').click();
    await expect(page.locator('#loan-status')).toContainText('คืนครบ');
    await expect(page.locator('#loan-status')).toContainText('คืนแล้ว 2 จาก 2 รายการ');
    await expect(page.locator('#loan-return-action')).toHaveCount(0);
  });
});
