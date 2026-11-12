import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import fastifyCookie from '@fastify/cookie';
import { csrfPlugin } from '../../src/plugins/csrf.ts';
import { authPlugin } from '../../src/plugins/auth.ts';
import { authRoutes } from '../../src/routes/auth.routes.ts';
import { systemRoutes } from '../../src/routes/system.routes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// Explicit allowlist of modules intentionally absent during TDD RED phase (T030)
const EXPECTED_TDD_MODULES = new Set([
  '../../src/routes/health.routes.ts',
]);

// Helper to determine if an error is strictly due to a genuinely absent/unimplemented expected module
function isExpectedMissingModuleError(err: unknown, moduleSpecifier: string): boolean {
  if (!EXPECTED_TDD_MODULES.has(moduleSpecifier)) {
    return false;
  }
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, any>;
  const message = typeof e.message === 'string' ? e.message : '';

  const isResolutionFailure =
    e.code === 'ERR_MODULE_NOT_FOUND' ||
    e.code === 'MODULE_NOT_FOUND' ||
    message.includes('Failed to resolve import') ||
    message.includes('Cannot find module') ||
    message.includes('Cannot find package') ||
    message.includes('Does the file exist');

  if (!isResolutionFailure) {
    return false;
  }

  const cleanTarget = moduleSpecifier.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');

  const viteMatch = message.match(/Cannot find module '([^']+)' imported from ([^\n\r]+)/);
  const viteResolveMatch = message.match(/Failed to resolve import "([^"]+)" from "([^"]+)"/);
  const nodeMatch = message.match(/Cannot find (?:module|package) '([^']+)'/);

  if (viteMatch) {
    const missingTarget = viteMatch[1];
    const importer = viteMatch[2];
    if (!importer.includes('health.test.ts')) {
      return false;
    }
    return (
      missingTarget === moduleSpecifier ||
      missingTarget === cleanTarget ||
      missingTarget === `/${cleanTarget}` ||
      missingTarget.endsWith(`/${cleanTarget}`)
    );
  }

  if (viteResolveMatch) {
    const missingTarget = viteResolveMatch[1];
    const importer = viteResolveMatch[2];
    if (!importer.includes('health.test.ts')) {
      return false;
    }
    return (
      missingTarget === moduleSpecifier ||
      missingTarget === cleanTarget ||
      missingTarget === `/${cleanTarget}` ||
      missingTarget.endsWith(`/${cleanTarget}`)
    );
  }

  if (nodeMatch) {
    const missingTarget = nodeMatch[1];
    return (
      missingTarget === moduleSpecifier ||
      missingTarget === cleanTarget ||
      missingTarget === `/${cleanTarget}` ||
      missingTarget.endsWith(`/${cleanTarget}`)
    );
  }

  return (
    message.includes(moduleSpecifier) ||
    message.includes(`'/${cleanTarget}'`) ||
    message.includes(`'${cleanTarget}'`) ||
    message.includes(`"${cleanTarget}"`)
  );
}

// Helper to setup test Fastify application compatible with T030 encapsulation
async function setupTestApp(options: {
  databaseUrl: string;
  pool: pg.Pool;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(fastifyCookie);
  await app.register(csrfPlugin);
  await app.register(authPlugin, {
    databaseUrl: options.databaseUrl,
    db: options.pool,
    publicRoutes: ['/health', '/ready'],
  });
  await app.register(authRoutes, {
    prefix: '/auth',
    databaseUrl: options.databaseUrl,
    db: options.pool,
  });
  await app.register(systemRoutes, {
    prefix: '/system',
    databaseUrl: options.databaseUrl,
    db: options.pool,
  });

  // T030: Health & Readiness routes (expected missing in T028 Tests-First RED phase)
  try {
    const healthMod = await import('../../src/routes/health.routes.ts' as string);
    const healthRoutes = healthMod.healthRoutes || healthMod.default;
    if (typeof healthRoutes === 'function') {
      await app.register(healthRoutes, {
        databaseUrl: options.databaseUrl,
        db: options.pool,
      });
    }
  } catch (err) {
    if (!isExpectedMissingModuleError(err, '../../src/routes/health.routes.ts')) {
      throw err;
    }
  }

  await app.ready();
  return app;
}

// Bounded container control: stops only the positively identified test-owned container
async function stopDatabaseContainer(containerId: string): Promise<void> {
  execSync(`podman stop ${containerId}`, { stdio: 'ignore' });
}

// Bounded container control: resumes the test-owned container and waits until PostgreSQL is ready
async function startDatabaseContainer(containerId: string, databaseUrl: string): Promise<void> {
  const status = execSync(`podman inspect ${containerId} --format '{{.State.Status}}'`, {
    encoding: 'utf-8',
  }).trim();
  if (status !== 'running') {
    execSync(`podman start ${containerId}`, { stdio: 'ignore' });
  }

  // Poll until PostgreSQL accepts connections
  for (let i = 0; i < 40; i++) {
    try {
      const client = new pg.Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 1000,
      });
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for PostgreSQL container ${containerId} to resume.`);
}

// Helper to create a user with a valid session and role for database-dependent operations
async function createTestSession(
  databaseUrl: string
): Promise<{ cookieHeader: string; userId: string; rawToken: string }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO roles (id, description) VALUES ('SYSTEM_MAINTAINER', 'System maintainer')
      ON CONFLICT (id) DO NOTHING
    `);

    const userId = crypto.randomUUID();
    const username = `health_user_${crypto.randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO users (id, username, password_hash, is_active) VALUES ($1, $2, $3, $4)`,
      [userId, username, '$argon2id$v=19$m=65536,t=3,p=4$dummy$validhash', true]
    );

    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, 'SYSTEM_MAINTAINER']
    );

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const digest = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
      [digest, userId, expiresAt]
    );

    return {
      userId,
      rawToken,
      cookieHeader: `session=${rawToken}`,
    };
  } finally {
    await client.end();
  }
}

// Verification helper for Scenario D: ensures no internal secrets or infrastructure details leak
function assertNoSensitiveInformationLeaked(
  rawBody: string,
  context: { databaseUrl: string; rawToken?: string }
): void {
  expect(rawBody).not.toContain(context.databaseUrl);
  expect(rawBody).not.toMatch(/postgres:\/\/[^@\s]+@/);
  expect(rawBody).not.toContain('test:test@');

  if (context.rawToken) {
    expect(rawBody).not.toContain(context.rawToken);
  }

  expect(rawBody).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bFROM\s+users\b|\bFROM\s+sessions\b/i);
  expect(rawBody).not.toMatch(/relation\s+"[^"]+"\s+does\s+not\s+exist/i);
  expect(rawBody).not.toContain('pg_backend_pid');

  expect(rawBody).not.toMatch(/\bat\s+[A-Za-z0-9_.]+\s+\(/);
  expect(rawBody).not.toContain('node_modules');
  expect(rawBody).not.toMatch(/\.ts:\d+:\d+/);
  expect(rawBody).not.toMatch(/\.js:\d+:\d+/);

  expect(rawBody).not.toMatch(/\/home\/[a-zA-Z0-9_-]+/);
  expect(rawBody).not.toMatch(/\/var\/lib\/postgresql/);
  expect(rawBody).not.toContain('multica_workspaces');
}

describe('Health & Readiness Integration Tests (T028 - US3)', () => {
  let container: StartedPostgreSqlContainer;
  let containerId: string;
  let databaseUrl: string;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    // Explicit test DB configuration: prevent fallback to any ambient DATABASE_URL
    delete process.env.DATABASE_URL;

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
    containerId = container.getId();
    databaseUrl = container.getConnectionUri();

    // Shared connection pool with intentional outage error handling
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
    });
    pool.on('error', () => {
      // Handle expected idle client termination during intentional database outages
    });

    // Apply 0001_foundation migration explicitly to test database
    const migrationResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(migrationResult.error).toBeUndefined();

    app = await setupTestApp({ databaseUrl, pool });
  }, 90_000);

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
    if (container) {
      await container.stop().catch(() => {});
    }
  });

  afterEach(async () => {
    // Ensure the test-owned container is running and healthy between test cases
    if (container && containerId && databaseUrl) {
      try {
        await startDatabaseContainer(containerId, databaseUrl);
      } catch {
        // Ignored in cleanup
      }
    }
  }, 30_000);

  // =========================================================================
  // Scenario A — Healthy database
  // =========================================================================
  describe('Scenario A: Healthy database', () => {
    it('returns HTTP 200 on GET /health without requiring authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('status', 'ok');
    });

    it('returns HTTP 200 on GET /ready without requiring authentication when database is healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('status', 'ok');
    });
  });

  // =========================================================================
  // Scenario B — Database unavailable
  // =========================================================================
  describe('Scenario B: Database unavailable', () => {
    it('returns HTTP 503 and SERVICE_UNAVAILABLE on GET /ready when database is unavailable', async () => {
      // 1. Confirm /ready returns 200 while PostgreSQL is healthy
      const healthyResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(healthyResponse.statusCode).toBe(200);

      // 2. Make test-owned PostgreSQL instance genuinely unavailable
      await stopDatabaseContainer(containerId);

      // 3. Request /ready again
      const outageResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      // 4. Expect HTTP 503
      expect(outageResponse.statusCode).toBe(503);

      // 5. Verify standard error envelope
      const body = outageResponse.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'SERVICE_UNAVAILABLE');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('request_id');
      expect(typeof body.error.request_id).toBe('string');
      expect(body.error).toHaveProperty('details');
    });

    it('does not return a stale cached success on repeated /ready requests during outage', async () => {
      // 1. Confirm /ready returns 200 while healthy
      const healthyResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(healthyResponse.statusCode).toBe(200);

      // 2. Stop container
      await stopDatabaseContainer(containerId);

      // 3. First outage request
      const outageRes1 = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(outageRes1.statusCode).toBe(503);
      expect(outageRes1.json().error.code).toBe('SERVICE_UNAVAILABLE');

      // 4. Repeated outage request: must not return stale cached success
      const outageRes2 = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(outageRes2.statusCode).toBe(503);
      expect(outageRes2.json().error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  // =========================================================================
  // Scenario C — Safe database-dependent operation failure
  // =========================================================================
  describe('Scenario C: Safe database-dependent operation failure', () => {
    it('succeeds when healthy, then fails safely without leaking protected payload when database is unavailable', async () => {
      // 1. Establish valid session while PostgreSQL is healthy
      const auth = await createTestSession(databaseUrl);

      // 2. Verify database-dependent operation (/system/info) succeeds when healthy
      const healthyResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });
      expect(healthyResponse.statusCode).toBe(200);
      expect(healthyResponse.json()).toEqual({ status: 'ok' });

      // 3. Make the database unavailable
      await stopDatabaseContainer(containerId);

      // 4. Repeat the operation during the outage
      const outageResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      // 5. Confirm operation does not succeed
      expect(outageResponse.statusCode).not.toBe(200);

      // 6. Confirm no protected business payload is returned
      const body = outageResponse.json();
      expect(body.status).toBeUndefined();
      expect(body.system).toBeUndefined();

      // 7. Verify error follows existing safe error contract
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('request_id');
      expect(typeof body.error.request_id).toBe('string');
    });
  });

  // =========================================================================
  // Scenario D — Safe error envelope
  // =========================================================================
  describe('Scenario D: Safe error envelope', () => {
    it('ensures unavailable-dependency responses contain no connection strings, passwords, SQL, stack traces, or sensitive infrastructure details', async () => {
      const auth = await createTestSession(databaseUrl);

      // Trigger outage
      await stopDatabaseContainer(containerId);

      // D.1 Verify /ready response during outage
      const readyResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(readyResponse.statusCode).toBe(503);
      expect(readyResponse.json().error.code).toBe('SERVICE_UNAVAILABLE');
      assertNoSensitiveInformationLeaked(readyResponse.body, { databaseUrl });

      // D.2 Verify database-dependent route (/system/info) response during outage
      const systemResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });
      expect(systemResponse.statusCode).not.toBe(200);
      assertNoSensitiveInformationLeaked(systemResponse.body, {
        databaseUrl,
        rawToken: auth.rawToken,
      });
    });
  });

  // =========================================================================
  // Scenario E — Recovery
  // =========================================================================
  describe('Scenario E: Recovery', () => {
    it('restores HTTP 200 on GET /ready after database connection is restored via real check', async () => {
      // 1. Initial healthy state check
      const initialResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(initialResponse.statusCode).toBe(200);

      // 2. Make database unavailable
      await stopDatabaseContainer(containerId);
      const outageResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(outageResponse.statusCode).toBe(503);

      // 3. Restore working database connection
      await startDatabaseContainer(containerId, databaseUrl);

      // 4. Verify /ready becomes successful again via real dependency check
      const recoveredResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(recoveredResponse.statusCode).toBe(200);
      expect(recoveredResponse.json()).toHaveProperty('status', 'ok');

      // 5. Confirm recovery is based on real dependency check by stopping again
      await stopDatabaseContainer(containerId);
      const secondOutageResponse = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(secondOutageResponse.statusCode).toBe(503);
    });
  });
});
