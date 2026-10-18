import { test, expect, type Cookie } from '@playwright/test';
import { validateBrowserAuthPrerequisites, type BrowserCredentials } from '../../../api/tests/fixtures/identity.ts';

test.describe.serial('Authentication and Session Management E2E', () => {
  let credentials: BrowserCredentials;

  test.beforeAll(async ({ baseURL }) => {
    credentials = validateBrowserAuthPrerequisites({ baseURL });
  });

  test('unauthenticated access redirects to login and server rejects session-check', async ({
    page,
    context,
  }) => {
    // 1. Root path redirects to /login
    await page.goto('/');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 2. Protected dashboard route redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 3. Server session-check endpoint returns 401 Unauthorized via context request API
    const sessionCheckResp = await context.request.get('/auth/session-check');
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

  test('coherent authenticated session lifecycle: login, direct navigation, reload, CSRF participation, logout, and revoked cookie rejection', async ({
    page,
    context,
  }) => {
    // 1. Initial UI navigation to /login
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 2. Authenticate with run-owned credentials and submit
    await page.locator('input#username').fill(credentials.username);
    await page.locator('input#password').fill(credentials.password);

    await Promise.all([
      page.waitForURL('**/dashboard'),
      page.locator('button[type="submit"]').click(),
    ]);

    // 3. UI assertions on protected dashboard
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'ข้อมูลผู้ใช้งาน' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();

    // 4. Server session verification via browser context request API (sharing cookie jar)
    const sessionCheckResp = await context.request.get('/auth/session-check');
    expect(sessionCheckResp.status()).toBe(200);
    const sessionData = await sessionCheckResp.json();
    expect(sessionData.user).toBeDefined();
    expect(sessionData.user.username).toBe(credentials.username);
    expect(typeof sessionData.csrfToken).toBe('string');
    expect(sessionData.csrfToken.length).toBeGreaterThan(0);
    const genuineCsrfToken: string = sessionData.csrfToken;

    // 5. Authenticated direct navigation retains session
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();

    // 6. Browser page reload retains authenticated state
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();

    // 7. Capture active session cookie BEFORE logout for subsequent revocation and replay testing
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!.value.length).toBeGreaterThan(0);
    expect(sessionCookie!.httpOnly).toBe(true);
    const capturedSessionCookie: Cookie = { ...sessionCookie! };

    // 8. Assert CSRF participation and rejection of missing/invalid CSRF while session is active
    // 8a. Missing CSRF token header returns HTTP 403 Forbidden
    const missingCsrfResp = await context.request.post('/auth/logout');
    expect(missingCsrfResp.status()).toBe(403);

    // 8b. Invalid / forged CSRF token returns HTTP 403 Forbidden
    const invalidCsrfResp = await context.request.post('/auth/logout', {
      headers: { 'x-csrf-token': 'invalid_forged_csrf_token_attempt' },
    });
    expect(invalidCsrfResp.status()).toBe(403);

    // 8c. Verify session remains active on server after rejected CSRF attempts
    const stillActiveResp = await context.request.get('/auth/session-check');
    expect(stillActiveResp.status()).toBe(200);

    // 9. Legitimate CSRF logout via UI
    const [logoutResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/auth/logout') && resp.status() === 200
      ),
      page.waitForURL('**/login'),
      page.getByRole('button', { name: 'ออกจากระบบ' }).click(),
    ]);

    expect(logoutResponse.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 10. Verify session cookie was cleared by server in browser context
    const postLogoutCookies = await context.cookies();
    const clearedCookie = postLogoutCookies.find((c) => c.name === 'session');
    expect(!clearedCookie || clearedCookie.value === '').toBe(true);

    // 11. Direct navigation without cookie redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 12. Deliberately re-inject the captured original cookie into the browser context
    await context.addCookies([
      {
        name: capturedSessionCookie.name,
        value: capturedSessionCookie.value,
        domain: capturedSessionCookie.domain,
        path: capturedSessionCookie.path,
        httpOnly: capturedSessionCookie.httpOnly,
        secure: capturedSessionCookie.secure,
        sameSite: capturedSessionCookie.sameSite,
      },
    ]);

    // 13. Direct browser navigation with revoked cookie: Dashboard session-check fails -> redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 14. Server API session-check explicitly denies revoked session with HTTP 401
    const replayedCheckResp = await context.request.get('/auth/session-check');
    expect(replayedCheckResp.status()).toBe(401);

    // 15. Server logout request using revoked cookie is denied with HTTP 401
    const replayedLogoutResp = await context.request.post('/auth/logout', {
      headers: { 'x-csrf-token': genuineCsrfToken },
    });
    expect(replayedLogoutResp.status()).toBe(401);
  });
});
