import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  validateOutsideCheckout,
  validateTargetDatabase,
  readAndValidateStateFile,
  TestIdentityState,
} from '../fixtures/identity.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, '../../src/server.ts');

// 1. Enforce supported FOUNDATION_SMOKE_PHASE (R6)
const rawPhase = process.env.FOUNDATION_SMOKE_PHASE || 'pre-outage';
const VALID_PHASES = ['pre-outage', 'outage', 'recovery', 'all'] as const;
type SmokePhase = (typeof VALID_PHASES)[number];

if (!VALID_PHASES.includes(rawPhase as SmokePhase)) {
  throw new Error(
    `Unsupported FOUNDATION_SMOKE_PHASE: "${rawPhase}". Allowed phases: ${VALID_PHASES.join(', ')}. Failing closed.`
  );
}
const phase: SmokePhase = rawPhase as SmokePhase;
const isPreOutage = phase === 'pre-outage' || phase === 'all';
const isOutage = phase === 'outage';
const isRecovery = phase === 'recovery';

const HTTP_API_URL = (process.env.HTTP_API_URL || 'http://api:3000').replace(/\/+$/, '');
const HTTP_WEB_URL = (process.env.HTTP_WEB_URL || 'http://web:5173').replace(/\/+$/, '');
const SESSION_COOKIE_NAME = 'session';

// 2. Validate and load configuration with fail-closed semantics (R3)
const configFile = process.env.FOUNDATION_FIXTURE_CONFIG_FILE;
if (!configFile) {
  throw new Error('FOUNDATION_FIXTURE_CONFIG_FILE is required. Failing closed.');
}
validateOutsideCheckout(configFile, 'Runner config file');
if (!fsSync.existsSync(configFile)) {
  throw new Error(`Runner config file not found: "${configFile}". Failing closed.`);
}

let runnerConfig: Record<string, string>;
try {
  runnerConfig = JSON.parse(fsSync.readFileSync(configFile, 'utf-8'));
} catch {
  throw new Error(`Corrupted runner config file "${configFile}": failed to parse JSON configuration. Failing closed.`);
}
for (const [k, v] of Object.entries(runnerConfig)) {
  if (typeof v === 'string' && v.length > 0 && !process.env[k]) {
    process.env[k] = v;
  }
}

const expectedRunId = process.env.FOUNDATION_TEST_RUN_ID;
if (!expectedRunId || !/^[a-zA-Z0-9_-]+$/.test(expectedRunId)) {
  throw new Error(`Valid FOUNDATION_TEST_RUN_ID is required: got "${expectedRunId}". Failing closed.`);
}

const stateFilePath = process.env.FOUNDATION_FIXTURE_STATE_FILE;
if (!stateFilePath) {
  throw new Error('FOUNDATION_FIXTURE_STATE_FILE is required. Failing closed.');
}
validateOutsideCheckout(stateFilePath, 'Fixture state file');
if (!fsSync.existsSync(stateFilePath)) {
  throw new Error(`Fixture state file not found: "${stateFilePath}". Failing closed.`);
}

const expectedDb = process.env.POSTGRES_DB;
if (!expectedDb || !/^s2_foundation_[a-zA-Z0-9_]+$/.test(expectedDb)) {
  throw new Error(`Valid POSTGRES_DB starting with "s2_foundation_" is required: got "${expectedDb}". Failing closed.`);
}

const databaseUrl = process.env.FOUNDATION_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('FOUNDATION_TEST_DATABASE_URL is required. Failing closed.');
}

// Target database validation using accepted fixture safeguards (R3)
const targetDb = validateTargetDatabase(databaseUrl, expectedDb);

// Read and validate state file under accepted safeguards
const expectedBaseUsername = process.env.FOUNDATION_TEST_USERNAME;
const fixtureState: TestIdentityState = await readAndValidateStateFile(
  stateFilePath,
  expectedRunId,
  expectedDb,
  targetDb.targetEndpoint,
  expectedBaseUsername
);

const testPassword = process.env.FOUNDATION_TEST_PASSWORD;
if (!testPassword) {
  throw new Error('FOUNDATION_TEST_PASSWORD is required. Failing closed.');
}

const maintainerUsername = fixtureState.maintainer.username;
const standardUsername = fixtureState.standard.username;

const sessionFilePath = process.env.FOUNDATION_SMOKE_SESSION_FILE;
if (!sessionFilePath) {
  throw new Error('FOUNDATION_SMOKE_SESSION_FILE is required. Failing closed.');
}
validateOutsideCheckout(sessionFilePath, 'Smoke session file');

/**
 * Lightweight cookie jar for tracking session and CSRF cookies across HTTP requests.
 */
class CookieJar {
  private cookies = new Map<string, string>();

  updateFromHeaders(headers: Headers): void {
    const rawSetCookies: string[] = [];
    if (typeof (headers as any).getSetCookie === 'function') {
      rawSetCookies.push(...(headers as any).getSetCookie());
    } else {
      const single = headers.get('set-cookie');
      if (single) rawSetCookies.push(single);
    }

    for (const cookieStr of rawSetCookies) {
      const parts = cookieStr.split(';')[0]?.trim();
      if (!parts) continue;
      const eqIdx = parts.indexOf('=');
      if (eqIdx === -1) continue;
      const name = parts.slice(0, eqIdx).trim();
      const val = parts.slice(eqIdx + 1).trim();

      const isExpired =
        cookieStr.toLowerCase().includes('max-age=0') ||
        cookieStr.toLowerCase().includes('expires=thu, 01 jan 1970');

      if (isExpired || !val) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, val);
      }
    }
  }

  getCookieHeader(): string {
    const pairs: string[] = [];
    for (const [name, val] of this.cookies.entries()) {
      pairs.push(`${name}=${val}`);
    }
    return pairs.join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  clear(): void {
    this.cookies.clear();
  }

  clone(): CookieJar {
    const cloned = new CookieJar();
    for (const [k, v] of this.cookies.entries()) {
      cloned.set(k, v);
    }
    return cloned;
  }
}

async function requestJson(
  url: string,
  options: RequestInit = {},
  jar?: CookieJar
): Promise<{ response: Response; body: any }> {
  const headers = new Headers(options.headers || {});
  if (jar) {
    const cookieHeader = jar.getCookieHeader();
    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (jar) {
    jar.updateFromHeaders(response.headers);
  }

  let body: any = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } else {
    try {
      body = await response.text();
    } catch {
      body = null;
    }
  }

  return { response, body };
}

/**
 * Mutates maintainer role grant strictly bounded to the proven test-owned fixture user
 * on the exact isolated database, enforcing safeguards before any SQL execution (R3).
 */
async function mutateMaintainerRole(
  action: 'revoke' | 'restore',
  overrides?: {
    runId?: string;
    database?: string;
    userId?: string;
  }
): Promise<void> {
  const effectiveRunId = overrides?.runId ?? fixtureState.runId;
  const effectiveDatabase = overrides?.database ?? fixtureState.database;
  const effectiveUserId = overrides?.userId ?? fixtureState.maintainer.id;

  if (effectiveRunId !== expectedRunId) {
    throw new Error(
      `Ownership check failed: runId mismatch (expected "${expectedRunId}", got "${effectiveRunId}"). Failing closed.`
    );
  }
  if (effectiveDatabase !== expectedDb || effectiveDatabase !== fixtureState.database) {
    throw new Error(
      `Ownership check failed: database mismatch (expected "${expectedDb}", got "${effectiveDatabase}"). Failing closed.`
    );
  }
  if (effectiveUserId !== fixtureState.maintainer.id) {
    throw new Error(`Ownership check failed: user ID mismatch. Failing closed.`);
  }
  if (!fixtureState.createdUserIds.includes(effectiveUserId)) {
    throw new Error(
      `Ownership check failed: user ID "${effectiveUserId}" is not in owned createdUserIds. Failing closed.`
    );
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await client.connect();
  try {
    // 1. Verify connected database matches expected database
    const dbRes = await client.query('SELECT current_database() as db');
    const currentDb = dbRes.rows[0]?.db;
    if (currentDb !== expectedDb) {
      throw new Error(`Active database mismatch: connected to "${currentDb}", expected "${expectedDb}". Failing closed.`);
    }

    // 2. Verify maintainer user identity in database
    const userRes = await client.query('SELECT id, username FROM users WHERE id = $1', [effectiveUserId]);
    if (userRes.rows.length !== 1 || userRes.rows[0].username !== fixtureState.maintainer.username) {
      throw new Error(`Maintainer user identity mismatch in database. Failing closed.`);
    }

    // 3. Mutate only the specific grant for the validated maintainer user
    if (action === 'revoke') {
      await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [
        effectiveUserId,
        'SYSTEM_MAINTAINER',
      ]);
    } else {
      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [effectiveUserId, 'SYSTEM_MAINTAINER']
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

describe('Real Listening Stack HTTP Smoke (T045)', () => {
  // =========================================================================
  // Phase 1: Pre-outage baseline checks (A1, A2, B1, B2, B3, C1, C2)
  // =========================================================================
  describe.runIf(isPreOutage)('Case A1 — Startup & Configuration Boundary', () => {
    it('aborts actual non-watching API entrypoint on missing required configuration without opening an operational listener', async () => {
      const isolatedPort = '3999';
      const child = spawn(process.execPath, [serverPath], {
        env: {
          ...process.env,
          PORT: isolatedPort,
          DATABASE_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });

      // 1. Nonzero exit code proves startup failure
      expect(exitCode).not.toBe(0);

      // 2. Safe error message present without sensitive leakage or stack trace
      expect(stderr).toMatch(/Fatal startup error:/i);
      if (testPassword) {
        expect(stderr).not.toContain(testPassword);
        expect(stdout).not.toContain(testPassword);
      }
      expect(stderr).not.toMatch(/stack|SELECT|pg_/i);

      // 3. Attempted HTTP request proves no operational listener was established
      let listenerFailed = false;
      try {
        await fetch(`http://127.0.0.1:${isolatedPort}/health`);
      } catch (err: any) {
        listenerFailed = true;
        expect(['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'TypeError', 'FetchError']).toContain(
          err.code || err.cause?.code || err.name
        );
      }
      expect(listenerFailed).toBe(true);

      // 4. Proves the existing operational stack remains running and untouched
      const workingCheck = await fetch(`${HTTP_API_URL}/health`);
      expect(workingCheck.status).toBe(200);
    });
  });

  describe.runIf(isPreOutage)('Case A2 — Public Probes & Standard Error Envelopes', () => {
    it('GET /health returns 200 and exactly {"status":"ok"}', async () => {
      const { response, body } = await requestJson(`${HTTP_API_URL}/health`);
      expect(response.status).toBe(200);
      expect(body).toEqual({ status: 'ok' });
    });

    it('GET /ready returns 200 and exactly {"status":"ok"} when database is connected', async () => {
      const { response, body } = await requestJson(`${HTTP_API_URL}/ready`);
      expect(response.status).toBe(200);
      expect(body).toEqual({ status: 'ok' });
    });

    it('public endpoints return safe error envelope without stack traces or internal secrets', async () => {
      const { response, body } = await requestJson(`${HTTP_API_URL}/not-found-smoke-test-endpoint`);
      expect(response.status).toBe(404);
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Requested resource not found');
      expect(body.error.request_id).toBeDefined();
      expect(typeof body.error.request_id).toBe('string');
      // No stack trace or internal SQL
      expect(JSON.stringify(body)).not.toMatch(/stack|SELECT|INSERT|UPDATE|DELETE/i);
    });
  });

  describe.runIf(isPreOutage)('Case B1 — Denial & Authorization Enforcement', () => {
    afterAll(async () => {
      // Ensure maintainer grant is restored if left revoked
      await mutateMaintainerRole('restore');
    });

    it('GET /auth/session-check and GET /system/info return 401 without a session', async () => {
      const sc = await requestJson(`${HTTP_API_URL}/auth/session-check`);
      expect(sc.response.status).toBe(401);
      expect(sc.body.error.code).toBe('UNAUTHORIZED');

      const sys = await requestJson(`${HTTP_API_URL}/system/info`);
      expect(sys.response.status).toBe(401);
      expect(sys.body.error.code).toBe('UNAUTHORIZED');
    });

    it('authenticated non-capable identity receives 403 on /system/info', async () => {
      const jar = new CookieJar();
      const loginRes = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: standardUsername, password: testPassword }),
        },
        jar
      );
      expect(loginRes.response.status).toBe(200);

      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(sys.response.status).toBe(403);
      expect(sys.body.error.code).toBe('FORBIDDEN');
    });

    it('authenticated maintainer receives 200 on /system/info', async () => {
      const jar = new CookieJar();
      const loginRes = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );
      expect(loginRes.response.status).toBe(200);

      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(sys.response.status).toBe(200);
      expect(sys.body).toEqual({ status: 'ok' });
    });

    it('immediate capability revocation: revoking role returns 403 on next request with same session; restoring grant returns 200', async () => {
      const jar = new CookieJar();
      const loginRes = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );
      expect(loginRes.response.status).toBe(200);

      // Verify initial access succeeds
      const initSys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(initSys.response.status).toBe(200);

      // Revoke only this fixture user's grant with verified ownership
      await mutateMaintainerRole('revoke');

      // The next request with the exact same session must return 403 immediately
      const revokedSys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(revokedSys.response.status).toBe(403);
      expect(revokedSys.body.error.code).toBe('FORBIDDEN');

      // Restore the grant
      await mutateMaintainerRole('restore');

      // The subsequent request with the same session returns 200 immediately
      const restoredSys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(restoredSys.response.status).toBe(200);
      expect(restoredSys.body).toEqual({ status: 'ok' });
    });

    it('negative ownership verification: rejects grant mutation on mismatched run, database, or user ID (R3)', async () => {
      // 1. Mismatched run ID rejects before any mutation
      await expect(
        mutateMaintainerRole('revoke', { runId: 'mismatched_run_id' })
      ).rejects.toThrow(/Ownership check failed: runId mismatch/);

      // 2. Mismatched database rejects before any mutation
      await expect(
        mutateMaintainerRole('revoke', { database: 's2_foundation_other' })
      ).rejects.toThrow(/Ownership check failed: database mismatch/);

      // 3. Mismatched user ID rejects before any mutation
      await expect(
        mutateMaintainerRole('revoke', { userId: 'usr_unauthorized_attacker' })
      ).rejects.toThrow(/Ownership check failed: user ID mismatch/);

      // 4. Verify unrelated rows/roles remain untouched (maintainer still has SYSTEM_MAINTAINER)
      const jar = new CookieJar();
      const loginRes = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );
      expect(loginRes.response.status).toBe(200);
      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(sys.response.status).toBe(200);
    });
  });

  describe.runIf(isPreOutage)('Case B2 — Session Lifecycle & CSRF Material', () => {
    it('POST /auth/login with valid credentials returns 200 and genuine session cookie; invalid returns 401', async () => {
      // 1. Valid credentials
      const validJar = new CookieJar();
      const validRes = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        validJar
      );
      // R1 fix: validRes.response.status
      expect(validRes.response.status).toBe(200);
      expect(validRes.body.user).toBeDefined();
      expect(validRes.body.user.username).toBe(maintainerUsername);
      const sessionCookie = validJar.get(SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie!.length).toBeGreaterThan(10);

      // 2. Invalid credentials
      const invalidJar = new CookieJar();
      const invalidRes = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: 'WrongPassword123!' }),
        },
        invalidJar
      );
      expect(invalidRes.response.status).toBe(401);
      expect(invalidRes.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(invalidJar.get(SESSION_COOKIE_NAME)).toBeUndefined();
    });

    it('authenticated GET /auth/session-check returns 200 and genuine CSRF material; unauthenticated returns 401', async () => {
      // Unauthenticated check returns 401
      const unauth = await requestJson(`${HTTP_API_URL}/auth/session-check`);
      expect(unauth.response.status).toBe(401);
      expect(unauth.body.error.code).toBe('UNAUTHORIZED');

      // Authenticated login
      const jar = new CookieJar();
      await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );

      // Authenticated session check
      const check = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, jar);
      expect(check.response.status).toBe(200);
      expect(check.body.user).toBeDefined();
      expect(check.body.user.username).toBe(maintainerUsername);
      expect(check.body.csrfToken).toBeDefined();
      expect(typeof check.body.csrfToken).toBe('string');
      expect(check.body.csrfToken.length).toBeGreaterThan(10);

      // Verify protected access works with this session before outage
      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(sys.response.status).toBe(200);

      // Carry genuine authenticated session privately across phases (R4)
      const sessionCookie = jar.get(SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      const sessionData = {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        csrfToken: check.body.csrfToken,
        username: maintainerUsername,
      };
      fsSync.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
    });
  });

  describe.runIf(isPreOutage)('Case B3 — CSRF Enforcement, Logout & Session Replay Denial', () => {
    it('POST /auth/logout rejects missing or invalid CSRF with 403; valid token succeeds and replay is rejected', async () => {
      // 1. Establish session
      const jar = new CookieJar();
      await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );

      // Obtain CSRF token through session-check only
      const sessionCheck = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, jar);
      expect(sessionCheck.response.status).toBe(200);
      const genuineCsrf = sessionCheck.body.csrfToken;
      expect(genuineCsrf).toBeDefined();

      // 2. Reject logout with missing CSRF token (403)
      const missingCsrf = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
        },
        jar
      );
      expect(missingCsrf.response.status).toBe(403);
      expect(missingCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // 3. Reject logout with invalid CSRF token (403)
      const invalidCsrf = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': 'invalid_forged_csrf_token_value' },
        },
        jar
      );
      expect(invalidCsrf.response.status).toBe(403);
      expect(invalidCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // Save genuine pre-logout session cookie string for replay denial verification (R2)
      const loggedOutCookie = jar.get(SESSION_COOKIE_NAME);
      expect(loggedOutCookie).toBeDefined();
      const loggedOutCookieHeader = `${SESSION_COOKIE_NAME}=${loggedOutCookie}`;

      // 4. Valid CSRF token and cookie succeeds with 200
      const validLogout = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': genuineCsrf },
        },
        jar
      );
      expect(validLogout.response.status).toBe(200);
      expect(validLogout.body).toEqual({ success: true });

      // 5. Replaying the genuine pre-logout session cookie is rejected on session-check and protected access
      const replayCheck = await requestJson(`${HTTP_API_URL}/auth/session-check`, {
        headers: { Cookie: loggedOutCookieHeader },
      });
      expect(replayCheck.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(replayCheck.body.error.code);

      const replaySys = await requestJson(`${HTTP_API_URL}/system/info`, {
        headers: { Cookie: loggedOutCookieHeader },
      });
      expect(replaySys.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(replaySys.body.error.code);

      // Also confirm unauthenticated request without cookies is rejected
      const noCookieCheck = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, jar);
      expect(noCookieCheck.response.status).toBe(401);
    });
  });

  describe.runIf(isPreOutage)('Case C1 — SPA Direct Navigation & Static Asset Serving', () => {
    it('direct GET /login and /dashboard return 200 and real HTML entrypoint across repeated requests', async () => {
      const routes = ['/login', '/dashboard'];
      for (const route of routes) {
        for (let i = 1; i <= 2; i++) {
          const res = await fetch(`${HTTP_WEB_URL}${route}`);
          expect(res.status).toBe(200);
          const html = await res.text();
          expect(html).toContain('<!doctype html>');
          expect(html).toContain('/src/main.tsx');
        }
      }
    });

    it('direct GET / returns 200 and legitimate HTML entrypoint', async () => {
      const res = await fetch(`${HTTP_WEB_URL}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('<div id="root">');
    });
  });

  describe.runIf(isPreOutage)('Case C2 — Reverse Proxy Forwarding & Continuity through Web', () => {
    it('exercises full auth and system lifecycle through http://web:5173 proxy', async () => {
      const webJar = new CookieJar();

      // 1. Login through Web proxy
      const loginRes = await requestJson(
        `${HTTP_WEB_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        webJar
      );
      expect(loginRes.response.status).toBe(200);
      expect(loginRes.body.user.username).toBe(maintainerUsername);
      expect(webJar.get(SESSION_COOKIE_NAME)).toBeDefined();

      // 2. Session check through Web proxy
      const checkRes = await requestJson(`${HTTP_WEB_URL}/auth/session-check`, {}, webJar);
      expect(checkRes.response.status).toBe(200);
      expect(checkRes.body.user.username).toBe(maintainerUsername);
      const csrfToken = checkRes.body.csrfToken;
      expect(csrfToken).toBeDefined();

      // 3. Protected /system/info through Web proxy
      const sysRes = await requestJson(`${HTTP_WEB_URL}/system/info`, {}, webJar);
      expect(sysRes.response.status).toBe(200);
      expect(sysRes.body).toEqual({ status: 'ok' });

      // 4. CSRF rejection through Web proxy
      const rejectLogout = await requestJson(
        `${HTTP_WEB_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': 'tampered-csrf-token' },
        },
        webJar
      );
      expect(rejectLogout.response.status).toBe(403);
      expect(rejectLogout.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // Save genuine pre-logout session cookie string for replay denial verification (R2)
      const loggedOutWebCookie = webJar.get(SESSION_COOKIE_NAME);
      expect(loggedOutWebCookie).toBeDefined();
      const loggedOutWebCookieHeader = `${SESSION_COOKIE_NAME}=${loggedOutWebCookie}`;

      // 5. Valid logout through Web proxy
      const validLogout = await requestJson(
        `${HTTP_WEB_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': csrfToken },
        },
        webJar
      );
      expect(validLogout.response.status).toBe(200);
      expect(validLogout.body).toEqual({ success: true });

      // 6. Session replay rejection through Web proxy with genuine logged-out cookie
      const replayCheck = await requestJson(`${HTTP_WEB_URL}/auth/session-check`, {
        headers: { Cookie: loggedOutWebCookieHeader },
      });
      expect(replayCheck.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(replayCheck.body.error.code);

      const replaySys = await requestJson(`${HTTP_WEB_URL}/system/info`, {
        headers: { Cookie: loggedOutWebCookieHeader },
      });
      expect(replaySys.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(replaySys.body.error.code);

      // Also confirm unauthenticated request without cookies through Web proxy is rejected
      const noCookieCheck = await requestJson(`${HTTP_WEB_URL}/auth/session-check`, {}, webJar);
      expect(noCookieCheck.response.status).toBe(401);
    });
  });

  // =========================================================================
  // Phase 2: Database Outage Assertions (Case D1)
  // =========================================================================
  describe.runIf(isOutage)('Case D1 — PostgreSQL Outage Behavior', () => {
    it('GET /health remains 200 while GET /ready degrades to 503 during database outage', async () => {
      // 1. Real GET /health remains 200
      const health = await requestJson(`${HTTP_API_URL}/health`);
      expect(health.response.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });

      // 2. Real GET /ready returns 503 with accepted error envelope
      const ready = await requestJson(`${HTTP_API_URL}/ready`);
      expect(ready.response.status).toBe(503);
      expect(ready.body).toHaveProperty('error');
      expect(ready.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('database-dependent login and authenticated requests fail safely with non-success statuses and safe envelopes (R4)', async () => {
      if (!fsSync.existsSync(sessionFilePath)) {
        throw new Error(`Smoke session file not found at "${sessionFilePath}". Failing closed.`);
      }
      const sessionData = JSON.parse(fsSync.readFileSync(sessionFilePath, 'utf-8'));
      expect(sessionData.cookie).toBeDefined();

      // 1. POST /auth/login fails safely
      const login = await requestJson(`${HTTP_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
      });
      expect([500, 503]).toContain(login.response.status);
      expect(login.body).toHaveProperty('error');
      expect(['DATABASE_ERROR', 'SERVICE_UNAVAILABLE']).toContain(login.body.error.code);
      expect(JSON.stringify(login.body)).not.toMatch(/stack|SELECT|pg_|password/i);

      // 2. GET /auth/session-check with GENUINE authenticated pre-outage session fails safely
      const check = await requestJson(`${HTTP_API_URL}/auth/session-check`, {
        headers: { Cookie: sessionData.cookie },
      });
      expect([500, 503]).toContain(check.response.status);
      expect(check.body).toHaveProperty('error');
      expect(['DATABASE_ERROR', 'SERVICE_UNAVAILABLE']).toContain(check.body.error.code);
      expect(JSON.stringify(check.body)).not.toMatch(/stack|SELECT|pg_/i);

      // 3. GET /system/info with GENUINE authenticated pre-outage session fails safely
      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {
        headers: { Cookie: sessionData.cookie },
      });
      expect([500, 503]).toContain(sys.response.status);
      expect(sys.body).toHaveProperty('error');
      expect(['DATABASE_ERROR', 'SERVICE_UNAVAILABLE']).toContain(sys.body.error.code);
      expect(JSON.stringify(sys.body)).not.toMatch(/stack|SELECT|pg_/i);
    });
  });

  // =========================================================================
  // Phase 3: Database Recovery Assertions (Case D2)
  // =========================================================================
  describe.runIf(isRecovery)('Case D2 — PostgreSQL Recovery & HTTP Operation Restoration', () => {
    it('observes /ready recovery to 200 and proves full authenticated HTTP operation recovers (R4)', async () => {
      if (!fsSync.existsSync(sessionFilePath)) {
        throw new Error(`Smoke session file not found at "${sessionFilePath}". Failing closed.`);
      }
      const sessionData = JSON.parse(fsSync.readFileSync(sessionFilePath, 'utf-8'));

      // 1. Bounded wait for /ready to recover to 200
      let readyRecovered = false;
      for (let attempt = 1; attempt <= 15; attempt++) {
        try {
          const ready = await requestJson(`${HTTP_API_URL}/ready`);
          if (ready.response.status === 200 && ready.body?.status === 'ok') {
            readyRecovered = true;
            break;
          }
        } catch {
          // Retry
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(readyRecovered).toBe(true);

      // 2. Liveness probe /health remains 200
      const health = await requestJson(`${HTTP_API_URL}/health`);
      expect(health.response.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });

      // 3. Proves the GENUINE pre-outage authenticated session recovers over HTTP
      const preOutageJar = new CookieJar();
      preOutageJar.updateFromHeaders(new Headers({ 'set-cookie': sessionData.cookie }));

      const check = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, preOutageJar);
      expect(check.response.status).toBe(200);
      expect(check.body.user.username).toBe(sessionData.username);
      expect(check.body.csrfToken).toBeDefined();

      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {}, preOutageJar);
      expect(sys.response.status).toBe(200);
      expect(sys.body).toEqual({ status: 'ok' });

      // 4. Proves a fresh login and session creation also succeeds after recovery
      const freshJar = new CookieJar();
      const freshLogin = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        freshJar
      );
      expect(freshLogin.response.status).toBe(200);
      expect(freshLogin.body.user.username).toBe(maintainerUsername);

      // 5. Clean logout of the pre-outage session
      const logout = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': check.body.csrfToken },
        },
        preOutageJar
      );
      expect(logout.response.status).toBe(200);
      expect(logout.body).toEqual({ success: true });

      // 6. Proves replay of the genuine logged-out pre-outage session is rejected
      const replay = await requestJson(`${HTTP_API_URL}/auth/session-check`, {
        headers: { Cookie: sessionData.cookie },
      });
      expect(replay.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(replay.body.error.code);

      const replaySys = await requestJson(`${HTTP_API_URL}/system/info`, {
        headers: { Cookie: sessionData.cookie },
      });
      expect(replaySys.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(replaySys.body.error.code);

      // Also confirm unauthenticated request without cookies is rejected
      const noCookieReplay = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, preOutageJar);
      expect(noCookieReplay.response.status).toBe(401);
    });
  });
});
