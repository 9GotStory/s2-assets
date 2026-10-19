/// <reference types="node" />
import { test, expect, type Cookie } from '@playwright/test';

interface BrowserCredentials {
  readonly username: string;
  readonly password: string;
}

interface ValidatePrerequisitesOptions {
  readonly baseURL?: string;
}

/**
 * Validates target endpoint and explicit private credentials before any browser
 * or network operations are attempted. Fails closed on missing or unapproved prerequisites.
 * Rejects embedded userinfo, query strings, fragments, and non-root paths.
 * Does NOT log or leak sensitive credentials, tokens, or cookies.
 */
function validateBrowserAuthPrerequisites(options?: ValidatePrerequisitesOptions): BrowserCredentials {
  const targetUrlString = options?.baseURL || process.env.E2E_BASE_URL;

  if (!targetUrlString || targetUrlString.trim().length === 0) {
    throw new Error(
      'E2E prerequisite check failed: Target base URL must be explicitly configured via baseURL or E2E_BASE_URL.'
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrlString);
  } catch {
    throw new Error('E2E prerequisite check failed: Target base URL is not a valid URL.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('E2E prerequisite check failed: Target base URL protocol must be http or https.');
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(
      'E2E prerequisite check failed: Target base URL must not contain embedded user credentials.'
    );
  }

  const approvedHosts = new Set(['localhost', '127.0.0.1', 'web']);
  if (!approvedHosts.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error(
      'E2E prerequisite check failed: Target host is not an approved isolated development endpoint.'
    );
  }

  if (parsedUrl.port !== '5173') {
    throw new Error(
      'E2E prerequisite check failed: Target port must be approved web development port 5173.'
    );
  }

  if (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') {
    throw new Error(
      'E2E prerequisite check failed: Target base URL must not contain a non-root path.'
    );
  }

  if (parsedUrl.search && parsedUrl.search.length > 0) {
    throw new Error(
      'E2E prerequisite check failed: Target base URL must not contain query parameters.'
    );
  }

  if (parsedUrl.hash && parsedUrl.hash.length > 0) {
    throw new Error(
      'E2E prerequisite check failed: Target base URL must not contain a URL fragment.'
    );
  }

  const username = process.env.E2E_USERNAME?.trim();
  const password = process.env.E2E_PASSWORD;

  if (!username || username.length === 0) {
    throw new Error(
      'E2E prerequisite check failed: E2E_USERNAME must be explicitly provided in environment.'
    );
  }

  if (!password || password.length === 0) {
    throw new Error(
      'E2E prerequisite check failed: E2E_PASSWORD must be explicitly provided in environment.'
    );
  }

  if (password.length < 8) {
    throw new Error(
      'E2E prerequisite check failed: E2E_PASSWORD must meet minimum complexity requirements (at least 8 characters).'
    );
  }

  return { username, password };
}

/**
 * Executes a sensitive browser or network operation and sanitizes any thrown error.
 * Prevents raw Playwright call logs, passwords, tokens, or cookies from reaching reporters.
 * Throws a clean generic error without original error message, cause, or parameters.
 */
async function safeAction<T>(action: () => Promise<T>, sanitizedMessage: string): Promise<T> {
  try {
    return await action();
  } catch {
    throw new Error(sanitizedMessage);
  }
}

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

    // Derive an incorrect password guaranteed to differ from valid password
    const invalidPassword = `${credentials.password}_invalid_mismatch`;
    expect(invalidPassword).not.toBe(credentials.password);

    await page.locator('input#username').fill(credentials.username);
    await safeAction(
      () => page.locator('input#password').fill(invalidPassword),
      'Failed to fill invalid password in login form'
    );

    const [loginResponse] = await safeAction(
      () =>
        Promise.all([
          page.waitForResponse((resp) => resp.url().includes('/auth/login')),
          page.locator('button[type="submit"]').click(),
        ]),
      'Failed to submit invalid login credentials'
    );

    // Explicitly assert the login endpoint rejected credentials with HTTP 401
    expect(loginResponse.status()).toBe(401);

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

    // 2. Authenticate with run-owned credentials and submit (wrapped in safeAction)
    await page.locator('input#username').fill(credentials.username);
    await safeAction(
      () => page.locator('input#password').fill(credentials.password),
      'Failed to fill password in login form'
    );

    await safeAction(
      () =>
        Promise.all([
          page.waitForURL('**/dashboard'),
          page.locator('button[type="submit"]').click(),
        ]),
      'Failed to submit login credentials or navigate to dashboard'
    );

    // 3. UI assertions on protected dashboard
    await expect(page.getByRole('heading', { level: 1, name: 'แดชบอร์ด' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'ข้อมูลผู้ใช้งาน' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: credentials.username })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();

    // 4. Server session verification via browser context request API (sharing cookie jar)
    const sessionCheckResp = await safeAction(
      () => context.request.get('/auth/session-check'),
      'Failed to verify session check on server'
    );
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
    const missingCsrfResp = await safeAction(
      () => context.request.post('/auth/logout'),
      'Failed to execute logout request without CSRF token'
    );
    expect(missingCsrfResp.status()).toBe(403);

    // 8b. Invalid / forged CSRF token returns HTTP 403 Forbidden
    const invalidCsrfResp = await safeAction(
      () =>
        context.request.post('/auth/logout', {
          headers: { 'x-csrf-token': 'invalid_forged_csrf_token_attempt' },
        }),
      'Failed to execute logout request with invalid CSRF token'
    );
    expect(invalidCsrfResp.status()).toBe(403);

    // 8c. Verify session remains active on server after rejected CSRF attempts
    const stillActiveResp = await safeAction(
      () => context.request.get('/auth/session-check'),
      'Failed to verify session persistence after CSRF denial'
    );
    expect(stillActiveResp.status()).toBe(200);

    // 9. Legitimate CSRF logout via UI
    const [logoutResponse] = await safeAction(
      () =>
        Promise.all([
          page.waitForResponse(
            (resp) => resp.url().includes('/auth/logout') && resp.status() === 200
          ),
          page.waitForURL('**/login'),
          page.getByRole('button', { name: 'ออกจากระบบ' }).click(),
        ]),
      'Failed to perform UI logout'
    );

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
    await safeAction(
      () =>
        context.addCookies([
          {
            name: capturedSessionCookie.name,
            value: capturedSessionCookie.value,
            domain: capturedSessionCookie.domain,
            path: capturedSessionCookie.path,
            httpOnly: capturedSessionCookie.httpOnly,
            secure: capturedSessionCookie.secure,
            sameSite: capturedSessionCookie.sameSite,
          },
        ]),
      'Failed to re-inject session cookie for replay validation'
    );

    // 13. Direct browser navigation with revoked cookie: Dashboard session-check fails -> redirects to /login
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();

    // 14. Server API session-check explicitly denies revoked session with HTTP 401
    const replayedCheckResp = await safeAction(
      () => context.request.get('/auth/session-check'),
      'Failed to execute session check with replayed cookie'
    );
    expect(replayedCheckResp.status()).toBe(401);

    // 15. Server logout request using revoked cookie is denied with HTTP 401
    const replayedLogoutResp = await safeAction(
      () =>
        context.request.post('/auth/logout', {
          headers: { 'x-csrf-token': genuineCsrfToken },
        }),
      'Failed to execute logout request with replayed cookie'
    );
    expect(replayedLogoutResp.status()).toBe(401);
  });
});

export {
  validateBrowserAuthPrerequisites,
  safeAction,
  type BrowserCredentials,
  type ValidatePrerequisitesOptions,
};
