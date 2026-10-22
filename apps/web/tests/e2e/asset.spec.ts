import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');

test.describe('Asset Registry SPA Journeys (Seam B)', () => {
  let viteServer: ViteDevServer;
  let targetBaseUrl: string;

  test.beforeAll(async () => {
    // Start isolated Vite dev server for this test run on an available port
    viteServer = await createServer({
      root: webRoot,
      configFile: path.resolve(webRoot, 'vite.config.ts'),
      server: {
        port: 5174,
        strictPort: false,
      },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (address && typeof address === 'object') {
      targetBaseUrl = `http://localhost:${address.port}`;
    } else {
      targetBaseUrl = 'http://localhost:5174';
    }
  });

  test.afterAll(async () => {
    if (viteServer) {
      await viteServer.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    // Mock valid authenticated session by default
    await page.route('**/auth/session-check', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            username: 'custodian_user',
            is_active: true,
          },
          csrfToken: 'test-csrf-token-12345',
        }),
      });
    });
  });

  test('Journey 1: minimal ordinary registration -> linked detail/history view', async ({ page }) => {
    const createdAssetId = '22222222-2222-4222-8222-222222222222';

    // Mock duplicate check returning empty
    await page.route('**/assets/duplicate-candidates*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: [] }),
      });
    });

    // Mock asset registration POST
    await page.route('**/assets', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        expect(body.item_name).toBe('MacBook Pro 16');
        expect(body.asset_number).toBe('ASSET-2026-001');
        expect(body.serial_number).toBe('C02XYZ12345');
        expect(body.is_legacy).toBe(false);

        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            asset: {
              id: createdAssetId,
              item_name: 'MacBook Pro 16',
              asset_number: 'ASSET-2026-001',
              serial_number: 'C02XYZ12345',
              category_id: null,
              organization_unit: 'ฝ่ายไอที',
              source_reference: 'PO-2026-0099',
              is_legacy: false,
              created_by: '11111111-1111-4111-8111-111111111111',
              recorded_at: '2026-10-22T10:00:00.000Z',
              updated_at: '2026-10-22T10:00:00.000Z',
            },
            starting_fact: {
              id: '33333333-3333-4333-8333-333333333333',
              asset_id: createdAssetId,
              event_type: 'REGISTERED',
              recorded_at: '2026-10-22T10:00:00.000Z',
              actor_id: '11111111-1111-4111-8111-111111111111',
              details: {
                item_name: 'MacBook Pro 16',
                asset_number: 'ASSET-2026-001',
                serial_number: 'C02XYZ12345',
                is_legacy: false,
              },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Mock asset detail GET
    await page.route(`**/assets/${createdAssetId}`, async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          asset: {
            id: createdAssetId,
            item_name: 'MacBook Pro 16',
            asset_number: 'ASSET-2026-001',
            serial_number: 'C02XYZ12345',
            category_id: null,
            organization_unit: 'ฝ่ายไอที',
            source_reference: 'PO-2026-0099',
            is_legacy: false,
            created_by: '11111111-1111-4111-8111-111111111111',
            recorded_at: '2026-10-22T10:00:00.000Z',
            updated_at: '2026-10-22T10:00:00.000Z',
          },
          history: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              asset_id: createdAssetId,
              event_type: 'REGISTERED',
              recorded_at: '2026-10-22T10:00:00.000Z',
              actor_id: '11111111-1111-4111-8111-111111111111',
              details: {
                item_name: 'MacBook Pro 16',
                asset_number: 'ASSET-2026-001',
                serial_number: 'C02XYZ12345',
                is_legacy: false,
              },
            },
          ],
        }),
      });
    });

    await page.goto(`${targetBaseUrl}/assets/register`);
    await expect(page.getByRole('heading', { level: 1, name: 'ลงทะเบียนครุภัณฑ์' })).toBeVisible();

    // Fill form
    await page.locator('input#item_name').fill('MacBook Pro 16');
    await page.locator('input#asset_number').fill('ASSET-2026-001');
    await page.locator('input#serial_number').fill('C02XYZ12345');
    await page.locator('input#organization_unit').fill('ฝ่ายไอที');
    await page.locator('textarea#source_reference').fill('PO-2026-0099');

    // Submit and verify navigation
    await Promise.all([
      page.waitForURL(`**/assets/${createdAssetId}`),
      page.locator('button#submit-register-btn').click(),
    ]);

    // Verify detail page elements
    await expect(page.locator('h1#asset-detail-heading')).toHaveText('MacBook Pro 16');
    await expect(page.getByText(`Stable ID: ${createdAssetId}`)).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: 'ASSET-2026-001' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: 'C02XYZ12345' })).toBeVisible();
    await expect(page.getByText('ยังไม่ระบุหมวดหมู่ (Uncategorized)')).toBeVisible();
    await expect(page.getByText('ลงทะเบียนครุภัณฑ์ (REGISTERED)')).toBeVisible();
  });

  test('Journey 2: duplicate warning and explicit continuation to distinct item', async ({ page }) => {
    const existingAssetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newAssetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    // Mock duplicate check returning candidate
    await page.route('**/assets/duplicate-candidates*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              id: existingAssetId,
              item_name: 'Existing Projector',
              asset_number: 'PROJ-001',
              serial_number: 'SN-PROJ-99',
              recorded_at: '2026-10-01T00:00:00.000Z',
            },
          ],
        }),
      });
    });

    // Mock POST rejecting without continuation and accepting with continuation
    await page.route('**/assets', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        if (!body.explicit_continuation) {
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'DUPLICATE_CANDIDATE',
              message: 'Found duplicate candidates',
              candidates: [
                {
                  id: existingAssetId,
                  item_name: 'Existing Projector',
                  asset_number: 'PROJ-001',
                  serial_number: 'SN-PROJ-99',
                  recorded_at: '2026-10-01T00:00:00.000Z',
                },
              ],
            }),
          });
        } else {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
              asset: {
                id: newAssetId,
                item_name: 'Distinct Second Projector',
                asset_number: 'PROJ-001',
                serial_number: 'SN-PROJ-99',
                category_id: null,
                organization_unit: null,
                source_reference: null,
                is_legacy: false,
                created_by: '11111111-1111-4111-8111-111111111111',
                recorded_at: '2026-10-22T11:00:00.000Z',
                updated_at: '2026-10-22T11:00:00.000Z',
              },
              starting_fact: {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                asset_id: newAssetId,
                event_type: 'REGISTERED',
                recorded_at: '2026-10-22T11:00:00.000Z',
                actor_id: '11111111-1111-4111-8111-111111111111',
                details: { item_name: 'Distinct Second Projector' },
              },
            }),
          });
        }
      } else {
        await route.continue();
      }
    });

    await page.route(`**/assets/${newAssetId}`, async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          asset: {
            id: newAssetId,
            item_name: 'Distinct Second Projector',
            asset_number: 'PROJ-001',
            serial_number: 'SN-PROJ-99',
            category_id: null,
            organization_unit: null,
            source_reference: null,
            is_legacy: false,
            created_by: '11111111-1111-4111-8111-111111111111',
            recorded_at: '2026-10-22T11:00:00.000Z',
            updated_at: '2026-10-22T11:00:00.000Z',
          },
          history: [],
        }),
      });
    });

    await page.goto(`${targetBaseUrl}/assets/register`);
    await page.locator('input#item_name').fill('Distinct Second Projector');
    await page.locator('input#asset_number').fill('PROJ-001');

    // Trigger duplicate check
    await page.locator('button#check-duplicate-btn').click();

    // Verify warning banner and candidates table appear
    await expect(page.getByRole('region', { name: 'การแจ้งเตือนข้อมูลซ้ำ' })).toBeVisible();
    await expect(page.getByText('คำเตือน: พบครุภัณฑ์ที่มีเลขระบุตัวตนตรงกันในระบบ')).toBeVisible();
    await expect(page.getByText('Existing Projector')).toBeVisible();

    // Submit button should be disabled without explicit continuation
    await expect(page.locator('button#submit-register-btn')).toBeDisabled();

    // Check explicit continuation checkbox
    await page.locator('input#explicit_continuation').check();
    await expect(page.locator('button#submit-register-btn')).toBeEnabled();

    // Submit form
    await Promise.all([
      page.waitForURL(`**/assets/${newAssetId}`),
      page.locator('button#submit-register-btn').click(),
    ]);

    await expect(page.locator('h1#asset-detail-heading')).toHaveText('Distinct Second Projector');
  });

  test('Journey 3: incomplete legacy entry without fabricated placeholders', async ({ page }) => {
    const legacyAssetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    await page.route('**/assets', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        expect(body.is_legacy).toBe(true);
        expect(body.item_name).toBeUndefined();
        expect(body.asset_number).toBeUndefined();
        expect(body.serial_number).toBeUndefined();

        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            asset: {
              id: legacyAssetId,
              item_name: null,
              asset_number: null,
              serial_number: null,
              category_id: null,
              organization_unit: null,
              source_reference: 'เอกสารเก่าปี 2540',
              is_legacy: true,
              created_by: '11111111-1111-4111-8111-111111111111',
              recorded_at: '2026-10-22T12:00:00.000Z',
              updated_at: '2026-10-22T12:00:00.000Z',
            },
            starting_fact: {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              asset_id: legacyAssetId,
              event_type: 'REGISTERED',
              recorded_at: '2026-10-22T12:00:00.000Z',
              actor_id: '11111111-1111-4111-8111-111111111111',
              details: { is_legacy: true },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/assets/${legacyAssetId}`, async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          asset: {
            id: legacyAssetId,
            item_name: null,
            asset_number: null,
            serial_number: null,
            category_id: null,
            organization_unit: null,
            source_reference: 'เอกสารเก่าปี 2540',
            is_legacy: true,
            created_by: '11111111-1111-4111-8111-111111111111',
            recorded_at: '2026-10-22T12:00:00.000Z',
            updated_at: '2026-10-22T12:00:00.000Z',
          },
          history: [],
        }),
      });
    });

    await page.goto(`${targetBaseUrl}/assets/register`);

    // Check legacy checkbox
    await page.locator('input#is_legacy').check();
    await page.locator('textarea#source_reference').fill('เอกสารเก่าปี 2540');

    // Submit without item_name or identifiers
    await Promise.all([
      page.waitForURL(`**/assets/${legacyAssetId}`),
      page.locator('button#submit-register-btn').click(),
    ]);

    // Detail view displays absent values without fabricated 'Unknown'
    await expect(page.locator('h1#asset-detail-heading')).toHaveText('(ไม่ระบุชื่อ - ข้อมูลตกทอดตามจริง)');
    await expect(page.getByText('ข้อมูลตกทอด (Legacy)')).toBeVisible();
    await expect(page.getByText('เอกสารเก่าปี 2540')).toBeVisible();
  });

  test('Journey 4: appropriate read-only and forbidden behavior', async ({ page }) => {
    // 4a: Forbidden on register
    await page.route('**/assets', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'FORBIDDEN',
            message: 'Forbidden: Insufficient capabilities',
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${targetBaseUrl}/assets/register`);
    await page.locator('input#item_name').fill('Unauthorized Attempt');
    await page.locator('button#submit-register-btn').click();

    await expect(page.getByText('ไม่ได้รับอนุญาต (403 Forbidden)')).toBeVisible();

    // 4b: Forbidden on detail view
    const forbiddenId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await page.route(`**/assets/${forbiddenId}`, async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'FORBIDDEN',
          message: 'Forbidden: Insufficient capabilities',
        }),
      });
    });

    await page.goto(`${targetBaseUrl}/assets/${forbiddenId}`);
    await expect(page.getByText('คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)')).toBeVisible();
  });
});
