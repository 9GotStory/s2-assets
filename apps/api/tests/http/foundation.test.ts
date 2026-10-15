import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, '../../src/server.ts');

const phase = process.env.FOUNDATION_SMOKE_PHASE || 'pre-outage';
const isPreOutage = phase === 'pre-outage' || phase === 'all';
const isOutage = phase === 'outage';
const isRecovery = phase === 'recovery';

const HTTP_API_URL = (process.env.HTTP_API_URL || 'http://api:3000').replace(/\/+$/, '');
const HTTP_WEB_URL = (process.env.HTTP_WEB_URL || 'http://web:5173').replace(/\/+$/, '');
const SESSION_COOKIE_NAME = 'session';

// Load runner config file if provided
function loadRunnerConfig(): Record<string, string> {
  const cfgFile = process.env.FOUNDATION_FIXTURE_CONFIG_FILE;
  if (cfgFile && fsSync.existsSync(cfgFile)) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(cfgFile, 'utf-8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.length > 0 && !process.env[k]) {
          process.env[k] = v;
        }
      }
      return parsed;
    } catch {
      // Ignore config read error
    }
  }
  return {};
}

// Load fixture state file if provided
interface FixtureState {
  runId: string;
  database: string;
  maintainer: { id: string; username: string; role: string | null };
  standard: { id: string; username: string; role: string | null };
}

function loadFixtureState(): FixtureState | null {
  const stateFile = process.env.FOUNDATION_FIXTURE_STATE_FILE;
  if (stateFile && fsSync.existsSync(stateFile)) {
    try {
      return JSON.parse(fsSync.readFileSync(stateFile, 'utf-8')) as FixtureState;
    } catch {
      // Ignore state read error
    }
  }
  return null;
}

loadRunnerConfig();
const fixtureState = loadFixtureState();

const testPassword = process.env.FOUNDATION_TEST_PASSWORD || '';
const baseUsername = process.env.FOUNDATION_TEST_USERNAME || '';

const maintainerUsername =
  fixtureState?.maintainer?.username || (baseUsername ? `${baseUsername}_maintainer` : 'test_maintainer');
const standardUsername =
  fixtureState?.standard?.username || (baseUsername ? `${baseUsername}_standard` : 'test_standard');

const databaseUrl =
  process.env.FOUNDATION_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  '';

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

async function queryDatabase(sql: string, params: unknown[] = []): Promise<any[]> {
  if (!databaseUrl) {
    throw new Error('Database URL is required for database fixture manipulation');
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
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
      // No stack trace in stderr
      expect(stderr).not.toMatch(/\s+at\s+.+\(.+:\d+:\d+\)/);

      // 3. Proves no operational listener opened on the isolated port
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
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(body).toEqual({ status: 'ok' });
    });

    it('GET /ready returns 200 and exactly {"status":"ok"} when healthy', async () => {
      const { response, body } = await requestJson(`${HTTP_API_URL}/ready`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(body).toEqual({ status: 'ok' });
    });

    it('returns safe standardized error envelope on nonexistent route without stack or secret leakage', async () => {
      const { response, body } = await requestJson(`${HTTP_API_URL}/nonexistent-route-path-test`);
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
    let resolvedMaintainerId = fixtureState?.maintainer?.id || '';

    beforeAll(async () => {
      if (!resolvedMaintainerId && databaseUrl) {
        const rows = await queryDatabase('SELECT id FROM users WHERE username = $1', [maintainerUsername]);
        if (rows.length > 0) {
          resolvedMaintainerId = rows[0].id;
        }
      }
    });

    afterAll(async () => {
      // Ensure maintainer grant is restored if left revoked
      if (resolvedMaintainerId && databaseUrl) {
        const check = await queryDatabase(
          'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2',
          [resolvedMaintainerId, 'SYSTEM_MAINTAINER']
        );
        if (check.length === 0) {
          await queryDatabase(
            'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
            [resolvedMaintainerId, 'SYSTEM_MAINTAINER']
          );
        }
      }
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
      expect(resolvedMaintainerId).toBeTruthy();

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

      // Revoke only this fixture user's grant
      await queryDatabase(
        'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
        [resolvedMaintainerId, 'SYSTEM_MAINTAINER']
      );

      // The next request with the exact same session must return 403 immediately
      const revokedSys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(revokedSys.response.status).toBe(403);
      expect(revokedSys.body.error.code).toBe('FORBIDDEN');

      // Restore the grant
      await queryDatabase(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [resolvedMaintainerId, 'SYSTEM_MAINTAINER']
      );

      // The subsequent request with the same session returns 200 immediately
      const restoredSys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(restoredSys.response.status).toBe(200);
      expect(restoredSys.body).toEqual({ status: 'ok' });
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
      expect(validRes.status ?? validRes.response.status).toBe(200);
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
          body: JSON.stringify({ username: maintainerUsername, password: 'WRONG_INVALID_PASSWORD' }),
        },
        invalidJar
      );
      expect(invalidRes.response.status).toBe(401);
      expect(invalidRes.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(invalidJar.get(SESSION_COOKIE_NAME)).toBeUndefined();
    });

    it('authenticated GET /auth/session-check returns 200 and real CSRF material', async () => {
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

      const check = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, jar);
      expect(check.response.status).toBe(200);
      expect(check.body.user.username).toBe(maintainerUsername);
      expect(check.body.csrfToken).toBeDefined();
      expect(typeof check.body.csrfToken).toBe('string');
      expect(check.body.csrfToken.length).toBeGreaterThan(10);
      expect(check.response.headers.get('x-csrf-token')).toBe(check.body.csrfToken);
      expect(jar.get('_csrf')).toBeDefined();
    });
  });

  describe.runIf(isPreOutage)('Case B3 — CSRF Enforcement, Logout, and Session Replay Denial', () => {
    it('POST /auth/logout rejects missing and invalid CSRF with 403; valid token succeeds and session replay is rejected', async () => {
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

      // Obtain CSRF token through existing session-check only
      const sessionCheck = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, jar);
      expect(sessionCheck.response.status).toBe(200);
      const genuineCsrfToken = sessionCheck.body.csrfToken;
      expect(genuineCsrfToken).toBeDefined();

      const savedSessionCookie = jar.get(SESSION_COOKIE_NAME)!;

      // 1. Missing CSRF header returns 403
      const missingCsrf = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        { method: 'POST' },
        jar
      );
      expect(missingCsrf.response.status).toBe(403);
      expect(missingCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // 2. Invalid CSRF header returns 403
      const invalidCsrf = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': 'INVALID_MALFORMED_CSRF_TOKEN_SENTINEL' },
        },
        jar
      );
      expect(invalidCsrf.response.status).toBe(403);
      expect(invalidCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // 3. Valid CSRF header and cookie succeeds with 200
      const validLogout = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': genuineCsrfToken },
        },
        jar
      );
      expect(validLogout.response.status).toBe(200);
      expect(validLogout.body).toEqual({ success: true });
      // Session cookie is cleared
      expect(jar.get(SESSION_COOKIE_NAME)).toBeUndefined();

      // 4. Session replay rejection: use original logged-out session cookie
      const replayJar = new CookieJar();
      replayJar.set(SESSION_COOKIE_NAME, savedSessionCookie);

      const replayCheck = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, replayJar);
      expect(replayCheck.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'UNAUTHORIZED']).toContain(replayCheck.body.error.code);

      const replaySys = await requestJson(`${HTTP_API_URL}/system/info`, {}, replayJar);
      expect(replaySys.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'UNAUTHORIZED']).toContain(replaySys.body.error.code);
    });
  });

  describe.runIf(isPreOutage)('Case C1 — SPA Direct Routes & Assets', () => {
    it('GET /login and /dashboard return 200 and genuine SPA entrypoint across repeated direct navigation', async () => {
      for (const route of ['/login', '/dashboard']) {
        for (let i = 0; i < 2; i++) {
          const res = await fetch(`${HTTP_WEB_URL}${route}`);
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toContain('text/html');
          const html = await res.text();
          expect(html).toContain('<div id="root"></div>');
          expect(html).toContain('/src/main.tsx');
        }
      }
    });

    it('serves SPA entrypoint script asset', async () => {
      const res = await fetch(`${HTTP_WEB_URL}/src/main.tsx`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe.runIf(isPreOutage)('Case C2 — Web Proxy Forwarding, Continuity, and CSRF Rejection', () => {
    it('exercises full authentication, session-check, system/info, CSRF rejection, and logout through http://web:5173 proxy', async () => {
      const jar = new CookieJar();

      // 1. Proxy Login
      const loginRes = await requestJson(
        `${HTTP_WEB_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );
      expect(loginRes.response.status).toBe(200);
      expect(loginRes.body.user.username).toBe(maintainerUsername);
      const sessionCookie = jar.get(SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();

      // 2. Proxy Session Check & CSRF retrieval
      const checkRes = await requestJson(`${HTTP_WEB_URL}/auth/session-check`, {}, jar);
      expect(checkRes.response.status).toBe(200);
      expect(checkRes.body.user.username).toBe(maintainerUsername);
      const csrfToken = checkRes.body.csrfToken;
      expect(csrfToken).toBeDefined();
      expect(jar.get('_csrf')).toBeDefined();

      // 3. Proxy Protected /system/info
      const sysRes = await requestJson(`${HTTP_WEB_URL}/system/info`, {}, jar);
      expect(sysRes.response.status).toBe(200);
      expect(sysRes.body).toEqual({ status: 'ok' });

      // 4. Proxy CSRF rejection on logout without token
      const rejectLogout = await requestJson(
        `${HTTP_WEB_URL}/auth/logout`,
        { method: 'POST' },
        jar
      );
      expect(rejectLogout.response.status).toBe(403);
      expect(rejectLogout.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // 5. Proxy Valid Logout
      const validLogout = await requestJson(
        `${HTTP_WEB_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': csrfToken },
        },
        jar
      );
      expect(validLogout.response.status).toBe(200);
      expect(validLogout.body).toEqual({ success: true });
      expect(jar.get(SESSION_COOKIE_NAME)).toBeUndefined();

      // 6. Proxy Session replay rejection
      const replayJar = new CookieJar();
      replayJar.set(SESSION_COOKIE_NAME, sessionCookie!);
      const replayCheck = await requestJson(`${HTTP_WEB_URL}/auth/session-check`, {}, replayJar);
      expect(replayCheck.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'UNAUTHORIZED']).toContain(replayCheck.body.error.code);

      const replaySys = await requestJson(`${HTTP_WEB_URL}/system/info`, {}, replayJar);
      expect(replaySys.response.status).toBe(401);
      expect(['SESSION_NOT_FOUND', 'UNAUTHORIZED']).toContain(replaySys.body.error.code);
    });
  });

  // =========================================================================
  // Phase 2: Database Outage Assertions (Case D1)
  // =========================================================================
  describe.runIf(isOutage)('Case D1 — PostgreSQL Outage Assertions', () => {
    it('proves GET /health remains 200 during outage while GET /ready returns 503 SERVICE_UNAVAILABLE', async () => {
      // 1. Liveness probe /health remains 200 without database
      const health = await requestJson(`${HTTP_API_URL}/health`);
      expect(health.response.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });

      // 2. Readiness probe /ready returns 503
      const ready = await requestJson(`${HTTP_API_URL}/ready`);
      expect(ready.response.status).toBe(503);
      expect(ready.body).toHaveProperty('error');
      expect(ready.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(ready.body.error.message).toBe('Service temporarily unavailable.');
      // No internal details, SQL, or stack
      expect(JSON.stringify(ready.body)).not.toMatch(/stack|SELECT|pg_|connection/i);
    });

    it('database-dependent login and authenticated requests fail safely with non-success statuses and safe envelopes', async () => {
      // 1. POST /auth/login fails safely
      const login = await requestJson(`${HTTP_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
      });
      expect([500, 503]).toContain(login.response.status);
      expect(login.body).toHaveProperty('error');
      expect(login.body.error.code).toBe('DATABASE_ERROR');
      expect(JSON.stringify(login.body)).not.toMatch(/stack|SELECT|pg_|password/i);

      // 2. GET /auth/session-check fails safely
      const check = await requestJson(`${HTTP_API_URL}/auth/session-check`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=outage-simulated-token-digest` },
      });
      expect([500, 503, 401]).toContain(check.response.status);
      expect(check.body).toHaveProperty('error');
      expect(JSON.stringify(check.body)).not.toMatch(/stack|SELECT|pg_/i);

      // 3. GET /system/info fails safely
      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=outage-simulated-token-digest` },
      });
      expect([500, 503, 401]).toContain(sys.response.status);
      expect(sys.body).toHaveProperty('error');
      expect(JSON.stringify(sys.body)).not.toMatch(/stack|SELECT|pg_/i);
    });
  });

  // =========================================================================
  // Phase 3: Database Recovery Assertions (Case D2)
  // =========================================================================
  describe.runIf(isRecovery)('Case D2 — PostgreSQL Recovery & HTTP Operation Restoration', () => {
    it('observes /ready recovery to 200 and proves full authenticated HTTP operation recovers', async () => {
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

      // 3. Proves authenticated operation recovers over HTTP
      const jar = new CookieJar();
      const login = await requestJson(
        `${HTTP_API_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: maintainerUsername, password: testPassword }),
        },
        jar
      );
      expect(login.response.status).toBe(200);
      expect(login.body.user.username).toBe(maintainerUsername);

      const check = await requestJson(`${HTTP_API_URL}/auth/session-check`, {}, jar);
      expect(check.response.status).toBe(200);
      expect(check.body.csrfToken).toBeDefined();

      const sys = await requestJson(`${HTTP_API_URL}/system/info`, {}, jar);
      expect(sys.response.status).toBe(200);
      expect(sys.body).toEqual({ status: 'ok' });

      // 4. Clean logout
      const logout = await requestJson(
        `${HTTP_API_URL}/auth/logout`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': check.body.csrfToken },
        },
        jar
      );
      expect(logout.response.status).toBe(200);
      expect(logout.body).toEqual({ success: true });
    });
  });
});
