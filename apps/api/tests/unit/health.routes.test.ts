import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.ts';
import { healthRoutes, default as defaultHealthRoutes, HealthError } from '../../src/routes/health.routes.ts';

describe('Health & Readiness Routes Unit Tests (T030 - US3)', () => {
  interface TestAppOptions {
    databaseUrl?: string;
    db?: any;
    timeoutMs?: number;
  }

  async function createTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(healthRoutes, {
      databaseUrl: opts.databaseUrl,
      db: opts.db,
      timeoutMs: opts.timeoutMs,
    });
    await app.ready();
    return app;
  }

  describe('Module Exports', () => {
    it('exports named healthRoutes and default export with strict identity', () => {
      expect(typeof healthRoutes).toBe('function');
      expect(typeof defaultHealthRoutes).toBe('function');
      expect(healthRoutes).toBe(defaultHealthRoutes);
    });

    it('exports HealthError class with expected defaults', () => {
      const err = new HealthError();
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      expect(err.message).toBe('Service temporarily unavailable.');
    });
  });

  describe('GET /health — Liveness probe', () => {
    it('returns HTTP 200 with { status: "ok" } without requiring database configuration', async () => {
      const app = await createTestApp(); // No db or databaseUrl
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      await app.close();
    });

    it('does not leak database, environment, or secret details in /health response', async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      const body = response.json();
      expect(body).toEqual({ status: 'ok' });
      expect(body.db).toBeUndefined();
      expect(body.database).toBeUndefined();
      expect(body.env).toBeUndefined();
      expect(body.secrets).toBeUndefined();
      await app.close();
    });
  });

  describe('GET /ready — Readiness probe', () => {
    it('returns HTTP 200 with { status: "ok" } when database connectivity check succeeds', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      };

      const app = await createTestApp({ db: mockDb });
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
      await app.close();
    });

    it('fails closed with HTTP 503 and SERVICE_UNAVAILABLE when database configuration is missing', async () => {
      const app = await createTestApp(); // No db, no databaseUrl
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error).toHaveProperty('code', 'SERVICE_UNAVAILABLE');
      expect(body.error).toHaveProperty('message', 'Service temporarily unavailable.');
      expect(body.error).toHaveProperty('request_id');
      expect(body.status).toBeUndefined();
      await app.close();
    });

    it('fails closed with HTTP 503 when database query throws an error', async () => {
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
      };

      const app = await createTestApp({ db: mockDb });
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error).toHaveProperty('code', 'SERVICE_UNAVAILABLE');
      expect(body.error).toHaveProperty('message', 'Service temporarily unavailable.');
      expect(response.body).not.toContain('Connection terminated');
      await app.close();
    });

    it('fails closed with HTTP 503 when database query times out', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 200))
        ),
      };

      const app = await createTestApp({ db: mockDb, timeoutMs: 30 });
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error).toHaveProperty('code', 'SERVICE_UNAVAILABLE');
      expect(body.error).toHaveProperty('message', 'Service temporarily unavailable.');
      await app.close();
    });

    it('performs fresh query on each request without caching previous results', async () => {
      let callCount = 0;
      const mockDb = {
        query: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { rows: [{ '?column?': 1 }] };
          }
          throw new Error('Database went down');
        }),
      };

      const app = await createTestApp({ db: mockDb });

      // First call succeeds
      const res1 = await app.inject({ method: 'GET', url: '/ready' });
      expect(res1.statusCode).toBe(200);

      // Second call fails (not cached)
      const res2 = await app.inject({ method: 'GET', url: '/ready' });
      expect(res2.statusCode).toBe(503);

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      await app.close();
    });
  });

  describe('Database Connection Ownership', () => {
    it('never closes externally injected database client on app close', async () => {
      const mockEnd = vi.fn();
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
        end: mockEnd,
      };

      const app = await createTestApp({ db: mockDb });
      await app.close();

      expect(mockEnd).not.toHaveBeenCalled();
    });

    it('closes plugin-owned connection pool on app close when databaseUrl is provided', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined);
      class MockPool {
        query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
        on = vi.fn();
        end = mockEnd;
      }
      const poolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPool() as any;
      });

      const app = await createTestApp({ databaseUrl: 'postgres://user:pass@localhost:5432/testdb' });
      await app.close();

      expect(mockEnd).toHaveBeenCalled();
      poolSpy.mockRestore();
    });
  });
});
