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
}

// Each route of router.tsx: the page a Read-only User opens and its heading, or why it is not opened.
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
};

// The paths router.tsx declares, read from its text: importing it builds a browser router, which needs a window.
// A `path:` written in another shape is not read, so the count of `path:` keys catches it.
const routerPaths = (): string[] => {
  const source = fs.readFileSync(path.resolve(webRoot, 'src/router.tsx'), 'utf8');
  const paths = [...source.matchAll(/^\s*path: '([^']+)',$/gm)].map(([, routePath]) => routePath);
  expect(paths, 'every `path:` in router.tsx is one line of the form   path: \'/x\',').toHaveLength((source.match(/\bpath:/g) ?? []).length);
  return paths;
};

// Every page a Read-only User can read renders its heading with no error, through the real SPA and API.
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
    readonlyUserId = await createUser('readonly_smoke', 'READ_ONLY');

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
    fixtures = { assetId: asset.id, assetName, acquisitionId: acquisition.id, loanId, repairRecordId, verificationRoundId };

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
    test(`Route smoke: a Read-only User opens ${routePath} and sees its heading with no error`, async ({ page, context }) => {
      const session = await sessionService.createSession(readonlyUserId);
      await context.addCookies([{ name: 'session', value: session.token, url: targetBaseUrl }]);
      // Every read the page makes, and the status each answered with once it has.
      const reads: { url: string; status?: number }[] = [];
      page.on('request', (request) => {
        if (['fetch', 'xhr'].includes(request.resourceType())) {
          reads.push({ url: request.url() });
        }
      });
      page.on('requestfinished', async (request) => {
        const read = reads.find(({ url, status }) => url === request.url() && status === undefined);
        if (read) read.status = (await request.response())?.status() ?? 0;
      });
      page.on('requestfailed', (request) => {
        const read = reads.find(({ url, status }) => url === request.url() && status === undefined);
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
      await expect.poll(() => reads.filter(({ status }) => status === undefined).length).toBe(0);
      // A read that failed or was refused; 0 is one that never got an answer.
      expect(reads.filter(({ status }) => status === 0 || status! >= 400)).toEqual([]);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  }
});
