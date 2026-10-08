import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
// @ts-expect-error - Expected RED state in T014: apps/api/src/plugins/error-handler.ts will be implemented in T015
import { errorHandler, errorHandlerPlugin } from '../../src/plugins/error-handler.ts';

interface StandardErrorPayload {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

describe('Standard Fastify Error Handler (T014)', () => {
  describe('Deterministic Machine-Readable Error Codes', () => {
    it('returns VALIDATION_FAILED for Fastify schema validation failures (HTTP 400)', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.post(
        '/test-schema-validation',
        {
          schema: {
            body: {
              type: 'object',
              required: ['username'],
              properties: {
                username: { type: 'string' },
              },
            },
          },
        },
        async () => ({ ok: true })
      );

      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/test-schema-validation',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<StandardErrorPayload>();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.message).toBe('The provided request data is invalid.');

      await app.close();
    });

    it('returns BAD_REQUEST for generic 400 bad request errors', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-bad-request', async () => {
        const err = new Error('Malformed request parameters') as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-bad-request',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('BAD_REQUEST');

      await app.close();
    });

    it('returns UNAUTHORIZED for 401 authentication errors', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-unauthorized', async () => {
        const err = new Error('Authentication required') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-unauthorized',
      });

      expect(response.statusCode).toBe(401);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('UNAUTHORIZED');

      await app.close();
    });

    it('returns FORBIDDEN for 403 authorization errors', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-forbidden', async () => {
        const err = new Error('Permission denied') as Error & { statusCode?: number };
        err.statusCode = 403;
        throw err;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-forbidden',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('FORBIDDEN');

      await app.close();
    });

    it('returns NOT_FOUND for 404 resource not found errors', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-not-found', async () => {
        const err = new Error('Requested resource not found') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-not-found',
      });

      expect(response.statusCode).toBe(404);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('NOT_FOUND');

      await app.close();
    });

    it('returns SERVICE_UNAVAILABLE for 503 database or upstream unavailability (FR-012)', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-service-unavailable', async () => {
        const err = new Error('Database connection lost') as Error & { statusCode?: number };
        err.statusCode = 503;
        throw err;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-service-unavailable',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');

      await app.close();
    });

    it('returns INTERNAL_SERVER_ERROR for unhandled runtime exceptions (HTTP 500)', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-unhandled-exception', async () => {
        throw new Error('Unexpected catastrophic runtime failure');
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-unhandled-exception',
      });

      expect(response.statusCode).toBe(500);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');

      await app.close();
    });

    it('preserves custom machine-readable error codes when explicitly defined on error', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-custom-code', async () => {
        const err = new Error('User already active') as Error & { statusCode?: number; code?: string };
        err.statusCode = 409;
        err.code = 'USER_ALREADY_EXISTS';
        throw err;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-custom-code',
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.code).toBe('USER_ALREADY_EXISTS');

      await app.close();
    });
  });

  describe('Safe User-Facing Messages & Correlation IDs', () => {
    it('sanitizes 500 internal server error messages with safe human-readable text', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      const rawInternalErrorMessage = 'FATAL: disk read failure in sector 0x8892A at internal storage engine';
      app.get('/test-internal-message', async () => {
        throw new Error(rawInternalErrorMessage);
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-internal-message',
      });

      expect(response.statusCode).toBe(500);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.message).toBeDefined();
      expect(body.error.message).not.toContain(rawInternalErrorMessage);
      expect(body.error.message).not.toContain('0x8892A');
      expect(body.error.message).not.toContain('sector');
      // Should be a safe human-readable message
      expect(body.error.message.length).toBeGreaterThan(0);

      await app.close();
    });

    it('provides standard human-readable safe message for validation errors conforming to api-error contract', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.post(
        '/test-validation-contract-message',
        {
          schema: {
            body: {
              type: 'object',
              required: ['username'],
              properties: {
                username: { type: 'string' },
              },
            },
          },
        },
        async () => ({ ok: true })
      );

      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/test-validation-contract-message',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.message).toBe('The provided request data is invalid.');

      await app.close();
    });

    it('propagates client-supplied x-request-id as error.request_id', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-request-id-propagation', async () => {
        throw new Error('Sample error for request id check');
      });

      await app.ready();

      const customRequestId = '123e4567-e89b-12d3-a456-426614174000';
      const response = await app.inject({
        method: 'GET',
        url: '/test-request-id-propagation',
        headers: {
          'x-request-id': customRequestId,
        },
      });

      const body = response.json<StandardErrorPayload>();
      expect(body.error.request_id).toBe(customRequestId);

      await app.close();
    });

    it('populates deterministic request_id from Fastify req.id when x-request-id is omitted', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      let capturedRequestId: string | undefined;

      app.get('/test-default-request-id', async (req) => {
        capturedRequestId = req.id;
        throw new Error('Sample error for default request id check');
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-default-request-id',
      });

      expect(capturedRequestId).toBeDefined();
      expect(typeof capturedRequestId).toBe('string');
      expect(capturedRequestId!.length).toBeGreaterThan(0);

      const body = response.json<StandardErrorPayload>();
      expect(body.error.request_id).toBeDefined();
      expect(body.error.request_id).toBe(capturedRequestId);

      await app.close();
    });

    it('strictly adheres to standard JSON error envelope with single root error key', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-envelope-structure', async () => {
        throw new Error('Envelope verification error');
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-envelope-structure',
      });

      const body = response.json() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['error']);

      const errorObj = body.error as Record<string, unknown>;
      expect(errorObj).toHaveProperty('code');
      expect(errorObj).toHaveProperty('message');
      expect(errorObj).toHaveProperty('request_id');
      expect(errorObj).toHaveProperty('details');

      expect(body).not.toHaveProperty('statusCode');
      expect(body).not.toHaveProperty('message');
      expect(body).not.toHaveProperty('stack');

      await app.close();
    });
  });

  describe('Minimized Validation Error Details', () => {
    it('formats single missing required field into minimized field-message map in details', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.post(
        '/test-single-field-validation',
        {
          schema: {
            body: {
              type: 'object',
              required: ['username'],
              properties: {
                username: { type: 'string' },
              },
            },
          },
        },
        async () => ({ ok: true })
      );

      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/test-single-field-validation',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.details).toBeDefined();
      expect(body.error.details).toHaveProperty('username');
      expect(typeof (body.error.details as any).username).toBe('string');
      expect((body.error.details as any).username.length).toBeGreaterThan(0);

      await app.close();
    });

    it('formats multi-field validation failures with concise field mappings', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.post(
        '/test-multi-field-validation',
        {
          schema: {
            body: {
              type: 'object',
              required: ['username', 'password'],
              properties: {
                username: { type: 'string', minLength: 3 },
                password: { type: 'string', minLength: 8 },
              },
            },
          },
        },
        async () => ({ ok: true })
      );

      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/test-multi-field-validation',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<StandardErrorPayload>();
      expect(body.error.details).toBeDefined();
      expect(body.error.details).toHaveProperty('username');
      expect(body.error.details).toHaveProperty('password');

      await app.close();
    });

    it('does not expose raw schema definitions, AJV keywords, or engine internals in details', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.post(
        '/test-clean-details',
        {
          schema: {
            body: {
              type: 'object',
              required: ['username'],
              properties: {
                username: { type: 'string' },
              },
            },
          },
        },
        async () => ({ ok: true })
      );

      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/test-clean-details',
        payload: {},
      });

      const body = response.json<StandardErrorPayload>();
      const details = body.error.details as Record<string, unknown>;
      expect(details).toBeDefined();
      expect(details).not.toHaveProperty('$schema');
      expect(details).not.toHaveProperty('schemaPath');
      expect(details).not.toHaveProperty('keyword');
      expect(details).not.toHaveProperty('definitions');
      expect(details).not.toHaveProperty('params');

      await app.close();
    });

    it('returns empty details object for non-validation errors (401, 403, 404, and 500)', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-details-401', async () => {
        const err = new Error('Authentication required') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      });

      app.get('/test-details-403', async () => {
        const err = new Error('Permission denied') as Error & { statusCode?: number };
        err.statusCode = 403;
        throw err;
      });

      app.get('/test-details-404', async () => {
        const err = new Error('Resource not found') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      });

      app.get('/test-details-500', async () => {
        throw new Error('Internal server error');
      });

      await app.ready();

      const res401 = await app.inject({ method: 'GET', url: '/test-details-401' });
      expect(res401.statusCode).toBe(401);
      const body401 = res401.json<StandardErrorPayload>();
      expect(body401.error.details).toBeDefined();
      expect(body401.error.details).toEqual({});

      const res403 = await app.inject({ method: 'GET', url: '/test-details-403' });
      expect(res403.statusCode).toBe(403);
      const body403 = res403.json<StandardErrorPayload>();
      expect(body403.error.details).toBeDefined();
      expect(body403.error.details).toEqual({});

      const res404 = await app.inject({ method: 'GET', url: '/test-details-404' });
      expect(res404.statusCode).toBe(404);
      const body404 = res404.json<StandardErrorPayload>();
      expect(body404.error.details).toBeDefined();
      expect(body404.error.details).toEqual({});

      const res500 = await app.inject({ method: 'GET', url: '/test-details-500' });
      expect(res500.statusCode).toBe(500);
      const body500 = res500.json<StandardErrorPayload>();
      expect(body500.error.details).toBeDefined();
      expect(body500.error.details).toEqual({});

      await app.close();
    });
  });

  describe('Confidentiality and Leak Prevention (FR-011 / FR-004)', () => {
    it('strictly prevents stack trace leakage in response payload and headers', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-leak-stack', async () => {
        const error = new Error('Failure with synthetic stack trace');
        error.stack =
          'Error: Failure with synthetic stack trace\n' +
          '    at queryDatabase (/home/multica-agent/s2-assets/apps/api/src/db.ts:42:15)\n' +
          '    at Object.<anonymous> (/home/multica-agent/s2-assets/node_modules/kysely/index.js:10:5)\n' +
          '    at Module._compile (node:internal/modules/cjs/loader:1469:14)';
        throw error;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-leak-stack',
      });

      const rawPayload = response.payload;
      const rawHeaders = JSON.stringify(response.headers);
      const body = response.json() as Record<string, any>;

      expect(body).not.toHaveProperty('stack');
      expect(body.error).not.toHaveProperty('stack');
      expect(rawPayload).not.toContain('/home/multica-agent/');
      expect(rawPayload).not.toContain('node:internal/modules');
      expect(rawPayload).not.toContain('db.ts:42');
      expect(rawPayload).not.toMatch(/at\s+[a-zA-Z0-9_.]+\s+\(/);

      expect(rawHeaders).not.toContain('/home/multica-agent/');
      expect(rawHeaders).not.toContain('node:internal/modules');
      expect(rawHeaders).not.toContain('db.ts:42');
      expect(rawHeaders).not.toMatch(/at\s+[a-zA-Z0-9_.]+\s+\(/);
      expect(rawHeaders).not.toContain('stack');

      await app.close();
    });

    it('strictly prevents SQL queries and database internals leakage', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      const rawSqlQuery = 'SELECT id, username, password_hash FROM users WHERE username = \'admin\'';
      app.get('/test-leak-sql', async () => {
        const error = new Error(`QueryFailedError: syntax error at or near "SELECT": ${rawSqlQuery}`);
        throw error;
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-leak-sql',
      });

      const rawPayload = response.payload;
      const rawHeaders = JSON.stringify(response.headers);

      expect(rawPayload).not.toContain(rawSqlQuery);
      expect(rawPayload).not.toContain('SELECT id, username');
      expect(rawPayload).not.toContain('FROM users');
      expect(rawPayload).not.toContain('password_hash');
      expect(rawPayload).not.toContain('QueryFailedError');

      expect(rawHeaders).not.toContain(rawSqlQuery);
      expect(rawHeaders).not.toContain('SELECT');
      expect(rawHeaders).not.toContain('FROM users');
      expect(rawHeaders).not.toContain('password_hash');
      expect(rawHeaders).not.toContain('QueryFailedError');

      await app.close();
    });

    it('strictly prevents database connection strings and credentials leakage (DATABASE_URL)', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      const secretDbPassword = 'SUPER_SECRET_DATABASE_PASSWORD_999';
      const databaseUrl = `postgresql://s2_user:${secretDbPassword}@postgres:5432/s2_assets`;
      app.get('/test-leak-db-url', async () => {
        throw new Error(`Failed to establish connection to pool: ${databaseUrl}`);
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-leak-db-url',
      });

      const rawPayload = response.payload;
      const rawHeaders = JSON.stringify(response.headers);

      expect(rawPayload).not.toContain(secretDbPassword);
      expect(rawPayload).not.toContain(databaseUrl);
      expect(rawPayload).not.toContain('s2_user');
      expect(rawPayload).not.toContain('postgresql://');

      expect(rawHeaders).not.toContain(secretDbPassword);
      expect(rawHeaders).not.toContain(databaseUrl);
      expect(rawHeaders).not.toContain('s2_user');
      expect(rawHeaders).not.toContain('postgresql://');

      await app.close();
    });

    it('strictly prevents bearer tokens, cookies, and raw secrets leakage', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      const rawBearerToken = 'RAW_SECRET_BEARER_AUTH_TOKEN_ABC123';
      const rawCookieSecret = 'RAW_SECRET_SESSION_COOKIE_XYZ789';
      const rawSecretPassword = 'RAW_SECRET_USER_PASSWORD_PASS456';

      app.get('/test-leak-credentials', async () => {
        throw new Error(
          `Authentication failed for token Bearer ${rawBearerToken} with session cookie=${rawCookieSecret} and password ${rawSecretPassword}`
        );
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-leak-credentials',
      });

      const rawPayload = response.payload;
      const rawHeaders = JSON.stringify(response.headers);

      expect(rawPayload).not.toContain(rawBearerToken);
      expect(rawPayload).not.toContain(rawCookieSecret);
      expect(rawPayload).not.toContain(rawSecretPassword);

      expect(rawHeaders).not.toContain(rawBearerToken);
      expect(rawHeaders).not.toContain(rawCookieSecret);
      expect(rawHeaders).not.toContain(rawSecretPassword);

      await app.close();
    });

    it('strictly prevents file system paths and internal implementation class leakage', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      const internalPath = '/home/multica-agent/multica_workspaces/9gotstory-4a2227e79222/workdir/s2-assets/apps/api/src/services/auth.service.ts';
      const internalClass = 'PostgresDialect';
      app.get('/test-leak-paths', async () => {
        throw new Error(`Unhandled exception inside ${internalClass} at ${internalPath}`);
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-leak-paths',
      });

      const rawPayload = response.payload;
      const rawHeaders = JSON.stringify(response.headers);

      expect(rawPayload).not.toContain(internalPath);
      expect(rawPayload).not.toContain('/home/multica-agent/');
      expect(rawPayload).not.toContain('auth.service.ts');
      expect(rawPayload).not.toContain(internalClass);

      expect(rawHeaders).not.toContain(internalPath);
      expect(rawHeaders).not.toContain('/home/multica-agent/');
      expect(rawHeaders).not.toContain('auth.service.ts');
      expect(rawHeaders).not.toContain(internalClass);

      await app.close();
    });
  });

  describe('Fastify Plugin & Handler Registration Conformance', () => {
    it('conforms to error contract when registered via app.setErrorHandler(errorHandler)', async () => {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      app.get('/test-direct-handler', async () => {
        throw new Error('Direct handler test error');
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-direct-handler',
        headers: { 'x-request-id': 'direct-handler-req-1' },
      });

      expect(response.statusCode).toBe(500);
      const body = response.json<StandardErrorPayload>();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(body.error.request_id).toBe('direct-handler-req-1');

      await app.close();
    });

    it('conforms to error contract when registered via app.register(errorHandlerPlugin)', async () => {
      const app = Fastify();
      await app.register(errorHandlerPlugin);

      app.get('/test-plugin-handler', async () => {
        throw new Error('Plugin handler test error');
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test-plugin-handler',
        headers: { 'x-request-id': 'plugin-handler-req-2' },
      });

      expect(response.statusCode).toBe(500);
      const body = response.json<StandardErrorPayload>();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(body.error.request_id).toBe('plugin-handler-req-2');

      await app.close();
    });
  });
});
