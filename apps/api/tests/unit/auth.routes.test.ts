import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import { authPlugin } from '../../src/plugins/auth.ts';
import { csrfPlugin } from '../../src/plugins/csrf.ts';
import { authRoutes } from '../../src/routes/auth.routes.ts';
import type { SafeUser, User } from '../../src/services/user.service.ts';
import { generateSessionToken, type Session } from '../../src/services/session.service.ts';

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

async function setupRouteTestApp(options: {
  userService?: any;
  sessionService?: any;
  secure?: boolean;
  withCsrf?: boolean;
  prefix?: string;
} = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(fastifyCookie, {
    secret: 'test-secret-at-least-32-bytes-long-secret-key!!',
  });

  const { userService, sessionService } = createMockServices();
  const uService = options.userService ?? userService;
  const sService = options.sessionService ?? sessionService;

  if (options.withCsrf) {
    await app.register(csrfPlugin, {
      cookieSecret: 'test-secret-at-least-32-bytes-long-secret-key!!',
      secure: options.secure,
    });
  }

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

    it('sets secure session cookie on successful login', async () => {
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
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            cookie: `session=${dummyToken}`,
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
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            cookie: `session=${dummyToken}`,
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

    it('rejects unauthenticated logout attempt with HTTP 401 UNAUTHORIZED', async () => {
      const app = await setupRouteTestApp();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
        });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHORIZED');
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // 3. GET /auth/session-check
  // =========================================================================
  describe('GET /auth/session-check', () => {
    it('returns sanitized user information for active authenticated session', async () => {
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
  });

  // =========================================================================
  // 4. Fastify registration and dependency injection
  // =========================================================================
  describe('Fastify Registration and Dependency Injection', () => {
    it('works when mounted without prefix, defaulting to /auth routes', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie);

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

    it('reuses services provided directly via plugin options', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      await app.register(fastifyCookie);

      const { userService, sessionService } = createMockServices();
      await app.register(authRoutes, {
        prefix: '/auth',
        userService: userService as any,
        sessionService: sessionService as any,
      });
      await app.ready();

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'alice', password: 'ValidPassword123!' },
        });

        expect(response.statusCode).toBe(200);
        expect(userService.verifyCredentials).toHaveBeenCalled();
        expect(sessionService.createSession).toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('fails closed when required services cannot be resolved', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      await expect(app.register(authRoutes, { prefix: '/auth' })).rejects.toThrow(
        /Auth routes require UserService and SessionService/
      );
    });
  });
});
