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
import { LoanService } from '../../../api/src/services/loan.service.ts';
import { LoanReturnService } from '../../../api/src/services/loan-return.service.ts';
import { RepairService } from '../../../api/src/services/repair.service.ts';
import { RetirementService } from '../../../api/src/services/retirement.service.ts';
import { VerificationService } from '../../../api/src/services/verification.service.ts';
import { ReferenceService } from '../../../api/src/services/reference.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F007-T1 (#155): recording a Retirement from the Asset page, after resolving the Loan that kept the Asset,
// and seeing the Retired Asset on its page and in the Asset list. F007-T2 (#156): a Retired Asset in the
// Loan form, on the Loan page and on the Repair Record page. F007-T3 (#157): a Retired Asset in a Bulk
// Reassignment, and a Reassignment refused once its Asset is Retired. F007-T4 (#158): an Asset retired while a
// Verification Round is open, in the Round's entries and in its "ตรวจประจำปี" panel.
test.describe.serial('Retirement journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let assetService: AssetService;
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
    loanService = new LoanService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-retirement-e2e',
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
    custodianUserId = await createUser('custodian_retirement', 'ASSET_CUSTODIAN');
    readonlyUserId = await createUser('readonly_retirement', 'READ_ONLY');
    adminUserId = await createUser('admin_retirement', 'ADMINISTRATOR');

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

  test('Journey F007-T1.1: a Custodian cannot retire an Asset On Loan, ends its LoanItem Not Returned, retires it, and finds it as "จำหน่ายแล้ว"; a Read-only User sees the Retirement with no action', async ({ page, context }) => {
    const { asset: lost } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องฉาย E2E จำหน่าย' } as any);
    const { asset: kept } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องฉาย E2E ยังใช้อยู่' } as any);
    const { loan_id: loanId, items } = await loanService.start(
      custodianUserId,
      { assets: [{ asset_id: lost.id, condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม E2E จำหน่าย' }, loan_date: daysAgo(5), due_date: '2099-12-31' },
      { retryToken: crypto.randomUUID() }
    );

    // On Loan: "จำหน่าย" is offered, and says why it cannot go on, linking to the Loan instead of the form.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${lost.id}`);
    await expect(page.locator('[data-testid="retirement-history-empty"]')).toBeVisible();
    await page.locator('#retirement-action').click();
    await expect(page.locator('[data-testid="retirement-blocked"]')).toContainText('กำลังถูกยืม');
    await expect(page.locator('#retirement-form')).toHaveCount(0);
    await page.locator('#retirement-blocked-link').click();
    await expect(page).toHaveURL(new RegExp(`/loans/${loanId}$`));

    // It never came back: the Custodian ends the LoanItem Not Returned, as it really ended.
    await page.locator('#loan-not-returned-action').click();
    await page.locator(`#loan-not-returned-select-${items[0].id}`).check();
    await page.locator('#loan-not-returned-date').fill(daysAgo(1));
    await page.locator('#loan-not-returned-reason').fill('ผู้ยืมแจ้งว่าทำหาย');
    await page.locator('#loan-not-returned-submit').click();
    await expect(page.locator('[data-testid="loan-item-not-returned"]')).toContainText('ปิดโดยไม่ได้รับคืน');

    // Now the Asset can be retired; the form asks for the Retirement Method first.
    await page.goto(`${targetBaseUrl}/assets/${lost.id}`);
    await expect(page.locator('#repair-action')).toBeVisible();
    await expect(page.locator('#assignment-action')).toBeVisible();
    await expect(page.locator('[data-testid="retired-banner"]')).toHaveCount(0);
    await page.locator('#retirement-action').click();
    await expect(page.locator('[data-testid="retirement-blocked"]')).toHaveCount(0);
    await page.locator('#retirement-submit').click();
    await expect(page.locator('[data-testid="retirement-form-error"]')).toContainText('กรุณาเลือกวิธีจำหน่าย');
    await page.locator('#retirement-retirement_method').selectOption('DECLARED_LOSS');
    await page.locator('#retirement-retirement_reference').fill('คำสั่งจำหน่ายเป็นสูญ 7/2569');
    await page.locator('#retirement-note').fill('ผู้ยืมทำหาย ไม่ได้รับคืน');
    await page.locator('#retirement-submit').click();

    // Its page says "จำหน่ายแล้ว" at the top, shows the Retirement, and offers no new event.
    const banner = page.locator('[data-testid="retired-banner"]');
    await expect(banner).toContainText('จำหน่ายแล้ว');
    await expect(banner).toContainText('จำหน่ายเป็นสูญ');
    const history = page.locator('[data-testid="retirement-history"]');
    await expect(history).toContainText('จำหน่ายเป็นสูญ');
    await expect(history).toContainText('คำสั่งจำหน่ายเป็นสูญ 7/2569');
    await expect(history).toContainText('custodian_retirement');
    await expect(page.locator('[data-testid="current-assignment-as-at-retirement"]')).toContainText('ณ วันจำหน่าย');
    await expect(page.locator('#retirement-action')).toHaveCount(0);
    await expect(page.locator('#repair-action')).toHaveCount(0);
    await expect(page.locator('#assignment-action')).toHaveCount(0);
    await expect(page.locator('#loan-action')).toHaveCount(0);
    // Its history and register correction stay.
    await expect(page.locator('[data-testid="loan-history-not-returned"]')).toContainText('ปิดโดยไม่ได้รับคืน');
    await expect(page.locator('#asset-correction-form')).toBeVisible();

    // The Asset list shows every Asset, marks the Retired one, and the filter "จำหน่ายแล้ว" finds it alone.
    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-field').selectOption('name');
    await page.locator('#search-value').fill('เครื่องฉาย E2E');
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 2 รายการ');
    await expect(page.locator(`[data-testid="search-result-retired-${lost.id}"]`)).toContainText('จำหน่ายแล้ว');
    await expect(page.locator(`[data-testid="search-result-retired-${kept.id}"]`)).toHaveCount(0);
    await page.locator('#search-filter-retired').selectOption('true');
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="search-result-row-${lost.id}"]`)).toBeVisible();
    await page.locator('#search-filter-retired').selectOption('false');
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="search-result-row-${kept.id}"]`)).toBeVisible();

    // A Custodian is offered "จำหน่าย" on an Asset still in use; a Read-only User is not.
    await page.goto(`${targetBaseUrl}/assets/${kept.id}`);
    await expect(page.locator('#retirement-action')).toBeVisible();
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${kept.id}`);
    await expect(page.locator('[data-testid="retirement-history-empty"]')).toBeVisible();
    await expect(page.locator('#retirement-action')).toHaveCount(0);

    // The Read-only User opens the Retired Asset as its QR link would, and sees the Retirement with no action.
    await page.goto(`${targetBaseUrl}/assets/${lost.id}`);
    await expect(page.locator('[data-testid="retired-banner"]')).toContainText('จำหน่ายเป็นสูญ');
    await expect(page.locator('[data-testid="retirement-history"]')).toContainText('คำสั่งจำหน่ายเป็นสูญ 7/2569');
    await expect(page.locator('[data-testid="loan-history-not-returned"]')).toContainText('ปิดโดยไม่ได้รับคืน');
    await expect(page.locator('#retirement-action')).toHaveCount(0);
  });

  test('Journey F007-T2.1: the Loan form shows a Retired Asset as not allowed with "จำหน่ายแล้ว" and the server refuses it; its Loan Return ชำรุด offers no "ส่งซ่อม", and voiding that Loan Return or its Repair Outcome is refused', async ({ page, context }) => {
    const tag = `E2E ${crypto.randomUUID().slice(0, 8)}`;
    const { asset: gone } = await assetService.registerAsset(custodianUserId, { name: `${tag} ลำโพงที่จำหน่ายแล้ว` } as any);
    const { asset: kept } = await assetService.registerAsset(custodianUserId, { name: `${tag} ลำโพงที่ยังใช้อยู่` } as any);
    // A Retired Asset with a Repair Record and no Loan: voiding its Repair Outcome meets no Repair Conflict.
    const { asset: broken } = await assetService.registerAsset(custodianUserId, { name: `${tag} ไมโครโฟนที่จำหน่ายแล้ว` } as any);
    const loan = await loanService.start(
      custodianUserId,
      { assets: [gone, kept].map(({ id }) => ({ asset_id: id, condition: 'NORMAL' as const })), borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม E2E จำหน่าย 2' }, loan_date: daysAgo(5), due_date: daysAgo(2) },
      { retryToken: crypto.randomUUID() }
    );
    await new LoanReturnService({ db: pool }).record(
      custodianUserId,
      loan.loan_id,
      { expected_version: loan.version, return_date: daysAgo(2), items: loan.items.map(({ id }) => ({ loan_item_id: id, condition: 'DAMAGED' as const })) },
      { retryToken: crypto.randomUUID() }
    );
    const repair = await new RepairService({ db: pool }).start(
      custodianUserId,
      { asset_id: broken.id, repair_kind: 'REPAIR', start_date: daysAgo(2), repairer: { kind: 'INTERNAL' }, symptom_or_work: 'ไม่มีเสียง', outcome: { outcome: 'NOT_USABLE', outcome_date: daysAgo(2) } },
      { retryToken: crypto.randomUUID() }
    );
    for (const { id } of [gone, broken]) {
      await new RetirementService({ db: pool }).record(custodianUserId, id, { retirement_date: daysAgo(1), retirement_method: 'SALE' }, { retryToken: crypto.randomUUID() });
    }
    const returnOf = async (assetId: string) =>
      (await pool.query("SELECT e.id FROM loan_item_endings e JOIN loan_items li ON li.id = e.loan_item_id WHERE li.asset_id = $1 AND e.kind = 'LOAN_RETURN'", [assetId])).rows[0].id;

    // Both came back ชำรุด: "ส่งซ่อม" is offered for the Asset still in use, not for the Retired one.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/loans/${loan.loan_id}`);
    await expect(page.locator(`#loan-return-${await returnOf(kept.id)}-repair-action`)).toBeVisible();
    await expect(page.locator(`#loan-return-${await returnOf(gone.id)}-repair-action`)).toHaveCount(0);

    // Voiding the Retired Asset's Loan Return would put it On Loan again: refused, pointing to its Retirement.
    await page.locator(`#loan-return-${await returnOf(gone.id)}-void-action`).click();
    await page.locator('#loan-void-reason').fill('บันทึกการคืนผิด E2E');
    await page.locator('#loan-void-submit').click();
    await expect(page.locator('[data-testid="loan-void-refused"]')).toContainText('จำหน่ายแล้ว ถ้าการจำหน่ายบันทึกผิด ต้องยกเลิกรายการจำหน่ายก่อน');
    await page.locator('#loan-void-cancel').click();

    // Voiding its Repair Outcome would put it Under Repair again: refused the same way.
    await page.goto(`${targetBaseUrl}/repairs/${repair.repair_record_id}`);
    await page.locator('#repair-outcome-void-action').click();
    await page.locator('#repair-void-reason').fill('บันทึกผลผิด E2E');
    await page.locator('#repair-void-submit').click();
    await expect(page.locator('[data-testid="repair-void-refused"]')).toContainText('ยกเลิกผลการซ่อมไม่ได้ เพราะ');
    await expect(page.locator('[data-testid="repair-void-refused"]')).toContainText('จำหน่ายแล้ว ถ้าการจำหน่ายบันทึกผิด ต้องยกเลิกรายการจำหน่ายก่อน');

    // The Asset list still lets the Retired Asset be selected; the Loan form shows it as not allowed, not hidden.
    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-field').selectOption('name');
    await page.locator('#search-value').fill(tag);
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 3 รายการ');
    await page.getByTestId(`asset-select-${gone.id}`).check();
    await page.getByTestId(`asset-select-${kept.id}`).check();
    await page.locator('#loan-from-list-open').click();
    await expect(page.locator(`#loan-condition-${gone.id}`)).toBeVisible();
    await expect(page.locator(`[data-testid="loan-retired-${gone.id}"]`)).toContainText('ยืมไม่ได้ เพราะจำหน่ายแล้ว');
    await expect(page.locator(`[data-testid="loan-retired-${kept.id}"]`)).toHaveCount(0);

    // The server refuses it by name, with a link to its Retirement, and saves nothing.
    await page.getByLabel('ผู้ยืมภายนอก').check();
    await page.locator('#loan-contact_name').fill('คุณยืมของที่จำหน่าย E2E');
    await page.locator('#loan-due_date').fill('2099-12-31');
    await page.locator('#loan-submit').click();
    const refused = page.locator('[data-testid="loan-refused"]');
    await expect(refused).toContainText(`${tag} ลำโพงที่จำหน่ายแล้ว: จำหน่ายแล้ว`);
    await expect(refused).not.toContainText('ลำโพงที่ยังใช้อยู่');
    expect((await pool.query('SELECT count(*)::int AS n FROM loan_items WHERE asset_id = ANY($1::uuid[])', [[gone.id, kept.id]])).rows[0].n).toBe(2);
    await refused.getByRole('link', { name: 'ดูการจำหน่าย' }).click();
    await expect(page).toHaveURL(new RegExp(`/assets/${gone.id}$`));
    await expect(page.locator('[data-testid="retired-banner"]')).toContainText('จำหน่ายแล้ว');
  });

  test('Journey F007-T3.1: a Bulk Reassignment shows a Retired Asset as not allowed with "จำหน่ายแล้ว" and its preview is refused naming it; a Reassignment form opened before a Retirement is refused once it commits', async ({ page, context }) => {
    const tag = `E2E ${crypto.randomUUID().slice(0, 8)}`;
    const referenceService = new ReferenceService({ db: pool });
    const room = await referenceService.create('locations', adminUserId, `${tag} ห้องเดิม`);
    const target = await referenceService.create('locations', adminUserId, `${tag} ห้องปลายทาง`);
    const placed = async (name: string) =>
      (await assetService.registerAsset(custodianUserId, { name: `${tag} ${name}`, location_id: room.id, effective_date: daysAgo(30) } as any)).asset;
    const gone = await placed('ตู้ที่จำหน่ายแล้ว');
    const kept = await placed('ตู้ที่ยังใช้อยู่');
    const retire = (assetId: string) =>
      new RetirementService({ db: pool }).record(custodianUserId, assetId, { retirement_date: daysAgo(1), retirement_method: 'SALE' }, { retryToken: crypto.randomUUID() });
    await retire(gone.id);
    const eventsOf = async (): Promise<number> =>
      (await pool.query('SELECT count(*)::int AS n FROM assignment_events WHERE asset_id = ANY($1::uuid[])', [[gone.id, kept.id]])).rows[0].n;

    // The Retired Asset's page offers no "ย้าย"; the other one's does.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${gone.id}`);
    await expect(page.locator('[data-testid="retired-banner"]')).toBeVisible();
    await expect(page.locator('#assignment-action')).toHaveCount(0);

    // The Asset list still lets it be selected; the Bulk Reassignment form shows it as not allowed, not hidden.
    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-field').selectOption('name');
    await page.locator('#search-value').fill(tag);
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#results-count-summary')).toContainText('พบ 2 รายการ');
    await page.getByTestId(`asset-select-${gone.id}`).check();
    await page.getByTestId(`asset-select-${kept.id}`).check();
    await page.locator('#bulk-reassign-open').click();
    await expect(page.getByTestId(`assignment-retired-${gone.id}`)).toContainText(`${tag} ตู้ที่จำหน่ายแล้ว ย้ายไม่ได้ เพราะจำหน่ายแล้ว`);
    await expect(page.getByTestId(`assignment-retired-${kept.id}`)).toHaveCount(0);

    // The server refuses the preview by name, with a link to the Retirement, and saves nothing.
    await page.locator('#assignment-location_id').selectOption(target.id);
    await page.locator('#bulk-reassign-preview').click();
    const refused = page.getByTestId('bulk-reassign-error');
    await expect(refused).toContainText('จำหน่ายแล้ว จึงย้ายไม่ได้');
    await expect(page.getByTestId(`bulk-retired-${gone.id}`)).toContainText(`${tag} ตู้ที่จำหน่ายแล้ว จำหน่ายแล้ว`);
    await expect(refused).not.toContainText('ตู้ที่ยังใช้อยู่');
    expect(await eventsOf()).toBe(2);
    await page.getByTestId(`bulk-retired-${gone.id}`).getByRole('link', { name: 'ดูการจำหน่าย' }).click();
    await expect(page).toHaveURL(new RegExp(`/assets/${gone.id}$`));

    // A Reassignment form opened before the other Asset's Retirement is refused once it commits, saving nothing.
    await page.goto(`${targetBaseUrl}/assets/${kept.id}`);
    await page.locator('#assignment-action').click();
    await page.locator('#assignment-location_id').selectOption(target.id);
    await retire(kept.id);
    await page.locator('#assignment-submit').click();
    await expect(page.getByTestId('assignment-form-error')).toContainText('บันทึกไม่ได้ เพราะครุภัณฑ์นี้จำหน่ายแล้ว');
    expect(await eventsOf()).toBe(2);
  });

  test('Journey F007-T4.1: an Asset retired while a Round is open shows "จำหน่ายแล้ว" in the Round with no "ส่งซ่อม" or "ย้าย", its "ตรวจประจำปี" panel offers no recording, and a result form opened before its Retirement is refused', async ({ page, context }) => {
    const tag = `E2E ${crypto.randomUUID().slice(0, 8)}`;
    const referenceService = new ReferenceService({ db: pool });
    const verificationService = new VerificationService({ db: pool });
    const room = await referenceService.create('locations', adminUserId, `${tag} ห้องตรวจ`);
    const seen = await referenceService.create('locations', adminUserId, `${tag} ห้องที่พบ`);
    const placed = async (name: string) =>
      (await assetService.registerAsset(custodianUserId, { name: `${tag} ${name}`, location_id: room.id, effective_date: daysAgo(30) } as any)).asset;
    const gone = await placed('ก ตู้ที่จำหน่ายแล้ว');
    const kept = await placed('ข ตู้ที่ยังใช้อยู่');
    const pending = await placed('ค ตู้ที่จำหน่ายก่อนตรวจ');
    const late = await placed('ง ตู้ที่จำหน่ายขณะเปิดฟอร์ม');
    const outside = (await assetService.registerAsset(custodianUserId, { name: `${tag} จ ตู้นอกรอบ` } as any)).asset;
    const { verification_round_id: roundId } = await verificationService.open(
      custodianUserId,
      { name: `${tag} ตรวจประจำปี`, fiscal_year: 2569, location_ids: [room.id] },
      { retryToken: crypto.randomUUID() }
    );
    // Both found ชำรุด in another room: each result would offer "ส่งซ่อม" and "ย้าย".
    for (const { id } of [gone, kept]) {
      await verificationService.record(custodianUserId, roundId, id, { result: 'FOUND', condition: 'DAMAGED', observed_location_id: seen.id }, { retryToken: crypto.randomUUID() });
    }
    const retire = (assetId: string) =>
      new RetirementService({ db: pool }).record(custodianUserId, assetId, { retirement_date: daysAgo(0), retirement_method: 'SALE' }, { retryToken: crypto.randomUUID() });
    await retire(gone.id);
    await retire(pending.id);
    const revisionsOf = async (assetId: string): Promise<number> =>
      (await pool.query('SELECT count(*)::int AS n FROM verification_revisions v JOIN verification_scope_entries e ON e.id = v.verification_scope_entry_id WHERE e.asset_id = $1', [assetId])).rows[0].n;

    // The Round keeps every Asset; the Retired ones show "จำหน่ายแล้ว" and the Retired result offers neither action.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.getByTestId(`scope-entry-retired-${gone.id}`)).toContainText('จำหน่ายแล้ว');
    await expect(page.getByTestId(`scope-entry-retired-${pending.id}`)).toContainText('จำหน่ายแล้ว');
    await expect(page.getByTestId(`scope-entry-retired-${kept.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`scope-entry-result-${pending.id}`)).toContainText('ยังไม่ได้ตรวจ');
    await expect(page.locator(`#scope-entry-repair-action-${kept.id}`)).toBeVisible();
    await expect(page.locator(`#scope-entry-reassign-action-${kept.id}`)).toBeVisible();
    await expect(page.locator(`#scope-entry-repair-action-${gone.id}`)).toHaveCount(0);
    await expect(page.locator(`#scope-entry-reassign-action-${gone.id}`)).toHaveCount(0);

    // "ยังไม่มี action ต่อ" leaves the Retired result out.
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}?awaiting_action=true`);
    await expect(page.getByTestId(`scope-entry-${kept.id}`)).toBeVisible();
    await expect(page.getByTestId(`scope-entry-${gone.id}`)).toHaveCount(0);

    // The panel of the Retired Asset with no result says so and offers no recording.
    await page.goto(`${targetBaseUrl}/assets/${pending.id}`);
    await expect(page.getByTestId('verification-panel-retired')).toContainText('จำหน่ายแล้ว บันทึกผลตรวจใหม่ไม่ได้');
    await expect(page.getByTestId('verification-panel-not-yet-verified')).toContainText('ยังไม่ได้ตรวจ');
    await expect(page.locator('#verification-record-form')).toHaveCount(0);

    // The panel of the Retired Asset with a result offers only the Verification Correction.
    await page.goto(`${targetBaseUrl}/assets/${gone.id}`);
    await expect(page.getByTestId('verification-panel-retired')).toContainText('จำหน่ายแล้ว');
    await expect(page.locator('#verification-void-action')).toBeVisible();
    await expect(page.locator('#verification-reverify-action')).toHaveCount(0);
    await expect(page.locator('#verification-repair-action')).toHaveCount(0);
    await expect(page.locator('#verification-reassign-action')).toHaveCount(0);

    // A result form opened before the Asset's Retirement is refused once it commits, saving nothing.
    await page.goto(`${targetBaseUrl}/assets/${late.id}`);
    await expect(page.locator('#verification-record-form')).toBeVisible();
    await expect(page.getByTestId('verification-panel-retired')).toHaveCount(0);
    await page.locator('#verification-record-result-NOT_FOUND').check();
    await retire(late.id);
    await page.locator('#verification-record-submit').click();
    await expect(page.getByTestId('verification-record-refused')).toContainText('บันทึกไม่ได้ เพราะครุภัณฑ์นี้จำหน่ายแล้ว');
    expect(await revisionsOf(late.id)).toBe(0);

    // A Late Addition form opened before the Asset's Retirement is refused the same way, adding nothing; then the
    // panel offers none.
    await page.goto(`${targetBaseUrl}/assets/${outside.id}`);
    await page.locator('#verification-late-addition-action').click();
    await page.locator('#verification-late-addition-reason').fill('พบภายหลังว่าตกหล่น E2E');
    await retire(outside.id);
    await page.locator('#verification-late-addition-submit').click();
    await expect(page.getByTestId('verification-late-addition-refused')).toContainText('เพิ่มไม่ได้ เพราะครุภัณฑ์นี้จำหน่ายแล้ว');
    expect((await pool.query('SELECT count(*)::int AS n FROM verification_scope_entries WHERE asset_id = $1', [outside.id])).rows[0].n).toBe(0);
    await page.goto(`${targetBaseUrl}/assets/${outside.id}`);
    await expect(page.getByTestId('verification-panel-retired')).toContainText('จำหน่ายแล้ว เพิ่มเข้ารอบภายหลังไม่ได้');
    await expect(page.getByTestId('verification-panel-not-in-round')).toHaveText('ครุภัณฑ์นี้ไม่อยู่ในรายการของรอบตรวจนี้');
    await expect(page.locator('#verification-late-addition-action')).toHaveCount(0);
  });
});
