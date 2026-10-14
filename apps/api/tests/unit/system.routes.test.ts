import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import { systemRoutes, default as defaultSystemRoutes } from '../../src/routes/system.routes.ts';
import { CapabilityService } from '../../src/services/capability.service.ts';

describe('System Routes Unit Tests (T026 - US2)', () => {
  const validUserId = 'a0000000-0000-4000-8000-000000000001';

  interface TestAppOptions {
    capabilityService?: any;
    db?: any;
    databaseUrl?: string;
    user?: any;
    session?: any;
    prefix?: string;
  }

  async function createTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(errorHandlerPlugin);

    // Simulate authentication hook populating request.user and request.session
    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (opts.user !== undefined) {
        (request as any).user = opts.user;
      }
      if (opts.session !== undefined) {
        (request as any).session = opts.session;
      }
    });

    await app.register(systemRoutes, {
      prefix: opts.prefix ?? '/system',
      capabilityService: opts.capabilityService,
      db: opts.db,
      databaseUrl: opts.databaseUrl,
    });

    await app.ready();
    return app;
  }

  describe('Module Exports and Structure', () => {
    it('exports named systemRoutes function and default export', () => {
      expect(typeof systemRoutes).toBe('function');
      expect(typeof defaultSystemRoutes).toBe('function');
      expect(systemRoutes).toBe(defaultSystemRoutes);
    });
  });

  describe('GET /system/info Enforcement', () => {
    it('returns HTTP 200 with { status: "ok" } for authorized user with system:maintain capability', async () => {
      const mockService = {
        hasCapability: vi.fn().mockResolvedValue(true),
      };

      const app = await createTestApp({
        capabilityService: mockService,
        user: { id: validUserId, is_active: true },
        session: { user_id: validUserId },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({ status: 'ok' });
      expect(mockService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');
      // Must not leak database info, secrets, env, or session contents
      expect(body.db).toBeUndefined();
      expect(body.system).toBeUndefined();
      expect(body.user).toBeUndefined();
      expect(body.session).toBeUndefined();
      await app.close();
    });

    it('returns HTTP 403 when user lacks system:maintain capability', async () => {
      const mockService = {
        hasCapability: vi.fn().mockResolvedValue(false),
      };

      const app = await createTestApp({
        capabilityService: mockService,
        user: { id: validUserId, is_active: true },
        session: { user_id: validUserId },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'FORBIDDEN');
      expect(body.error).toHaveProperty('message', 'Permission denied');
      expect(body.status).toBeUndefined();
      await app.close();
    });

    it('returns HTTP 401 when request is unauthenticated', async () => {
      const mockService = {
        hasCapability: vi.fn().mockResolvedValue(true),
      };

      const app = await createTestApp({
        capabilityService: mockService,
        user: undefined,
        session: undefined,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'UNAUTHORIZED');
      expect(body.error).toHaveProperty('message', 'Authentication required');
      expect(body.status).toBeUndefined();
      await app.close();
    });

    it('returns HTTP 403 when user is disabled (is_active === false)', async () => {
      const mockService = {
        hasCapability: vi.fn().mockResolvedValue(true),
      };

      const app = await createTestApp({
        capabilityService: mockService,
        user: { id: validUserId, is_active: false },
        session: { user_id: validUserId },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'FORBIDDEN');
      expect(body.status).toBeUndefined();
      await app.close();
    });

    it('fails closed (never 200) when database evaluation throws an error', async () => {
      const mockService = {
        hasCapability: vi.fn().mockRejectedValue(new Error('PostgreSQL connection terminated')),
      };

      const app = await createTestApp({
        capabilityService: mockService,
        user: { id: validUserId, is_active: true },
        session: { user_id: validUserId },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect([403, 500]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.status).toBeUndefined();
      await app.close();
    });

    it('fails closed with HTTP 500 when capability service dependency cannot be resolved', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);
      app.addHook('preHandler', async (request: FastifyRequest) => {
        (request as any).user = { id: validUserId, is_active: true };
        (request as any).session = { user_id: validUserId };
      });
      // Register without capabilityService, db, or databaseUrl
      await app.register(systemRoutes, { prefix: '/system' });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
      expect(body.status).toBeUndefined();
      await app.close();
    });
  });

  describe('Database and Service Dependency Resolution', () => {
    it('uses injected shared db client without creating a pool or closing external client', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            { user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' },
          ],
        }),
      };

      const app = await createTestApp({
        db: mockDb,
        user: { id: validUserId, is_active: true },
        session: { user_id: validUserId },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(mockDb.query).toHaveBeenCalled();
      await app.close();
    });

    it('decorates fastify instance with capabilityService if not already decorated', async () => {
      const mockService = {
        hasCapability: vi.fn(async () => true),
      };

      const app = Fastify();
      await app.register(errorHandlerPlugin);
      app.addHook('preHandler', async (request: FastifyRequest) => {
        (request as any).user = { id: validUserId, is_active: true };
        (request as any).session = { user_id: validUserId };
      });

      // Provide capabilityService via server decorator before registering systemRoutes
      app.decorate('capabilityService', mockService as any);

      // Register systemRoutes without explicit capabilityService option
      await app.register(systemRoutes, {
        prefix: '/system',
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(mockService.hasCapability).toHaveBeenCalledWith(validUserId, 'system:maintain');
      await app.close();
    });
  });
});
