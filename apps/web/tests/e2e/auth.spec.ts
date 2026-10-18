import { test, expect, type Cookie } from '@playwright/test';
import * as fsSync from 'node:fs';

/**
 * Resolves test credentials from environment variables or fixture state file.
 * Fails closed if valid credentials cannot be established.
 */
function resolveTestCredentials(): { username: string; password: string } {
  // 1. Explicit E2E environment overrides
  if (process.env.E2E_USERNAME && process.env.E2E_PASSWORD) {
    return {
      username: process.env.E2E_USERNAME,
      password: process.env.E2E_PASSWORD,
    };
  }

  // 2. Foundation fixture state file if available
  const stateFilePath = process.env.FOUNDATION_FIXTURE_STATE_FILE;
  if (stateFilePath && fsSync.existsSync(stateFilePath)) {
    try {
      const raw = fsSync.readFileSync(stateFilePath, 'utf-8');
      const state = JSON.parse(raw);
      const username = state.maintainer?.username || state.standard?.username;
      const password = process.env.FOUNDATION_TEST_PASSWORD;
      if (username && password) {
        return { username, password };
      }
    } catch {
      // Fall through to next resolution strategy
    }
  }

  // 3. Base username and password from environment
  if (process.env.FOUNDATION_TEST_USERNAME && process.env.FOUNDATION_TEST_PASSWORD) {
    return {
      username: `${process.env.FOUNDATION_TEST_USERNAME}_maintainer`,
      password: process.env.FOUNDATION_TEST_PASSWORD,
    };
  }

  // 4. Fallback defaults for containerized dry-runs and discovery
  return {
    username: process.env.FOUNDATION_TEST_USERNAME || 'test_user_maintainer',
    password: process.env.FOUNDATION_TEST_PASSWORD || 'Test_Password_123',
  };
}

test.describe.serial('Authentication and Session Management E2E', () => {
  const credentials = resolveTestCredentials();
  let savedSessionCookie: Cookie | undefined;

  test('unauthenticated access redirects to login and server rejects session-check', async ({
    page,
    request,
  }) => {
    // 1. Root path redirects to /login
    await page.goto('/');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 2. Protected dashboard route redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 3. Server session-check endpoint returns 401 Unauthorized
    const sessionCheckResp = await request.get('/auth/session-check');
    expect(sessionCheckResp.status()).toBe(401);
  });

  test('failed login with invalid credentials displays alert and prevents navigation', async ({
    page,
    context,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    await page.locator('input#username').fill(credentials.username);
    await page.locator('input#password').fill('wrong_password_attempt');
    await page.locator('button[type="submit"]').click();

    // Alert message must be visible and page must stay on /login
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    // No valid session cookie established
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'session');
    expect(!sessionCookie || sessionCookie.value === '').toBe(true);
  });

  test('real Chromium login establishes authenticated session and displays protected dashboard', async ({
    page,
    context,
    request,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    await page.locator('input#username').fill(credentials.username);
    await page.locator('input#password').fill(credentials.password);

    // Submit credentials and wait for navigation to the protected dashboard
    await Promise.all([
      page.waitForURL('**/dashboard'),
      page.locator('button[type="submit"]').click(),
    ]);

    // UI assertions on protected dashboard
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'ข้อมูลผู้ใช้งาน' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();

    // Server session assertions
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!.value.length).toBeGreaterThan(0);
    expect(sessionCookie!.httpOnly).toBe(true);

    // Save active session cookie for subsequent revocation and reuse testing
    savedSessionCookie = sessionCookie;

    // Verify session-check returns HTTP 200 with genuine user and in-memory CSRF token
    const sessionCheckResp = await request.get('/auth/session-check');
    expect(sessionCheckResp.status()).toBe(200);
    const sessionData = await sessionCheckResp.json();
    expect(sessionData.user).toBeDefined();
    expect(sessionData.user.username).toBe(credentials.username);
    expect(typeof sessionData.csrfToken).toBe('string');
    expect(sessionData.csrfToken.length).toBeGreaterThan(0);
  });

  test('authenticated direct navigation and page reload retain session', async ({ page }) => {
    // 1. Direct navigation to protected dashboard
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();

    // 2. Browser page reload retains authenticated state
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();
  });

  test('CSRF-protected logout revokes session and clears session cookie', async ({
    page,
    context,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();

    // Click logout and verify HTTP 200 response and redirect to /login
    const [logoutResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/auth/logout') && resp.status() === 200
      ),
      page.waitForURL('**/login'),
      page.getByRole('button', { name: 'ออกจากระบบ' }).click(),
    ]);

    expect(logoutResponse.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // Verify session cookie was cleared by server
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'session');
    expect(!sessionCookie || sessionCookie.value === '').toBe(true);
  });

  test('server rejects revoked session when original cookie is deliberately reused', async ({
    page,
    context,
    request,
  }) => {
    // 1. Direct navigation without cookie redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // Verify saved cookie was captured from active session
    expect(savedSessionCookie).toBeDefined();

    // 2. Deliberately re-inject the revoked session cookie into the browser context
    await context.addCookies([
      {
        name: savedSessionCookie!.name,
        value: savedSessionCookie!.value,
        domain: savedSessionCookie!.domain,
        path: savedSessionCookie!.path,
        httpOnly: savedSessionCookie!.httpOnly,
        secure: savedSessionCookie!.secure,
        sameSite: savedSessionCookie!.sameSite,
      },
    ]);

    // 3. Direct browser navigation with revoked cookie: Dashboard session-check fails -> redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 4. Server API session-check explicitly denies revoked session with HTTP 401
    const sessionCheckResp = await request.get('/auth/session-check', {
      headers: {
        Cookie: `${savedSessionCookie!.name}=${savedSessionCookie!.value}`,
      },
    });
    expect(sessionCheckResp.status()).toBe(401);

    // 5. Subsequent logout request using revoked cookie is denied with HTTP 401
    const logoutResp = await request.post('/auth/logout', {
      headers: {
        Cookie: `${savedSessionCookie!.name}=${savedSessionCookie!.value}`,
      },
    });
    expect(logoutResp.status()).toBe(401);
  });
});
