import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import {
  requireCapability,
  AuthorizationError,
  type AuthorizationMiddlewareOptions,
} from '../../src/middleware/authorization.ts';
import { CapabilityService } from '../../src/services/capability.service.ts';

describe('Authorization Middleware Unit Tests (T025 - US2)', () => {
  const validUserId = 'a0000000-0000-4000-8000-000000000001';
  const mismatchedUserId = 'b0000000-0000-4000-8000-000000000002';

  interface TestAppOptions {
    capabilityService?: any;
    decorateServerService?: boolean;
    user?: any;
    session?: any;
    middlewareOptions?: AuthorizationMiddlewareOptions;
    requiredCapability?: string;
  }

  async function createTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(errorHandlerPlugin);

    if (opts.decorateServerService && opts.capabilityService) {
      app.decorate('capabilityService', opts.capabilityService);
    }

    // Simulate T020 global authentication hook populating request.user and request.session
    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (opts.user !== undefined) {
        (request as any).user = opts.user;
      }
      if (opts.session !== undefined) {
        (request as any).session = opts.session;
      }
    });

    const cap = opts.requiredCapability ?? 'system:maintain';
    const preHandler = requireCapability(cap, opts.middlewareOptions);

    app.get('/protected', { preHandler: [preHandler] }, async () => {
      return { status: 'ok', data: 'protected-system-payload' };
    });

    await app.ready();
    return app;
  }

  // =========================================================================
  // Required Test 1: Unauthenticated request returns 401
  // =========================================================================
  it('1. Unauthenticated request returns 401', async () => {
    // Both user and session absent
    const app = await createTestApp({
      capabilityService: { hasCapability: vi.fn().mockResolvedValue(true) },
      decorateServerService: true,
      user: undefined,
      session: undefined,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'UNAUTHORIZED');
    expect(body.error).toHaveProperty('message', 'Authentication required');
    expect(body.data).toBeUndefined();
    await app.close();
  });

  // =========================================================================
  // Required Test 2: Authenticated user without capability returns 403
  // =========================================================================
  it('2. Authenticated user without capability returns 403', async () => {
    const mockService = {
      hasCapability: vi.fn().mockResolvedValue(false),
    };

    const app = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'FORBIDDEN');
    expect(body.error).toHaveProperty('message', 'Permission denied');
    expect(body.data).toBeUndefined();
    expect(mockService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');
    await app.close();
  });

  // =========================================================================
  // Required Test 3: Authenticated user with required capability proceeds
  // =========================================================================
  it('3. Authenticated user with required capability proceeds', async () => {
    const mockService = {
      hasCapability: vi.fn().mockResolvedValue(true),
    };

    const app = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ status: 'ok', data: 'protected-system-payload' });
    expect(mockService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');
    await app.close();
  });

  // =========================================================================
  // Required Test 4: "SYSTEM_MAINTAINER" is authorized for "system:maintain"
  // =========================================================================
  it('4. "SYSTEM_MAINTAINER" is authorized for "system:maintain"', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' }],
      }),
    };
    const realService = new CapabilityService({ db: mockDb });

    const app = await createTestApp({
      capabilityService: realService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
      requiredCapability: 'system:maintain',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    await app.close();
  });

  // =========================================================================
  // Required Test 5: "ADMINISTRATOR" is authorized for "system:maintain"
  // =========================================================================
  it('5. "ADMINISTRATOR" is authorized for "system:maintain"', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ user_id: validUserId, is_active: true, role_id: 'ADMINISTRATOR' }],
      }),
    };
    const realService = new CapabilityService({ db: mockDb });

    const app = await createTestApp({
      capabilityService: realService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
      requiredCapability: 'system:maintain',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    await app.close();
  });

  // =========================================================================
  // Required Test 6: "READ_ONLY" is denied
  // =========================================================================
  it('6. "READ_ONLY" is denied', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ user_id: validUserId, is_active: true, role_id: 'READ_ONLY' }],
      }),
    };
    const realService = new CapabilityService({ db: mockDb });

    const app = await createTestApp({
      capabilityService: realService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
      requiredCapability: 'system:maintain',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'FORBIDDEN');
    expect(body.error).toHaveProperty('message', 'Permission denied');
    expect(body.data).toBeUndefined();
    await app.close();
  });

  // =========================================================================
  // Required Test 7: Unknown capability is denied
  // =========================================================================
  it('7. Unknown capability is denied', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ user_id: validUserId, is_active: true, role_id: 'ADMINISTRATOR' }],
      }),
    };
    const realService = new CapabilityService({ db: mockDb });

    const app = await createTestApp({
      capabilityService: realService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
      requiredCapability: 'system:unknown_custom_cap',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'FORBIDDEN');
    expect(body.data).toBeUndefined();
    await app.close();
  });

  // =========================================================================
  // Required Test 8: Missing CapabilityService fails closed
  // =========================================================================
  it('8. Missing CapabilityService fails closed', async () => {
    // 8a: Service is completely absent from server and options
    const appWithoutService = await createTestApp({
      capabilityService: undefined,
      decorateServerService: false,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    const responseWithoutService = await appWithoutService.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(responseWithoutService.statusCode).toBe(500);
    const body = responseWithoutService.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    expect(body.error).toHaveProperty('message', 'An unexpected internal server error occurred.');
    expect(body.data).toBeUndefined();
    await appWithoutService.close();

    // 8b: Service throws unexpected error (e.g. database crash) -> fails closed
    const appWithFailingService = await createTestApp({
      capabilityService: {
        hasCapability: vi.fn().mockRejectedValue(new Error('Fatal connection loss to PostgreSQL')),
      },
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    const responseWithFailingService = await appWithFailingService.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(responseWithFailingService.statusCode).toBe(500);
    const failBody = responseWithFailingService.json();
    expect(failBody.error).toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    expect(failBody.data).toBeUndefined();
    await appWithFailingService.close();
  });

  // =========================================================================
  // Required Test 9: Invalid user/session context is denied
  // =========================================================================
  it('9. Invalid user/session context is denied', async () => {
    const mockService = { hasCapability: vi.fn().mockResolvedValue(true) };

    // Case 9a: session has empty string user_id
    const appEmptySession = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: '' },
    });
    const respEmpty = await appEmptySession.inject({ method: 'GET', url: '/protected' });
    expect(respEmpty.statusCode).toBe(401);
    await appEmptySession.close();

    // Case 9b: user has empty id
    const appEmptyUser = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: '', is_active: true },
      session: { user_id: validUserId },
    });
    const respEmptyUser = await appEmptyUser.inject({ method: 'GET', url: '/protected' });
    expect(respEmptyUser.statusCode).toBe(401);
    await appEmptyUser.close();

    // Case 9c: user is not an object
    const appNonObjUser = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: 'invalid-user-string',
      session: { user_id: validUserId },
    });
    const respNonObj = await appNonObjUser.inject({ method: 'GET', url: '/protected' });
    expect(respNonObj.statusCode).toBe(401);
    await appNonObjUser.close();

    // Case 9d: user is disabled (is_active === false)
    const appDisabledUser = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: false },
      session: { user_id: validUserId },
    });
    const respDisabled = await appDisabledUser.inject({ method: 'GET', url: '/protected' });
    expect(respDisabled.statusCode).toBe(403);
    await appDisabledUser.close();
  });

  // =========================================================================
  // Required Test 10: Session/user ID mismatch fails closed
  // =========================================================================
  it('10. Session/user ID mismatch fails closed', async () => {
    const mockService = { hasCapability: vi.fn().mockResolvedValue(true) };

    const app = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: mismatchedUserId, is_active: true },
      session: { user_id: validUserId },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toHaveProperty('code', 'UNAUTHORIZED');
    expect(body.error).toHaveProperty('message', 'Authentication required');
    expect(mockService.hasCapability).not.toHaveBeenCalled();
    await app.close();
  });

  // =========================================================================
  // Required Test 11: No role or capability information is trusted from the client
  // =========================================================================
  it('11. No role or capability information is trusted from the client', async () => {
    // User in database has NO roles (returns false)
    const mockService = {
      hasCapability: vi.fn().mockResolvedValue(false),
    };

    const app = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    // Client attempts to spoof role / capability via headers, query params, and request body
    const response = await app.inject({
      method: 'GET',
      url: '/protected?role=ADMINISTRATOR&capability=system:maintain',
      headers: {
        'x-role': 'ADMINISTRATOR',
        'x-user-role': 'SYSTEM_MAINTAINER',
        'x-capability': 'system:maintain',
      },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error).toHaveProperty('code', 'FORBIDDEN');
    expect(mockService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');
    await app.close();
  });

  // =========================================================================
  // Required Test 12: Role revocation changes authorization on the next request
  // =========================================================================
  it('12. Role revocation changes authorization on the next request', async () => {
    let userRoles: string[] = ['SYSTEM_MAINTAINER'];

    const mockDb = {
      query: vi.fn().mockImplementation(async () => {
        if (userRoles.length === 0) {
          return { rows: [{ user_id: validUserId, is_active: true, role_id: null }] };
        }
        return {
          rows: userRoles.map((role_id) => ({
            user_id: validUserId,
            is_active: true,
            role_id,
          })),
        };
      }),
    };

    const service = new CapabilityService({ db: mockDb });

    const app = await createTestApp({
      capabilityService: service,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    // Request 1: User holds SYSTEM_MAINTAINER -> succeeds (200)
    const res1 = await app.inject({ method: 'GET', url: '/protected' });
    expect(res1.statusCode).toBe(200);

    // Dynamic role revocation in database
    userRoles = [];

    // Request 2: Next request with the EXACT same session context -> fails closed (403)
    const res2 = await app.inject({ method: 'GET', url: '/protected' });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().error).toHaveProperty('code', 'FORBIDDEN');

    await app.close();
  });

  // =========================================================================
  // Required Test 13: Role grant changes authorization on the next request
  // =========================================================================
  it('13. Role grant changes authorization on the next request', async () => {
    let userRoles: string[] = [];

    const mockDb = {
      query: vi.fn().mockImplementation(async () => {
        if (userRoles.length === 0) {
          return { rows: [{ user_id: validUserId, is_active: true, role_id: null }] };
        }
        return {
          rows: userRoles.map((role_id) => ({
            user_id: validUserId,
            is_active: true,
            role_id,
          })),
        };
      }),
    };

    const service = new CapabilityService({ db: mockDb });

    const app = await createTestApp({
      capabilityService: service,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    // Request 1: User has no roles -> denied (403)
    const res1 = await app.inject({ method: 'GET', url: '/protected' });
    expect(res1.statusCode).toBe(403);

    // Dynamic role grant in database
    userRoles = ['SYSTEM_MAINTAINER'];

    // Request 2: Next request with the EXACT same session context -> succeeds (200)
    const res2 = await app.inject({ method: 'GET', url: '/protected' });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toHaveProperty('status', 'ok');

    await app.close();
  });

  // =========================================================================
  // Required Test 14: Error envelopes expose no sensitive data
  // =========================================================================
  it('14. Error envelopes expose no sensitive data', async () => {
    const mockService = {
      hasCapability: vi.fn().mockRejectedValue(
        new Error('SELECT * FROM users WHERE password_hash = $argon2id$v=19$m=65536 secret_table_leak')
      ),
    };

    const app = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(500);
    const rawBody = response.body;

    // Must not leak internal exceptions, SQL, table names, passwords, or hashes
    expect(rawBody).not.toContain('SELECT');
    expect(rawBody).not.toContain('password_hash');
    expect(rawBody).not.toContain('$argon2id$');
    expect(rawBody).not.toContain('secret_table_leak');
    expect(rawBody).not.toContain('stack');

    const json = response.json();
    expect(json).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal server error occurred.',
        request_id: expect.any(String),
        details: {},
      },
    });

    await app.close();
  });

  // =========================================================================
  // Required Test 15: CapabilityService is invoked with the validated session user ID
  // =========================================================================
  it('15. CapabilityService is invoked with the validated session user ID', async () => {
    const mockService = {
      hasCapability: vi.fn().mockResolvedValue(true),
    };

    const app = await createTestApp({
      capabilityService: mockService,
      decorateServerService: true,
      user: { id: validUserId, is_active: true },
      session: { user_id: validUserId },
    });

    await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(mockService.hasCapability).toHaveBeenCalledTimes(1);
    expect(mockService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');

    await app.close();
  });

  // =========================================================================
  // Additional Edge-Case / Contract Invariant Tests
  // =========================================================================
  describe('Additional Contract Invariants', () => {
    it('avoids duplicate capability checks within the same request lifecycle', async () => {
      const mockService = {
        hasCapability: vi.fn().mockResolvedValue(true),
      };

      const app = Fastify();
      await app.register(errorHandlerPlugin);
      app.decorate('capabilityService', mockService as any);

      app.addHook('preHandler', async (request) => {
        (request as any).user = { id: validUserId, is_active: true };
        (request as any).session = { user_id: validUserId };
      });

      // Chain the SAME middleware twice in preHandler
      const check1 = requireCapability('system:maintain');
      const check2 = requireCapability('system:maintain');

      app.get('/double-check', { preHandler: [check1, check2] }, async () => {
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/double-check' });
      expect(response.statusCode).toBe(200);

      // Must have invoked hasCapability only ONCE despite two preHandler checks
      expect(mockService.hasCapability).toHaveBeenCalledTimes(1);

      await app.close();
    });

    it('supports direct options dependency injection in requireCapability', async () => {
      const explicitService = {
        hasCapability: vi.fn().mockResolvedValue(true),
      };

      const app = await createTestApp({
        middlewareOptions: { capabilityService: explicitService as any },
        decorateServerService: false,
        user: { id: validUserId, is_active: true },
        session: { user_id: validUserId },
      });

      const response = await app.inject({ method: 'GET', url: '/protected' });
      expect(response.statusCode).toBe(200);
      expect(explicitService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');

      await app.close();
    });

    it('exports stable named function requireCapability and AuthorizationError', () => {
      expect(typeof requireCapability).toBe('function');
      expect(typeof AuthorizationError).toBe('function');
      const err = new AuthorizationError(403, 'FORBIDDEN', 'Permission denied');
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toBe('Permission denied');
    });
  });
});
