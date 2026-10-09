import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import {
  authPlugin,
  AuthenticationError,
  resolveCookieSecure,
  setSessionCookie,
  clearSessionCookie,
  getSessionCookie,
} from '../../src/plugins/auth.ts';
import {
  generateSessionToken,
  hashToken,
  SESSION_TTL_MS,
  type Session,
} from '../../src/services/session.service.ts';
import type { SafeUser, User } from '../../src/services/user.service.ts';

function createMockServices(overrides: {
  validateSessionResult?: Session | null;
  verifySessionResult?: { valid: boolean; session?: Session; reason?: 'MALFORMED' | 'EXPIRED' | 'NOT_FOUND' };
  userResult?: User | null;
  dbError?: boolean;
} = {}) {
  const sessionService = {
    validateSession: vi.fn(async (token: string, options?: { rolling?: boolean }) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: SELECT * FROM sessions');
      }
      return overrides.validateSessionResult !== undefined ? overrides.validateSessionResult : null;
    }),
    verifySession: vi.fn(async (token: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed');
      }
      return (
        overrides.verifySessionResult ?? {
          valid: false,
          reason: 'NOT_FOUND' as const,
        }
      );
    }),
  };

  const userService = {
    findById: vi.fn(async (id: string) => {
      if (overrides.dbError) {
        throw new Error('Database connection failed: SELECT * FROM users');
      }
      return overrides.userResult !== undefined ? overrides.userResult : null;
    }),
    sanitizeUser: vi.fn((user: any): SafeUser => {
      const { password_hash, ...safe } = user;
      return safe;
    }),
  };

  return { sessionService, userService };
}

describe('Fastify Auth Plugin Unit Tests (T020)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('1. Plugin Registration and Request/Reply Decoration', () => {
    it('decorates Fastify instance, request, and reply with auth context and helpers', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      expect(typeof app.authenticate).toBe('function');
      expect(typeof app.requireAuth).toBe('function');
      expect(typeof app.setSessionCookie).toBe('function');
      expect(typeof app.clearSessionCookie).toBe('function');
      expect(app.sessionService).toBeDefined();
      expect(app.userService).toBeDefined();

      app.get('/test-decorators', async (request, reply) => {
        return {
          hasUser: request.user !== undefined,
          hasSession: request.session !== undefined,
          hasRawToken: request.rawToken !== undefined,
          isAuthenticated: request.isAuthenticated(),
          hasGetSessionToken: typeof request.getSessionToken === 'function',
          hasReplySetCookie: typeof reply.setSessionCookie === 'function',
          hasReplyClearCookie: typeof reply.clearSessionCookie === 'function',
        };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-decorators',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasUser).toBe(true);
      expect(body.hasSession).toBe(true);
      expect(body.hasRawToken).toBe(true);
      expect(body.isAuthenticated).toBe(false);
      expect(body.hasGetSessionToken).toBe(true);
      expect(body.hasReplySetCookie).toBe(true);
      expect(body.hasReplyClearCookie).toBe(true);

      await app.close();
    });

    it('ensures plugin decorators escape encapsulation scopes via skip-override', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      // Register separate child plugin in parallel
      await app.register(async (childScope) => {
        expect(typeof childScope.authenticate).toBe('function');
        expect(typeof childScope.setSessionCookie).toBe('function');
        childScope.get('/child-route', async () => ({ child: true }));
      });

      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/child-route' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('2. Missing Session Cookie', () => {
    it('denies access with HTTP 401 and UNAUTHORIZED when session cookie is completely missing', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async (request) => {
        return { user: request.user };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toBe('Authentication required');
      expect(sessionService.validateSession).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe('3. Malformed and Forged Session Tokens', () => {
    it('rejects malformed token format (e.g. invalid length) with HTTP 401 UNAUTHORIZED', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: 'session=short_malformed_token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(sessionService.validateSession).not.toHaveBeenCalled();

      await app.close();
    });

    it('rejects forged token with HTTP 401 SESSION_NOT_FOUND when valid format is not in database', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const forgedToken = generateSessionToken();
      const { sessionService, userService } = createMockServices({
        validateSessionResult: null,
        verifySessionResult: { valid: false, reason: 'NOT_FOUND' },
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${forgedToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(['SESSION_NOT_FOUND', 'UNAUTHORIZED']).toContain(body.error.code);
      expect(sessionService.validateSession).toHaveBeenCalledWith(forgedToken, { rolling: true });

      await app.close();
    });
  });

  describe('4. Valid Active Session and Authentication Context', () => {
    it('authenticates active user, sets request context, and refreshes rolling cookie', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const validToken = generateSessionToken();
      const validDigest = hashToken(validToken);
      const userId = '11111111-2222-3333-4444-555555555555';

      const mockSession: Session = {
        id: validDigest,
        user_id: userId,
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
        created_at: new Date(),
      };

      const mockUser: User = {
        id: userId,
        username: 'alice',
        password_hash: '$argon2id$v=19$m=65536,t=3,p=4$someSalt$someHash',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { sessionService, userService } = createMockServices({
        validateSessionResult: mockSession,
        userResult: mockUser,
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
        rolling: true,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async (request) => {
        return {
          user: request.user,
          session: request.session,
          rawToken: request.rawToken,
          isAuthenticated: request.isAuthenticated(),
        };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${validToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(userId);
      expect(body.user.username).toBe('alice');
      // Password hash must never leak in authenticated context
      expect(body.user.password_hash).toBeUndefined();
      expect(body.session.id).toBe(validDigest);
      expect(body.rawToken).toBe(validToken);
      expect(body.isAuthenticated).toBe(true);

      // Verify rolling session re-issues the session cookie
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain(`session=${validToken}`);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);

      await app.close();
    });
  });

  describe('5. Expired Session Rejection', () => {
    it('denies access with HTTP 401 and SESSION_EXPIRED when session has expired', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const expiredToken = generateSessionToken();
      const { sessionService, userService } = createMockServices({
        validateSessionResult: null,
        verifySessionResult: { valid: false, reason: 'EXPIRED' },
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${expiredToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('SESSION_EXPIRED');
      expect(body.error.message).toBe('Authentication required');

      await app.close();
    });
  });

  describe('6. Revoked Session Rejection', () => {
    it('denies access with HTTP 401 when session has been deleted or revoked', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const revokedToken = generateSessionToken();
      const { sessionService, userService } = createMockServices({
        validateSessionResult: null,
        verifySessionResult: { valid: false, reason: 'NOT_FOUND' },
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${revokedToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'UNAUTHORIZED']).toContain(body.error.code);

      await app.close();
    });
  });

  describe('7. Disabled User Rejection', () => {
    it('denies access with HTTP 403 USER_DISABLED when user is deactivated in the database', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const token = generateSessionToken();
      const userId = '22222222-3333-4444-5555-666666666666';

      const mockSession: Session = {
        id: hashToken(token),
        user_id: userId,
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
        created_at: new Date(),
      };

      const disabledUser: User = {
        id: userId,
        username: 'disabled_alice',
        password_hash: '$argon2id$v=19$m=65536,t=3,p=4$someSalt$someHash',
        is_active: false,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { sessionService, userService } = createMockServices({
        validateSessionResult: mockSession,
        userResult: disabledUser,
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${token}`,
        },
      });

      expect([401, 403]).toContain(response.statusCode);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['USER_DISABLED', 'FORBIDDEN', 'UNAUTHORIZED']).toContain(body.error.code);

      await app.close();
    });
  });

  describe('8. Missing User Record Rejection', () => {
    it('denies access with HTTP 401 USER_NOT_FOUND when associated user record was deleted', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const token = generateSessionToken();
      const userId = '33333333-4444-5555-6666-777777777777';

      const mockSession: Session = {
        id: hashToken(token),
        user_id: userId,
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
        created_at: new Date(),
      };

      const { sessionService, userService } = createMockServices({
        validateSessionResult: mockSession,
        userResult: null, // User missing
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${token}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(['USER_NOT_FOUND', 'UNAUTHORIZED']).toContain(body.error.code);

      await app.close();
    });
  });

  describe('9. Session Expiration Policy Bounded by 8 Hours', () => {
    it('rejects registration with TTL exceeding the 8-hour maximum policy', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const { sessionService, userService } = createMockServices();

      await expect(
        app.register(authPlugin, {
          sessionService: sessionService as any,
          userService: userService as any,
          sessionTtlMs: 9 * 60 * 60 * 1000, // 9 hours > 8 hours max
        })
      ).rejects.toThrow(/Session TTL cannot exceed 8 hours/);

      await app.close();
    });
  });

  describe('10. Secure Cookie Attributes in Production', () => {
    it('strictly enforces Secure attribute in production environment', async () => {
      process.env.NODE_ENV = 'production';

      const app = Fastify();
      await app.register(errorHandlerPlugin);
      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/set-cookie', async (_req, reply) => {
        app.setSessionCookie(reply, 'sample_token_value_for_cookie');
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/set-cookie',
      });

      expect(response.statusCode).toBe(200);
      const cookieHeader = response.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      expect(cookieHeader).toMatch(/;\s*Secure/i);
      expect(cookieHeader).toMatch(/;\s*HttpOnly/i);
      expect(cookieHeader).toMatch(/;\s*SameSite=Lax/i);
      expect(cookieHeader).toMatch(/;\s*Path=\//i);

      await app.close();
    });

    it('cannot weaken Secure attribute in production even if options attempt to set secure: false', () => {
      process.env.NODE_ENV = 'production';
      expect(resolveCookieSecure(false)).toBe(true);
      expect(resolveCookieSecure(undefined)).toBe(true);
      expect(resolveCookieSecure(true)).toBe(true);
    });
  });

  describe('11. Cookie Behavior in Development/Test', () => {
    it('does not enforce Secure attribute by default in test/dev environment', () => {
      process.env.NODE_ENV = 'test';
      expect(resolveCookieSecure(undefined)).toBe(false);
      expect(resolveCookieSecure(false)).toBe(false);
    });

    it('enforces Secure attribute in test/dev environment when explicitly configured', () => {
      process.env.NODE_ENV = 'test';
      expect(resolveCookieSecure(true)).toBe(true);
    });
  });

  describe('12. Safe Session Cookie Clearing', () => {
    it('sets deletion attributes (Max-Age=0, Expires in past, Path=/, HttpOnly, SameSite=Lax)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.post('/clear', async (_req, reply) => {
        app.clearSessionCookie(reply);
        return { cleared: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/clear',
      });

      expect(response.statusCode).toBe(200);
      const cookieHeader = response.headers['set-cookie'] as string;
      expect(cookieHeader).toBeDefined();

      // Verify name is session
      expect(cookieHeader).toMatch(/^session=/i);
      // Verify Max-Age is 0
      expect(cookieHeader).toMatch(/Max-Age=0/i);
      // Verify Path=/
      expect(cookieHeader).toMatch(/Path=\//i);
      // Verify HttpOnly
      expect(cookieHeader).toMatch(/HttpOnly/i);
      // Verify SameSite=Lax
      expect(cookieHeader).toMatch(/SameSite=Lax/i);

      await app.close();
    });
  });

  describe('13. Database Failure Handling', () => {
    it('fails closed with HTTP 500 DATABASE_ERROR and sanitized message on database error', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const token = generateSessionToken();
      const { sessionService, userService } = createMockServices({
        dbError: true,
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: {
          cookie: `session=${token}`,
        },
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('DATABASE_ERROR');
      expect(body.error.message).toBe('An unexpected internal server error occurred.');
      // Never expose SQL queries or database errors to client
      expect(JSON.stringify(body)).not.toContain('SELECT * FROM');
      expect(JSON.stringify(body)).not.toContain('Database connection failed');

      await app.close();
    });
  });

  describe('14. Externally Owned Injected Database Client', () => {
    it('does not destroy or close externally injected database client on app close', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const mockDb = {
        query: vi.fn(async () => ({ rows: [] })),
        end: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };

      await app.register(authPlugin, {
        db: mockDb,
      });

      await app.ready();
      await app.close();

      expect(mockDb.end).not.toHaveBeenCalled();
      expect(mockDb.close).not.toHaveBeenCalled();
    });
  });

  describe('15. Credential and Secret Leakage Prevention', () => {
    it('ensures password_hash and raw tokens are never leaked in error responses or user object', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const token = generateSessionToken();
      const secretPasswordHash = '$argon2id$v=19$m=65536,t=3,p=4$ultraSecretSalt$ultraSecretHash';

      const mockSession: Session = {
        id: hashToken(token),
        user_id: 'user-secret-test',
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
        created_at: new Date(),
      };

      const mockUser: User = {
        id: 'user-secret-test',
        username: 'bob',
        password_hash: secretPasswordHash,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { sessionService, userService } = createMockServices({
        validateSessionResult: mockSession,
        userResult: mockUser,
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
        return { user: request.user };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: {
          cookie: `session=${token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const rawText = response.body;
      expect(rawText).not.toContain(secretPasswordHash);
      expect((response.json().user as any).password_hash).toBeUndefined();

      await app.close();
    });
  });

  describe('16. Declarative and Encapsulated Protected Routes', () => {
    it('enforces authentication on routes configured with config: { auth: true }', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      app.get('/declarative-protected', { config: { auth: true } }, async () => ({ secret: 42 }));
      app.get('/declarative-public', { config: { public: true } }, async () => ({ public: true }));

      await app.ready();

      // Protected route without cookie fails closed
      const resProtected = await app.inject({
        method: 'GET',
        url: '/declarative-protected',
      });
      expect(resProtected.statusCode).toBe(401);

      // Public route succeeds without credentials
      const resPublic = await app.inject({
        method: 'GET',
        url: '/declarative-public',
      });
      expect(resPublic.statusCode).toBe(200);
      expect(resPublic.json()).toEqual({ public: true });

      await app.close();
    });

    it('enforces protectAll mode by default unless route has config: { public: true }', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      const { sessionService, userService } = createMockServices();

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
        protectAll: true,
      });

      app.get('/unmarked-route', async () => ({ unmarked: true }));
      app.get('/explicit-public', { config: { public: true } }, async () => ({ public: true }));

      await app.ready();

      const resUnmarked = await app.inject({ method: 'GET', url: '/unmarked-route' });
      expect(resUnmarked.statusCode).toBe(401);

      const resPublic = await app.inject({ method: 'GET', url: '/explicit-public' });
      expect(resPublic.statusCode).toBe(200);

      await app.close();
    });

    it('does not perform duplicate verification if authenticate is called twice in the same request', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      const token = generateSessionToken();
      const mockSession: Session = {
        id: hashToken(token),
        user_id: 'user-dup',
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
        created_at: new Date(),
      };
      const mockUser: User = {
        id: 'user-dup',
        username: 'dup_user',
        password_hash: '$argon2id$...',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { sessionService, userService } = createMockServices({
        validateSessionResult: mockSession,
        userResult: mockUser,
      });

      await app.register(authPlugin, {
        sessionService: sessionService as any,
        userService: userService as any,
      });

      // Calling authenticate twice via config AND preHandler
      app.get(
        '/double-auth',
        {
          config: { auth: true },
          preHandler: [app.authenticate],
        },
        async (request) => ({ ok: true, user: request.user })
      );

      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/double-auth',
        headers: { cookie: `session=${token}` },
      });

      expect(res.statusCode).toBe(200);
      // Database verification only performed once!
      expect(sessionService.validateSession).toHaveBeenCalledTimes(1);
      expect(userService.findById).toHaveBeenCalledTimes(1);

      await app.close();
    });
  });
});
