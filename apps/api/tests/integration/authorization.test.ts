import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import fastifyCookie from '@fastify/cookie';
import { csrfPlugin } from '../../src/plugins/csrf.ts';
import { authPlugin } from '../../src/plugins/auth.ts';
import { authRoutes } from '../../src/routes/auth.routes.ts';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// Explicit allowlist of modules intentionally absent during TDD RED phase (T024-T026)
const EXPECTED_TDD_MODULES = new Set([
  '../../src/routes/system.routes.ts',
  '../../src/middleware/authorization.ts',
  '../../src/services/capability.service.ts',
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
    if (!importer.includes('authorization.test.ts')) {
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
    if (!importer.includes('authorization.test.ts')) {
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

// Helper to setup test Fastify application
async function setupTestApp(options: { databaseUrl: string; secure?: boolean }): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(fastifyCookie);
  await app.register(csrfPlugin);
  await app.register(authPlugin, { databaseUrl: options.databaseUrl, secure: options.secure });
  await app.register(authRoutes, { prefix: '/auth', databaseUrl: options.databaseUrl });

  // T026: Capability-protected system routes (expected missing in T023 RED phase)
  try {
    const systemMod = await import('../../src/routes/system.routes.ts' as string);
    const systemRoutes = systemMod.systemRoutes || systemMod.default;
    if (typeof systemRoutes === 'function') {
      await app.register(systemRoutes, { prefix: '/system', databaseUrl: options.databaseUrl });
    }
  } catch (err) {
    if (!isExpectedMissingModuleError(err, '../../src/routes/system.routes.ts')) {
      throw err;
    }
  }

  // T025: Capability authorization middleware (expected missing in T023 RED phase)
  try {
    const authzMod = await import('../../src/middleware/authorization.ts' as string);
    const requireCapability = authzMod.requireCapability;
    if (typeof requireCapability === 'function') {
      app.get(
        '/system/unknown-capability-test',
        {
          preHandler: [requireCapability('system:unknown_capability' as any)],
        },
        async () => ({ status: 'ok' })
      );
    }
  } catch (err) {
    if (!isExpectedMissingModuleError(err, '../../src/middleware/authorization.ts')) {
      throw err;
    }
  }

  await app.ready();
  return app;
}

// Database helper: insert a user
async function insertUser(
  databaseUrl: string,
  user: {
    id?: string;
    username: string;
    passwordHash?: string;
    isActive?: boolean;
  }
): Promise<{ id: string; username: string; passwordHash: string; isActive: boolean }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const id = user.id || crypto.randomUUID();
    const isActive = user.isActive ?? true;
    const passwordHash =
      user.passwordHash ||
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgqlfreuzphiOZoHzAcTXbgFixda/50No';
    await client.query(
      `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, user.username, passwordHash, isActive]
    );
    return { id, username: user.username, passwordHash, isActive };
  } finally {
    await client.end();
  }
}

// Database helper: insert a role
async function insertRole(
  databaseUrl: string,
  role: { id: string; description: string }
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO roles (id, description) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [role.id, role.description]
    );
  } finally {
    await client.end();
  }
}

// Database helper: assign a role to a user
async function assignRole(
  databaseUrl: string,
  userId: string,
  roleId: string
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleId]
    );
  } finally {
    await client.end();
  }
}

// Database helper: revoke a role from a user
async function revokeRole(
  databaseUrl: string,
  userId: string,
  roleId: string
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId]
    );
  } finally {
    await client.end();
  }
}

// Database helper: get user roles
async function getUserRoles(
  databaseUrl: string,
  userId: string
): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT role_id FROM user_roles WHERE user_id = $1`,
      [userId]
    );
    return res.rows.map((r: { role_id: string }) => r.role_id);
  } finally {
    await client.end();
  }
}

// Database helper: insert a session directly
async function insertSession(
  databaseUrl: string,
  session: {
    userId: string;
    rawToken?: string;
    expiresAt?: Date;
  }
): Promise<{ rawToken: string; digest: string; userId: string; expiresAt: Date }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rawToken = session.rawToken || crypto.randomBytes(32).toString('base64url');
    const digest = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = session.expiresAt || new Date(Date.now() + 8 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [digest, session.userId, expiresAt]
    );
    return { rawToken, digest, userId: session.userId, expiresAt };
  } finally {
    await client.end();
  }
}

// Database helper: delete session digest
async function deleteSession(
  databaseUrl: string,
  digest: string
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DELETE FROM sessions WHERE id = $1`, [digest]);
  } finally {
    await client.end();
  }
}

// Helper: create an authenticated user session with database-committed state
async function createAuthenticatedUserSession(
  databaseUrl: string,
  options: {
    usernamePrefix?: string;
    roles?: string[];
    isActive?: boolean;
    expiresAt?: Date;
  } = {}
): Promise<{
  user: { id: string; username: string; isActive: boolean };
  rawToken: string;
  digest: string;
  cookieHeader: string;
}> {
  const uniqueSuffix = crypto.randomUUID().slice(0, 8);
  const username = `${options.usernamePrefix || 'authz_user'}_${uniqueSuffix}`;
  const user = await insertUser(databaseUrl, {
    username,
    isActive: options.isActive ?? true,
  });

  if (options.roles && options.roles.length > 0) {
    for (const role of options.roles) {
      await assignRole(databaseUrl, user.id, role);
    }
  }

  const session = await insertSession(databaseUrl, {
    userId: user.id,
    expiresAt: options.expiresAt,
  });

  return {
    user,
    rawToken: session.rawToken,
    digest: session.digest,
    cookieHeader: `session=${session.rawToken}`,
  };
}

describe('Authorization Integration Tests (T023 - US2)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let app: FastifyInstance;

  beforeAll(async () => {
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
    databaseUrl = container.getConnectionUri();

    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    // Seed baseline roles in PostgreSQL
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO roles (id, description) VALUES
          ('SYSTEM_MAINTAINER', 'System maintainer with maintenance capabilities'),
          ('ADMINISTRATOR', 'Administrator with full system privileges'),
          ('READ_ONLY', 'Read-only observer role')
        ON CONFLICT (id) DO NOTHING
      `);
    } finally {
      await client.end();
    }

    app = await setupTestApp({ databaseUrl });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (container) {
      await container.stop();
    }
  });

  // =========================================================================
  // Scenario A — Unauthenticated access denied
  // =========================================================================
  describe('Scenario A: Unauthenticated access denied', () => {
    it('rejects unauthenticated request to capability-protected endpoint with HTTP 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'UNAUTHORIZED');
      expect(body.error).toHaveProperty('message', 'Authentication required');
      expect(body.error).toHaveProperty('request_id');
      expect(typeof body.error.request_id).toBe('string');
      // Must not leak protected business payload
      expect(body.system).toBeUndefined();
      expect(body.status).toBeUndefined();
    });

    it('rejects unauthenticated request with invalid/malformed session cookie with HTTP 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: 'session=invalid-malformed-opaque-token!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'UNAUTHORIZED');
      expect(body.system).toBeUndefined();
    });
  });

  // =========================================================================
  // Scenario B — Authenticated but without capability denied
  // =========================================================================
  describe('Scenario B: Authenticated but without capability denied', () => {
    it('rejects authenticated user without SYSTEM_MAINTAINER role with HTTP 403', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_no_roles',
        roles: [],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS']).toContain(body.error.code);
      expect(body.error).toHaveProperty('message', 'Permission denied');
      expect(body.error).toHaveProperty('request_id');
      // Must not leak protected business payload
      expect(body.system).toBeUndefined();
      expect(body.status).toBeUndefined();
    });

    it('rejects authenticated user possessing an unrelated role (e.g. READ_ONLY) with HTTP 403', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_read_only',
        roles: ['READ_ONLY'],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS']).toContain(body.error.code);
      expect(body.system).toBeUndefined();
    });
  });

  // =========================================================================
  // Scenario C — Authenticated with capability allowed
  // =========================================================================
  describe('Scenario C: Authenticated with capability allowed', () => {
    it('allows access to protected system endpoint for user with SYSTEM_MAINTAINER role with HTTP 200', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_maintainer',
        roles: ['SYSTEM_MAINTAINER'],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('status', 'ok');
    });

    it('verifies authorization is based dynamically on current authoritative PostgreSQL roles', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_dyn_check',
        roles: ['SYSTEM_MAINTAINER'],
      });

      // Assert role mapping exists directly in committed PostgreSQL state
      const roles = await getUserRoles(databaseUrl, auth.user.id);
      expect(roles).toContain('SYSTEM_MAINTAINER');

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('status', 'ok');
    });
  });

  // =========================================================================
  // Scenario D — Immediate capability revocation
  // =========================================================================
  describe('Scenario D: Immediate capability revocation', () => {
    it('enforces immediate revocation on next request using exact same session without re-login', async () => {
      // 1. Create an active user with SYSTEM_MAINTAINER and active session
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_revocation_target',
        roles: ['SYSTEM_MAINTAINER'],
      });

      // 2. Initial protected request must succeed (HTTP 200)
      const initialResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });
      expect(initialResponse.statusCode).toBe(200);
      expect(initialResponse.json()).toHaveProperty('status', 'ok');

      // 3. Remove user's role assignment directly from PostgreSQL
      await revokeRole(databaseUrl, auth.user.id, 'SYSTEM_MAINTAINER');

      const remainingRoles = await getUserRoles(databaseUrl, auth.user.id);
      expect(remainingRoles).not.toContain('SYSTEM_MAINTAINER');

      // 4. Repeat protected request using SAME session cookie without logging out
      const subsequentResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      // 5. Must fail closed immediately with HTTP 403 on the next request
      expect(subsequentResponse.statusCode).toBe(403);
      const body = subsequentResponse.json();
      expect(body).toHaveProperty('error');
      expect(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS']).toContain(body.error.code);
      expect(body.error).toHaveProperty('message', 'Permission denied');
      expect(body.system).toBeUndefined();
    });
  });

  // =========================================================================
  // Additional High-Value Regression Cases
  // =========================================================================
  describe('Additional Authorization Regression Scenarios', () => {
    it('enforces newly granted role on the next request using an existing active session', async () => {
      // 1. User starts with no roles
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_grant_target',
        roles: [],
      });

      // 2. Initial request must be rejected with HTTP 403
      const initialResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });
      expect(initialResponse.statusCode).toBe(403);

      // 3. Grant SYSTEM_MAINTAINER role directly in PostgreSQL
      await assignRole(databaseUrl, auth.user.id, 'SYSTEM_MAINTAINER');

      // 4. Repeat request with the SAME session cookie
      const subsequentResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      // 5. Must succeed with HTTP 200 without requiring new login
      expect(subsequentResponse.statusCode).toBe(200);
      expect(subsequentResponse.json()).toHaveProperty('status', 'ok');
    });

    it('rejects disabled user even if they possess SYSTEM_MAINTAINER role in PostgreSQL', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_disabled_maintainer',
        roles: ['SYSTEM_MAINTAINER'],
        isActive: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect([401, 403]).toContain(response.statusCode);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.system).toBeUndefined();
    });

    it('rejects request with revoked session even if user possesses SYSTEM_MAINTAINER role', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_revoked_session',
        roles: ['SYSTEM_MAINTAINER'],
      });

      // Delete session digest from PostgreSQL
      await deleteSession(databaseUrl, auth.digest);

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(['UNAUTHORIZED', 'SESSION_NOT_FOUND', 'SESSION_REVOKED']).toContain(body.error.code);
    });

    it('rejects request with expired session even if user possesses SYSTEM_MAINTAINER role', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_expired_session',
        roles: ['SYSTEM_MAINTAINER'],
        expiresAt: new Date(Date.now() - 60 * 1000), // 1 minute in the past
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(['UNAUTHORIZED', 'SESSION_EXPIRED']).toContain(body.error.code);
    });

    it('fails closed when an unmapped or nonexistent capability is required', async () => {
      // Insert unmapped role into roles table first to satisfy foreign key constraint
      await insertRole(databaseUrl, {
        id: 'UNMAPPED_ROLE',
        description: 'Role with no mapped capabilities',
      });

      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_unmapped_role',
        roles: ['UNMAPPED_ROLE'],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS']).toContain(body.error.code);
    });

    it('distinguishes authentication (401) and authorization (403) errors cleanly', async () => {
      // 1. Unauthenticated request -> 401 UNAUTHORIZED
      const unauthResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
      });
      expect(unauthResponse.statusCode).toBe(401);
      const unauthBody = unauthResponse.json();
      expect(unauthBody.error.code).toBe('UNAUTHORIZED');

      // 2. Authenticated but unauthorized request -> 403 FORBIDDEN / INSUFFICIENT_PERMISSIONS
      const authNoCap = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_distinguish',
        roles: [],
      });
      const forbiddenResponse = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: authNoCap.cookieHeader,
        },
      });
      expect(forbiddenResponse.statusCode).toBe(403);
      const forbiddenBody = forbiddenResponse.json();
      expect(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS']).toContain(forbiddenBody.error.code);

      // Status codes and error codes must be strictly distinct
      expect(unauthResponse.statusCode).not.toBe(forbiddenResponse.statusCode);
      expect(unauthBody.error.code).not.toBe(forbiddenBody.error.code);
    });

    it('sanitizes authorization error envelopes with zero leakage of secrets, SQL, or stack traces', async () => {
      const auth = await createAuthenticatedUserSession(databaseUrl, {
        usernamePrefix: 'user_leak_check',
        roles: [],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          cookie: auth.cookieHeader,
        },
      });

      expect(response.statusCode).toBe(403);
      const rawPayload = response.body;

      // Must not leak sensitive details
      expect(rawPayload).not.toContain('password');
      expect(rawPayload).not.toContain('$argon2id$');
      expect(rawPayload).not.toContain(auth.rawToken);
      expect(rawPayload).not.toContain(auth.digest);
      expect(rawPayload).not.toContain('SELECT');
      expect(rawPayload).not.toContain('FROM');
      expect(rawPayload).not.toContain('WHERE');
      expect(rawPayload).not.toContain('user_roles');
      expect(rawPayload).not.toContain('stack');
    });
  });
});
