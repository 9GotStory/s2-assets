import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp, createApp } from '../../src/app.ts';
import { createLogger } from '../../src/plugins/logger.ts';
import { createShutdownHandler } from '../../src/server.ts';
import { hashPassword } from '../../src/services/user.service.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, '../../src/server.ts');

function createMockDb(overrides: Partial<any> = {}) {
  const queryFn = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('SELECT 1')) {
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  });

  return {
    query: queryFn,
    end: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('Fastify Application Bootstrap (T041)', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  describe('1. Factory Contract and Listener Invariants', () => {
    it('creates and returns a Fastify application without opening a listener', async () => {
      const mockDb = createMockDb();
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      expect(app).toBeDefined();
      expect(typeof app.inject).toBe('function');
      expect(app.server.listening).toBe(false);
    });

    it('exports both buildApp and createApp aliases', () => {
      expect(typeof buildApp).toBe('function');
      expect(typeof createApp).toBe('function');
      expect(buildApp).toBe(createApp);
    });

    it('does not register process signal listeners when importing or building the factory', async () => {
      const initialSigintListeners = process.listeners('SIGINT').length;
      const initialSigtermListeners = process.listeners('SIGTERM').length;

      const mockDb = createMockDb();
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      expect(process.listeners('SIGINT').length).toBe(initialSigintListeners);
      expect(process.listeners('SIGTERM').length).toBe(initialSigtermListeners);
    });
  });

  describe('2. Configuration Validation and Secret Redaction', () => {
    it('fails closed when DATABASE_URL is missing and no db is injected', async () => {
      const origUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;

      try {
        await expect(buildApp({ logger: false })).rejects.toThrow(
          /DATABASE_URL is required/i
        );
      } finally {
        if (origUrl) process.env.DATABASE_URL = origUrl;
      }
    });

    it('fails closed when DATABASE_URL does not start with postgresql://', async () => {
      await expect(
        buildApp({
          databaseUrl: 'mysql://user:pass@localhost:3306/db',
          logger: false,
        })
      ).rejects.toThrow(/must start with postgresql:\/\//i);
    });

    it('fails closed in production if cookie signing secret is missing or insufficient', async () => {
      const mockDb = createMockDb();
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.COOKIE_SECRET;
      const origCsrf = process.env.CSRF_SECRET;

      delete process.env.COOKIE_SECRET;
      delete process.env.CSRF_SECRET;

      try {
        await expect(
          buildApp({
            db: mockDb,
            config: { NODE_ENV: 'production' },
            logger: false,
          })
        ).rejects.toThrow(/CSRF cookie signing is required/i);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origSecret) process.env.COOKIE_SECRET = origSecret;
        if (origCsrf) process.env.CSRF_SECRET = origCsrf;
      }
    });

    it('redacts secret sentinels from error messages when pool initialization fails', async () => {
      const secretPassword = 'SUPER_SECRET_DB_PASSWORD_XYZ';
      const connectionString = `postgresql://dbuser:${secretPassword}@invalid-db-host.internal:5432/testdb`;

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        throw new Error(`Failed to connect to ${connectionString}`);
      });

      let thrownError: Error | null = null;
      try {
        await buildApp({
          databaseUrl: connectionString,
          logger: false,
        });
      } catch (err: any) {
        thrownError = err;
      } finally {
        pgPoolSpy.mockRestore();
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect(thrownError!.message).not.toContain(secretPassword);
      expect(thrownError!.message).toContain('***');
    });

    it('does not disclose synthetic secrets in logs when idle database pool error fires', async () => {
      let logOutput = '';
      const logStream = new Writable({
        write(chunk, _encoding, callback) {
          logOutput += chunk.toString();
          callback();
        },
      });
      const logger = createLogger({}, logStream);

      const secretSentinel = 'REVIEW_SYNTHETIC_IDLE_SECRET';
      let capturedPool: any = null;
      const endSpy = vi.fn(async () => {});

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        const emitter = new EventEmitter();
        const mock = Object.assign(emitter, {
          query: vi.fn(async () => ({ rows: [] })),
          end: endSpy,
        });
        capturedPool = mock;
        return mock as any;
      });

      try {
        app = await buildApp({
          databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
          logger,
        });

        expect(capturedPool).toBeDefined();
        // Force idle pool error with synthetic secret
        capturedPool.emit('error', new Error(`Idle pool connection reset: ${secretSentinel}`));

        expect(logOutput).toContain('Unexpected error on idle database pool client');
        expect(logOutput).not.toContain(secretSentinel);
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('does not disclose synthetic secrets in logs when graceful shutdown fails', async () => {
      let logOutput = '';
      const logStream = new Writable({
        write(chunk, _encoding, callback) {
          logOutput += chunk.toString();
          callback();
        },
      });
      const logger = createLogger({}, logStream);

      const secretSentinel = 'REVIEW_SYNTHETIC_SHUTDOWN_SECRET';
      const mockApp = {
        log: logger,
        close: vi.fn(async () => {
          throw new Error(`Shutdown failure: ${secretSentinel}`);
        }),
      } as unknown as FastifyInstance;

      const exitSpy = vi.fn();
      const shutdownHandler = createShutdownHandler(mockApp, exitSpy);

      await shutdownHandler('SIGTERM');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logOutput).toContain('Error during graceful shutdown');
      expect(logOutput).not.toContain(secretSentinel);
    });
  });

  describe('3. PostgreSQL Ownership and Graceful Shutdown Lifecycle', () => {
    it('preserves caller ownership of injected database client and does not close it on app.close()', async () => {
      const mockDb = createMockDb();
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      await app.close();
      app = null;

      expect(mockDb.end).not.toHaveBeenCalled();
    });

    it('closes application-owned connection pool on app.close()', async () => {
      const endSpy = vi.fn(async () => {});
      class MockPgPool {
        query = vi.fn(async () => ({ rows: [] }));
        end = endSpy;
        on = vi.fn();
      }

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPgPool() as any;
      });

      try {
        app = await buildApp({
          databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
          logger: false,
        });

        expect(pgPoolSpy).toHaveBeenCalled();
        expect(endSpy).not.toHaveBeenCalled();

        await app.close();
        app = null;

        expect(endSpy).toHaveBeenCalledTimes(1);
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('cleans up application-owned pool if plugin registration throws during build', async () => {
      const endSpy = vi.fn(async () => {});
      class MockPgPool {
        query = vi.fn(async () => ({ rows: [] }));
        end = endSpy;
        on = vi.fn();
      }

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPgPool() as any;
      });

      try {
        // Trigger initialization failure in production due to missing signing secret
        await expect(
          buildApp({
            databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
            config: { NODE_ENV: 'production' },
            logger: false,
          })
        ).rejects.toThrow();

        expect(endSpy).toHaveBeenCalled();
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('cleans up application-owned pool when logger construction fails with invalid level', async () => {
      const endSpy = vi.fn(async () => {});
      class MockPgPool {
        query = vi.fn(async () => ({ rows: [] }));
        end = endSpy;
        on = vi.fn();
      }

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPgPool() as any;
      });

      try {
        await expect(
          buildApp({
            databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
            logger: { level: 'invalid-logger-level' as any },
          })
        ).rejects.toThrow();

        expect(pgPoolSpy).toHaveBeenCalledTimes(1);
        expect(endSpy).toHaveBeenCalledTimes(1);
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('closes Fastify and invokes registered onClose hooks when plugin registration throws', async () => {
      const endSpy = vi.fn(async () => {});
      class MockPgPool {
        query = vi.fn(async () => ({ rows: [] }));
        end = endSpy;
        on = vi.fn();
      }

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPgPool() as any;
      });

      const probeSpy = vi.fn();

      try {
        await expect(
          buildApp({
            databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
            logger: false,
            plugin: async (instance) => {
              instance.addHook('onClose', async () => {
                probeSpy();
              });
              throw new Error('Plugin initialization failed');
            },
          })
        ).rejects.toThrow('Plugin initialization failed');

        expect(probeSpy).toHaveBeenCalledTimes(1);
        expect(endSpy).toHaveBeenCalledTimes(1);
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('releases application-owned pool exactly once', async () => {
      const endSpy = vi.fn(async () => {});
      class MockPgPool {
        query = vi.fn(async () => ({ rows: [] }));
        end = endSpy;
        on = vi.fn();
      }

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPgPool() as any;
      });

      try {
        app = await buildApp({
          databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
          logger: false,
        });

        await app.close();
        await app.close();
        expect(endSpy).toHaveBeenCalledTimes(1);
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('releases application-owned pool when listener fails', async () => {
      const endSpy = vi.fn(async () => {});
      class MockPgPool {
        query = vi.fn(async () => ({ rows: [] }));
        end = endSpy;
        on = vi.fn();
      }

      const pgPoolSpy = vi.spyOn(pg, 'Pool').mockImplementation(function (this: any) {
        return new MockPgPool() as any;
      });

      try {
        app = await buildApp({
          databaseUrl: 'postgresql://testuser:testpass@localhost:5432/testdb',
          logger: false,
        });

        vi.spyOn(app, 'listen').mockRejectedValueOnce(
          new Error('EADDRINUSE: address already in use')
        );

        let listenErr: Error | null = null;
        try {
          await app.listen({ port: 3000 });
        } catch (err: any) {
          listenErr = err;
          await app.close();
        }

        expect(listenErr).toBeDefined();
        expect(listenErr?.message).toContain('EADDRINUSE');
        expect(endSpy).toHaveBeenCalledTimes(1);
      } finally {
        pgPoolSpy.mockRestore();
      }
    });

    it('preserves caller ownership of injected database client when initialization fails', async () => {
      const mockDb = createMockDb();

      await expect(
        buildApp({
          db: mockDb,
          logger: false,
          plugin: async () => {
            throw new Error('Plugin initialization failed');
          },
        })
      ).rejects.toThrow('Plugin initialization failed');

      expect(mockDb.end).not.toHaveBeenCalled();
    });
  });

  describe('4. Route Composition and Security Policies', () => {
    let mockDb: ReturnType<typeof createMockDb>;
    let passwordHash: string;

    beforeEach(async () => {
      passwordHash = await hashPassword('CorrectPassword123!');
      mockDb = createMockDb({
        query: vi.fn(async (text: string, params?: unknown[]) => {
          // Liveness / readiness
          if (text.includes('SELECT 1')) {
            return { rows: [{ '?column?': 1 }] };
          }
          // User verification
          if (text.includes('SELECT') && text.includes('FROM users') && text.includes('username =')) {
            const username = (params as any[])?.[0];
            if (username === 'alice') {
              return {
                rows: [
                  {
                    id: 'usr-123',
                    username: 'alice',
                    password_hash: passwordHash,
                    is_active: true,
                    created_at: new Date(),
                    updated_at: new Date(),
                  },
                ],
              };
            }
            return { rows: [] };
          }
          // Session lookup
          if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('token_hash =')) {
            return {
              rows: [
                {
                  id: 'ses-456',
                  user_id: 'usr-123',
                  token_hash: 'somehash',
                  expires_at: new Date(Date.now() + 3600000),
                  created_at: new Date(),
                  last_activity_at: new Date(),
                },
              ],
            };
          }
          // User by ID lookup
          if (text.includes('SELECT') && text.includes('FROM users') && text.includes('id =')) {
            return {
              rows: [
                {
                  id: 'usr-123',
                  username: 'alice',
                  password_hash: passwordHash,
                  is_active: true,
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              ],
            };
          }
          // Session insertion
          if (text.includes('INSERT INTO sessions')) {
            return {
              rows: [
                {
                  id: (params as any[])?.[0] || 'ses-mock',
                  user_id: (params as any[])?.[1] || 'usr-123',
                  expires_at: new Date(Date.now() + 3600000),
                  created_at: new Date(),
                },
              ],
            };
          }
          // Capability check
          if (text.includes('system:maintain') || text.includes('capabilities') || text.includes('user_roles')) {
            return { rows: [{ capability: 'system:maintain' }] };
          }
          // Default query response
          return { rows: [] };
        }),
      });
    });

    it('mounts GET /health as a public endpoint independent of database', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });

    it('mounts GET /ready as a public endpoint checking fresh DB connectivity', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('GET /ready returns HTTP 503 SERVICE_UNAVAILABLE when database fails', async () => {
      const failingDb = createMockDb({
        query: vi.fn(async (text: string) => {
          if (text.includes('SELECT 1')) {
            throw new Error('Database connection failed');
          }
          return { rows: [] };
        }),
      });

      app = await buildApp({
        db: failingDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('POST /auth/login is public and validates credentials', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      // Missing body
      const badReq = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {},
      });
      expect(badReq.statusCode).toBe(400);

      // Invalid credentials
      const invalidReq = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'alice',
          password: 'WrongPassword!',
        },
      });
      expect(invalidReq.statusCode).toBe(401);

      // Valid credentials
      const validReq = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'alice',
          password: 'CorrectPassword123!',
        },
      });
      expect(validReq.statusCode).toBe(200);
      const body = validReq.json();
      expect(body.user?.username).toBe('alice');
      expect(body.user?.password_hash).toBeUndefined();
    });

    it('GET /auth/session-check requires authentication', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/auth/session-check',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error?.code).toBe('UNAUTHORIZED');
    });

    it('POST /auth/logout requires authentication and CSRF token', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      // Missing CSRF token fails with 403 CSRF_TOKEN_INVALID
      const unauthRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
      });
      expect(unauthRes.statusCode).toBe(403);
    });

    it('GET /system/info requires authentication', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/system/info',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error?.code).toBe('UNAUTHORIZED');
    });

    it('unmarked routes fail closed and require authentication by default', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
        plugin: (instance) => {
          instance.get('/unmarked-endpoint', async () => ({ secret: 'data' }));
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/unmarked-endpoint',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error?.code).toBe('UNAUTHORIZED');
    });

    it('non-existent routes return standard 404 NOT_FOUND error envelope', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/non-existent-route-12345',
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error?.code).toBe('NOT_FOUND');
      expect(body.error?.request_id).toBeDefined();
    });

    it('does not expose /test-csrf-token in the application', async () => {
      app = await buildApp({
        db: mockDb,
        logger: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/test-csrf-token',
      });

      // Must NOT return 200 with csrfToken
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode === 401 || res.statusCode === 404).toBe(true);
    });
  });

  describe('5. Server Entrypoint Process Execution (server.ts)', () => {
    it('aborts with nonzero exit and safe error message when DATABASE_URL is missing', async () => {
      const child = spawn(process.execPath, [serverPath], {
        env: {
          ...process.env,
          DATABASE_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/Fatal startup error:/i);
      expect(stderr).toMatch(/DATABASE_URL/i);
    });

    it('aborts with nonzero exit and redacts credentials when DATABASE_URL has secret sentinels', async () => {
      const secretPassword = 'MY_SUPER_SECRET_STARTUP_PASS_123';
      const child = spawn(process.execPath, [serverPath], {
        env: {
          ...process.env,
          DATABASE_URL: `postgresql://appuser:${secretPassword}@invalid host with spaces.internal:5432/appdb`,
          PORT: '3000',
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

      expect(exitCode).not.toBe(0);
      expect(stderr).not.toContain(secretPassword);
      expect(stdout).not.toContain(secretPassword);
      expect(stderr).toMatch(/Fatal startup error:/i);
    });

    it('aborts with nonzero exit in production when cookie secret is missing', async () => {
      const child = spawn(process.execPath, [serverPath], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://appuser:apppass@localhost:5432/appdb',
          COOKIE_SECRET: '',
          CSRF_SECRET: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/CSRF cookie signing is required in production/i);
    });
  });
});
