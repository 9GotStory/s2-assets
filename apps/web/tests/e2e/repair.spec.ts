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
import { RepairService } from '../../../api/src/services/repair.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F005-T1 (#99): sending an Asset for repair or maintenance from its page. F005-T2 (#100): recording how
// it ended, alone or with its Repair Start.
test.describe.serial('Repair journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let assetService: AssetService;
  let repairService: RepairService;

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
    repairService = new RepairService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-repair-e2e',
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
    custodianUserId = await createUser('custodian_repair', 'ASSET_CUSTODIAN');
    readonlyUserId = await createUser('readonly_repair', 'READ_ONLY');

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

  // Lends the Asset from its page, to an External Borrower, and sees it On Loan.
  const lendFromAssetPage = async (page: any, contactName: string) => {
    await page.locator('#loan-action').click();
    await page.getByLabel('ผู้ยืมภายนอก').check();
    await page.locator('#loan-contact_name').fill(contactName);
    await page.locator('#loan-due_date').fill('2099-12-31');
    await page.locator('#loan-submit').click();
    await expect(page.locator('[data-testid="loan-on-loan"]')).toContainText(contactName);
  };

  const yesterday = () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  };

  test('Journey F005-T1.1: a Custodian sends an Asset for repair from its page and sees "อยู่ระหว่างซ่อม", a Loan of it is refused, and a Read-only User sees the section with no action', async ({ page, context }) => {
    const { asset } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องพิมพ์ E2E ส่งซ่อม' } as any);

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${asset.id}`);
    const section = page.locator('#repair-section');
    await expect(section.getByRole('heading', { name: 'การซ่อม/บำรุงรักษา' })).toBeVisible();
    await expect(page.locator('[data-testid="repair-history-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="repair-under-repair"]')).toHaveCount(0);

    await page.locator('#repair-action').click();

    // The form says what it needs before asking the server.
    await page.locator('#repair-submit').click();
    await expect(page.locator('[data-testid="repair-form-error"]')).toBeVisible();

    await page.locator('#repair-repair_kind').selectOption('REPAIR');
    await page.locator('#repair-start_date').fill(yesterday());
    await page.getByLabel('ผู้ซ่อมภายนอก').check();
    await page.locator('#repair-repairer_name').fill('ร้านซ่อมดี E2E');
    await page.locator('#repair-symptom_or_work').fill('กระดาษติด\nมีเสียงดัง');
    await page.locator('#repair-under_warranty').selectOption('NO');
    await page.locator('#repair-cost').fill('1500.50');
    await page.locator('#repair-document_reference').fill('ใบรับซ่อม 77/2569');
    await page.locator('#repair-assignment_remark').fill('ร้านโทรแจ้งเมื่อเสร็จ');
    await page.locator('#repair-submit').click();

    // The Asset is Under Repair, and the page links to its Repair Record instead of offering another.
    const underRepair = page.locator('[data-testid="repair-under-repair"]');
    await expect(underRepair).toContainText('อยู่ระหว่างซ่อม');
    await expect(underRepair).toContainText('ร้านซ่อมดี E2E');
    await expect(page.locator('#repair-action')).toHaveCount(0);
    await expect(page.locator('[data-testid="repair-history"] li')).toHaveCount(1);

    // A Loan of it is refused, naming why.
    await page.locator('#loan-action').click();
    await page.getByLabel('ผู้ยืมภายนอก').check();
    await page.locator('#loan-contact_name').fill('คุณยืมของที่ซ่อม');
    await page.locator('#loan-due_date').fill('2099-12-31');
    await page.locator('#loan-submit').click();
    const refused = page.locator('[data-testid="loan-refused"]');
    await expect(refused).toContainText('เครื่องพิมพ์ E2E ส่งซ่อม');
    await expect(refused).toContainText('อยู่ระหว่างซ่อม');
    await page.locator('#loan-cancel').click();

    // The Repair Record page shows every fact.
    await page.locator('#repair-current-link').click();
    await expect(page).toHaveURL(/\/repairs\/[0-9a-f-]{36}$/);
    const recordUrl = page.url();
    await expect(page.locator('#repair-asset')).toHaveText('เครื่องพิมพ์ E2E ส่งซ่อม');
    await expect(page.locator('#repair-kind')).toHaveText('ซ่อม');
    await expect(page.locator('#repair-repairer')).toHaveText('ภายนอก: ร้านซ่อมดี E2E');
    await expect(page.locator('#repair-symptom-or-work')).toHaveText('กระดาษติด\nมีเสียงดัง');
    await expect(page.locator('#repair-under-warranty')).toHaveText('ไม่ใช่');
    await expect(page.locator('#repair-cost')).toHaveText('1,500.50 บาท');
    await expect(page.locator('#repair-document-reference')).toHaveText('ใบรับซ่อม 77/2569');
    await expect(page.locator('#repair-remark')).toHaveText('ร้านโทรแจ้งเมื่อเสร็จ');
    await expect(page.locator('#repair-recorded-by')).toHaveText('custodian_repair');
    await expect(page.locator('#repair-recorded-at')).not.toBeEmpty();

    // A Read-only User sees the section, with no action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${asset.id}`);
    await expect(page.locator('[data-testid="repair-under-repair"]')).toContainText('อยู่ระหว่างซ่อม');
    await expect(page.locator('[data-testid="repair-history"] li')).toHaveCount(1);
    await expect(page.locator('#repair-action')).toHaveCount(0);

    await page.goto(recordUrl);
    await expect(page.locator('#repair-repairer')).toHaveText('ภายนอก: ร้านซ่อมดี E2E');
    await expect(page.locator('#repair-cost')).toHaveText('1,500.50 บาท');
    await expect(page.locator('main button')).toHaveCount(0);

    // Nor is the action offered on an Asset free to send, where the Custodian saw it above; maintenance reads as such.
    const { asset: free } = await assetService.registerAsset(custodianUserId, { name: 'จอภาพ E2E ไม่ได้ส่งซ่อม' } as any);
    await page.goto(`${targetBaseUrl}/assets/${free.id}`);
    await expect(page.locator('[data-testid="repair-history-empty"]')).toBeVisible();
    await expect(page.locator('#repair-action')).toHaveCount(0);

    const { asset: serviced } = await assetService.registerAsset(custodianUserId, { name: 'แอร์ E2E บำรุงรักษา' } as any);
    await repairService.start(
      custodianUserId,
      { asset_id: serviced.id, repair_kind: 'MAINTENANCE', start_date: yesterday(), repairer: { kind: 'INTERNAL' }, symptom_or_work: 'ล้างแอร์ประจำปี' },
      { retryToken: crypto.randomUUID() }
    );
    await page.goto(`${targetBaseUrl}/assets/${serviced.id}`);
    await expect(page.locator('[data-testid="repair-under-repair"]')).toContainText('อยู่ระหว่างบำรุงรักษา');
    await expect(page.locator('[data-testid="repair-history"] li')).toContainText('บำรุงรักษา');
  });

  test('Journey F005-T2.1: a Custodian records ใช้งานได้ on an Asset Under Repair, which is then lent', async ({ page, context }) => {
    const { asset } = await assetService.registerAsset(custodianUserId, { name: 'โน้ตบุ๊ก E2E รอผลซ่อม' } as any);
    const { repair_record_id: repairRecordId } = await repairService.start(
      custodianUserId,
      { asset_id: asset.id, repair_kind: 'REPAIR', start_date: yesterday(), repairer: { kind: 'EXTERNAL', name: 'ร้านซ่อม E2E' }, symptom_or_work: 'จอไม่ติด', cost: '200' },
      { retryToken: crypto.randomUUID() }
    );

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/repairs/${repairRecordId}`);
    await expect(page.locator('#repair-status')).toHaveText('อยู่ระหว่างซ่อม');
    await expect(page.locator('[data-testid="repair-outcome-none"]')).toBeVisible();

    await page.locator('#repair-outcome-action').click();
    // The record's cost is shown for the Custodian to keep or change, and where the Asset goes back to.
    await expect(page.locator('#repair-outcome-cost')).toHaveValue('200.00');
    await expect(page.locator('[data-testid="repair-outcome-assignment"]')).toBeVisible();
    await expect(page.getByLabel('ซ่อมไม่ได้')).toBeVisible();

    // The form says what it needs before asking the server.
    await page.locator('#repair-outcome-submit').click();
    await expect(page.locator('[data-testid="repair-outcome-form-error"]')).toBeVisible();

    await page.getByLabel('ใช้งานได้').check();
    await page.locator('#repair-outcome-cost').fill('350');
    await page.locator('#repair-outcome-outcome_note').fill('เปลี่ยนสายแพจอ');
    await page.locator('#repair-outcome-outcome_document_reference').fill('ใบแจ้งหนี้ 9/2569');
    await page.locator('#repair-outcome-submit').click();

    await expect(page.locator('#repair-outcome-value')).toHaveText('ใช้งานได้');
    await expect(page.locator('#repair-status')).toHaveText('ผลการซ่อม: ใช้งานได้');
    await expect(page.locator('#repair-outcome-note')).toHaveText('เปลี่ยนสายแพจอ');
    await expect(page.locator('#repair-outcome-document-reference')).toHaveText('ใบแจ้งหนี้ 9/2569');
    await expect(page.locator('#repair-cost')).toHaveText('350.00 บาท');
    await expect(page.locator('#repair-outcome-action')).toHaveCount(0);

    // The Asset is no longer Under Repair, its history shows the outcome, and it can be lent.
    await page.locator('#repair-asset').click();
    await expect(page.locator('[data-testid="repair-history"] li')).toHaveCount(1);
    await expect(page.locator(`[data-testid="repair-history-outcome-${repairRecordId}"]`)).toContainText('ใช้งานได้');
    await expect(page.locator('[data-testid="repair-under-repair"]')).toHaveCount(0);
    await expect(page.locator('#repair-action')).toBeVisible();
    await lendFromAssetPage(page, 'คุณยืมของที่ซ่อมแล้ว');
  });

  test('Journey F005-T2.2: maintenance recorded with its outcome in one step shows its Next Recommended Maintenance Date on the Asset page', async ({ page, context }) => {
    const { asset } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องปรับอากาศ E2E ล้างประจำปี' } as any);

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${asset.id}`);
    await expect(page.locator('[data-testid="repair-history-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="repair-next-maintenance-date"]')).toHaveCount(0);

    await page.locator('#repair-action').click();
    await page.locator('#repair-repair_kind').selectOption('MAINTENANCE');
    await page.locator('#repair-start_date').fill(yesterday());
    await page.getByLabel('ผู้ซ่อมภายใน').check();
    await page.locator('#repair-symptom_or_work').fill('ล้างแอร์ประจำปี');
    await page.locator('#repair-with-outcome').check();
    // Maintenance names its outcome ใช้งานไม่ได้, not ซ่อมไม่ได้.
    await expect(page.getByLabel('ใช้งานไม่ได้')).toBeVisible();
    await page.getByLabel('ใช้งานได้', { exact: true }).check();
    await page.locator('#repair-outcome_date').fill(yesterday());
    await page.locator('#repair-next_recommended_maintenance_date').fill('2099-06-01');
    await page.locator('#repair-outcome_note').fill('ล้างแผงคอยล์แล้ว');
    await page.locator('#repair-submit').click();

    // The Asset was never Under Repair, and the date shows on its page.
    await expect(page.locator('[data-testid="repair-history"] li')).toHaveCount(1);
    await expect(page.locator('[data-testid="repair-under-repair"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="repair-next-maintenance-date"] time')).toHaveAttribute('datetime', '2099-06-01');
    await expect(page.locator('[data-testid="repair-history"] li')).toContainText('ใช้งานได้');
    await expect(page.locator('[data-testid="repair-history"] li')).toContainText('ล้างแผงคอยล์แล้ว');
  });

  test('Journey F005-T2.3: after ซ่อมไม่ได้, the Start Loan form warns while the Asset stays in the register', async ({ page, context }) => {
    const { asset } = await assetService.registerAsset(custodianUserId, { name: 'สแกนเนอร์ E2E ซ่อมไม่ได้' } as any);
    const { repair_record_id: repairRecordId } = await repairService.start(custodianUserId, { asset_id: asset.id, repair_kind: 'REPAIR', start_date: yesterday(), repairer: { kind: 'INTERNAL' }, symptom_or_work: 'หัวอ่านเสีย' }, { retryToken: crypto.randomUUID() });

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/repairs/${repairRecordId}`);
    await page.locator('#repair-outcome-action').click();
    await page.getByLabel('ซ่อมไม่ได้').check();
    await page.locator('#repair-outcome-outcome_note').fill('ร้านเก็บเครื่องไว้');
    await page.locator('#repair-outcome-submit').click();
    await expect(page.locator('#repair-outcome-value')).toHaveText('ซ่อมไม่ได้');

    // Still in the register, not Under Repair, and its page offers a Loan that warns but is not blocked.
    await page.locator('#repair-asset').click();
    await expect(page.locator('h1')).toContainText('สแกนเนอร์ E2E ซ่อมไม่ได้');
    await expect(page.locator('[data-testid="repair-under-repair"]')).toHaveCount(0);
    await page.locator('#loan-action').click();
    const warning = page.locator(`[data-testid="loan-repair-outcome-warning-${asset.id}"]`);
    await expect(warning).toContainText('ซ่อมไม่ได้');
    await expect(warning.locator('time')).toHaveAttribute('datetime', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()));
    await expect(page.locator(`[data-testid="loan-damaged-warning-${asset.id}"]`)).toHaveCount(0);
    await page.locator('#loan-cancel').click();
    await lendFromAssetPage(page, 'คุณยืมของซ่อมไม่ได้');
  });
});
