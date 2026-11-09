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
import { AssignmentRecordingService } from '../../../api/src/services/assignment-recording.service.ts';
import { AssignmentCorrectionService } from '../../../api/src/services/assignment-correction.service.ts';
import { ReferenceService, type ReferenceKind } from '../../../api/src/services/reference.service.ts';
import { repositoryProxyConfig } from '../../vite.config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F003-T2 (#52): the assignment actions on the Asset page.
test.describe.serial('Assignment journeys: Real SPA -> Composed API -> PostgreSQL (Seam B)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fastifyApp: FastifyInstance;
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;
  let sessionService: SessionService;
  let assetService: AssetService;
  let recordingService: AssignmentRecordingService;
  let correctionService: AssignmentCorrectionService;
  let referenceService: ReferenceService;

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
    recordingService = new AssignmentRecordingService({ db: pool });
    correctionService = new AssignmentCorrectionService({ db: pool });
    referenceService = new ReferenceService({ db: pool });

    fastifyApp = await buildApp({
      db: pool,
      cookieSecret: 'test-secret-at-least-32-chars-long-assignment-e2e',
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
    custodianUserId = await createUser('custodian_assign', 'ASSET_CUSTODIAN');
    readonlyUserId = await createUser('readonly_assign', 'READ_ONLY');
    adminUserId = await createUser('admin_assign', 'ADMINISTRATOR');

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

  const bangkokToday = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  const entryIn = (kind: ReferenceKind, name: string) => referenceService.create(kind, adminUserId, name);

  const register = async (input: Record<string, unknown>): Promise<string> =>
    (await assetService.registerAsset(custodianUserId, input as any)).asset.id;

  const reassignBehindTheForm = (assetId: string, expectedVersion: number, effectiveDate: string, locationId: string) =>
    recordingService.record(
      custodianUserId,
      assetId,
      { kind: 'REASSIGNMENT', expected_assignment_version: expectedVersion, effective_date: effectiveDate, location_id: locationId },
      { retryToken: crypto.randomUUID() }
    );

  const lastEvent = (page: any) => page.locator('[data-testid^="assignment-event-"]').last();

  test('Journey F003-T2.1: a Custodian reassigns an Asset from its page, seeing the values in effect on the chosen date', async ({ page, context }) => {
    const firstRoom = await entryIn('locations', 'ห้องแรก E2E');
    const secondRoom = await entryIn('locations', 'ห้องที่สอง E2E');
    const newRoom = await entryIn('locations', 'ห้องใหม่ E2E');
    const closedRoom = await entryIn('locations', 'ห้องที่ปิดแล้ว E2E');
    await referenceService.update('locations', adminUserId, closedRoom.id, { expected_version: closedRoom.version, is_active: false });
    const unit = await entryIn('organization-units', 'กลุ่มงานเดิม E2E');

    const assetId = await register({
      name: 'เครื่องฉาย E2E',
      location_id: firstRoom.id,
      organization_unit_id: unit.id,
      effective_date: '2020-01-01',
    });
    await reassignBehindTheForm(assetId, 1, '2024-06-01', secondRoom.id);

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.locator('#detail-location')).toHaveText('ห้องที่สอง E2E');

    const action = page.locator('#assignment-action');
    await expect(action).toHaveText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
    await action.click();

    // MR-13: temporary lending is not a Reassignment.
    await expect(page.getByTestId('assignment-loan-note')).toContainText('การยืมชั่วคราว');

    // The form shows the values in effect on the chosen date.
    await expect(page.locator('#assignment-effective_date')).toHaveValue(bangkokToday());
    await expect(page.locator('#assignment-prior-location')).toContainText('ห้องที่สอง E2E');
    await page.locator('#assignment-effective_date').fill('2021-03-01');
    await expect(page.locator('#assignment-prior-location')).toContainText('ห้องแรก E2E');
    await expect(page.locator('#assignment-prior-organization_unit')).toContainText('กลุ่มงานเดิม E2E');
    await expect(page.locator('#assignment-prior-responsible_person')).toContainText('ไม่ระบุ');

    // Clearing is offered only for the OrganizationUnit and the Responsible Person.
    await expect(page.locator('#assignment-location_id option', { hasText: 'ล้างค่า' })).toHaveCount(0);
    await expect(page.locator('#assignment-organization_unit_id option', { hasText: 'ล้างค่า' })).toHaveCount(1);
    await expect(page.locator('#assignment-responsible_person_id option', { hasText: 'ล้างค่า' })).toHaveCount(1);

    // Deactivated entries are offered, labelled, only for past dates.
    const closedOption = page.locator(`#assignment-location_id option[value="${closedRoom.id}"]`);
    await expect(closedOption).toHaveText('ห้องที่ปิดแล้ว E2E (ปิดใช้งาน)');
    await page.locator('#assignment-location_id').selectOption(closedRoom.id);
    await page.locator('#assignment-effective_date').fill(bangkokToday());
    await expect(closedOption).toHaveCount(0);
    await expect(page.locator('#assignment-location_id')).toHaveValue('');

    await page.locator('#assignment-location_id').selectOption(newRoom.id);
    await page.locator('#assignment-organization_unit_id').selectOption({ label: 'ล้างค่า (ไม่ระบุ)' });
    await page.locator('#assignment-document_reference').fill('บันทึกข้อความ ที่ 7/2569');
    await page.locator('#assignment-assignment_remark').fill('ย้ายตามการจัดห้องใหม่');
    await page.locator('#assignment-submit').click();

    await expect(page.locator('#assignment-form')).toHaveCount(0);
    await expect(page.getByTestId('assignment-recorded')).toBeVisible();
    await expect(page.locator('#detail-location')).toHaveText('ห้องใหม่ E2E');
    await expect(page.locator('#detail-organization_unit')).toHaveText('ไม่ระบุ');

    const event = lastEvent(page);
    await expect(event).toContainText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
    await expect(event).toContainText('วันที่บันทึก');
    await expect(event).toContainText('custodian_assign');
    await expect(event).toContainText('ห้องที่สอง E2E → ห้องใหม่ E2E');
    await expect(event).toContainText('กลุ่มงานเดิม E2E → ไม่ระบุ');
    await expect(event).toContainText('เอกสารอ้างอิง: บันทึกข้อความ ที่ 7/2569');
    await expect(event).toContainText('หมายเหตุ: ย้ายตามการจัดห้องใหม่');

    const stored = await pool.query(
      `SELECT e.kind, to_char(e.effective_date, 'YYYY-MM-DD') AS effective_date, count(c.id)::int AS changes
       FROM assignment_events e JOIN assignment_changes c ON c.event_id = e.id
       WHERE e.asset_id = $1 AND e.remark = 'ย้ายตามการจัดห้องใหม่'
       GROUP BY e.kind, e.effective_date`,
      [assetId]
    );
    expect(stored.rows).toEqual([{ kind: 'REASSIGNMENT', effective_date: bangkokToday(), changes: 2 }]);
  });

  test('Journey F003-T2.2: a stale save is refused until the latest facts are read, and a lost response retries into one event', async ({ page, context }) => {
    const roomA = await entryIn('locations', 'ห้องชนกัน ก E2E');
    const roomB = await entryIn('locations', 'ห้องชนกัน ข E2E');
    const roomC = await entryIn('locations', 'ห้องชนกัน ค E2E');
    const person = await entryIn('persons', 'คุณชนกัน E2E');
    const assetId = await register({ name: 'ตู้ชนกัน E2E', location_id: roomA.id, effective_date: '2024-01-01' });

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await page.locator('#assignment-action').click();
    await page.locator('#assignment-location_id').selectOption(roomC.id);

    // Someone else records a change after the form opened.
    await reassignBehindTheForm(assetId, 1, '2024-06-01', roomB.id);
    await page.locator('#assignment-submit').click();

    const error = page.getByTestId('assignment-form-error');
    await expect(error).toContainText('มีการบันทึกรายการอื่น');
    const count = async () =>
      (await pool.query('SELECT count(*)::int AS count FROM assignment_events WHERE asset_id = $1', [assetId])).rows[0].count;
    expect(await count()).toBe(2);

    // Reading the latest facts lets the same form go on, showing what changed.
    await page.locator('#assignment-reload').click();
    await expect(error).toHaveCount(0);
    await expect(page.locator('#assignment-prior-location')).toContainText('ห้องชนกัน ข E2E');

    // The response is lost after the server commits; the retry returns the same result.
    let lostOnce = false;
    await page.route(`**/assets/${assetId}/assignments`, async (route) => {
      if (route.request().method() === 'POST' && !lostOnce) {
        lostOnce = true;
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.fallback();
    });
    await page.locator('#assignment-submit').click();
    await expect(error).toContainText('ส่งซ้ำ');
    await expect(page.locator('#assignment-location_id')).toBeDisabled();
    expect(await count()).toBe(3);

    await page.locator('#assignment-retry').click();
    await expect(page.locator('#assignment-form')).toHaveCount(0);
    await expect(page.locator('#detail-location')).toHaveText('ห้องชนกัน ค E2E');
    expect(await count()).toBe(3);
  });

  test('Journey F003-T2.3: an Asset with no Initial Assignment is given one from its page, and may then be reassigned', async ({ page, context }) => {
    const room = await entryIn('locations', 'ห้องกำหนดภายหลัง E2E');
    const assetId = await register({ name: 'ของตกทอด E2E', is_legacy: true });

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.getByTestId('assignment-timeline-empty')).toBeVisible();

    const action = page.locator('#assignment-action');
    await expect(action).toHaveText('กำหนดครั้งแรก');
    await action.click();

    // A legacy item starts at "ไม่ทราบ", and an Initial Assignment may keep Legacy text.
    await expect(page.locator('#assignment-effective_date_unknown')).toBeChecked();
    await page.locator('#assignment-location_id').selectOption(room.id);
    await page.locator('#assignment-legacy_responsible_person_text').fill('คุณเก่า (ทะเบียนปี 2540)');
    await page.locator('#assignment-submit').click();

    await expect(page.locator('#assignment-form')).toHaveCount(0);
    await expect(page.locator('#detail-location')).toHaveText('ห้องกำหนดภายหลัง E2E');
    await expect(page.locator('#detail-responsible_person')).toHaveText('ข้อความเดิม: คุณเก่า (ทะเบียนปี 2540)');
    await expect(lastEvent(page)).toContainText('ไม่ทราบวันที่');
    await expect(action).toHaveText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
  });

  test('Journey F003-T2.4: a Read-only User and an Administrator see the timeline with no assignment action', async ({ page, context }) => {
    const room = await entryIn('locations', 'ห้องดูอย่างเดียว E2E');
    const other = await entryIn('locations', 'ห้องดูอย่างเดียว 2 E2E');
    const assetId = await register({ name: 'ดูอย่างเดียว E2E', location_id: room.id, effective_date: '2024-01-01' });
    await reassignBehindTheForm(assetId, 1, '2024-06-01', other.id);

    for (const viewer of [readonlyUserId, adminUserId]) {
      await page.goto('about:blank');
      await loginAs(context, viewer);
      await page.goto(`${targetBaseUrl}/assets/${assetId}`);
      await expect(page.locator('#detail-location')).toHaveText('ห้องดูอย่างเดียว 2 E2E');
      await expect(lastEvent(page)).toContainText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
      await expect(page.locator('#assignment-action')).toHaveCount(0);
      await expect(page.locator('#assignment-form')).toHaveCount(0);
    }
  });

  test('Journey F003-T3.1: a Read-only User sees corrections and voided facts with no correction action; holders of assignment:correct are offered it', async ({ page, context }) => {
    const firstRoom = await entryIn('locations', 'ห้องแก้แล้ว E2E');
    const wrongRoom = await entryIn('locations', 'ห้องที่บันทึกผิด E2E');
    const rightRoom = await entryIn('locations', 'ห้องที่ถูกต้อง E2E');
    const assetId = await register({ name: 'ตู้มีการแก้ไข E2E', location_id: firstRoom.id, effective_date: '2024-01-01' });
    const correctedEvent = (await reassignBehindTheForm(assetId, 1, '2024-06-01', wrongRoom.id)).event;
    const voidedEvent = (await reassignBehindTheForm(assetId, 2, '2024-07-01', rightRoom.id)).event;

    const correctBehindTheForm = (eventId: string, version: number, input: Record<string, unknown>) =>
      correctionService.correct(custodianUserId, assetId, eventId, { expected_assignment_version: version, ...input } as any, {
        retryToken: crypto.randomUUID(),
      });
    await correctBehindTheForm(correctedEvent.id, 3, {
      action: 'AMEND',
      reason: 'เลือกห้องผิดรายการ',
      changes: { location: { new: { entry_id: rightRoom.id } } },
      // The later fact still records wrongRoom as its prior value, until it is voided below.
      explicit_continuation: true,
    });
    await correctBehindTheForm(voidedEvent.id, 4, { action: 'VOID', reason: 'ไม่เคยย้ายจริง' });

    const correctedFact = page.getByTestId(`assignment-event-${correctedEvent.id}`);
    const voidedFact = page.getByTestId(`assignment-event-${voidedEvent.id}`);
    const offers = page.locator('[data-testid^="assignment-amend-"], [data-testid^="assignment-void-"]');

    await loginAs(context, readonlyUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);

    // The Current Assignment follows the facts that stand: the void and the amendment both count.
    await expect(page.locator('#detail-location')).toHaveText('ห้องที่ถูกต้อง E2E');

    // Each correction shows who, the reason and before → after.
    const corrections = page.getByTestId(`assignment-corrections-${correctedEvent.id}`);
    await expect(corrections).toContainText('แก้ไขรายการที่บันทึกผิด');
    await expect(corrections).toContainText('custodian_assign');
    await expect(corrections).toContainText('เหตุผล: เลือกห้องผิดรายการ');
    await expect(corrections).toContainText('ห้องแก้แล้ว E2E → ห้องที่บันทึกผิด E2E แก้เป็น ห้องแก้แล้ว E2E → ห้องที่ถูกต้อง E2E');

    // A voided fact stays, struck through, with its reason.
    await expect(page.getByTestId(`assignment-fact-${voidedEvent.id}`)).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.getByTestId(`assignment-voided-${voidedEvent.id}`)).toHaveText('ยกเลิกแล้ว');
    await expect(voidedFact).toContainText('เหตุผล: ไม่เคยย้ายจริง');
    await expect(page.getByTestId(`assignment-fact-${correctedEvent.id}`)).toHaveCSS('text-decoration-line', 'none');

    await expect(page.locator('[data-testid^="assignment-event-"]')).toHaveCount(3);
    await expect(offers).toHaveCount(0);

    // Holders of assignment:correct are offered both actions on each fact that stands, and none on a voided one.
    for (const holder of [custodianUserId, adminUserId]) {
      await page.goto('about:blank');
      await loginAs(context, holder);
      await page.goto(`${targetBaseUrl}/assets/${assetId}`);
      await expect(correctedFact.getByTestId(`assignment-amend-${correctedEvent.id}`)).toHaveText('แก้ไขรายการที่บันทึกผิด');
      await expect(correctedFact.getByTestId(`assignment-void-${correctedEvent.id}`)).toHaveText('ยกเลิกรายการ (บันทึกผิด)');
      await expect(page.getByTestId(`assignment-amend-${voidedEvent.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`assignment-void-${voidedEvent.id}`)).toHaveCount(0);
    }
  });

  test("Journey F003-T3.2: a Custodian corrects facts from the Asset page, and reading the latest facts keeps another user's values", async ({ page, context }) => {
    const roomA = await entryIn('locations', 'ห้องแก้จากฟอร์ม ก E2E');
    const roomB = await entryIn('locations', 'ห้องแก้จากฟอร์ม ข E2E');
    const roomC = await entryIn('locations', 'ห้องแก้จากฟอร์ม ค E2E');
    const unit = await entryIn('organization-units', 'หน่วยแก้จากฟอร์ม E2E');
    const assetId = await register({ name: 'ตู้แก้จากฟอร์ม E2E', location_id: roomA.id, effective_date: '2024-01-01' });
    const reassignment = (await reassignBehindTheForm(assetId, 1, '2024-06-01', roomB.id)).event;
    const initial = (await pool.query(`SELECT id FROM assignment_events WHERE asset_id = $1 AND kind = 'INITIAL'`, [assetId])).rows[0];

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.locator('#detail-location')).toHaveText('ห้องแก้จากฟอร์ม ข E2E');

    // Amend a Reassignment's new value.
    await page.getByTestId(`assignment-amend-${reassignment.id}`).click();
    const form = page.locator('#assignment-form');
    await expect(form).toBeVisible();
    await expect(page.locator('#assignment-amend-location-prior')).toHaveValue(roomA.id);
    await expect(page.locator('#assignment-amend-location-new')).toHaveValue(roomB.id);
    await expect(page.locator('#assignment-amend-organization_unit-new')).toHaveCount(0);

    // The form refuses no reason, then no change.
    await page.locator('#assignment-submit').click();
    await expect(page.getByTestId('assignment-form-error')).toContainText('กรุณาระบุเหตุผล');
    await page.locator('#assignment-correction-reason').fill('เลือกห้องผิด');
    await page.locator('#assignment-submit').click();
    await expect(page.getByTestId('assignment-form-error')).toContainText('ยังไม่มีค่าที่แก้ไข');

    await page.locator('#assignment-amend-location-new').selectOption(roomC.id);
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('#detail-location')).toHaveText('ห้องแก้จากฟอร์ม ค E2E');
    await expect(page.getByTestId(`assignment-corrections-${reassignment.id}`)).toContainText('แก้เป็น');

    // Amend the Initial Assignment: add a dimension it missed, and set its date unknown.
    await page.getByTestId(`assignment-amend-${initial.id}`).click();
    await page.locator('#assignment-amend-organization_unit_id').selectOption(unit.id);
    await page.locator('#assignment-amend-effective_date_unknown').check();
    await page.locator('#assignment-correction-reason').fill('รู้ภายหลังว่าเป็นของหน่วยนี้มาตลอด');
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('#detail-organization_unit')).toHaveText('หน่วยแก้จากฟอร์ม E2E');
    await expect(page.getByTestId(`assignment-event-${initial.id}`)).toContainText('ไม่ทราบวันที่');

    // Another user amends the fact after this form opened. Reading the latest facts keeps what this
    // user typed and shows the other user's value for the field this user left alone.
    await page.getByTestId(`assignment-amend-${reassignment.id}`).click();
    await page.locator('#assignment-amend-document_reference').fill('เอกสารของฉัน');
    await page.locator('#assignment-correction-reason').fill('เติมเอกสาร');
    await correctionService.correct(custodianUserId, assetId, reassignment.id, { action: 'AMEND', expected_assignment_version: 4, reason: 'คนอื่นแก้', remark: 'หมายเหตุจากคนอื่น' } as any, { retryToken: crypto.randomUUID() });
    await page.locator('#assignment-submit').click();
    await expect(page.getByTestId('assignment-form-error')).toContainText('มีการบันทึกรายการอื่น');
    await page.locator('#assignment-reload').click();
    await expect(page.getByTestId('assignment-form-error')).toHaveCount(0);
    await expect(page.locator('#assignment-amend-assignment_remark')).toHaveValue('หมายเหตุจากคนอื่น');
    await expect(page.locator('#assignment-amend-document_reference')).toHaveValue('เอกสารของฉัน');
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    const event = page.getByTestId(`assignment-event-${reassignment.id}`);
    await expect(event).toContainText('หมายเหตุ: หมายเหตุจากคนอื่น');
    await expect(event).toContainText('เอกสารอ้างอิง: เอกสารของฉัน');

    // Void the Reassignment.
    await page.getByTestId(`assignment-void-${reassignment.id}`).click();
    await expect(page.locator('#assignment-cancel')).toHaveText('ไม่ยกเลิก');
    await page.locator('#assignment-submit').click();
    await expect(page.getByTestId('assignment-form-error')).toContainText('กรุณาระบุเหตุผล');
    await page.locator('#assignment-correction-reason').fill('ไม่เคยย้ายจริง');
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('#detail-location')).toHaveText('ห้องแก้จากฟอร์ม ก E2E');
    await expect(page.getByTestId(`assignment-fact-${reassignment.id}`)).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.getByTestId(`assignment-amend-${reassignment.id}`)).toHaveCount(0);

    // Void the Initial Assignment: "กำหนดครั้งแรก" is offered again.
    await expect(page.locator('#assignment-action')).toHaveText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
    await page.getByTestId(`assignment-void-${initial.id}`).click();
    await page.locator('#assignment-correction-reason').fill('กำหนดผิด');
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    const action = page.locator('#assignment-action');
    await expect(action).toHaveText('กำหนดครั้งแรก');
    await action.click();
    await page.locator('#assignment-location_id').selectOption(roomB.id);
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('#detail-location')).toHaveText('ห้องแก้จากฟอร์ม ข E2E');
    await expect(action).toHaveText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
  });

  test('Journey F003-T4.1: a backdated Reassignment warns, is confirmed and marked, can be found, and a correction clears it', async ({ page, context }) => {
    const roomA = await entryIn('locations', 'ห้องขัดแย้ง ก E2E');
    const roomB = await entryIn('locations', 'ห้องขัดแย้ง ข E2E');
    const roomC = await entryIn('locations', 'ห้องขัดแย้ง ค E2E');
    const assetId = await register({ name: 'ตู้ขัดแย้ง E2E', location_id: roomA.id, effective_date: '2024-01-01' });
    const later = (await reassignBehindTheForm(assetId, 1, '2024-06-01', roomC.id)).event;
    const consistentId = await register({ name: 'ตู้ไม่ขัดแย้ง E2E', location_id: roomA.id, effective_date: '2024-01-01' });

    const count = async () =>
      (await pool.query('SELECT count(*)::int AS count FROM assignment_events WHERE asset_id = $1', [assetId])).rows[0].count;
    const notice = page.getByTestId('assignment-conflict-notice');
    const marker = page.getByTestId(`assignment-conflict-${later.id}-location`);
    const form = page.locator('#assignment-form');

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.locator('#detail-location')).toHaveText('ห้องขัดแย้ง ค E2E');
    await expect(notice).toHaveCount(0);

    await page.locator('#assignment-action').click();
    await page.locator('#assignment-effective_date').fill('2024-03-01');
    await page.locator('#assignment-location_id').selectOption(roomB.id);
    await page.locator('#assignment-submit').click();

    // The warning lists the contradiction, and nothing is saved.
    const warning = page.getByTestId('assignment-conflict-warning');
    await expect(warning).toContainText('ย้าย / เปลี่ยนผู้รับผิดชอบ');
    await expect(warning).toContainText('บันทึกค่าเดิมไว้ว่า ห้องขัดแย้ง ก E2E');
    await expect(warning).toContainText('ค่าก่อนหน้าคือ ห้องขัดแย้ง ข E2E');
    expect(await count()).toBe(2);

    // What is confirmed is what the warning covers: the fields are locked until the user goes back.
    await expect(page.locator('#assignment-location_id')).toBeDisabled();
    await page.locator('#assignment-conflict-back').click();
    await expect(warning).toHaveCount(0);
    await expect(page.locator('#assignment-location_id')).toBeEnabled();
    await page.locator('#assignment-submit').click();
    await expect(warning).toBeVisible();

    await page.locator('#assignment-conflict-confirm').click();
    await expect(form).toHaveCount(0);
    expect(await count()).toBe(3);

    // The Asset page says so, and the Current Assignment still follows the latest Effective Date (MR-03).
    await expect(notice).toContainText('มีประวัติขัดแย้งค้างตรวจ');
    await expect(marker).toContainText('บันทึกค่าเดิมไว้ว่า ห้องขัดแย้ง ก E2E');
    await expect(marker).toContainText('ค่าก่อนหน้าคือ ห้องขัดแย้ง ข E2E');
    await expect(page.locator('#detail-location')).toHaveText('ห้องขัดแย้ง ค E2E');

    // The asset list finds it.
    await page.goto(`${targetBaseUrl}/assets/search`);
    await expect(page.getByTestId(`search-result-row-${consistentId}`)).toBeVisible();
    await page.locator('#search-filter-has_assignment_conflict').check();
    await page.locator('#search-submit-btn').click();
    await expect(page.getByTestId(`search-result-row-${assetId}`)).toBeVisible();
    await expect(page.getByTestId(`search-result-row-${consistentId}`)).toHaveCount(0);

    // A correction that makes the facts consistent clears it, with no confirmation.
    await page.getByTestId(`asset-detail-link-${assetId}`).click();
    await page.getByTestId(`assignment-amend-${later.id}`).click();
    await page.locator('#assignment-amend-location-prior').selectOption(roomB.id);
    await page.locator('#assignment-correction-reason').fill('ค่าเดิมต้องเป็นห้อง ข');
    await page.locator('#assignment-submit').click();
    await expect(form).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(marker).toHaveCount(0);

    await page.goto(`${targetBaseUrl}/assets/search`);
    await page.locator('#search-filter-has_assignment_conflict').check();
    await page.locator('#search-submit-btn').click();
    await expect(page.locator('#search-results-region')).toBeVisible();
    await expect(page.getByTestId(`search-result-row-${assetId}`)).toHaveCount(0);
  });

  test('Journey F003-T4.2: corrections and an Initial Assignment warn too, and a stale confirmation has to be warned again', async ({ page, context }) => {
    const roomA = await entryIn('locations', 'ห้องเตือนแก้ ก E2E');
    const roomB = await entryIn('locations', 'ห้องเตือนแก้ ข E2E');
    const roomC = await entryIn('locations', 'ห้องเตือนแก้ ค E2E');
    const assetId = await register({ name: 'ตู้เตือนแก้ E2E', location_id: roomA.id, effective_date: '2024-01-01' });
    const first = (await reassignBehindTheForm(assetId, 1, '2024-03-01', roomB.id)).event;
    await reassignBehindTheForm(assetId, 2, '2024-06-01', roomC.id);
    const initial = (await pool.query(`SELECT id FROM assignment_events WHERE asset_id = $1 AND kind = 'INITIAL'`, [assetId])).rows[0];

    const warning = page.getByTestId('assignment-conflict-warning');
    const form = page.locator('#assignment-form');

    await loginAs(context, custodianUserId);
    await page.goto(`${targetBaseUrl}/assets/${assetId}`);
    await expect(page.locator('#detail-location')).toHaveText('ห้องเตือนแก้ ค E2E');

    // Voiding a fact that a later fact's prior value relies on warns first.
    await page.getByTestId(`assignment-void-${first.id}`).click();
    await page.locator('#assignment-correction-reason').fill('ไม่เคยย้ายจริง');
    await page.locator('#assignment-submit').click();
    await expect(warning).toContainText('ค่าก่อนหน้าคือ ห้องเตือนแก้ ก E2E');

    // Someone else records a fact after the warning: the confirmation is refused as stale.
    await correctionService.correct(custodianUserId, assetId, initial.id, { action: 'AMEND', expected_assignment_version: 3, reason: 'คนอื่นแก้', remark: 'หมายเหตุจากคนอื่น' } as any, { retryToken: crypto.randomUUID() });
    await page.locator('#assignment-conflict-confirm').click();
    await expect(page.getByTestId('assignment-form-error')).toContainText('มีการบันทึกรายการอื่น');
    await expect(page.getByTestId(`assignment-fact-${first.id}`)).toHaveCSS('text-decoration-line', 'none');

    // After reading the latest facts, the save warns again instead of carrying the old confirmation over.
    await page.locator('#assignment-reload').click();
    await expect(page.getByTestId('assignment-form-error')).toHaveCount(0);
    await page.locator('#assignment-submit').click();
    await expect(warning).toBeVisible();
    await page.locator('#assignment-conflict-confirm').click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId(`assignment-fact-${first.id}`)).toHaveCSS('text-decoration-line', 'line-through');

    // With the Initial Assignment voided as well, a new one dated after a Reassignment warns about itself.
    await page.getByTestId(`assignment-void-${initial.id}`).click();
    await page.locator('#assignment-correction-reason').fill('กำหนดผิด');
    await page.locator('#assignment-submit').click();
    await expect(warning).toBeVisible();
    await page.locator('#assignment-conflict-confirm').click();
    await expect(form).toHaveCount(0);

    const action = page.locator('#assignment-action');
    await expect(action).toHaveText('กำหนดครั้งแรก');
    await action.click();
    await page.locator('#assignment-location_id').selectOption(roomA.id);
    await page.locator('#assignment-effective_date').fill('2025-01-01');
    await page.locator('#assignment-submit').click();
    await expect(warning).toContainText('รายการที่กำลังบันทึก');
    await expect(warning).toContainText('ค่าก่อนหน้าคือ ห้องเตือนแก้ ค E2E');
    await page.locator('#assignment-conflict-confirm').click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId('assignment-conflict-notice')).toBeVisible();
  });
});
