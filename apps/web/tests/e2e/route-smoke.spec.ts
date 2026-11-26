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
import { AcquisitionService } from '../../../api/src/services/acquisition.service.ts';
import { LoanService } from '../../../api/src/services/loan.service.ts';
import { RepairService } from '../../../api/src/services/repair.service.ts';
import { VerificationService } from '../../../api/src/services/verification.service.ts';
import { CatalogListService } from '../../../api/src/services/catalog-list.service.ts';
import { RequestableMaterialService } from '../../../api/src/services/requestable-material.service.ts';
import { MaterialRequestService } from '../../../api/src/services/material-request.service.ts';
import { StockMaterialService } from '../../../api/src/services/stock-material.service.ts';
import { OpeningBalanceService } from '../../../api/src/services/opening-balance.service.ts';
import { MaterialReceiptService } from '../../../api/src/services/material-receipt.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// The ids a smoke visit fills into a route's parameters.
interface Fixtures {
  assetId: string;
  assetName: string;
  acquisitionId: string;
  loanId: string;
  repairRecordId: string;
  verificationRoundId: string;
  stockMaterialId: string;
  stockMaterialName: string;
  requestableMaterialId: string;
  requestableMaterialName: string;
  materialRequestId: string;
  requestNumber: string;
  openingBalanceId: string;
  confirmedBalanceId: string;
  materialReceiptId: string;
  receivedReceiptId: string;
}

// Each route of router.tsx: the page a Read-only User who is also a Requester and a Supply Officer opens and its
// heading, or why it is not opened. F009-T4 (#206): the Requester role lets the visits reach the Requester's pages, and
// the Dashboard's "ขอเบิกวัสดุ" probe answer 200 (#202 Q1). F009-T6 (#208 start decision 3): the Supply Officer role
// lets them reach "คำขอเบิก" (material-request:view); the pages its other grants add actions to keep their headings.
// A page that adds a route adds its row here; the first test fails until it does (F005-T3 retrospective, #101).
const SMOKE: Record<string, { url: (f: Fixtures) => string; heading: (f: Fixtures) => string } | { skip: string }> = {
  '/': { url: () => '/', heading: () => 'เข้าสู่ระบบ' },
  '/login': { url: () => '/login', heading: () => 'เข้าสู่ระบบ' },
  '/dashboard': { url: () => '/dashboard', heading: () => 'แดชบอร์ด' },
  '/assets/register': { skip: 'a write: asset:register' },
  '/assets/bulk-register': { skip: 'a write: asset:bulk-register' },
  '/assets/search': { url: () => '/assets/search', heading: () => 'ค้นหาและตรวจสอบครุภัณฑ์ (Asset Search)' },
  '/assets/:id': { url: (f) => `/assets/${f.assetId}`, heading: (f) => f.assetName },
  '/acquisitions/new': { skip: 'a write: acquisition:create' },
  '/acquisitions/:id': { url: (f) => `/acquisitions/${f.acquisitionId}`, heading: () => 'ข้อมูลการได้มา (Acquisition Reference)' },
  '/loans': { url: () => '/loans', heading: () => 'รายการยืม' },
  '/loans/:id': { url: (f) => `/loans/${f.loanId}`, heading: () => 'การยืม' },
  '/repairs': { url: () => '/repairs', heading: () => 'รายการซ่อม/บำรุงรักษา' },
  '/repairs/:id': { url: (f) => `/repairs/${f.repairRecordId}`, heading: () => 'รายการซ่อม/บำรุงรักษา' },
  '/verification-rounds': { url: () => '/verification-rounds', heading: () => 'รอบตรวจ' },
  '/verification-rounds/:id': { url: (f) => `/verification-rounds/${f.verificationRoundId}`, heading: () => 'ตรวจประจำปี E2E route smoke' },
  // Every registry viewer reads the Reference Lists; maintaining them is reference:maintain.
  '/admin/references': { url: () => '/admin/references', heading: () => 'รายการข้อมูลอ้างอิง (Reference Lists)' },
  // F008-T1 (#176): every catalog viewer reads the Stock Materials; creating one is material:manage.
  '/stock-materials': { url: () => '/stock-materials', heading: () => 'วัสดุ' },
  '/stock-materials/new': { skip: 'a write: material:manage' },
  // F008-T8 (#183): every catalog viewer reads the Brand, Material Category and Unit lists; keeping them is material:manage.
  '/stock-materials/lists': { url: () => '/stock-materials/lists', heading: () => 'ยี่ห้อ หมวดวัสดุ หน่วยนับ แหล่งที่มา และวิธีได้มา' },
  // F010-T4 (#235): its page reads its รายการเคลื่อนไหว too, which every read below checks.
  '/stock-materials/:id': { url: (f) => `/stock-materials/${f.stockMaterialId}`, heading: (f) => f.stockMaterialName },
  // F009-T1 (#203): every catalog viewer reads the Requestable Materials; creating one is material:manage.
  '/requestable-materials': { url: () => '/requestable-materials', heading: () => 'วัสดุสำหรับขอเบิก' },
  '/requestable-materials/new': { skip: 'a write: material:manage' },
  '/requestable-materials/:id': { url: (f) => `/requestable-materials/${f.requestableMaterialId}`, heading: (f) => f.requestableMaterialName },
  // F009-T4 (#206): the Requester's own Material Requests, the form and a Material Request's page.
  '/my-material-requests': { url: () => '/my-material-requests', heading: () => 'คำขอของฉัน' },
  '/my-material-requests/new': { url: () => '/my-material-requests/new', heading: () => 'สร้างคำขอเบิก' },
  '/material-requests/:id': { url: (f) => `/material-requests/${f.materialRequestId}`, heading: (f) => `คำขอเบิก เลขที่คำขอ ${f.requestNumber}` },
  // F009-T6 (#208): every person's Material Requests, for material-request:view.
  '/material-requests': { url: () => '/material-requests', heading: () => 'คำขอเบิก' },
  // F010-T2 (#233): every catalog viewer reads the Opening Balances; the Supply Officer role reaches the Draft form.
  '/opening-balances': { url: () => '/opening-balances', heading: () => 'ยอดตั้งต้น' },
  '/opening-balances/new': { url: () => '/opening-balances/new', heading: () => 'เพิ่มยอดตั้งต้น' },
  '/opening-balances/:id': { url: (f) => `/opening-balances/${f.openingBalanceId}`, heading: () => 'ยอดตั้งต้น ร่าง' },
  '/opening-balances/:id/edit': { url: (f) => `/opening-balances/${f.openingBalanceId}/edit`, heading: () => 'แก้ไขร่าง' },
  '/opening-balances/:id/correct': { url: (f) => `/opening-balances/${f.confirmedBalanceId}/correct`, heading: () => 'แก้ไขรายการที่บันทึกผิด' },
  // F010-T3 (#234): every catalog viewer reads the Material Receipts; the Supply Officer role reaches the Draft form.
  '/material-receipts': { url: () => '/material-receipts', heading: () => 'รายการรับวัสดุ' },
  '/material-receipts/new': { url: () => '/material-receipts/new', heading: () => 'เพิ่มรายการรับวัสดุ' },
  '/material-receipts/:id': { url: (f) => `/material-receipts/${f.materialReceiptId}`, heading: () => 'รายการรับวัสดุ ร่าง' },
  '/material-receipts/:id/edit': { url: (f) => `/material-receipts/${f.materialReceiptId}/edit`, heading: () => 'แก้ไขร่าง' },
  '/material-receipts/:id/correct': { url: (f) => `/material-receipts/${f.receivedReceiptId}/correct`, heading: () => 'แก้ไขรายการที่บันทึกผิด' },
};

// The paths router.tsx declares, read from its text: importing it builds a browser router, which needs a window.
// A `path:` written in another shape is not read, so the count of `path:` keys catches it.
const routerPaths = (): string[] => {
  const source = fs.readFileSync(path.resolve(webRoot, 'src/router.tsx'), 'utf8');
  const paths = [...source.matchAll(/^\s*path: '([^']+)',$/gm)].map(([, routePath]) => routePath);
  expect(paths, 'every `path:` in router.tsx is one line of the form   path: \'/x\',').toHaveLength((source.match(/\bpath:/g) ?? []).length);
  return paths;
};

// Every page a Read-only User who is also a Requester can read renders its heading with no error, through the real SPA
// and API.
test.describe.serial('Route smoke: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let readonlyUserId: string;
  let fixtures: Fixtures;

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

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-route-smoke',
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
    const custodianUserId = await createUser('custodian_smoke', 'ASSET_CUSTODIAN');
    const officerUserId = await createUser('officer_smoke', 'SUPPLY_OFFICER');
    readonlyUserId = await createUser('readonly_smoke', 'READ_ONLY');
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'REQUESTER'), ($1, 'SUPPLY_OFFICER')`, [readonlyUserId]);

    const assetService = new AssetService({ db: pool });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const assetName = 'ครุภัณฑ์ E2E route smoke';
    const { asset } = await assetService.registerAsset(custodianUserId, { name: assetName } as any);
    const { asset: lentAsset } = await assetService.registerAsset(custodianUserId, { name: 'ของยืม E2E route smoke' } as any);
    const acquisition = await new AcquisitionService({ db: pool }).createAcquisition(custodianUserId, { notes: 'E2E route smoke' }, { retryToken: crypto.randomUUID() });
    const { loan_id: loanId } = await new LoanService({ db: pool }).start(
      custodianUserId,
      { assets: [{ asset_id: lentAsset.id, condition: 'NORMAL' }], borrower: { kind: 'EXTERNAL', contact_name: 'คุณ E2E route smoke' }, loan_date: today, due_date: '2099-12-31' } as any,
      { retryToken: crypto.randomUUID() }
    );
    const { repair_record_id: repairRecordId } = await new RepairService({ db: pool }).start(
      custodianUserId,
      { asset_id: asset.id, repair_kind: 'REPAIR', start_date: today, repairer: { kind: 'INTERNAL' }, symptom_or_work: 'E2E route smoke' } as any,
      { retryToken: crypto.randomUUID() }
    );
    const { verification_round_id: verificationRoundId } = await new VerificationService({ db: pool }).open(
      custodianUserId,
      { name: 'ตรวจประจำปี E2E route smoke', fiscal_year: 2569 },
      { retryToken: crypto.randomUUID() }
    );
    const stockMaterialName = 'กระดาษ E2E route smoke';
    const unit = await new CatalogListService({ db: pool }).add(officerUserId, 'unit', { name: 'รีม' }, { retryToken: crypto.randomUUID() });
    const { stock_material_id: stockMaterialId } = await new StockMaterialService({ db: pool }).create(
      officerUserId,
      { name: stockMaterialName, base_unit: { unit_id: unit.id } },
      { retryToken: crypto.randomUUID() }
    );
    const requestableMaterialName = 'กระดาษ A4 E2E route smoke';
    const { requestable_material_id: requestableMaterialId } = await new RequestableMaterialService({ db: pool }).create(
      officerUserId,
      { name: requestableMaterialName, request_unit_id: unit.id },
      { retryToken: crypto.randomUUID() }
    );
    await new RequestableMaterialService({ db: pool }).addCompatibleStockMaterial(
      officerUserId,
      requestableMaterialId,
      { stock_material_id: stockMaterialId, expected_version: 1 },
      { retryToken: crypto.randomUUID() }
    );
    const { material_request_id: materialRequestId, request_number: requestNumber } = await new MaterialRequestService({ db: pool }).create(
      readonlyUserId,
      { requested_items: [{ requestable_material_id: requestableMaterialId, requested_quantity: '2' }] },
      { retryToken: crypto.randomUUID() }
    );
    // A Draft with one line, so the edit form reads its Stock Material's Units.
    const { opening_balance_id: openingBalanceId } = await new OpeningBalanceService({ db: pool }).create(
      officerUserId,
      { lines: [{ stock_material_id: stockMaterialId, unit_id: unit.id, quantity: '3' }] },
      { retryToken: crypto.randomUUID() }
    );
    // F010-T7 (#238): a confirmed Opening Balance, which the correction form reads back whole, as of a date before the
    // Received Material Receipt below (Q21).
    const balances = new OpeningBalanceService({ db: pool });
    const { opening_balance_id: confirmedBalanceId } = await balances.create(
      officerUserId,
      { as_of_date: '2026-01-01', source: 'สมุดคุมวัสดุ', lines: [{ stock_material_id: stockMaterialId, unit_id: unit.id, quantity: '1' }] },
      { retryToken: crypto.randomUUID() }
    );
    await balances.confirm(officerUserId, confirmedBalanceId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    // A Material Receipt Draft with one line, so the edit form reads its Stock Material's Units.
    const { material_receipt_id: materialReceiptId } = await new MaterialReceiptService({ db: pool }).create(
      officerUserId,
      { lines: [{ stock_material_id: stockMaterialId, unit_id: unit.id, quantity: '3' }] },
      { retryToken: crypto.randomUUID() }
    );
    // F010-T6 (#237): a Received Material Receipt, which the Receipt Correction form reads back whole.
    const receipts = new MaterialReceiptService({ db: pool });
    const { material_receipt_id: receivedReceiptId } = await receipts.create(
      officerUserId,
      { received_date: '2026-01-15', lines: [{ stock_material_id: stockMaterialId, unit_id: unit.id, quantity: '2' }] },
      { retryToken: crypto.randomUUID() }
    );
    await receipts.confirm(officerUserId, receivedReceiptId, { expected_version: 1 }, { retryToken: crypto.randomUUID() });
    fixtures = {
      assetId: asset.id,
      assetName,
      acquisitionId: acquisition.id,
      loanId,
      repairRecordId,
      verificationRoundId,
      stockMaterialId,
      stockMaterialName,
      requestableMaterialId,
      requestableMaterialName,
      materialRequestId,
      requestNumber,
      openingBalanceId,
      confirmedBalanceId,
      materialReceiptId,
      receivedReceiptId,
    };

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

  test('Route smoke: every route of router.tsx has its row', () => {
    expect(Object.keys(SMOKE).sort()).toEqual(routerPaths().sort());
  });

  for (const [routePath, row] of Object.entries(SMOKE)) {
    if ('skip' in row) {
      continue;
    }
    test(`Route smoke: a Read-only User who is also a Requester and a Supply Officer opens ${routePath} and sees its heading with no error`, async ({ page, context }) => {
      const session = await sessionService.createSession(readonlyUserId);
      await context.addCookies([{ name: 'session', value: session.token, url: targetBaseUrl }]);
      // Every read the page makes, and the status each answered with once it has. A read is matched by its request,
      // not its URL: when a page reads one URL twice at once and cancels one, as the Dashboard's effects do, a URL
      // match could drop the other read while its status is still awaited (F008-T1).
      const reads: { request: unknown; url: string; status?: number }[] = [];
      page.on('request', (request) => {
        if (['fetch', 'xhr'].includes(request.resourceType())) {
          reads.push({ request, url: request.url() });
        }
      });
      page.on('requestfinished', async (request) => {
        const read = reads.find((entry) => entry.request === request);
        if (read) read.status = (await request.response())?.status() ?? 0;
      });
      page.on('requestfailed', (request) => {
        const read = reads.find((entry) => entry.request === request);
        if (!read) return;
        // A page cancels a read it no longer needs, as when an effect runs again; that read did not fail.
        if (request.failure()?.errorText === 'net::ERR_ABORTED') {
          reads.splice(reads.indexOf(read), 1);
        } else {
          read.status = 0;
        }
      });

      await page.goto(`${targetBaseUrl}${row.url(fixtures)}`);

      await expect(page.getByRole('heading', { level: 1, name: row.heading(fixtures), exact: true })).toBeVisible();
      // The URLs, not a count, so that a failure names the read still waiting (#176 retro).
      await expect.poll(() => reads.filter(({ status }) => status === undefined).map(({ url }) => url)).toEqual([]);
      // A read that failed or was refused; 0 is one that never got an answer.
      expect(reads.filter(({ status }) => status === 0 || status! >= 400).map(({ url, status }) => ({ url, status }))).toEqual([]);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  }
});
