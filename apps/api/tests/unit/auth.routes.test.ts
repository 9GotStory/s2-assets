import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import { authPlugin } from '../../src/plugins/auth.ts';
import { csrfPlugin } from '../../src/plugins/csrf.ts';
import { authRoutes } from '../../src/routes/auth.routes.ts';
import type { SafeUser, User } from '../../src/services/user.service.ts';
import { generateSessionToken, type Session } from '../../src/services/session.service.ts';

const TEST_SECRET = 'test-secret-at-least-32-bytes-long-secret-key!!';

function createMockServices(overrides: {
  verifyCredentialsResult?: { valid: boolean; user?: SafeUser; reason?: 'INVALID_CREDENTIALS' | 'USER_DISABLED' };
  createSessionResult?: { token: string; rawToken: string; session: Session };
  revokeSessionResult?: boolean;
  userResult?: User | null;
  sessionResult?: Session | null;
  dbError?: boolean;
} = {}) {
  const dummyUser: SafeUser = {
    id: 'user-uuid-1234',
    username: 'alice',
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const dummyToken = generateSessionToken();

  const dummySession: Session = {
    id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    user_id: dummyUser.id,
    expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
    created_at: new Date(),
  };

  const userService = {
    verifyCredentials: vi.fn(async (username: string, password: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: SELECT * FROM users');
      }
      if (overrides.verifyCredentialsResult !== undefined) {
        return overrides.verifyCredentialsResult;
      }
      if (username === 'alice' && password === 'ValidPassword123!') {
        return { valid: true, user: dummyUser };
      }
      if (username === 'disabled') {
        return { valid: false, reason: 'USER_DISABLED' as const };
      }
      return { valid: false, reason: 'INVALID_CREDENTIALS' as const };
    }),
    findById: vi.fn(async (id: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: SELECT * FROM users');
      }
      if (overrides.userResult !== undefined) {
        return overrides.userResult;
      }
      return {
        ...dummyUser,
        id,
        password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$dummy',
      };
    }),
    sanitizeUser: vi.fn((user: any): SafeUser => {
      const { password_hash, ...safe } = user;
      return safe;
    }),
  };

  const sessionService = {
    createSession: vi.fn(async (userId: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: INSERT INTO sessions');
      }
      if (overrides.createSessionResult !== undefined) {
        return overrides.createSessionResult;
      }
      return {
        token: dummyToken,
        rawToken: dummyToken,
        session: { ...dummySession, user_id: userId },
      };
    }),
    revokeSession: vi.fn(async (_token: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: DELETE FROM sessions');
      }
      return overrides.revokeSessionResult !== undefined ? overrides.revokeSessionResult : true;
    }),
    revokeByDigest: vi.fn(async (_digest: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: DELETE FROM sessions');
      }
      return overrides.revokeSessionResult !== undefined ? overrides.revokeSessionResult : true;
    }),
    validateSession: vi.fn(async (_token: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed');
      }
      return overrides.sessionResult !== undefined ? overrides.sessionResult : dummySession;
    }),
    verifySession: vi.fn(async (_token: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed');
      }
      return { valid: true, session: dummySession };
    }),
  };

  return { userService, sessionService, dummyUser, dummySession, dummyToken };
}

async function fetchCsrfCredentials(
  app: FastifyInstance,
  cookieHeader?: string
): Promise<{ csrfToken: string; cookieHeader?: string }> {
  const response = await app.inject({
    method: 'GET',
    url: '/test-csrf-token',
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });

  const body = response.json();
  const csrfToken = body?.csrfToken;
  const setCookie = response.headers['set-cookie'];
  const newCookieHeader = setCookie
    ? Array.isArray(setCookie)
      ? setCookie.map((c: string) => c.split(';')[0]).join('; ')
      : setCookie.split(';')[0]
    : undefined;

  return {
    csrfToken,
    cookieHeader: newCookieHeader,
  };
}

async function setupRouteTestApp(options: {
  userService?: any;
  sessionService?: any;
  secure?: boolean;
  prefix?: string;
} = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(fastifyCookie, {
    secret: TEST_SECRET,
  });

  await app.register(csrfPlugin, {
    cookieSecret: TEST_SECRET,
    secure: options.secure,
  });

  app.get('/test-csrf-token', async (_request, reply) => {
    if (typeof (reply as any).generateCsrf === 'function') {
      const token = (reply as any).generateCsrf();
      return { csrfToken: token };
    }
    return { csrfToken: undefined };
  });

  const { userService, sessionService } = createMockServices();
  const uService = options.userService ?? userService;
  const sService = options.sessionService ?? sessionService;

  await app.register(authPlugin, {
    userService: uService,
    sessionService: sService,
    secure: options.secure,
  });

  await app.register(authRoutes, {
    prefix: options.prefix ?? '/auth',
    secure: options.secure,
  });

  await app.ready();
  return app;
}

describe('Focused Auth Routes Unit Tests (T022)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  // =========================================================================
  // 1. POST /auth/login
  // =========================================================================
  describe('POST /auth/login', () => {
    it('returns HTTP 200 with sanitized user information on valid credentials', async () => {
      const app = await setupRouteTestApp();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'alice',
            password: 'ValidPassword123!',
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.user).toBeDefined();
        expect(body.user.username).toBe('alice');
        expect(body.user.id).toBe('user-uuid-1234');
        expect(body.user.password_hash).toBeUndefined();
        expect(body.password_hash).toBeUndefined();
        expect(body.token).toBeUndefined();
        expect(body.rawToken).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('sets secure session cookie on successful login via T020 decorator', async () => {
      const app = await setupRouteTestApp();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'alice',
            password: 'ValidPassword123!',
          },
        });

        expect(response.statusCode).toBe(200);
        const setCookie = response.headers['set-cookie'];
        expect(setCookie).toBeDefined();
        const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        expect(cookieStr).toMatch(/^session=/);
        expect(cookieStr).toMatch(/;\s*HttpOnly/i);
        expect(cookieStr).toMatch(/;\s*SameSite=Lax/i);
        expect(cookieStr).toMatch(/;\s*Path=\//i);
      } finally {
        await app.close();
      }
    });

    it('creates exactly one session in sessionService on successful login', async () => {
      const { userService, sessionService } = createMockServices();
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'alice',
            password: 'ValidPassword123!',
          },
        });

        expect(response.statusCode).toBe(200);
        expect(sessionService.createSession).toHaveBeenCalledTimes(1);
        expect(sessionService.createSession).toHaveBeenCalledWith('user-uuid-1234');
      } finally {
        await app.close();
      }
    });

    it('rejects invalid password with HTTP 401 INVALID_CREDENTIALS and creates NO session', async () => {
      const { userService, sessionService } = createMockServices();
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'alice',
            password: 'WrongPassword!',
          },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('INVALID_CREDENTIALS');
        expect(body.error.message).toBe('Authentication required');
        expect(sessionService.createSession).not.toHaveBeenCalled();
        expect(response.headers['set-cookie']).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('rejects non-existent user with HTTP 401 INVALID_CREDENTIALS without enumeration leakage', async () => {
      const { userService, sessionService } = createMockServices();
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'nonexistent_user',
            password: 'Password123!',
          },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('INVALID_CREDENTIALS');
        expect(sessionService.createSession).not.toHaveBeenCalled();
        expect(response.headers['set-cookie']).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('rejects disabled user with HTTP 403 USER_DISABLED and creates NO session', async () => {
      const { userService, sessionService } = createMockServices();
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'disabled',
            password: 'Password123!',
          },
        });

        expect(response.statusCode).toBe(403);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('USER_DISABLED');
        expect(body.error.message).toBe('Permission denied');
        expect(sessionService.createSession).not.toHaveBeenCalled();
        expect(response.headers['set-cookie']).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('rejects malformed payload missing username or password with HTTP 400 VALIDATION_FAILED', async () => {
      const app = await setupRouteTestApp();
      try {
        const missingPassRes = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'alice' },
        });
        expect(missingPassRes.statusCode).toBe(400);
        expect(missingPassRes.json().error.code).toBe('VALIDATION_FAILED');

        const emptyUserRes = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: '', password: 'pwd' },
        });
        expect(emptyUserRes.statusCode).toBe(400);
        expect(emptyUserRes.json().error.code).toBe('VALIDATION_FAILED');
      } finally {
        await app.close();
      }
    });

    it('handles unexpected database errors safely without leaking query or connection info', async () => {
      const { userService, sessionService } = createMockServices({ dbError: true });
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'alice',
            password: 'Password123!',
          },
        });

        expect(response.statusCode).toBe(500);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('DATABASE_ERROR');
        expect(body.error.message).toBe('An unexpected internal server error occurred.');
        expect(JSON.stringify(body)).not.toContain('SELECT');
        expect(JSON.stringify(body)).not.toContain('password_hash');
      } finally {
        await app.close();
      }
    });

    it('enforces Secure attribute on session cookie in production', async () => {
      process.env.NODE_ENV = 'production';
      const app = await setupRouteTestApp({ secure: true });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username: 'alice',
            password: 'ValidPassword123!',
          },
        });

        expect(response.statusCode).toBe(200);
        const cookieStr = response.headers['set-cookie'] as string;
        expect(cookieStr).toMatch(/;\s*Secure/i);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // 2. POST /auth/logout
  // =========================================================================
  describe('POST /auth/logout', () => {
    it('revokes session via sessionService, clears session cookie, and returns HTTP 200', async () => {
      const { userService, sessionService, dummyToken } = createMockServices();
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const { csrfToken, cookieHeader: csrfCookie } = await fetchCsrfCredentials(app, `session=${dummyToken}`);
        const cookies = [`session=${dummyToken}`];
        if (csrfCookie) cookies.push(csrfCookie);

        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            cookie: cookies.join('; '),
            'x-csrf-token': csrfToken,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true });
        expect(sessionService.revokeSession).toHaveBeenCalledTimes(1);
        expect(sessionService.revokeSession).toHaveBeenCalledWith(dummyToken);

        const cookieHeader = response.headers['set-cookie'] as string;
        expect(cookieHeader).toBeDefined();
        expect(cookieHeader).toMatch(/session=/);
        expect(cookieHeader).toMatch(/Max-Age=0/i);
        expect(cookieHeader).toMatch(/;\s*HttpOnly/i);
        expect(cookieHeader).toMatch(/;\s*SameSite=Lax/i);
      } finally {
        await app.close();
      }
    });

    it('fails closed with HTTP 401 SESSION_NOT_FOUND when session revocation reports false', async () => {
      const { userService, sessionService, dummyToken } = createMockServices({ revokeSessionResult: false });
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const { csrfToken, cookieHeader: csrfCookie } = await fetchCsrfCredentials(app, `session=${dummyToken}`);
        const cookies = [`session=${dummyToken}`];
        if (csrfCookie) cookies.push(csrfCookie);

        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            cookie: cookies.join('; '),
            'x-csrf-token': csrfToken,
          },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('SESSION_NOT_FOUND');
      } finally {
        await app.close();
      }
    });

    it('rejects unauthenticated logout attempt missing CSRF with HTTP 403 CSRF_TOKEN_INVALID', async () => {
      const app = await setupRouteTestApp();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('CSRF_TOKEN_INVALID');
      } finally {
        await app.close();
      }
    });

    it('rejects unauthenticated logout attempt with valid CSRF token with HTTP 401 UNAUTHORIZED', async () => {
      const app = await setupRouteTestApp();
      try {
        const { csrfToken, cookieHeader: csrfCookie } = await fetchCsrfCredentials(app);
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            ...(csrfCookie ? { cookie: csrfCookie } : {}),
            'x-csrf-token': csrfToken,
          },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHORIZED');
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // 3. GET /auth/session-check (Finding 1 & 2)
  // =========================================================================
  describe('GET /auth/session-check', () => {
    it('returns sanitized user information and genuine CSRF token for active authenticated session', async () => {
      const { userService, sessionService, dummyToken } = createMockServices();
      const app = await setupRouteTestApp({ userService, sessionService });
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/session-check',
          headers: {
            cookie: `session=${dummyToken}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.user).toBeDefined();
        expect(body.user.username).toBe('alice');
        expect(body.user.id).toBe('user-uuid-1234');
        expect(body.user.password_hash).toBeUndefined();

        // Finding 2: Genuine CSRF token must be provided
        expect(body.csrfToken).toBeDefined();
        expect(typeof body.csrfToken).toBe('string');
        expect(body.csrfToken.length).toBeGreaterThan(0);
        expect(response.headers['x-csrf-token']).toBe(body.csrfToken);
      } finally {
        await app.close();
      }
    });

    it('rejects unauthenticated session-check with HTTP 401 UNAUTHORIZED', async () => {
      const app = await setupRouteTestApp();
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/session-check',
        });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHORIZED');
      } finally {
        await app.close();
      }
    });

    it('fails closed and logs a safe generic diagnostic without leaking sensitive error messages or secrets (Finding 1)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });

      // Spy on request.log.error to ensure no raw error objects or secrets leak to logs
      const logErrorSpy = vi.fn();
      app.addHook('onRequest', async (req) => {
        req.log.error = logErrorSpy;
      });

      // Register mock csrf plugin with skip-override where generateCsrf throws with sensitive secret string
      const mockCsrf = async (instance: FastifyInstance) => {
        instance.decorate('csrfProtection', () => {});
        instance.decorate('generateCsrf', () => {
          throw new Error('Secret key failure: internal_super_secret_token_key_12345');
        });
        instance.decorateReply('generateCsrf', function () {
          throw new Error('Secret key failure: internal_super_secret_token_key_12345');
        });
      };
      (mockCsrf as any)[Symbol.for('skip-override')] = true;
      await app.register(mockCsrf);

      const { userService, sessionService, dummyToken } = createMockServices();
      await app.register(authPlugin, {
        userService: userService as any,
        sessionService: sessionService as any,
      });

      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/session-check',
          headers: {
            cookie: `session=${dummyToken}`,
          },
        });

        // Fail-closed requirement: must NOT return HTTP 200 without token
        expect(response.statusCode).toBe(500);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(body.error.message).toBe('An unexpected internal server error occurred.');
        // Sensitive secret must NOT be leaked in response body
        expect(JSON.stringify(body)).not.toContain('internal_super_secret_token_key_12345');

        // Finding 1: Ensure logger output is safe and generic
        expect(logErrorSpy).toHaveBeenCalled();
        expect(logErrorSpy).toHaveBeenCalledWith('CSRF token generation failed during session check');
        // Ensure no call passed the secret, raw Error object, or stack trace
        for (const callArgs of logErrorSpy.mock.calls) {
          const serialized = JSON.stringify(callArgs);
          expect(serialized).not.toContain('internal_super_secret_token_key_12345');
          expect(serialized).not.toContain('Secret key failure');
          expect(serialized).not.toContain('stack');
        }
      } finally {
        await app.close();
      }
    });

    it('fails closed with HTTP 500 when CSRF generator produces an empty token (Finding 2)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });

      const mockCsrf = async (instance: FastifyInstance) => {
        instance.decorate('csrfProtection', () => {});
        instance.decorate('generateCsrf', () => '');
        instance.decorateReply('generateCsrf', function () {
          return '';
        });
      };
      (mockCsrf as any)[Symbol.for('skip-override')] = true;
      await app.register(mockCsrf);

      const { userService, sessionService, dummyToken } = createMockServices();
      await app.register(authPlugin, {
        userService: userService as any,
        sessionService: sessionService as any,
      });

      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/session-check',
          headers: {
            cookie: `session=${dummyToken}`,
          },
        });

        expect(response.statusCode).toBe(500);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // 4. Fastify registration and dependency injection (Finding 1 & 2)
  // =========================================================================
  describe('Fastify Registration and Security Plugin Validation (Finding 1 & 2)', () => {
    it('fails closed during registration when T020 Auth Plugin is missing', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      const { userService, sessionService } = createMockServices();
      await expect(
        app.register(authRoutes, {
          prefix: '/auth',
          userService: userService as any,
          sessionService: sessionService as any,
        })
      ).rejects.toThrow(/Auth routes require Fastify Auth Plugin \(T020\) to be registered/);
    });

    it('fails closed during registration when T021 CSRF Plugin is missing', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });

      const { userService, sessionService } = createMockServices();
      await app.register(authPlugin, {
        userService: userService as any,
        sessionService: sessionService as any,
      });

      await expect(
        app.register(authRoutes, {
          prefix: '/auth',
          userService: userService as any,
          sessionService: sessionService as any,
        })
      ).rejects.toThrow(/Auth routes require Fastify CSRF Plugin \(T021\) to be registered/);
    });

    it('fails closed during registration when both security plugins are missing', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie);

      const { userService, sessionService } = createMockServices();
      await expect(
        app.register(authRoutes, {
          prefix: '/auth',
          userService: userService as any,
          sessionService: sessionService as any,
        })
      ).rejects.toThrow(/Auth routes require Fastify Auth Plugin \(T020\) to be registered/);
    });

    it('works when mounted without prefix, defaulting to /auth routes', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      const { userService, sessionService } = createMockServices();
      await app.register(authPlugin, {
        userService: userService as any,
        sessionService: sessionService as any,
      });

      // Register without prefix option
      await app.register(authRoutes);
      await app.ready();

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'alice', password: 'ValidPassword123!' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().user.username).toBe('alice');
      } finally {
        await app.close();
      }
    });

    it('accepts injected services when they match the authoritative Fastify decorator instances (Finding 2)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      const { userService: mockUser, sessionService: mockSession } = createMockServices();
      await app.register(authPlugin, {
        userService: mockUser as any,
        sessionService: mockSession as any,
      });

      // Pass the exact same authoritative service instances via options
      await app.register(authRoutes, {
        prefix: '/auth',
        userService: mockUser as any,
        sessionService: mockSession as any,
      });
      await app.ready();

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'alice', password: 'ValidPassword123!' },
        });

        expect(response.statusCode).toBe(200);
        expect(mockUser.verifyCredentials).toHaveBeenCalled();
        expect(mockSession.createSession).toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('fails closed when injected userService does not match authoritative Fastify userService instance (Finding 2)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      const { userService: authoritativeUser, sessionService } = createMockServices();
      await app.register(authPlugin, {
        userService: authoritativeUser as any,
        sessionService: sessionService as any,
      });

      // Injected userService differs from authoritative Fastify decorator
      const conflictingUser = {
        verifyCredentials: vi.fn(),
        findById: vi.fn(),
        sanitizeUser: vi.fn(),
      };

      await expect(
        app.register(authRoutes, {
          prefix: '/auth',
          userService: conflictingUser as any,
        })
      ).rejects.toThrow(/Injected userService does not match authoritative Fastify userService instance/);
    });

    it('fails closed when injected sessionService does not match authoritative Fastify sessionService instance (Finding 2)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      const { userService, sessionService: authoritativeSession } = createMockServices();
      await app.register(authPlugin, {
        userService: userService as any,
        sessionService: authoritativeSession as any,
      });

      // Injected sessionService differs from authoritative Fastify decorator
      const conflictingSession = {
        createSession: vi.fn(),
        revokeSession: vi.fn(),
        validateSession: vi.fn(),
      };

      await expect(
        app.register(authRoutes, {
          prefix: '/auth',
          sessionService: conflictingSession as any,
        })
      ).rejects.toThrow(/Injected sessionService does not match authoritative Fastify sessionService instance/);
    });

    it('does not construct an unnecessary second DB pool when authoritative services exist (Finding 2)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      const { userService, sessionService } = createMockServices();
      await app.register(authPlugin, {
        userService: userService as any,
        sessionService: sessionService as any,
      });

      // Pass an invalid fake connection string that would throw if pg.Pool were constructed
      // T016 integration registration syntax: { prefix: '/auth', databaseUrl: '...' }
      await app.register(authRoutes, {
        prefix: '/auth',
        databaseUrl: 'postgresql://invalid-host-should-never-be-connected:9999/fake',
      });
      await app.ready();

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'alice', password: 'ValidPassword123!' },
        });

        // Reuses authoritative services without touching fake databaseUrl
        expect(response.statusCode).toBe(200);
        expect(userService.verifyCredentials).toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('fails closed when required services cannot be resolved despite plugins being present', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie, { secret: TEST_SECRET });
      await app.register(csrfPlugin, { cookieSecret: TEST_SECRET });

      // Mock authPlugin decorations without userService or sessionService
      const mockAuth = async (instance: FastifyInstance) => {
        instance.decorate('authenticate', async () => {});
        instance.decorate('setSessionCookie', ((reply: any) => reply) as any);
        instance.decorate('clearSessionCookie', ((reply: any) => reply) as any);
        instance.decorateReply('setSessionCookie', function (this: any) { return this; });
        instance.decorateReply('clearSessionCookie', function (this: any) { return this; });
      };
      (mockAuth as any)[Symbol.for('skip-override')] = true;
      await app.register(mockAuth);

      await expect(app.register(authRoutes, { prefix: '/auth' })).rejects.toThrow(
        /Auth routes require UserService and SessionService/
      );
    });
  });
});
