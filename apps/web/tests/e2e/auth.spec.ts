import { test, expect, type Cookie } from '@playwright/test';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

const APPROVED_E2E_BASE_URLS = [
  'http://web:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];

/**
 * Locates the repository checkout root.
 */
function findRepoRoot(startDir: string = process.cwd()): string {
  let curr = path.resolve(startDir);
  while (curr !== path.dirname(curr)) {
    if (
      fsSync.existsSync(path.join(curr, '.git')) ||
      (fsSync.existsSync(path.join(curr, 'pnpm-workspace.yaml')) &&
        fsSync.existsSync(path.join(curr, 'package.json')))
    ) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(startDir);
}

/**
 * Validates that a file or directory path is strictly outside the repository checkout.
 */
function validateOutsideCheckout(targetPath: string, description: string): void {
  const repoRoot = findRepoRoot();
  const absTarget = path.resolve(targetPath);
  let canonicalRepoRoot: string;
  try {
    canonicalRepoRoot = fsSync.realpathSync(repoRoot);
  } catch {
    canonicalRepoRoot = repoRoot;
  }

  let canonicalTarget: string;
  try {
    const parentDir = path.dirname(absTarget);
    const canonicalParent = fsSync.realpathSync(parentDir);
    canonicalTarget = path.resolve(canonicalParent, path.basename(absTarget));
  } catch {
    canonicalTarget = absTarget;
  }

  if (
    canonicalTarget === repoRoot ||
    canonicalTarget.startsWith(repoRoot + path.sep) ||
    canonicalTarget === canonicalRepoRoot ||
    canonicalTarget.startsWith(canonicalRepoRoot + path.sep)
  ) {
    throw new Error(
      `${description} must reside outside repository checkout (resolved "${canonicalTarget}" is inside "${canonicalRepoRoot}"). Failing closed.`
    );
  }
}

/**
 * Validates browser authentication prerequisites and resolves matching run-owned credentials.
 * Fails closed before authentication if base URL is unapproved, state file is missing/insecure/invalid,
 * or credentials mismatch. Does NOT use hardcoded fallback credentials.
 */
function validateAndResolveBrowserCredentials(baseURL?: string): { username: string; password: string } {
  const effectiveBaseURL = baseURL ?? process.env.E2E_BASE_URL ?? process.env.PLAYWRIGHT_BASE_URL;
  if (!effectiveBaseURL || typeof effectiveBaseURL !== 'string' || effectiveBaseURL.trim().length === 0) {
    throw new Error('Browser base URL is required. Failing closed.');
  }

  const normalizedBaseURL = effectiveBaseURL.replace(/\/+$/, '');
  if (!APPROVED_E2E_BASE_URLS.includes(normalizedBaseURL)) {
    throw new Error(
      `Unapproved browser base URL "${effectiveBaseURL}". Expected one of: ${APPROVED_E2E_BASE_URLS.join(', ')}. Failing closed.`
    );
  }

  const runId = process.env.FOUNDATION_TEST_RUN_ID;

  let stateFile = process.env.FOUNDATION_FIXTURE_STATE_FILE;
  if (!stateFile && process.env.FOUNDATION_ENV_FILE && runId) {
    stateFile = path.join(
      path.dirname(process.env.FOUNDATION_ENV_FILE),
      `fixture-state-${runId}.json`
    );
  }

  if (!stateFile || typeof stateFile !== 'string' || stateFile.trim().length === 0) {
    throw new Error('Fixture state file is required for browser authentication. Failing closed.');
  }

  validateOutsideCheckout(stateFile, 'State file');
  const stateDir = path.dirname(stateFile);
  validateOutsideCheckout(stateDir, 'State directory');

  try {
    const dirStat = fsSync.statSync(stateDir);
    const dirMode = (dirStat.mode & 0o777).toString(8);
    if (dirMode.slice(-2) !== '00') {
      throw new Error(
        `Insecure permissions on state directory "${stateDir}": mode must be 700 (got ${dirMode}). Failing closed.`
      );
    }
  } catch (err: any) {
    if (err.message.includes('Insecure permissions')) throw err;
  }

  if (!fsSync.existsSync(stateFile)) {
    throw new Error(`Fixture state file "${stateFile}" does not exist. Failing closed.`);
  }

  const fileStat = fsSync.statSync(stateFile);
  if (!fileStat.isFile()) {
    throw new Error(`Fixture state file "${stateFile}" is not a regular file. Failing closed.`);
  }

  const fileMode = (fileStat.mode & 0o777).toString(8);
  if (fileMode.slice(-2) !== '00') {
    throw new Error(
      `Insecure permissions on fixture state file "${stateFile}": mode must be 600 or 400 (got ${fileMode}). Failing closed.`
    );
  }

  let state: any;
  try {
    const raw = fsSync.readFileSync(stateFile, 'utf-8');
    state = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupted fixture state file "${stateFile}": JSON parsing failed. Failing closed.`);
  }

  if (typeof state !== 'object' || state === null) {
    throw new Error(`Corrupted fixture state file "${stateFile}": not an object. Failing closed.`);
  }

  if (state.status !== 'active') {
    throw new Error(
      `Fixture state is not active (status: "${state.status}"). Browser execution requires active fixture state. Failing closed.`
    );
  }

  if (runId && state.runId !== runId) {
    throw new Error(
      `State file run ID mismatch: expected "${runId}", got "${state.runId}". Failing closed.`
    );
  }

  const expectedPolicy = process.env.FOUNDATION_TARGET_POLICY;
  if (expectedPolicy && state.targetPolicy !== expectedPolicy) {
    throw new Error(
      `State file target policy mismatch: expected "${expectedPolicy}", got "${state.targetPolicy}". Failing closed.`
    );
  }

  if (state.targetPolicy === 'shared-development') {
    if (state.database !== 's2_assets_dev') {
      throw new Error(
        `State file database mismatch under shared-Development policy: expected "s2_assets_dev", got "${state.database}". Failing closed.`
      );
    }
    if (Array.isArray(state.createdRoleIds) && state.createdRoleIds.length > 0) {
      throw new Error(
        'Inconsistent role ownership: shared-Development policy prohibits creating or tracking roles. Failing closed.'
      );
    }
  }

  if (!state.maintainer || typeof state.maintainer !== 'object') {
    throw new Error('Corrupted fixture state file: missing maintainer descriptor. Failing closed.');
  }

  if (!state.maintainer.username || typeof state.maintainer.username !== 'string') {
    throw new Error('Corrupted fixture state file: missing maintainer username. Failing closed.');
  }

  if (state.maintainer.role !== 'SYSTEM_MAINTAINER') {
    throw new Error('Corrupted fixture state file: maintainer role must be "SYSTEM_MAINTAINER". Failing closed.');
  }

  if (
    !state.maintainer.id ||
    !Array.isArray(state.createdUserIds) ||
    !state.createdUserIds.includes(state.maintainer.id)
  ) {
    throw new Error(
      `Inconsistent ownership: maintainer ID "${state.maintainer.id}" not found in createdUserIds. Failing closed.`
    );
  }

  const expectedUsername =
    process.env.E2E_USERNAME ??
    (process.env.FOUNDATION_TEST_USERNAME
      ? `${process.env.FOUNDATION_TEST_USERNAME}_maintainer`
      : undefined);

  if (expectedUsername && state.maintainer.username !== expectedUsername) {
    throw new Error(
      `Browser username mismatch: expected "${expectedUsername}", got state maintainer "${state.maintainer.username}". Failing closed.`
    );
  }

  const username = state.maintainer.username;

  const rawPassword = process.env.E2E_PASSWORD ?? process.env.FOUNDATION_TEST_PASSWORD;
  if (!rawPassword || typeof rawPassword !== 'string') {
    throw new Error('Test password is required for browser authentication. Failing closed.');
  }

  const trimmedPw = rawPassword.trim();
  if (
    trimmedPw === 'password' ||
    trimmedPw === 'test' ||
    trimmedPw === 'admin' ||
    trimmedPw === 's2_password'
  ) {
    throw new Error('Test password cannot use default or trivial passwords. Failing closed.');
  }

  const nonWsPassword = rawPassword.replace(/\s/g, '');
  if (nonWsPassword.length < 8) {
    throw new Error('Test password must contain at least 8 non-whitespace characters. Failing closed.');
  }

  return { username, password: rawPassword };
}

test.describe.serial('Authentication and Session Management E2E', () => {
  let credentials: { username: string; password: string };

  test.beforeAll(async ({ baseURL }) => {
    credentials = validateAndResolveBrowserCredentials(baseURL);
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
