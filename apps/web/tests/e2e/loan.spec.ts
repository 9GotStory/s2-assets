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
import { AssetService } from '../../../api/src/services/asset.service.ts';
import { ReferenceService } from '../../../api/src/services/reference.service.ts';
import { LoanService } from '../../../api/src/services/loan.service.ts';
import { LoanReadService } from '../../../api/src/services/loan-read.service.ts';
import { LoanReturnService } from '../../../api/src/services/loan-return.service.ts';
import { NotReturnedService } from '../../../api/src/services/not-returned.service.ts';
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
  let loanReadService: LoanReadService;

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
    loanReadService = new LoanReadService({ db: pool });

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

  // F004-T4 (#78): the Asset list knows about Loans, and the Reassignment forms say who holds an Asset.
  test('Journey F004-T4.1: a Custodian selects Assets across pages of the Asset list, starts one Loan and sees "กำลังถูกยืม"; the Reassignment forms say who holds them', async ({ page, context }) => {
    const tag = `รายการยืม E2E ${crypto.randomUUID().slice(0, 8)}`;
    const room = await referenceService.create('locations', adminUserId, `ห้อง ${tag}`);
    const register = async (name: string) =>
      (await assetService.registerAsset(custodianUserId, { name: `${tag} ${name}`, location_id: room.id, effective_date: '2024-01-01' } as any)).asset;

    // The list reads newest first, 25 rows a page: the two registered first land on the second page.
    const held = await register('กล้องที่ถูกยืมอยู่');
    const damaged = await register('ขาตั้งคืนชำรุด');
    const fillers = [];
    for (let i = 0; i < 25; i++) {
      fillers.push(await register(`เก้าอี้ ${String(i).padStart(2, '0')}`));
    }
    const newest = fillers[24];

    await loanService.start(
      custodianUserId,
      { assets: [{ asset_id: held.id, condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณถือไว้ก่อน E2E' }, loan_date: yesterday(), due_date: '2099-12-31' },
      { retryToken: crypto.randomUUID() }
    );
    const earlier = await loanService.start(
      custodianUserId,
      { assets: [{ asset_id: damaged.id, condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณคืนชำรุด E2E' }, loan_date: daysAgo(3), due_date: daysAgo(2) },
      { retryToken: crypto.randomUUID() }
    );
    await new LoanReturnService({ db: pool }).record(
      custodianUserId,
      earlier.loan_id,
      { expected_version: earlier.version, return_date: daysAgo(2), items: [{ loan_item_id: earlier.items[0].id, condition: 'DAMAGED' }] },
      { retryToken: crypto.randomUUID() }
    );

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-field').selectOption('name');
    await page.locator('#search-value').fill(tag);
    await page.locator('#search-submit-btn').click();

    // One row on the first page and two on the second, among them the Asset already On Loan.
    await expect(page.locator(`[data-testid="search-result-row-${newest.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="search-result-on-loan-${newest.id}"]`)).toHaveCount(0);
    await page.getByTestId(`asset-select-${newest.id}`).check();
    await page.locator('#next-page-btn').click();
    await expect(page.locator(`[data-testid="search-result-on-loan-${held.id}"]`)).toHaveText('กำลังถูกยืม');
    await expect(page.locator(`[data-testid="search-result-on-loan-${damaged.id}"]`)).toHaveCount(0);
    await page.getByTestId(`asset-select-${damaged.id}`).check();
    await page.getByTestId(`asset-select-${held.id}`).check();
    await expect(page.locator('#bulk-reassign-count')).toContainText('เลือกแล้ว 3 รายการ');

    // The Start Loan form shows the three, and warns of the latest Loan Return in ชำรุด as the Asset page does.
    const fillLoan = async () => {
      await page.getByLabel('ผู้ยืมภายนอก').check();
      await page.locator('#loan-contact_name').fill('คุณยืมจากรายการ E2E');
      await page.locator('#loan-due_date').fill('2099-12-31');
    };
    await page.locator('#loan-from-list-open').click();
    for (const asset of [newest, damaged, held]) {
      await expect(page.locator(`#loan-condition-${asset.id}`)).toHaveValue('NORMAL');
    }
    await expect(page.locator(`[data-testid="loan-damaged-warning-${damaged.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="loan-damaged-warning-${newest.id}"]`)).toHaveCount(0);
    await fillLoan();
    await page.locator('#loan-submit').click();

    // The Asset On Loan is refused by name, and nothing is saved.
    const refused = page.locator('[data-testid="loan-refused"]');
    await expect(refused).toContainText(`${tag} กล้องที่ถูกยืมอยู่: กำลังถูกยืม`);
    await expect(refused).not.toContainText('เก้าอี้');
    expect((await pool.query('SELECT count(*)::int AS n FROM loan_items WHERE asset_id = ANY($1::uuid[])', [[newest.id, damaged.id]])).rows[0].n).toBe(1);

    // Without it, the Loan starts, and the list read again shows the two On Loan.
    await page.locator('#loan-cancel').click();
    await page.getByTestId(`asset-select-${held.id}`).uncheck();
    await expect(page.locator('#bulk-reassign-count')).toContainText('เลือกแล้ว 2 รายการ');
    await page.locator('#loan-from-list-open').click();
    await fillLoan();
    await page.locator('#loan-submit').click();
    await expect(page.locator('#loan-form')).toHaveCount(0);
    await expect(page.locator(`[data-testid="search-result-on-loan-${damaged.id}"]`)).toHaveText('กำลังถูกยืม');
    await expect(page.locator('#bulk-reassign-count')).toContainText('เลือกแล้ว 0 รายการ');

    // "กำลังถูกยืม" combines with the name search.
    await page.locator('#search-filter-on_loan').check();
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 3 รายการ');
    for (const asset of [newest, damaged, held]) {
      await expect(page.locator(`[data-testid="search-result-on-loan-${asset.id}"]`)).toBeVisible();
    }

    // "ย้ายหลายรายการ" says who holds each selected Asset, and blocks nothing.
    await page.getByTestId(`asset-select-${held.id}`).check();
    await page.getByTestId(`asset-select-${newest.id}`).check();
    await page.locator('#bulk-reassign-open').click();
    await expect(page.locator('[data-testid="assignment-loan-note"]')).toBeVisible();
    await expect(page.locator(`[data-testid="assignment-on-loan-${held.id}"]`)).toContainText('คุณถือไว้ก่อน E2E');
    await expect(page.locator(`[data-testid="assignment-on-loan-${newest.id}"]`)).toContainText('คุณยืมจากรายการ E2E');
    await expect(page.locator('[data-testid="assignment-on-loan-notice"]')).toContainText('การย้ายไม่เปลี่ยนผู้ยืม');
    await expect(page.locator('#bulk-reassign-preview')).toBeEnabled();
    await page.locator('#bulk-reassign-cancel').click();

    // So does the Reassignment form on the Asset page, and on an Asset free to lend it says nothing.
    await page.goto(`${targetBaseUrl}/assets/${held.id}`);
    await page.locator('#assignment-action').click();
    await expect(page.locator(`[data-testid="assignment-on-loan-${held.id}"]`)).toContainText('คุณถือไว้ก่อน E2E');
    const free = await register('โต๊ะว่าง');
    await page.goto(`${targetBaseUrl}/assets/${free.id}`);
    await page.locator('#assignment-action').click();
    await expect(page.locator('[data-testid="assignment-loan-note"]')).toBeVisible();
    await expect(page.locator('[data-testid="assignment-on-loan-notice"]')).toHaveCount(0);

    // A Read-only User sees "กำลังถูกยืม" and is offered no selection and no Loan action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-field').selectOption('name');
    await page.locator('#search-value').fill(tag);
    await page.locator('#search-submit-btn').click();
    await expect(page.locator(`[data-testid="search-result-on-loan-${newest.id}"]`)).toBeVisible();
    await expect(page.locator('[data-testid^="asset-select-"]')).toHaveCount(0);
    await expect(page.locator('#loan-from-list-open')).toHaveCount(0);
  });

  // F004-T3 (#77): a backdated Loan past its Due Date shows "เกินกำหนด", and F004-T5 (#79) completes the
  // journey with a Due Date Extension that clears it.
  test('Journey F004-T3.1: a backdated Loan past its Due Date shows "เกินกำหนด" on the Loan list, the Loan page and the Asset page, and a Due Date Extension clears it', async ({ page, context }) => {
    const start = async (name: string, assetNames: string[], dueDate: string) => {
      const assets = [];
      for (const assetName of assetNames) {
        assets.push((await assetService.registerAsset(custodianUserId, { name: assetName } as any)).asset);
      }
      const { loan_id: loanId, items } = await loanService.start(
        custodianUserId,
        {
          assets: assets.map(({ id }) => ({ asset_id: id, condition: 'NORMAL' as const })),
          borrower: { kind: 'EXTERNAL', contact_name: name, organization_name: 'หน่วยงาน E2E รายการยืม' },
          loan_date: daysAgo(10),
          due_date: dueDate,
        },
        { retryToken: crypto.randomUUID() }
      );
      return { loanId, assets, items };
    };
    const late = await start('คุณเกินกำหนด E2E', ['โปรเจกเตอร์ E2E เกินกำหนด', 'จอ E2E คืนช้า'], daysAgo(3));
    const onTime = await start('คุณยังไม่ถึงกำหนด E2E', ['ไมค์ E2E ยังไม่ถึงกำหนด'], '2099-12-31');
    const [stillOut, returnedLate] = late.assets;
    await new LoanReturnService({ db: pool }).record(
      custodianUserId,
      late.loanId,
      { expected_version: 1, return_date: daysAgo(1), items: [{ loan_item_id: late.items.find(({ asset_id }) => asset_id === returnedLate.id)!.id, condition: 'NORMAL' }] },
      { retryToken: crypto.randomUUID() }
    );

    // A Read-only User reaches the list from the Dashboard and finds the Loans by the External Borrower's organization.
    await loginAs(context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-loan-list').click();
    await expect(page).toHaveURL(/\/loans$/);
    await expect(page.getByRole('heading', { name: 'รายการยืม' })).toBeVisible();
    await page.locator('#loan-filter-borrower_kind').selectOption('EXTERNAL');
    await page.locator('#loan-filter-borrower_name').fill('หน่วยงาน E2E รายการยืม');
    await page.locator('#loan-list-submit').click();

    const lateRow = page.locator(`[data-testid="loan-row-${late.loanId}"]`);
    const onTimeRow = page.locator(`[data-testid="loan-row-${onTime.loanId}"]`);
    await expect(lateRow).toContainText('คุณเกินกำหนด E2E');
    await expect(lateRow).toContainText('คืนบางส่วน');
    await expect(lateRow).toContainText('คืนแล้ว 1 จาก 2 รายการ');
    await expect(lateRow.locator('[data-testid="loan-overdue"]')).toHaveText('เกินกำหนด');
    await expect(onTimeRow).toContainText('ยังไม่คืน');
    await expect(page.locator('#loan-list-table tbody tr')).toHaveCount(2);
    await expect(onTimeRow.locator('[data-testid="loan-overdue"]')).toHaveCount(0);

    // The Overdue filter leaves the Loan still past its Due Date.
    await page.locator('#loan-filter-overdue').check();
    await page.locator('#loan-list-submit').click();
    await expect(page.locator('#loan-list-table tbody tr')).toHaveCount(1);
    await expect(lateRow).toBeVisible();

    // The Loan page says the Loan and its item still out are Overdue, and the item back after its Due Date "คืนเกินกำหนด".
    await lateRow.getByRole('link', { name: 'ดูการยืม' }).click();
    await expect(page).toHaveURL(new RegExp(`/loans/${late.loanId}$`));
    await expect(page.locator('#loan-overdue')).toHaveText('เกินกำหนด');
    const itemOf = (asset: { name: string | null }) => page.locator('[data-testid="loan-item"]').filter({ hasText: asset.name! });
    await expect(itemOf(stillOut).locator('[data-testid="loan-item-overdue"]')).toHaveText('เกินกำหนด');
    await expect(itemOf(returnedLate).locator('[data-testid="loan-item-returned-late"]')).toHaveText('คืนเกินกำหนด');
    await expect(itemOf(returnedLate).locator('[data-testid="loan-item-overdue"]')).toHaveCount(0);

    // Back on the list, its filters stand.
    await page.goBack();
    await expect(page.locator('#loan-filter-overdue')).toBeChecked();
    await expect(page.locator('#loan-list-table tbody tr')).toHaveCount(1);

    // The Asset page's "การยืม" section says so too, and only for the Loan past its Due Date.
    await page.goto(`${targetBaseUrl}/assets/${stillOut.id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณเกินกำหนด E2E');
    await expect(page.locator('[data-testid="loan-on-loan-overdue"]')).toHaveText('เกินกำหนด');
    await expect(page.locator('[data-testid="loan-history"] [data-testid="loan-overdue"]')).toHaveText('เกินกำหนด');
    await page.goto(`${targetBaseUrl}/assets/${returnedLate.id}`);
    await expect(page.locator('[data-testid="loan-history"] [data-testid="loan-returned-late"]')).toHaveText('คืนเกินกำหนด');
    await page.goto(`${targetBaseUrl}/assets/${onTime.assets[0].id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณยังไม่ถึงกำหนด E2E');
    await expect(page.locator('[data-testid="loan-on-loan-overdue"]')).toHaveCount(0);

    // F004-T5: a Custodian extends the Due Date of the item still out, the only one the form offers.
    await switchActor(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/loans/${late.loanId}`);
    await expect(page.locator('#loan-overdue')).toHaveText('เกินกำหนด');
    await page.locator('#loan-extension-action').click();
    const offered = page.locator('[data-testid="loan-extension-item"]');
    await expect(offered).toHaveCount(1);
    await expect(offered).toContainText(stillOut.name!);
    await expect(page.locator(`#loan-extension-select-${late.items.find(({ asset_id }) => asset_id === stillOut.id)!.id}`)).toBeChecked();

    // A new date that is not later than the current Due Date is refused before it is sent.
    await page.locator('#loan-extension-new_due_date').fill(daysAgo(3));
    await page.locator('#loan-extension-submit').click();
    await expect(page.locator('[data-testid="loan-extension-form-error"]')).toContainText('ต้องช้ากว่ากำหนดคืนเดิม');
    await page.locator('#loan-extension-new_due_date').fill(daysAgo(-7));
    await page.locator('#loan-extension-reason').fill('ผู้ยืมขอใช้ต่ออีกหนึ่งสัปดาห์');
    await page.locator('#loan-extension-submit').click();

    // The extended item is no longer Overdue, nor is the Loan, and the item back late keeps "คืนเกินกำหนด".
    const extension = itemOf(stillOut).locator('[data-testid="loan-item-extension"]');
    await expect(extension).toContainText('เลื่อนกำหนดคืน');
    await expect(extension).toContainText('ผู้ยืมขอใช้ต่ออีกหนึ่งสัปดาห์');
    await expect(extension).toContainText('custodian_loan');
    await expect(itemOf(stillOut).locator('time').first()).toHaveAttribute('datetime', daysAgo(-7));
    await expect(itemOf(stillOut).locator('[data-testid="loan-item-overdue"]')).toHaveCount(0);
    await expect(page.locator('#loan-overdue')).toHaveCount(0);
    await expect(itemOf(returnedLate).locator('[data-testid="loan-item-returned-late"]')).toHaveText('คืนเกินกำหนด');

    // The Loan list and the Asset page say the same.
    await page.goto(`${targetBaseUrl}/loans?overdue=true&borrower_name=${encodeURIComponent('หน่วยงาน E2E รายการยืม')}`);
    await expect(page.locator('#loan-list-empty')).toBeVisible();
    await page.goto(`${targetBaseUrl}/assets/${stillOut.id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณเกินกำหนด E2E');
    await expect(page.locator('[data-testid="loan-on-loan"] time')).toHaveAttribute('datetime', daysAgo(-7));
    await expect(page.locator('[data-testid="loan-on-loan-overdue"]')).toHaveCount(0);
  });

  // F004-T5 (#79): "ปิดโดยไม่ได้รับคืน", after which a new Loan of that Asset is refused until it comes back.
  test('Journey F004-T5.1: a Custodian closes an item as "ปิดโดยไม่ได้รับคืน", the Asset cannot be lent again until it turns up, and then it can', async ({ page, context }) => {
    const { asset: lost } = await assetService.registerAsset(custodianUserId, { name: 'แท็บเล็ต E2E ไม่ได้คืน' } as any);
    const { asset: back } = await assetService.registerAsset(custodianUserId, { name: 'ขาตั้ง E2E คืนแล้ว' } as any);
    const { loan_id: loanId, items } = await loanService.start(
      custodianUserId,
      {
        assets: [lost, back].map(({ id }) => ({ asset_id: id, condition: 'NORMAL' as const })),
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม E2E ไม่ได้คืน' },
        loan_date: daysAgo(5),
        due_date: '2099-12-31',
      },
      { retryToken: crypto.randomUUID() }
    );
    const itemIdOf = (assetId: string) => items.find(({ asset_id }) => asset_id === assetId)!.id;
    const itemOf = (name: string | null) => page.locator('[data-testid="loan-item"]').filter({ hasText: name! });

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/loans/${loanId}`);
    await page.locator('#loan-not-returned-action').click();

    // No item is chosen, and the date it became known and the reason are asked for before the request.
    await expect(page.locator(`#loan-not-returned-select-${itemIdOf(lost.id)}`)).not.toBeChecked();
    await page.locator('#loan-not-returned-submit').click();
    await expect(page.locator('[data-testid="loan-not-returned-form-error"]')).toContainText('กรุณาเลือกรายการที่ไม่ได้รับคืน');
    await page.locator(`#loan-not-returned-select-${itemIdOf(lost.id)}`).check();
    await page.locator('#loan-not-returned-submit').click();
    await expect(page.locator('[data-testid="loan-not-returned-form-error"]')).toContainText('กรุณาระบุเหตุผล');
    await page.locator('#loan-not-returned-date').fill(daysAgo(1));
    await page.locator('#loan-not-returned-reason').fill('ผู้ยืมแจ้งว่าทำหายระหว่างเดินทาง');
    await page.locator('#loan-not-returned-submit').click();

    // It is its own ending, and no Loan Return.
    const closure = itemOf(lost.name).locator('[data-testid="loan-item-not-returned"]');
    await expect(closure).toContainText('ปิดโดยไม่ได้รับคืน');
    await expect(closure).toContainText('ผู้ยืมแจ้งว่าทำหายระหว่างเดินทาง');
    await expect(closure).toContainText('custodian_loan');
    await expect(itemOf(lost.name).locator('[data-testid="loan-item-return"]')).toHaveCount(0);
    await expect(page.locator('#loan-status')).toContainText('ยังไม่คืน');
    await expect(page.locator('#loan-status')).toContainText('คืนแล้ว 0 จาก 2 รายการ');

    // The other item comes back, and the Loan is "ปิดแล้ว", which the list's status filter finds.
    await page.locator('#loan-return-action').click();
    await page.locator(`#loan-return-select-${itemIdOf(back.id)}`).check();
    await page.locator(`#loan-return-condition-${itemIdOf(back.id)}`).selectOption('NORMAL');
    await page.locator('#loan-return-submit').click();
    await expect(page.locator('#loan-status')).toContainText('ปิดแล้ว (ไม่ได้รับคืน 1 ชิ้น)');
    await expect(page.locator('#loan-status')).toContainText('คืนแล้ว 1 จาก 2 รายการ');
    await expect(page.locator('#loan-return-action')).toBeVisible();
    await expect(page.locator('#loan-extension-action')).toHaveCount(0);
    await expect(page.locator('#loan-not-returned-action')).toHaveCount(0);

    await page.goto(`${targetBaseUrl}/loans`);
    await page.locator('#loan-filter-status').selectOption('CLOSED');
    await page.locator('#loan-filter-borrower_kind').selectOption('EXTERNAL');
    await page.locator('#loan-filter-borrower_name').fill('คุณผู้ยืม E2E ไม่ได้คืน');
    await page.locator('#loan-list-submit').click();
    await expect(page.locator(`[data-testid="loan-row-${loanId}"]`)).toContainText('ปิดแล้ว (ไม่ได้รับคืน 1 ชิ้น)');
    await expect(page.locator('#loan-list-table tbody tr')).toHaveCount(1);

    // The Asset page says why it cannot be lent, and offers no new Loan, where a returned Asset has one.
    await page.goto(`${targetBaseUrl}/assets/${back.id}`);
    await expect(page.locator('#loan-action')).toBeVisible();
    await page.goto(`${targetBaseUrl}/assets/${lost.id}`);
    const notice = page.locator('[data-testid="loan-not-returned"]');
    await expect(notice).toContainText('ปิดโดยไม่ได้รับคืน');
    await expect(page.locator('[data-testid="loan-history-not-returned"]')).toContainText('ปิดโดยไม่ได้รับคืน');
    await expect(page.locator('[data-testid="loan-on-loan"]')).toHaveCount(0);
    await expect(page.locator('#loan-action')).toHaveCount(0);

    // It turns up: the Loan Return is not dated before the Not Returned date, and both facts stay.
    await page.locator('#loan-not-returned-link').click();
    await expect(page).toHaveURL(new RegExp(`/loans/${loanId}$`));
    await page.locator('#loan-return-action').click();
    await expect(page.locator(`[data-testid="loan-return-not-returned-${itemIdOf(lost.id)}"]`)).toContainText('ปิดโดยไม่ได้รับคืน');
    await page.locator(`#loan-return-select-${itemIdOf(lost.id)}`).check();
    await page.locator(`#loan-return-condition-${itemIdOf(lost.id)}`).selectOption('DAMAGED');
    await page.locator('#loan-return-return_date').fill(daysAgo(2));
    await page.locator('#loan-return-submit').click();
    await expect(page.locator('[data-testid="loan-return-form-error"]')).toContainText('ไม่ก่อนวันที่ทราบว่าไม่ได้รับคืน');
    await page.locator('#loan-return-return_date').fill(daysAgo(0));
    await page.locator('#loan-return-submit').click();
    await expect(page.locator('#loan-status')).toContainText('คืนครบ');
    await expect(itemOf(lost.name).locator('[data-testid="loan-item-return"]')).toContainText('ชำรุด');
    await expect(itemOf(lost.name).locator('[data-testid="loan-item-not-returned"]')).toContainText('ผู้ยืมแจ้งว่าทำหายระหว่างเดินทาง');

    // Now the Asset can be lent again.
    await page.goto(`${targetBaseUrl}/assets/${lost.id}`);
    await expect(page.locator('#loan-action')).toBeVisible();
    await expect(page.locator('[data-testid="loan-not-returned"]')).toHaveCount(0);

    // A form opened before an Asset was closed as Not Returned elsewhere: the server refuses the new
    // Loan, and the refusal names the Asset, the reason and the Loan.
    const { asset: raced } = await assetService.registerAsset(custodianUserId, { name: 'กล้อง E2E ถูกปิดระหว่างกรอก' } as any);
    await page.goto(`${targetBaseUrl}/assets/${raced.id}`);
    await page.locator('#loan-action').click();
    await page.getByLabel('ผู้ยืมภายนอก').check();
    await page.locator('#loan-contact_name').fill('คุณผู้ยืมรายใหม่ E2E');
    await page.locator('#loan-due_date').fill('2099-12-31');
    const elsewhere = await loanService.start(
      custodianUserId,
      { assets: [{ asset_id: raced.id, condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืมก่อนหน้า E2E' }, loan_date: daysAgo(3), due_date: '2099-12-31' },
      { retryToken: crypto.randomUUID() }
    );
    await new NotReturnedService({ db: pool }).record(
      custodianUserId,
      elsewhere.loan_id,
      { expected_version: elsewhere.version, not_returned_date: daysAgo(0), reason: 'ผู้ยืมแจ้งว่าทำหาย', items: [{ loan_item_id: elsewhere.items[0].id }] },
      { retryToken: crypto.randomUUID() }
    );
    await page.locator('#loan-submit').click();
    const refused = page.locator('[data-testid="loan-refused"]');
    await expect(refused).toContainText('กล้อง E2E ถูกปิดระหว่างกรอก');
    await expect(refused).toContainText('ปิดโดยไม่ได้รับคืน');
    await expect(refused.getByRole('link', { name: 'ดูการยืม' })).toHaveAttribute('href', `/loans/${elsewhere.loan_id}`);
    expect((await loanReadService.itemsOfAsset(raced.id))!.map(({ loan_id }) => loan_id)).toEqual([elsewhere.loan_id]);
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
    const loan = await loanReadService.read(loanId, { includePhone: false });
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

  // F004-T6 (#80): correcting a Loan from its page, up to voiding a Loan Return that never happened.
  test('Journey F004-T6.1: a Custodian amends a Loan field and voids a Loan Return from the Loan page, and sees the correction and the item Outstanding again', async ({ page, context }) => {
    const { asset } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องฉาย E2E แก้ไขการยืม' } as any);
    const started = await loanService.start(
      custodianUserId,
      {
        assets: [{ asset_id: asset.id, condition: 'NORMAL' }],
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม E2E แก้ไข' },
        loan_date: daysAgo(3),
        due_date: '2099-12-31',
        remark: 'ยืมไปใช้ประชุม',
      },
      { retryToken: crypto.randomUUID() }
    );
    await new LoanReturnService({ db: pool }).record(
      custodianUserId,
      started.loan_id,
      { expected_version: started.version, return_date: daysAgo(1), items: [{ loan_item_id: started.items[0].id, condition: 'NORMAL' }] },
      { retryToken: crypto.randomUUID() }
    );
    const loanReturnId = (await loanReadService.read(started.loan_id, { includePhone: false }))!.items[0].loan_return!.id;
    const item = page.locator('[data-testid="loan-item"]');

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/loans/${started.loan_id}`);
    await expect(page.locator('#loan-status')).toContainText('คืนครบ');

    // Amending a Loan field needs a reason, and the correction shows before and after.
    await page.locator('#loan-amend-action').click();
    await page.locator('#loan-amend-remark').fill('ยืมไปใช้อบรม');
    await page.locator('#loan-amend-reason').fill('บันทึกวัตถุประสงค์ผิด');
    await page.locator('#loan-amend-submit').click();
    await expect(page.locator('#loan-amend-form')).toHaveCount(0);
    const corrections = page.locator('#loan-corrections [data-testid="loan-correction"]');
    await expect(corrections).toHaveCount(1);
    await expect(corrections.first()).toContainText('บันทึกวัตถุประสงค์ผิด');
    await expect(corrections.first()).toContainText('หมายเหตุ: ยืมไปใช้ประชุม แก้เป็น ยืมไปใช้อบรม');
    await expect(corrections.first()).toContainText('custodian_loan');

    // Voiding the Loan Return keeps it shown as voided, and the item is Outstanding again.
    await page.locator(`#loan-return-${loanReturnId}-void-action`).click();
    await page.locator('#loan-void-reason').fill('ผู้ยืมยังไม่ได้นำมาคืน บันทึกผิดรายการ');
    await page.locator('#loan-void-submit').click();
    await expect(page.locator('#loan-void-form')).toHaveCount(0);
    await expect(page.locator(`[data-testid="loan-ending-voided-${loanReturnId}"]`)).toContainText('ยกเลิกแล้ว');
    await expect(item.locator('[data-testid="loan-item-return"]')).toHaveCount(0);
    await expect(item.locator('[data-testid="loan-item-outstanding"]')).toHaveText('ยังไม่คืน');
    await expect(page.locator('#loan-status')).toContainText('ยังไม่คืน');
    await expect(corrections).toHaveCount(2);
    await expect(corrections.nth(1)).toContainText('ผู้ยืมยังไม่ได้นำมาคืน บันทึกผิดรายการ');

    // The Asset is On Loan again.
    await page.goto(`${targetBaseUrl}/assets/${asset.id}`);
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText('คุณผู้ยืม E2E แก้ไข');

    // A Read-only User sees the corrections and no action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/loans/${started.loan_id}`);
    await expect(corrections).toHaveCount(2);
    await expect(page.locator(`[data-testid="loan-ending-voided-${loanReturnId}"]`)).toBeVisible();
    await expect(page.locator('main button')).toHaveCount(0);
  });
});
