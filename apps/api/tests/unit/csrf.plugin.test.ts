import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import {
  csrfPlugin,
  CsrfError,
  DEFAULT_CSRF_COOKIE_NAME,
  resolveCookieSecure,
  isValidCookieDomain,
  isSafeMethod,
  isBootstrapLoginRoute,
  isRouteCsrfExempt,
  getCsrfToken,
  getCsrfSecret,
} from '../../src/plugins/csrf.ts';
import { authPlugin } from '../../src/plugins/auth.ts';

// Helper to parse Set-Cookie header into key-value and attributes
function parseCookieHeader(headerValue?: string | string[]): Record<string, string | boolean> {
  if (!headerValue) return {};
  const single = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const parts = single.split(';').map((p) => p.trim());
  const result: Record<string, string | boolean> = {};

  const [cookiePair] = parts;
  const eqIdx = cookiePair.indexOf('=');
  if (eqIdx !== -1) {
    result.name = cookiePair.slice(0, eqIdx);
    result.value = cookiePair.slice(eqIdx + 1);
  }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const eq = part.indexOf('=');
    if (eq !== -1) {
      result[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
    } else {
      result[part.toLowerCase()] = true;
    }
  }

  return result;
}

describe('CSRF Protection Plugin (T021)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(csrfPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // 1. Successful plugin registration
  // =========================================================================
  describe('1. Plugin Registration', () => {
    it('registers successfully and decorates fastify and reply', async () => {
      expect(app.hasDecorator('csrfProtection')).toBe(true);
      expect(typeof app.csrfProtection).toBe('function');
      expect(app.hasDecorator('generateCsrf')).toBe(true);

      app.get('/test-reg', async (req, reply) => {
        expect(typeof reply.generateCsrf).toBe('function');
        const token = reply.generateCsrf();
        return { token };
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/test-reg' });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().token).toBe('string');
    });

    it('automatically registers @fastify/cookie if omitted by caller', async () => {
      const independentApp = Fastify();
      await independentApp.register(errorHandlerPlugin);
      // Register csrfPlugin without registering cookie plugin beforehand
      await independentApp.register(csrfPlugin);
      expect(independentApp.parseCookie).toBeDefined();
      await independentApp.close();
    });
  });

  // =========================================================================
  // 2. Safe GET, HEAD, OPTIONS requests without CSRF tokens
  // =========================================================================
  describe('2. Safe HTTP Methods Exemption', () => {
    beforeEach(async () => {
      app.get('/safe-get', async () => ({ method: 'GET' }));
      app.head('/safe-head', async (req, reply) => {
        reply.header('x-safe-head', 'true');
        return reply.status(200).send();
      });
      app.options('/safe-options', async (req, reply) => {
        reply.header('allow', 'GET, HEAD, OPTIONS, POST');
        return reply.status(200).send();
      });
      await app.ready();
    });

    it('permits safe GET requests without CSRF tokens or cookies', async () => {
      const res = await app.inject({ method: 'GET', url: '/safe-get' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ method: 'GET' });
    });

    it('permits safe HEAD requests without CSRF tokens or cookies', async () => {
      const res = await app.inject({ method: 'HEAD', url: '/safe-head' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-safe-head']).toBe('true');
    });

    it('permits safe OPTIONS requests without CSRF tokens or cookies', async () => {
      const res = await app.inject({ method: 'OPTIONS', url: '/safe-options' });
      expect(res.statusCode).toBe(200);
      expect(res.headers.allow).toBe('GET, HEAD, OPTIONS, POST');
    });
  });

  // =========================================================================
  // 3. Rejection of POST without CSRF token
  // =========================================================================
  describe('3. Rejection of POST without CSRF Token', () => {
    beforeEach(async () => {
      app.post('/unsafe-post', async () => ({ success: true }));
      app.get('/get-token', async (req, reply) => ({ token: reply.generateCsrf() }));
      await app.ready();
    });

    it('rejects POST with completely missing token and cookie (HTTP 403 and CSRF_TOKEN_INVALID)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        payload: { field: 'value' },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('CSRF_TOKEN_INVALID');
      expect(body.error.message).toBe('Permission denied');
      expect(typeof body.error.request_id).toBe('string');
      expect(body.error.details).toEqual({});
    });

    it('rejects POST with secret cookie present but missing x-csrf-token header', async () => {
      const tokenRes = await app.inject({ method: 'GET', url: '/get-token' });
      const cookieHeader = tokenRes.headers['set-cookie']?.toString().split(';')[0];

      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          cookie: cookieHeader,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects POST with x-csrf-token header present but missing secret cookie', async () => {
      const tokenRes = await app.inject({ method: 'GET', url: '/get-token' });
      const validToken = tokenRes.json().token;

      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          'x-csrf-token': validToken,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  // =========================================================================
  // 4. Rejection of PUT, PATCH, DELETE without CSRF token
  // =========================================================================
  describe('4. Rejection of Unsafe Methods (PUT, PATCH, DELETE)', () => {
    beforeEach(async () => {
      app.put('/resource/1', async () => ({ method: 'PUT' }));
      app.patch('/resource/1', async () => ({ method: 'PATCH' }));
      app.delete('/resource/1', async () => ({ method: 'DELETE' }));
      await app.ready();
    });

    it('rejects PUT without CSRF token with HTTP 403 CSRF_TOKEN_INVALID', async () => {
      const res = await app.inject({ method: 'PUT', url: '/resource/1' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects PATCH without CSRF token with HTTP 403 CSRF_TOKEN_INVALID', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/resource/1' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects DELETE without CSRF token with HTTP 403 CSRF_TOKEN_INVALID', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/resource/1' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  // =========================================================================
  // 5. Rejection of malformed and tampered tokens
  // =========================================================================
  describe('5. Rejection of Malformed and Tampered Tokens', () => {
    let cookieHeader: string;
    let genuineToken: string;

    beforeEach(async () => {
      app.get('/get-token', async (req, reply) => ({ token: reply.generateCsrf() }));
      app.post('/unsafe-post', async () => ({ success: true }));
      await app.ready();

      const tokenRes = await app.inject({ method: 'GET', url: '/get-token' });
      genuineToken = tokenRes.json().token;
      cookieHeader = tokenRes.headers['set-cookie']?.toString().split(';')[0]!;
    });

    it('rejects tampered token value (appended characters)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': `${genuineToken}modified`,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects token generated against a different secret (forged token)', async () => {
      // Obtain a second token from an independent instance
      const secondApp = Fastify();
      await secondApp.register(errorHandlerPlugin);
      await secondApp.register(csrfPlugin);
      secondApp.get('/get-token-2', async (req, reply) => ({ token: reply.generateCsrf() }));
      await secondApp.ready();

      const secondTokenRes = await secondApp.inject({ method: 'GET', url: '/get-token-2' });
      const foreignToken = secondTokenRes.json().token;
      await secondApp.close();

      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          cookie: cookieHeader, // App 1 cookie
          'x-csrf-token': foreignToken, // App 2 token
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects arbitrary placeholder strings (dummy tokens)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': 'csrf-token-placeholder',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects empty or whitespace-only token string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': '    ',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  // =========================================================================
  // 6. Acceptance of genuine valid tokens generated by the plugin
  // =========================================================================
  describe('6. Acceptance of Genuine Valid Tokens', () => {
    it('accepts genuine valid token with matching CSRF cookie', async () => {
      app.get('/get-token', async (req, reply) => ({ token: reply.generateCsrf() }));
      app.post('/unsafe-post', async () => ({ success: true }));
      await app.ready();

      const tokenRes = await app.inject({ method: 'GET', url: '/get-token' });
      const genuineToken = tokenRes.json().token;
      const cookieHeader = tokenRes.headers['set-cookie']?.toString().split(';')[0]!;

      const res = await app.inject({
        method: 'POST',
        url: '/unsafe-post',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': genuineToken,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  // =========================================================================
  // 7. Token/header and CSRF cookie verification together
  // =========================================================================
  describe('7. Token and Cookie Pair Verification', () => {
    it('validates that token and secret cookie form an interdependent cryptographic pair', async () => {
      app.get('/get-token', async (req, reply) => ({ token: reply.generateCsrf() }));
      app.post('/api/action', async () => ({ ok: true }));
      await app.ready();

      const r1 = await app.inject({ method: 'GET', url: '/get-token' });
      const t1 = r1.json().token;
      const c1 = r1.headers['set-cookie']?.toString().split(';')[0]!;

      const r2 = await app.inject({ method: 'GET', url: '/get-token' });
      const t2 = r2.json().token;
      const c2 = r2.headers['set-cookie']?.toString().split(';')[0]!;

      // Pair 1 succeeds
      const ok1 = await app.inject({
        method: 'POST',
        url: '/api/action',
        headers: { cookie: c1, 'x-csrf-token': t1 },
      });
      expect(ok1.statusCode).toBe(200);

      // Pair 2 succeeds
      const ok2 = await app.inject({
        method: 'POST',
        url: '/api/action',
        headers: { cookie: c2, 'x-csrf-token': t2 },
      });
      expect(ok2.statusCode).toBe(200);

      // Mixed pair (c1 with t2) fails
      const bad = await app.inject({
        method: 'POST',
        url: '/api/action',
        headers: { cookie: c1, 'x-csrf-token': t2 },
      });
      expect(bad.statusCode).toBe(403);
      expect(bad.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  // =========================================================================
  // 8. Bootstrap login exception limited to POST /auth/login
  // =========================================================================
  describe('8. Bootstrap Login Exception', () => {
    beforeEach(async () => {
      app.post('/auth/login', async () => ({ login: 'success' }));
      app.post('/auth/login/callback', async () => ({ callback: true }));
      app.post('/auth/register', async () => ({ register: true }));
      app.put('/auth/login', async () => ({ put: true }));
      app.delete('/auth/login', async () => ({ delete: true }));
      await app.ready();
    });

    it('permits unauthenticated POST /auth/login without CSRF token or cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'test_user', password: 'secret_password' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ login: 'success' });
    });

    it('permits unauthenticated POST /auth/login with query strings (exact path match)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login?redirect=/dashboard&client=web',
        payload: { username: 'test_user' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('does NOT exempt subpaths like POST /auth/login/callback', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login/callback',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('does NOT exempt other auth routes like POST /auth/register', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('does NOT exempt non-POST methods on /auth/login (PUT, DELETE fail closed)', async () => {
      const putRes = await app.inject({ method: 'PUT', url: '/auth/login' });
      expect(putRes.statusCode).toBe(403);

      const delRes = await app.inject({ method: 'DELETE', url: '/auth/login' });
      expect(delRes.statusCode).toBe(403);
    });

    it('fails closed if POST /auth/login is explicitly declared protected', async () => {
      const strictApp = Fastify();
      await strictApp.register(errorHandlerPlugin);
      await strictApp.register(csrfPlugin);

      strictApp.post('/auth/login', { config: { csrf: true } }, async () => ({ strict: true }));
      await strictApp.ready();

      const res = await strictApp.inject({ method: 'POST', url: '/auth/login' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
      await strictApp.close();
    });
  });

  // =========================================================================
  // 9. Logout POST protected from CSRF
  // =========================================================================
  describe('9. POST /auth/logout Protection', () => {
    beforeEach(async () => {
      app.get('/get-token', async (req, reply) => ({ token: reply.generateCsrf() }));
      app.post('/auth/logout', async () => ({ logout: true }));
      await app.ready();
    });

    it('strictly requires CSRF token for POST /auth/logout (rejects missing token)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('allows POST /auth/logout when genuine CSRF token and cookie are supplied', async () => {
      const tokenRes = await app.inject({ method: 'GET', url: '/get-token' });
      const genuineToken = tokenRes.json().token;
      const cookieHeader = tokenRes.headers['set-cookie']?.toString().split(';')[0]!;

      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': genuineToken,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ logout: true });
    });
  });

  // =========================================================================
  // 10. Explicit public routes are not automatically exempt from unsafe-method CSRF protection
  // =========================================================================
  describe('10. Public Routes vs CSRF Protection', () => {
    it('does NOT exempt routes marked public for authentication from CSRF on unsafe methods', async () => {
      app.post('/public-submission', { config: { public: true } }, async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/public-submission',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('exempts route only when explicitly configured with config: { csrf: false }', async () => {
      app.post('/webhook', { config: { csrf: false } }, async () => ({ webhook: 'received' }));
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ webhook: 'received' });
    });

    it('fails closed if route has conflicting config { csrf: false, protected: true }', async () => {
      app.post('/conflicting', { config: { csrf: false, protected: true } }, async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/conflicting',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  // =========================================================================
  // 11. Nested Fastify routes cannot bypass enforcement
  // =========================================================================
  describe('11. Nested Fastify Routes Enforcement', () => {
    it('enforces CSRF across child plugins and route prefixes', async () => {
      await app.register(
        async (childInstance) => {
          childInstance.post('/nested-action', async () => ({ nested: true }));
          childInstance.register(
            async (grandchild) => {
              grandchild.post('/deep', async () => ({ deep: true }));
            },
            { prefix: '/v2' }
          );
        },
        { prefix: '/api/v1' }
      );
      await app.ready();

      // Child route fails without CSRF
      const r1 = await app.inject({ method: 'POST', url: '/api/v1/nested-action' });
      expect(r1.statusCode).toBe(403);
      expect(r1.json().error.code).toBe('CSRF_TOKEN_INVALID');

      // Grandchild route fails without CSRF
      const r2 = await app.inject({ method: 'POST', url: '/api/v1/v2/deep' });
      expect(r2.statusCode).toBe(403);
      expect(r2.json().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  // =========================================================================
  // 12. Production Secure cookie enforcement
  // =========================================================================
  describe('12. Production Secure Cookie Enforcement', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('strictly enforces Secure=true in production even if caller attempts secure: false', async () => {
      process.env.NODE_ENV = 'production';

      const prodApp = Fastify();
      await prodApp.register(errorHandlerPlugin);
      await prodApp.register(csrfPlugin, { secure: false });

      prodApp.get('/token', async (req, reply) => {
        return { token: reply.generateCsrf({ secure: false } as any) };
      });
      await prodApp.ready();

      const res = await prodApp.inject({ method: 'GET', url: '/token' });
      const parsed = parseCookieHeader(res.headers['set-cookie']);
      expect(parsed.secure).toBe(true);

      await prodApp.close();
    });

    it('permits non-secure cookies in test/development when secure is not set', async () => {
      process.env.NODE_ENV = 'test';

      const devApp = Fastify();
      await devApp.register(errorHandlerPlugin);
      await devApp.register(csrfPlugin);

      devApp.get('/token', async (req, reply) => ({ token: reply.generateCsrf() }));
      await devApp.ready();

      const res = await devApp.inject({ method: 'GET', url: '/token' });
      const parsed = parseCookieHeader(res.headers['set-cookie']);
      expect(parsed.secure).toBeUndefined();

      await devApp.close();
    });
  });

  // =========================================================================
  // 13. HttpOnly, SameSite, Path, and cookie integrity properties
  // =========================================================================
  describe('13. Rigid Cookie Invariants', () => {
    it('rigidly enforces HttpOnly=true, SameSite=Lax, and Path=/', async () => {
      app.get('/token', async (req, reply) => {
        // Attempt weakening via generateCsrf caller arguments
        const token = reply.generateCsrf({
          httpOnly: false,
          sameSite: 'none',
          path: '/subpath',
        } as any);
        return { token };
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/token' });
      const parsed = parseCookieHeader(res.headers['set-cookie']);

      expect(parsed.name).toBe(DEFAULT_CSRF_COOKIE_NAME);
      expect(parsed.httponly).toBe(true);
      expect(parsed.samesite?.toString().toLowerCase()).toBe('lax');
      expect(parsed.path).toBe('/');
    });

    it('rejects overly broad cookie domains like .com or single labels', async () => {
      const domainApp = Fastify();
      await domainApp.register(errorHandlerPlugin);
      await domainApp.register(csrfPlugin, { domain: '.com' });

      domainApp.get('/token', async (req, reply) => ({ token: reply.generateCsrf() }));
      await domainApp.ready();

      const res = await domainApp.inject({ method: 'GET', url: '/token' });
      const parsed = parseCookieHeader(res.headers['set-cookie']);
      expect(parsed.domain).toBeUndefined();

      await domainApp.close();
    });
  });

  // =========================================================================
  // 14. Consistent HTTP 403 and standardized CSRF error response
  // =========================================================================
  describe('14. Standard Error Envelope Conformance', () => {
    it('returns exact standard error envelope with request_id and no leaked internal data', async () => {
      app.post('/api/action', async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/action',
        headers: {
          'x-request-id': 'custom-req-id-12345',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toContain('application/json');

      const body = res.json();
      expect(body).toEqual({
        error: {
          code: 'CSRF_TOKEN_INVALID',
          message: 'Permission denied',
          request_id: 'custom-req-id-12345',
          details: {},
        },
      });
    });
  });

  // =========================================================================
  // 15. CSRF plugin behavior alongside T020 Authentication
  // =========================================================================
  describe('15. Integration with T020 Authentication', () => {
    it('fails closed on POST when valid auth session cookie is present but CSRF is omitted', async () => {
      const combinedApp = Fastify();
      await combinedApp.register(errorHandlerPlugin);
      await combinedApp.register(csrfPlugin);
      // Register authPlugin with mock services
      await combinedApp.register(authPlugin, {
        sessionService: {
          validateSession: async () => ({ id: 's1', user_id: 'u1', token_digest: 'd', expires_at: new Date() }),
          verifySession: async () => ({ valid: true, session: null }),
        } as any,
        userService: {
          findById: async () => ({ id: 'u1', username: 'john', is_active: true }),
          sanitizeUser: (u: any) => u,
        } as any,
      });

      combinedApp.post('/api/account', async () => ({ updated: true }));
      await combinedApp.ready();

      const validSessionToken = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP1';

      // Valid session cookie, but NO CSRF token
      const res = await combinedApp.inject({
        method: 'POST',
        url: '/api/account',
        headers: {
          cookie: `session=${validSessionToken}`,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');

      await combinedApp.close();
    });

    it('allows request when BOTH valid auth session and valid CSRF token are provided', async () => {
      const combinedApp = Fastify();
      await combinedApp.register(errorHandlerPlugin);
      await combinedApp.register(csrfPlugin);
      await combinedApp.register(authPlugin, {
        sessionService: {
          validateSession: async () => ({ id: 's1', user_id: 'u1', token_digest: 'd', expires_at: new Date() }),
        } as any,
        userService: {
          findById: async () => ({ id: 'u1', username: 'john', is_active: true }),
          sanitizeUser: (u: any) => u,
        } as any,
      });

      combinedApp.get('/get-csrf', { config: { public: true } }, async (req, reply) => ({
        token: reply.generateCsrf(),
      }));
      combinedApp.post('/api/account', async () => ({ updated: true }));
      await combinedApp.ready();

      const validSessionToken = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP1';
      const csrfRes = await combinedApp.inject({ method: 'GET', url: '/get-csrf' });
      const csrfToken = csrfRes.json().token;
      const csrfCookie = csrfRes.headers['set-cookie']?.toString().split(';')[0];

      const res = await combinedApp.inject({
        method: 'POST',
        url: '/api/account',
        headers: {
          cookie: `session=${validSessionToken}; ${csrfCookie}`,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ updated: true });

      await combinedApp.close();
    });
  });

  // =========================================================================
  // 16. Failure handling for missing configuration or verification errors
  // =========================================================================
  describe('16. Fail-Closed Error Handling', () => {
    it('fails closed with signed cookie enabled when signature is invalid/tampered', async () => {
      const signedApp = Fastify();
      await signedApp.register(errorHandlerPlugin);
      await signedApp.register(fastifyCookie, { secret: 'secret-signature-key-1234567890' });
      await signedApp.register(csrfPlugin, { signed: true });

      signedApp.get('/token', async (req, reply) => ({ token: reply.generateCsrf() }));
      signedApp.post('/api/action', async () => ({ ok: true }));
      await signedApp.ready();

      const tokenRes = await signedApp.inject({ method: 'GET', url: '/token' });
      const validToken = tokenRes.json().token;
      const cookieHeader = tokenRes.headers['set-cookie']?.toString().split(';')[0]!;

      // Tamper signed cookie
      const tamperedCookie = `${cookieHeader}tampered`;

      const res = await signedApp.inject({
        method: 'POST',
        url: '/api/action',
        headers: {
          cookie: tamperedCookie,
          'x-csrf-token': validToken,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');

      await signedApp.close();
    });
  });

  // =========================================================================
  // 17. Absence of secret/token leakage in errors and logs
  // =========================================================================
  describe('17. Leak Prevention', () => {
    it('does not leak secrets, token strings, stack traces, or SQL in error response', async () => {
      app.get('/token', async (req, reply) => ({ token: reply.generateCsrf() }));
      app.post('/unsafe', async () => ({ ok: true }));
      await app.ready();

      const tokenRes = await app.inject({ method: 'GET', url: '/token' });
      const secretCookie = tokenRes.headers['set-cookie']?.toString().split(';')[0]!;
      const secretValue = secretCookie.split('=')[1];

      const res = await app.inject({
        method: 'POST',
        url: '/unsafe',
        headers: {
          cookie: secretCookie,
          'x-csrf-token': 'bad-token-attempt',
        },
      });

      const bodyText = res.body;
      expect(bodyText).not.toContain(secretValue);
      expect(bodyText).not.toContain('bad-token-attempt');
      expect(bodyText).not.toContain('stack');
      expect(bodyText).not.toContain('SELECT');
      expect(bodyText).not.toContain('node_modules');
    });
  });
});
