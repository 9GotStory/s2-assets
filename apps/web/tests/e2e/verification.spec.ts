import { test, expect } from '@playwright/test';
import { actorSwitch } from './support/actors.ts';
import { delaySessionCheck, endSessionDelay } from './support/session-check.ts';
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
import { RepairService } from '../../../api/src/services/repair.service.ts';
import { VerificationRoundService } from '../../../api/src/services/verification-round.service.ts';
import { VerificationService } from '../../../api/src/services/verification.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F006-T1 (#126): an Asset Custodian opens a Verification Round and sees its Scope Snapshot; a Read-only User
// sees the Round with no action. F006-T2 (#127): Verification Staff record a result from the Asset page a QR
// label opens, at a phone viewport. F006-T4 (#129): a Re-verification from the panel and a Verification Correction.
// F006-T5 (#130): a Late Addition from the Asset page of an Asset registered after the Round opened. F006-T6 (#131):
// closing a Round over its summary, and reopening it with a reason. F006-T7 (#132): "ส่งซ่อม" from a result Found ชำรุด.
// F006-T8 (#133): "ย้าย" from a result with "Location ไม่ตรงทะเบียน".
test.describe.serial('Verification journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let assetService: AssetService;
  let referenceService: ReferenceService;
  let verificationService: VerificationService;
  let verificationRoundService: VerificationRoundService;

  let adminUserId: string;
  let custodianUserId: string;
  let readonlyUserId: string;
  let staffUserId: string;

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
    verificationService = new VerificationService({ db: pool });
    verificationRoundService = new VerificationRoundService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-verification-e2e',
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
    adminUserId = await createUser('admin_verification', 'ADMINISTRATOR');
    custodianUserId = await createUser('custodian_verification', 'ASSET_CUSTODIAN');
    readonlyUserId = await createUser('readonly_verification', 'READ_ONLY');
    staffUserId = await createUser('staff_verification', 'VERIFICATION_STAFF');

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

  const { loginAs, switchActor } = actorSwitch(() => sessionService, () => targetBaseUrl);

  // Closes the open Round, if any, as an Asset Custodian would, so that the next journey can open one (#125 Q17).
  const closeOpenRound = async () => {
    const open = await pool.query(`SELECT id, version FROM verification_rounds WHERE state = 'OPEN'`);
    for (const { id, version } of open.rows) {
      await verificationRoundService.close(custodianUserId, id, { expected_version: version }, { retryToken: crypto.randomUUID() });
    }
  };

  test('Journey F006-T1.1: a Custodian opens a Round with a Location filter and sees its Assets as "ยังไม่ได้ตรวจ"; a Read-only User then sees the Round with no action', async ({ page, context }) => {
    const meetingRoom = await referenceService.create('locations', adminUserId, 'ห้องประชุม E2E ตรวจ');
    const store = await referenceService.create('locations', adminUserId, 'ห้องเก็บของ E2E ตรวจ');
    const { asset: projector } = await assetService.registerAsset(custodianUserId, {
      name: 'โปรเจกเตอร์ E2E ตรวจ',
      asset_number: 'E2E-VR-001',
      serial_number: 'SN-PJ-01',
      location_id: meetingRoom.id,
      effective_date: '2026-01-05',
    } as any);
    const { asset: table } = await assetService.registerAsset(custodianUserId, { name: 'โต๊ะประชุม E2E ตรวจ', location_id: meetingRoom.id, effective_date: '2026-01-05' } as any);
    const { asset: shelf } = await assetService.registerAsset(custodianUserId, { name: 'ชั้นวาง E2E ตรวจ', location_id: store.id, effective_date: '2026-01-05' } as any);

    // The Dashboard links to the Round list, which has no Round yet.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/dashboard`);
    await page.locator('#nav-verification-round-list').click();
    await expect(page).toHaveURL(/\/verification-rounds$/);
    await expect(page.getByRole('heading', { name: 'รอบตรวจ', level: 1 })).toBeVisible();
    await expect(page.locator('#verification-round-list-empty')).toBeVisible();

    // The form says what it needs before asking the server.
    await page.locator('#verification-open-action').click();
    await page.locator('#verification-open-submit').click();
    await expect(page.locator('[data-testid="verification-open-form-error"]')).toContainText('ชื่อรอบตรวจ');

    await page.locator('#verification-open-name').fill('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await page.locator('#verification-open-fiscal_year').fill('2569');
    await page.locator('#verification-open-notes').fill('คณะกรรมการ:\nนาย ก');
    await page.locator(`#verification-open-location-${meetingRoom.id}`).check();
    await page.locator('#verification-open-submit').click();

    // The new Round is listed, open, covering the two Assets in the meeting room.
    const row = page.locator('[data-testid^="verification-round-row-"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await expect(row).toContainText('เปิดอยู่');
    await expect(page.locator('#verification-open-action')).toBeVisible();

    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/verification-rounds\/[0-9a-f-]{36}$/);
    const roundUrl = page.url();
    await expect(page.locator('#verification-round-name')).toHaveText('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await expect(page.locator('#verification-round-fiscal-year')).toHaveText('2569');
    await expect(page.locator('#verification-round-state')).toHaveText('เปิดอยู่');
    await expect(page.locator('#verification-round-scope')).toHaveText('สถานที่: ห้องประชุม E2E ตรวจ');
    await expect(page.locator('#verification-round-notes')).toHaveText('คณะกรรมการ:\nนาย ก');
    await expect(page.locator('#verification-round-opened-by')).toHaveText('custodian_verification');
    await expect(page.locator('[data-testid="verification-round-count-in-scope"]')).toContainText('2');
    await expect(page.locator('[data-testid="verification-round-count-not-yet-verified"]')).toContainText('2');
    await expect(page.locator('[data-testid="verification-round-history"] li')).toHaveCount(1);
    await expect(page.locator('[data-testid="verification-round-history"] li')).toContainText('เปิดรอบ โดย custodian_verification');

    // Each Asset of the snapshot is Not Yet Verified, with what the register showed, and links to its page.
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveText(['ยังไม่ได้ตรวจ', 'ยังไม่ได้ตรวจ']);
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toContainText('E2E-VR-001');
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toContainText('SN-PJ-01');
    await expect(page.locator(`[data-testid="scope-entry-assignment-${table.id}"]`)).toContainText('ห้องประชุม E2E ตรวจ');
    await expect(page.locator(`[data-testid="scope-entry-${shelf.id}"]`)).toHaveCount(0);

    // A search over the snapshot finds an Asset by its Serial Number.
    await page.locator('#scope-entry-search').fill('sn-pj');
    await page.locator('#scope-entry-search-submit').click();
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="scope-entry-${table.id}"]`)).toHaveCount(0);
    await page.locator(`[data-testid="scope-entry-${projector.id}"]`).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/assets/${projector.id}$`));

    // A second Round is refused while this one is open, naming it. The session answers late: the action waits for
    // its CSRF token, or a quick submit would be refused as if the grant were gone.
    await delaySessionCheck(page);
    await page.goto(`${targetBaseUrl}/verification-rounds`);
    await page.locator('#verification-open-action').click();
    await page.locator('#verification-open-name').fill('รอบที่สอง');
    await page.locator('#verification-open-fiscal_year').fill('2569');
    await page.locator('#verification-open-submit').click();
    await expect(page.locator('[data-testid="verification-open-refused"]')).toContainText('ตรวจสอบพัสดุประจำปี 2569 ห้องประชุม');
    await endSessionDelay(page);
    await page.locator('#verification-open-cancel').click();

    // A Read-only User sees the list and the Round, with no action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds`);
    await expect(page.locator('[data-testid^="verification-round-row-"]')).toHaveCount(1);
    await expect(page.locator('#verification-open-action')).toHaveCount(0);
    await page.goto(roundUrl);
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveText(['ยังไม่ได้ตรวจ', 'ยังไม่ได้ตรวจ']);
    await expect(page.locator('main button:not(#scope-entry-search-submit)')).toHaveCount(0);
  });

  // #125 Q29: one journey runs at a phone viewport, set here because the Playwright configuration has only a desktop project.
  test.describe('at a phone viewport', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    // The page fits the viewport's width: nothing scrolls sideways.
    const fitsWidth = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    test('Journey F006-T2.1: Verification Staff open an Asset page as its QR link would and record Found ปกติ; the panel then shows the result and the Round page counts it', async ({ page, context }) => {
      await closeOpenRound();
      const office = await referenceService.create('locations', adminUserId, 'ห้องธุรการ E2E ตรวจ');
      const store = await referenceService.create('locations', adminUserId, 'ห้องเก็บของ E2E ตรวจ 2');
      const { asset: printer } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องพิมพ์ E2E ตรวจ', asset_number: 'E2E-VR-101', location_id: office.id, effective_date: '2026-01-05' } as any);
      const { asset: cabinet } = await assetService.registerAsset(custodianUserId, { name: 'ตู้เอกสาร E2E ตรวจ', location_id: office.id, effective_date: '2026-01-05' } as any);
      const { asset: outside } = await assetService.registerAsset(custodianUserId, { name: 'พัดลม E2E ตรวจ', location_id: store.id, effective_date: '2026-01-05' } as any);
      // The cabinet is Under Repair: the panel shows it as context, and it blocks nothing.
      const { repair_record_id: repairRecordId } = await new RepairService({ db: pool }).start(
        custodianUserId,
        { asset_id: cabinet.id, repair_kind: 'REPAIR', start_date: '2026-01-10', repairer: { kind: 'INTERNAL' }, symptom_or_work: 'บานพับหลุด' } as any,
        { retryToken: crypto.randomUUID() }
      );
      const { verification_round_id: roundId } = await verificationService.open(
        custodianUserId,
        { name: 'ตรวจสอบพัสดุประจำปี 2569 ห้องธุรการ', fiscal_year: 2569, location_ids: [office.id] },
        { retryToken: crypto.randomUUID() }
      );

      // The QR label opens /assets/<id>.
      await loginAs(context, staffUserId);
      await page.goto(`${targetBaseUrl}/assets/${printer.id}`);
      const panel = page.locator('#verification-panel');
      await expect(panel.getByRole('heading', { name: 'ตรวจประจำปี' })).toBeVisible();
      await expect(page.locator('#verification-panel-round-link')).toHaveText('ตรวจสอบพัสดุประจำปี 2569 ห้องธุรการ (ปีงบประมาณ 2569)');
      await page.locator('#verification-record-result-FOUND').check();
      await page.locator('#verification-record-condition-NORMAL').check();
      await page.locator('#verification-record-submit').click();

      // The panel shows the result, who recorded it and when, and offers no second form.
      await expect(page.locator('[data-testid="verification-panel-current-result"]')).toHaveText('พบ · สภาพปกติ');
      await expect(page.locator('[data-testid="verification-panel-current-recorded-by"]')).toHaveText('staff_verification');
      await expect(page.locator('#verification-record-form')).toHaveCount(0);
      await expect(page.locator(`[data-testid="asset-verification-result-${roundId}"]`)).toContainText('พบ · สภาพปกติ');
      expect(await fitsWidth(page)).toBe(true);

      // An Asset outside the Round says so, with no form.
      await page.goto(`${targetBaseUrl}/assets/${outside.id}`);
      await expect(page.locator('[data-testid="verification-panel-not-in-round"]')).toBeVisible();
      await expect(page.locator('#verification-record-form')).toHaveCount(0);

      // The Round page counts the result and filters by it.
      await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
      await expect(page.locator('[data-testid="verification-round-count-found"]')).toContainText('1');
      await expect(page.locator('[data-testid="verification-round-count-not-found"]')).toContainText('0');
      await expect(page.locator('[data-testid="verification-round-count-not-yet-verified"]')).toContainText('1');
      await expect(page.locator(`[data-testid="scope-entry-result-${printer.id}"]`)).toHaveText('พบ · สภาพปกติ');
      await expect(page.locator(`[data-testid="scope-entry-result-${cabinet.id}"]`)).toHaveText('ยังไม่ได้ตรวจ');
      await page.locator('#scope-entry-result-filter-FOUND').click();
      await expect(page).toHaveURL(/result=FOUND/);
      await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveText(['พบ · สภาพปกติ']);
      expect(await fitsWidth(page)).toBe(true);

      // A Read-only User sees the Asset Not Yet Verified, where Verification Staff see the form, and no form.
      await page.goto(`${targetBaseUrl}/assets/${cabinet.id}`);
      await expect(page.locator('#verification-record-form')).toBeVisible();
      await expect(page.locator('[data-testid="verification-panel-context"]')).toContainText('อยู่ระหว่างซ่อม');
      await expect(page.locator('[data-testid="verification-panel-context"]').getByRole('link', { name: 'ดูรายการซ่อม' })).toHaveAttribute('href', `/repairs/${repairRecordId}`);
      await switchActor(page, context, readonlyUserId);
      await page.goto(`${targetBaseUrl}/assets/${cabinet.id}`);
      await expect(page.locator('[data-testid="verification-panel-not-yet-verified"]')).toHaveText('ยังไม่ได้ตรวจ');
      await expect(page.locator('#verification-record-form')).toHaveCount(0);
    });
  });

  test('Journey F006-T3.1: Verification Staff record Found at a Location other than the register\'s, with both flags; the panel, the section and the Round page show each Discrepancy, and the Round filters by them', async ({ page, context }) => {
    await closeOpenRound();
    const office = await referenceService.create('locations', adminUserId, 'ห้องการเงิน E2E ตรวจ');
    const hall = await referenceService.create('locations', adminUserId, 'ห้องโถง E2E ตรวจ');
    const { asset: scanner } = await assetService.registerAsset(custodianUserId, { name: 'สแกนเนอร์ E2E ตรวจ', asset_number: 'E2E-VR-201', location_id: office.id, effective_date: '2026-01-05' } as any);
    const { asset: safe } = await assetService.registerAsset(custodianUserId, { name: 'ตู้เซฟ E2E ตรวจ', asset_number: 'E2E-VR-202', location_id: office.id, effective_date: '2026-01-05' } as any);
    const { asset: chair } = await assetService.registerAsset(custodianUserId, { name: 'เก้าอี้ E2E ตรวจ', asset_number: 'E2E-VR-203', location_id: hall.id, effective_date: '2026-01-05' } as any);
    // The safe is Under Repair and recorded Not Found: its row shows the context it kept (#125 Q14).
    await new RepairService({ db: pool }).start(
      custodianUserId,
      { asset_id: safe.id, repair_kind: 'REPAIR', start_date: '2026-01-10', repairer: { kind: 'INTERNAL' }, symptom_or_work: 'กุญแจเสีย' } as any,
      { retryToken: crypto.randomUUID() }
    );
    const { verification_round_id: roundId } = await verificationService.open(
      custodianUserId,
      { name: 'ตรวจสอบพัสดุประจำปี 2569 ห้องการเงินและโถง', fiscal_year: 2569, location_ids: [office.id, hall.id] },
      { retryToken: crypto.randomUUID() }
    );
    await verificationService.record(staffUserId, roundId, safe.id, { result: 'NOT_FOUND' }, { retryToken: crypto.randomUUID() });

    await loginAs(context, staffUserId);
    await page.goto(`${targetBaseUrl}/assets/${scanner.id}`);

    // Not Found asks for no Observed Location and no flag.
    await page.locator('#verification-record-result-NOT_FOUND').check();
    await expect(page.locator('#verification-record-observed_location_id')).toHaveCount(0);
    await expect(page.locator('#verification-record-label_missing_or_damaged')).toHaveCount(0);

    // "ข้อมูลไม่ตรงทะเบียน" needs its note before the server is asked.
    await page.locator('#verification-record-result-FOUND').check();
    await page.locator('#verification-record-condition-NORMAL').check();
    await page.locator('#verification-record-observed_location_id').selectOption({ label: 'ห้องโถง E2E ตรวจ' });
    await page.locator('#verification-record-label_missing_or_damaged').check();
    await page.locator('#verification-record-data_mismatch').check();
    await page.locator('#verification-record-submit').click();
    await expect(page.locator('[data-testid="verification-record-form-error"]')).toContainText('ข้อมูลไม่ตรงทะเบียน');
    await page.locator('#verification-record-data_mismatch_note').fill('Serial Number บนตัวเครื่องไม่ตรง');
    await page.locator('#verification-record-submit').click();

    // The panel shows the Observed Location and each Discrepancy.
    await expect(page.locator('[data-testid="verification-panel-current-observed-location"]')).toHaveText('ห้องโถง E2E ตรวจ');
    await expect(page.locator('[data-testid="verification-panel-current-discrepancies"] li')).toHaveText([
      'Location ไม่ตรงทะเบียน',
      'ป้าย/QR หายหรือชำรุด',
      'ข้อมูลไม่ตรงทะเบียน: Serial Number บนตัวเครื่องไม่ตรง',
    ]);
    await expect(page.locator(`[data-testid="asset-verification-discrepancies-${roundId}"]`)).toContainText('Location ไม่ตรงทะเบียน');
    await expect(page.locator(`[data-testid="asset-verification-discrepancies-${roundId}"]`)).toContainText('สถานที่ที่พบ: ห้องโถง E2E ตรวจ');

    // The Round page counts the result with a Discrepancy, shows it on its row, and filters by it.
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator('[data-testid="verification-round-count-with-discrepancy"]')).toContainText('1');
    await expect(page.locator(`[data-testid="scope-entry-discrepancies-${scanner.id}"]`)).toContainText('Location ไม่ตรงทะเบียน');
    await expect(page.locator(`[data-testid="scope-entry-discrepancies-${scanner.id}"]`)).toContainText('สถานที่ที่พบ: ห้องโถง E2E ตรวจ');
    await expect(page.locator(`[data-testid="scope-entry-verification-${safe.id}"]`)).toContainText('ขณะตรวจ: อยู่ระหว่างซ่อม');
    await page.locator('#scope-entry-discrepancy-filter-LOCATION_MISMATCH').click();
    await expect(page).toHaveURL(/discrepancy=LOCATION_MISMATCH/);
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid="scope-entry-${scanner.id}"]`)).toBeVisible();

    // The snapshot Location filter walks the office room by room, with the Discrepancy filter or without it.
    // Each step waits for its URL: a filter chosen before the page shows the last one would keep the last one's.
    await page.locator('#scope-entry-discrepancy-filter-ALL').click();
    await expect(page).not.toHaveURL(/discrepancy=/);
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveCount(3);
    await page.locator('#scope-entry-location-filter').selectOption({ label: 'ห้องโถง E2E ตรวจ' });
    await expect(page).toHaveURL(new RegExp(`\\?location_id=${hall.id}$`));
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid="scope-entry-${chair.id}"]`)).toBeVisible();
    await page.locator('#scope-entry-location-filter').selectOption({ label: 'ห้องการเงิน E2E ตรวจ' });
    await expect(page).toHaveURL(new RegExp(`\\?location_id=${office.id}$`));
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveCount(2);
    await page.locator('#scope-entry-discrepancy-filter-LOCATION_MISMATCH').click();
    await expect(page).toHaveURL(new RegExp(`discrepancy=LOCATION_MISMATCH&location_id=${office.id}`));
    await expect(page.locator('[data-testid^="scope-entry-result-"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid="scope-entry-${scanner.id}"]`)).toBeVisible();
  });

  test('Journey F006-T4.1: Verification Staff re-verify an Asset as Not Found from the panel that shows its latest result; the revisions show both; an Asset Custodian voids the new result and the earlier one is current again', async ({ page, context }) => {
    await closeOpenRound();
    const office = await referenceService.create('locations', adminUserId, 'ห้องพัสดุ E2E ตรวจซ้ำ');
    const { asset: laptop } = await assetService.registerAsset(custodianUserId, { name: 'โน้ตบุ๊ก E2E ตรวจซ้ำ', asset_number: 'E2E-VR-301', location_id: office.id, effective_date: '2026-01-05' } as any);
    const { verification_round_id: roundId } = await verificationService.open(
      custodianUserId,
      { name: 'ตรวจสอบพัสดุประจำปี 2569 ห้องพัสดุ', fiscal_year: 2569, location_ids: [office.id] },
      { retryToken: crypto.randomUUID() }
    );
    await verificationService.record(custodianUserId, roundId, laptop.id, { result: 'FOUND', condition: 'NORMAL', note: 'ครั้งแรก' }, { retryToken: crypto.randomUUID() });
    const revisions = page.locator(`[data-testid="verification-revisions-${roundId}-${laptop.id}"]`);

    // The panel shows the latest result and "ตรวจซ้ำ"; Verification Staff are offered no void.
    await loginAs(context, staffUserId);
    await page.goto(`${targetBaseUrl}/assets/${laptop.id}`);
    await expect(page.locator('[data-testid="verification-panel-current-result"]')).toHaveText('พบ · สภาพปกติ');
    await expect(page.locator('#verification-record-form')).toHaveCount(0);
    await expect(page.locator('#verification-void-action')).toHaveCount(0);
    await page.locator('#verification-reverify-action').click();

    // "ตรวจซ้ำ" opens an empty form: nothing is carried over from the earlier result.
    await expect(page.locator('#verification-record-form').getByRole('heading', { name: 'ตรวจซ้ำ' })).toBeVisible();
    await expect(page.locator('#verification-record-result-FOUND')).not.toBeChecked();
    await expect(page.locator('#verification-record-result-NOT_FOUND')).not.toBeChecked();
    await expect(page.locator('#verification-record-note')).toHaveValue('');
    await page.locator('#verification-record-result-NOT_FOUND').check();
    await page.locator('#verification-record-submit').click();

    // The panel shows the new result, and the revisions show both, newest first.
    await expect(page.locator('[data-testid="verification-panel-current-result"]')).toHaveText('ไม่พบในการตรวจ');
    await expect(page.locator('[data-testid="verification-panel-current-recorded-by"]')).toHaveText('staff_verification');
    await expect(page.locator('#verification-record-form')).toHaveCount(0);
    await expect(revisions.locator('summary')).toHaveText('ประวัติผลตรวจ (2 ครั้ง)');
    await revisions.locator('summary').click();
    await expect(revisions.locator('[data-testid$="-facts-result"]')).toHaveText(['ไม่พบในการตรวจ', 'พบ · สภาพปกติ']);
    await expect(revisions.locator('[data-testid$="-facts-recorded-by"]')).toHaveText(['staff_verification', 'custodian_verification']);
    await expect(revisions.locator('[data-testid$="-voided"]')).toHaveCount(0);

    // An Asset Custodian voids the new result with a reason; it stays struck through and the earlier result is current again.
    await switchActor(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${laptop.id}`);
    await page.locator('#verification-void-action').click();
    await page.locator('#verification-void-submit').click();
    await expect(page.locator('[data-testid="verification-void-form-error"]')).toContainText('เหตุผล');
    await page.locator('#verification-void-reason').fill('บันทึกผิดเครื่อง');
    await page.locator('#verification-void-submit').click();
    await expect(page.locator('[data-testid="verification-panel-current-result"]')).toHaveText('พบ · สภาพปกติ');
    await expect(page.locator('#verification-void-form')).toHaveCount(0);
    await revisions.locator('summary').click();
    await expect(revisions.locator(`[data-testid="verification-revisions-${roundId}-${laptop.id}-2-voided"]`)).toHaveText('ยกเลิกแล้ว');
    await expect(revisions.locator(`[data-testid="verification-revisions-${roundId}-${laptop.id}-2-correction"]`)).toContainText('ยกเลิกโดย custodian_verification');
    await expect(revisions.locator(`[data-testid="verification-revisions-${roundId}-${laptop.id}-2-correction"]`)).toContainText('เหตุผล: บันทึกผิดเครื่อง');
    await expect(revisions.locator(`[data-testid="verification-revisions-${roundId}-${laptop.id}-2-facts"]`).locator('xpath=..')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(revisions.locator(`[data-testid="verification-revisions-${roundId}-${laptop.id}-1-voided"]`)).toHaveCount(0);

    // The Round page counts the earlier result again, and its row opens the same revisions.
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator('[data-testid="verification-round-count-found"]')).toContainText('1');
    await expect(page.locator(`[data-testid="scope-entry-result-${laptop.id}"]`)).toHaveText('พบ · สภาพปกติ');
    const rowRevisions = page.locator(`[data-testid="scope-entry-${laptop.id}"] [data-testid="verification-revisions-${roundId}-${laptop.id}"]`);
    await rowRevisions.locator('summary').click();
    await expect(rowRevisions.locator('[data-testid$="-facts-result"]')).toHaveText(['ไม่พบในการตรวจ', 'พบ · สภาพปกติ']);
    await expect(rowRevisions.locator('[data-testid$="-voided"]')).toHaveCount(1);

    // A Read-only User sees the result with neither action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${laptop.id}`);
    await expect(page.locator('[data-testid="verification-panel-current-result"]')).toHaveText('พบ · สภาพปกติ');
    await expect(page.locator('#verification-reverify-action')).toHaveCount(0);
    await expect(page.locator('#verification-void-action')).toHaveCount(0);
  });

  test('Journey F006-T5.1: an Asset Custodian registers an Asset after the Round opened, adds it from its Asset page with a reason, and the Round page lists it as a Late Addition', async ({ page, context }) => {
    await closeOpenRound();
    const office = await referenceService.create('locations', adminUserId, 'ห้องพัสดุ E2E เพิ่มภายหลัง');
    const { asset: printer } = await assetService.registerAsset(custodianUserId, { name: 'เครื่องพิมพ์ E2E เพิ่มภายหลัง', asset_number: 'E2E-VR-501', location_id: office.id, effective_date: '2026-01-05' } as any);
    const { verification_round_id: roundId } = await verificationService.open(
      custodianUserId,
      { name: 'ตรวจสอบพัสดุประจำปี 2569 เพิ่มภายหลัง', fiscal_year: 2569, location_ids: [office.id] },
      { retryToken: crypto.randomUUID() }
    );

    // The Custodian registers an Asset as Feature 002 does; the Round does not take it by itself.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/register`);
    await page.locator('input#name').fill('จอภาพ E2E เพิ่มภายหลัง');
    await page.locator('input#asset_number').fill('E2E-VR-502');
    await page.locator('button#submit-register-btn').click();
    await page.waitForURL(new RegExp(`${targetBaseUrl}/assets/[0-9a-f-]{36}$`));
    const monitorId = page.url().split('/assets/')[1];
    await expect(page.locator('[data-testid="verification-panel-not-in-round"]')).toHaveText('ครุภัณฑ์นี้ไม่อยู่ในรายการของรอบตรวจนี้');
    await expect(page.locator('#verification-record-form')).toHaveCount(0);

    // Verification Staff see the same note, asking for an Asset Custodian, with no way to add it.
    await switchActor(page, context, staffUserId);
    await page.goto(`${targetBaseUrl}/assets/${monitorId}`);
    await expect(page.locator('[data-testid="verification-panel-not-in-round"]')).toHaveText('ครุภัณฑ์นี้ไม่อยู่ในรายการของรอบตรวจนี้ กรุณาแจ้งผู้ดูแลพัสดุ');
    await expect(page.locator('#verification-late-addition-action')).toHaveCount(0);

    // The Custodian adds it with a reason; it is then Not Yet Verified and can be recorded.
    await switchActor(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${monitorId}`);
    await page.locator('#verification-late-addition-action').click();
    await expect(page.locator('#verification-late-addition-form').getByRole('heading', { name: 'เพิ่มเข้ารอบภายหลัง' })).toBeVisible();
    await page.locator('#verification-late-addition-submit').click();
    await expect(page.locator('[data-testid="verification-late-addition-form-error"]')).toContainText('เหตุผล');
    await page.locator('#verification-late-addition-reason').fill('ลงทะเบียนหลังเปิดรอบ\nพบที่ห้องประชุม');
    await page.locator('#verification-late-addition-submit').click();
    await expect(page.locator('#verification-record-form')).toBeVisible();
    await expect(page.locator('[data-testid="verification-panel-not-in-round"]')).toHaveCount(0);
    await expect(page.locator('#verification-late-addition-form')).toHaveCount(0);

    // The Round page counts it, marks it with who added it and why, and filters by Late Addition.
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator('[data-testid="verification-round-count-in-scope"]')).toContainText('2');
    const lateAddition = page.locator(`[data-testid="scope-entry-late-addition-${monitorId}"]`);
    await expect(lateAddition).toContainText('เพิ่มเข้ารอบภายหลัง โดย custodian_verification เมื่อ');
    await expect(lateAddition).toContainText('เหตุผล: ลงทะเบียนหลังเปิดรอบ\nพบที่ห้องประชุม');
    // The Asset that joined when the Round opened is listed on the same page, with no Late Addition mark.
    await expect(page.locator(`[data-testid="scope-entry-${printer.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="scope-entry-late-addition-${printer.id}"]`)).toHaveCount(0);
    await page.locator('#scope-entry-joined-as-filter-LATE_ADDITION').click();
    await expect(page).toHaveURL(/joined_as=LATE_ADDITION/);
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="scope-entry-result-${monitorId}"]`)).toHaveText('ยังไม่ได้ตรวจ');
    await expect(page.locator(`[data-testid="scope-entry-${printer.id}"]`)).toHaveCount(0);
  });
  test('Journey F006-T6.1: an Asset Custodian closes a Round with Assets still "ยังไม่ได้ตรวจ" after confirming its summary; the panel then offers no recording; the Custodian reopens it with a reason, and recording works again', async ({ page, context }) => {
    await closeOpenRound();
    const room = await referenceService.create('locations', adminUserId, 'ห้องประชุม E2E ปิดรอบ');
    const { asset: desk } = await assetService.registerAsset(custodianUserId, { name: 'โต๊ะ E2E ปิดรอบ', asset_number: 'E2E-VR-601', location_id: room.id, effective_date: '2026-01-05' } as any);
    const { asset: chair } = await assetService.registerAsset(custodianUserId, { name: 'เก้าอี้ E2E ปิดรอบ', asset_number: 'E2E-VR-602', location_id: room.id, effective_date: '2026-01-05' } as any);
    const { verification_round_id: roundId } = await verificationService.open(
      custodianUserId,
      { name: 'ตรวจสอบพัสดุประจำปี 2569 ปิดรอบ', fiscal_year: 2569, location_ids: [room.id] },
      { retryToken: crypto.randomUUID() }
    );
    await verificationService.record(staffUserId, roundId, desk.id, { result: 'FOUND', condition: 'NORMAL' }, { retryToken: crypto.randomUUID() });

    // The Custodian closes the Round over its summary; the chair stays Not Yet Verified.
    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await page.locator('#verification-round-close-action').click();
    const summary = page.locator('[data-testid="verification-round-close-summary"]');
    await expect(summary).toContainText('พบ 1 รายการ');
    await expect(summary).toContainText('ไม่พบในการตรวจ 0 รายการ');
    await expect(summary).toContainText('ยังไม่ได้ตรวจ 1 รายการ');
    await expect(page.locator('#verification-round-close-submit')).toHaveText('ยืนยันปิดรอบ');
    await page.locator('#verification-round-close-submit').click();
    await expect(page.locator('#verification-round-state')).toHaveText('ปิดรอบแล้ว');
    const history = page.locator('[data-testid="verification-round-history"]');
    await expect(history).toContainText('ปิดรอบ โดย custodian_verification');
    await expect(history).toContainText('พบ 1 · ไม่พบในการตรวจ 0 · ยังไม่ได้ตรวจ 1 · มีข้อแตกต่าง 0');
    await expect(page.locator(`[data-testid="scope-entry-result-${chair.id}"]`)).toHaveText('ยังไม่ได้ตรวจ');
    await expect(page.locator('#verification-round-close-action')).toHaveCount(0);
    await expect(page.locator('#verification-round-edit-action')).toHaveCount(0);

    // With no Round open, the Asset page offers no recording; its section keeps the result of the Closed Round.
    await page.goto(`${targetBaseUrl}/assets/${chair.id}`);
    await expect(page.locator(`[data-testid="asset-verification-result-${roundId}"]`)).toContainText('ยังไม่ได้ตรวจ');
    await expect(page.locator('#verification-panel')).toHaveCount(0);
    await expect(page.locator('#verification-record-form')).toHaveCount(0);

    // The Custodian reopens the Round, which needs a reason.
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await page.locator('#verification-round-reopen-action').click();
    await page.locator('#verification-round-reopen-submit').click();
    await expect(page.locator('[data-testid="verification-round-reopen-form-error"]')).toContainText('เหตุผล');
    await page.locator('#verification-round-reopen-reason').fill('ต้องตรวจเก้าอี้ที่ยืมไปห้องอื่น');
    await page.locator('#verification-round-reopen-submit').click();
    await expect(page.locator('#verification-round-state')).toHaveText('เปิดอยู่');
    await expect(history).toContainText('เปิดรอบอีกครั้ง โดย custodian_verification');
    await expect(history).toContainText('เหตุผล: ต้องตรวจเก้าอี้ที่ยืมไปห้องอื่น');
    await expect(page.locator('#verification-round-close-action')).toBeVisible();

    // The page prints its summary, history and entries, without the controls, saying which entries it shows.
    await expect(page.locator('#scope-entry-print-filters')).toBeHidden();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#scope-entry-print-filters')).toHaveText('รายการที่แสดง: ทุกรายการในรอบ');
    await expect(page.locator('#verification-round-actions')).toBeHidden();
    await expect(page.locator('#scope-entry-search-form')).toBeHidden();
    await expect(page.locator('#scope-entry-result-filters')).toBeHidden();
    await expect(page.locator('[data-testid="verification-round-count-not-yet-verified"]')).toBeVisible();
    await expect(history).toBeVisible();
    await expect(page.locator(`[data-testid="scope-entry-${chair.id}"]`)).toBeVisible();
    await page.emulateMedia({ media: 'screen' });

    // A Read-only User sees the same Round with no action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator('#verification-round-state')).toHaveText('เปิดอยู่');
    await expect(page.locator('#verification-round-actions')).toHaveCount(0);

    // Recording works again in the reopened Round.
    await switchActor(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${chair.id}`);
    await page.locator('#verification-record-result-FOUND').check();
    await page.locator('#verification-record-condition-NORMAL').check();
    await page.locator('#verification-record-submit').click();
    await expect(page.locator('[data-testid="verification-panel-current-result"]')).toHaveText('พบ · สภาพปกติ');
  });

  test('Journey F006-T7.1: an Asset Custodian sends Assets Found ชำรุด for repair from a Round page row and from the panel; the Repair Record shows its Round source, the result shows "ส่งซ่อมแล้ว", and "ยังไม่มี action ต่อ" empties; Verification Staff see no "ส่งซ่อม"', async ({ page, context }) => {
    await closeOpenRound();
    const room = await referenceService.create('locations', adminUserId, 'ห้องเรียน E2E ส่งซ่อม');
    const { asset: projector } = await assetService.registerAsset(custodianUserId, { name: 'โปรเจกเตอร์ E2E ส่งซ่อม', asset_number: 'E2E-VR-701', location_id: room.id, effective_date: '2026-01-05' } as any);
    const { asset: speaker } = await assetService.registerAsset(custodianUserId, { name: 'ลำโพง E2E ส่งซ่อม', asset_number: 'E2E-VR-702', location_id: room.id, effective_date: '2026-01-05' } as any);
    const roundName = 'ตรวจสอบพัสดุประจำปี 2569 ส่งซ่อม';
    const { verification_round_id: roundId } = await verificationService.open(custodianUserId, { name: roundName, fiscal_year: 2569, location_ids: [room.id] }, { retryToken: crypto.randomUUID() });
    for (const [asset, note] of [
      [projector, 'หลอดภาพไม่ติด'],
      [speaker, null],
    ] as const) {
      await verificationService.record(staffUserId, roundId, asset.id, { result: 'FOUND', condition: 'DAMAGED', note }, { retryToken: crypto.randomUUID() });
    }

    // Verification Staff see the Discrepancy without "ส่งซ่อม" (#125 Q22).
    await loginAs(context, staffUserId);
    await page.goto(`${targetBaseUrl}/assets/${projector.id}`);
    await expect(page.locator('[data-testid="verification-panel-current-discrepancies"]')).toContainText('ชำรุด');
    await expect(page.locator('#verification-repair-action')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toBeVisible();
    await expect(page.locator('[id^="scope-entry-repair-action-"]')).toHaveCount(0);

    // The Custodian lists the results awaiting an action and sends the projector from its row. The session answers
    // late: the action waits for its CSRF token, or a quick submit would be refused as if the grant were gone (#135).
    await switchActor(page, context, custodianUserId);
    await delaySessionCheck(page);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toBeVisible();
    await expect(page.locator('[id^="scope-entry-repair-action-"]')).toHaveCount(0);
    await page.locator('#scope-entry-awaiting-action-filter-true').click();
    await expect(page).toHaveURL(/awaiting_action=true/);
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 2 รายการ');
    await page.locator(`#scope-entry-repair-action-${projector.id}`).click();
    await expect(page.locator('#repair-repair_source')).toContainText(`ที่มา: ผลตรวจประจำปี ${roundName} พบสภาพชำรุด วันที่ตรวจ`);
    await expect(page.locator('#repair-symptom_or_work')).toHaveValue('หลอดภาพไม่ติด');
    await page.locator('#repair-repair_kind').selectOption('REPAIR');
    await page.getByLabel('ผู้ซ่อมภายนอก').check();
    await page.locator('#repair-submit').click();
    await endSessionDelay(page);

    // The projector no longer awaits an action; the speaker still does.
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="scope-entry-${projector.id}"]`)).toHaveCount(0);
    await expect(page.locator(`#scope-entry-repair-action-${speaker.id}`)).toBeVisible();
    await page.locator('#scope-entry-awaiting-action-filter-ALL').click();
    await expect(page.locator(`[data-testid="scope-entry-sent-for-repair-${projector.id}"]`)).toContainText('ส่งซ่อมแล้ว');
    await expect(page.locator(`[data-testid="scope-entry-sent-for-repair-${speaker.id}"]`)).toHaveCount(0);

    // From the speaker's panel the Custodian sends it too, and follows its link to the Repair Record.
    await page.goto(`${targetBaseUrl}/assets/${speaker.id}`);
    await page.locator('#verification-repair-action').click();
    await expect(page.locator('#repair-repair_source')).toContainText(`ผลตรวจประจำปี ${roundName}`);
    await expect(page.locator('#repair-symptom_or_work')).toHaveValue('');
    await page.locator('#repair-repair_kind').selectOption('MAINTENANCE');
    await page.getByLabel('ผู้ซ่อมภายใน').check();
    await page.locator('#repair-symptom_or_work').fill('เสียงแตก');
    await page.locator('#repair-submit').click();
    const sent = page.locator('[data-testid="verification-panel-current-sent-for-repair"]');
    await expect(sent).toContainText('ส่งซ่อมแล้ว');
    await expect(page.locator('#repair-form')).toHaveCount(0);
    await sent.getByRole('link').click();
    await expect(page).toHaveURL(/\/repairs\/[0-9a-f-]{36}$/);
    await expect(page.locator('#repair-source')).toContainText(`ผลตรวจประจำปี ${roundName} วันที่ตรวจ`);
    await expect(page.locator('[data-testid="repair-source-voided"]')).toHaveCount(0);
    await page.locator('#repair-source-round-link').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/verification-rounds/${roundId}`);

    // A Read-only User sees "ส่งซ่อมแล้ว" with no action, and nothing awaits an action.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}?awaiting_action=true`);
    await expect(page.locator('#scope-entry-list-count')).toHaveText('ไม่พบรายการ');
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator(`[data-testid="scope-entry-sent-for-repair-${speaker.id}"]`)).toContainText('ส่งซ่อมแล้ว');
    await expect(page.locator('[id^="scope-entry-repair-action-"]')).toHaveCount(0);
  });

  test('Journey F006-T8.1: an Asset Custodian moves misplaced Assets from a Round page row and from the panel with the prefilled form; the Round shows "ย้ายแล้ว", "ยังไม่มี action ต่อ" empties, and the Asset timeline names the Round; Verification Staff see no "ย้าย"', async ({ page, context }) => {
    await closeOpenRound();
    const room = await referenceService.create('locations', adminUserId, 'ห้องประชุม E2E ย้าย');
    const hall = await referenceService.create('locations', adminUserId, 'ห้องโถง E2E ย้าย');
    const { asset: desk } = await assetService.registerAsset(custodianUserId, { name: 'โต๊ะ E2E ย้าย', asset_number: 'E2E-VR-801', location_id: room.id, effective_date: '2026-01-05' } as any);
    const { asset: chair } = await assetService.registerAsset(custodianUserId, { name: 'เก้าอี้ E2E ย้าย', asset_number: 'E2E-VR-802', location_id: room.id, effective_date: '2026-01-05' } as any);
    const roundName = 'ตรวจสอบพัสดุประจำปี 2569 ย้าย';
    const { verification_round_id: roundId } = await verificationService.open(custodianUserId, { name: roundName, fiscal_year: 2569, location_ids: [room.id] }, { retryToken: crypto.randomUUID() });
    const revisionOf: Record<string, string> = {};
    for (const asset of [desk, chair]) {
      const { verification_revision_id: revisionId } = await verificationService.record(
        staffUserId,
        roundId,
        asset.id,
        { result: 'FOUND', condition: 'NORMAL', observed_location_id: hall.id },
        { retryToken: crypto.randomUUID() }
      );
      revisionOf[asset.id] = revisionId;
    }
    const verificationDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

    // Verification Staff see the Discrepancy without "ย้าย" (#125 Q22).
    await loginAs(context, staffUserId);
    await page.goto(`${targetBaseUrl}/assets/${desk.id}`);
    await expect(page.locator('[data-testid="verification-panel-current-discrepancies"]')).toContainText('Location ไม่ตรงทะเบียน');
    await expect(page.locator('#verification-reassign-action')).toHaveCount(0);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator(`[data-testid="scope-entry-${desk.id}"]`)).toBeVisible();
    await expect(page.locator('[id^="scope-entry-reassign-action-"]')).toHaveCount(0);

    // The Custodian lists the results awaiting an action and moves the desk from its row, with the form prefilled (P2).
    await switchActor(page, context, custodianUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await page.locator('#scope-entry-awaiting-action-filter-true').click();
    await expect(page).toHaveURL(/awaiting_action=true/);
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 2 รายการ');
    await page.locator(`#scope-entry-reassign-action-${desk.id}`).click();
    await expect(page.locator('#reassignment-verification-source')).toContainText(`ที่มา: ผลตรวจประจำปี ${roundName} Location ไม่ตรงทะเบียน วันที่ตรวจ`);
    await expect(page.locator('#assignment-location_id')).toHaveValue(hall.id);
    await expect(page.locator('#assignment-effective_date')).toHaveValue(verificationDate);
    await expect(page.locator('#assignment-prior-location')).toContainText('ห้องประชุม E2E ย้าย');
    await page.locator('#assignment-submit').click();

    // The desk no longer awaits an action; the chair still does.
    await expect(page.locator('#scope-entry-list-count')).toContainText('พบ 1 รายการ');
    await expect(page.locator(`[data-testid="scope-entry-${desk.id}"]`)).toHaveCount(0);
    await expect(page.locator(`#scope-entry-reassign-action-${chair.id}`)).toBeVisible();
    await page.locator('#scope-entry-awaiting-action-filter-ALL').click();
    await expect(page).not.toHaveURL(/awaiting_action/);
    await expect(page.locator(`[data-testid="scope-entry-reassigned-${desk.id}"]`)).toContainText('ย้ายแล้ว');
    await expect(page.locator(`[data-testid="scope-entry-reassigned-${chair.id}"]`)).toHaveCount(0);
    // The result stays as recorded: its Discrepancy is still shown (Q15).
    await expect(page.locator(`[data-testid="scope-entry-discrepancies-${desk.id}"]`)).toContainText('Location ไม่ตรงทะเบียน');

    // From the chair's panel the Custodian moves it too, a day before the check this time (P2: the date may change);
    // the timeline names the Round and links to it.
    await page.goto(`${targetBaseUrl}/assets/${chair.id}`);
    await page.locator('#verification-reassign-action').click();
    await expect(page.locator('#reassignment-verification-source')).toContainText(`ผลตรวจประจำปี ${roundName}`);
    await expect(page.locator('#assignment-location_id')).toHaveValue(hall.id);
    const dayBefore = new Date(`${verificationDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    await page.locator('#assignment-effective_date').fill(dayBefore.toISOString().slice(0, 10));
    await page.locator('#assignment-submit').click();
    await expect(page.locator('[data-testid="verification-panel-current-reassigned"]')).toContainText('ย้ายแล้ว');
    await expect(page.locator('#detail-location')).toContainText('ห้องโถง E2E ย้าย');
    const source = page.locator('[data-testid^="assignment-verification-source-"]');
    await expect(source).toHaveCount(1);
    await expect(source).toContainText(`ย้ายจากผลตรวจประจำปี ${roundName} วันที่ตรวจ`);
    const saved = await pool.query(`SELECT to_char(effective_date, 'YYYY-MM-DD') AS effective_date FROM assignment_events WHERE verification_revision_id = $1`, [revisionOf[chair.id]]);
    expect(saved.rows).toEqual([{ effective_date: dayBefore.toISOString().slice(0, 10) }]);
    await expect(page.locator('[data-testid^="assignment-cited-revision-voided-"]')).toHaveCount(0);

    // A Verification Correction voids the chair's result: the Reassignment stays and shows its source ยกเลิกแล้ว (P1).
    await verificationService.correct(custodianUserId, roundId, chair.id, { verification_revision_id: revisionOf[chair.id], reason: 'บันทึกผิดครุภัณฑ์' }, { retryToken: crypto.randomUUID() });
    await page.reload();
    await expect(source).toContainText(`ย้ายจากผลตรวจประจำปี ${roundName}`);
    await expect(page.locator('[data-testid^="assignment-cited-revision-voided-"]')).toContainText('ผลตรวจนั้นยกเลิกแล้ว');
    await expect(page.locator('#detail-location')).toContainText('ห้องโถง E2E ย้าย');
    await source.getByRole('link').click();
    await expect(page).toHaveURL(`${targetBaseUrl}/verification-rounds/${roundId}`);

    // A Read-only User sees "ย้ายแล้ว" with no action, and nothing awaits an action: the chair is Not Yet Verified again.
    await switchActor(page, context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}?awaiting_action=true`);
    await expect(page.locator('#scope-entry-list-count')).toHaveText('ไม่พบรายการ');
    await page.goto(`${targetBaseUrl}/verification-rounds/${roundId}`);
    await expect(page.locator(`[data-testid="scope-entry-reassigned-${desk.id}"]`)).toContainText('ย้ายแล้ว');
    await expect(page.locator('[id^="scope-entry-reassign-action-"]')).toHaveCount(0);
  });
});
