import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { createLogger, getLoggerOptions, REDACTED_PATHS } from '../../src/plugins/logger.ts';

function createLogCapture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    getRawLogs: () => chunks.join(''),
    getParsedLogs: (): Record<string, unknown>[] =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        }),
  };
}

describe('Logger Secret Redaction (T012)', () => {
  describe('Configured Secret Fields Configuration', () => {
    it('defines explicit list of sensitive fields and paths for redaction', () => {
      expect(REDACTED_PATHS).toBeDefined();
      expect(Array.isArray(REDACTED_PATHS)).toBe(true);

      const criticalFields = [
        'password',
        'token',
        'secret',
        'password_hash',
        'DATABASE_URL',
      ];
      for (const field of criticalFields) {
        const hasField = REDACTED_PATHS.some((path: string) => path.includes(field));
        expect(hasField).toBe(true);
      }

      const hasAuthHeader = REDACTED_PATHS.some((path: string) => path.includes('authorization'));
      const hasCookieHeader = REDACTED_PATHS.some((path: string) => path.includes('cookie'));
      expect(hasAuthHeader).toBe(true);
      expect(hasCookieHeader).toBe(true);
    });

    it('provides logger options configured with redaction paths and censor', () => {
      const options = getLoggerOptions();
      expect(options).toBeDefined();
      expect(options.redact).toBeDefined();

      if (Array.isArray(options.redact)) {
        expect(options.redact.length).toBeGreaterThan(0);
      } else {
        expect(options.redact.paths).toBeDefined();
        expect(options.redact.paths.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Operational Log Emission and Direct Logger Redaction', () => {
    it('redacts top-level configured secret fields from emitted logs', () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const logger = createLogger({ stream });

      const rawSecretPassword = 'RAW_SECRET_PASSWORD_12345';
      const rawSecretToken = 'RAW_SECRET_TOKEN_ABCDEF';
      const rawSecretHash = '$argon2id$v=19$m=65536,t=3,p=4$syntheticHash';

      logger.info(
        {
          password: rawSecretPassword,
          token: rawSecretToken,
          password_hash: rawSecretHash,
        },
        'user credential operation'
      );

      const rawOutput = getRawLogs();
      expect(rawOutput).not.toContain(rawSecretPassword);
      expect(rawOutput).not.toContain(rawSecretToken);
      expect(rawOutput).not.toContain(rawSecretHash);

      const logs = getParsedLogs();
      expect(logs.length).toBeGreaterThan(0);
      const entry = logs[0];
      expect(entry.password).toBe('[REDACTED]');
      expect(entry.token).toBe('[REDACTED]');
      expect(entry.password_hash).toBe('[REDACTED]');
    });

    it('redacts nested secret fields within operational payloads', () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const logger = createLogger({ stream });

      const nestedSecret = 'RAW_NESTED_SECRET_98765';
      const userEmail = 'operator@example.com';

      logger.info(
        {
          user: {
            email: userEmail,
            password: nestedSecret,
          },
          credentials: {
            token: 'RAW_NESTED_TOKEN_555',
          },
        },
        'nested payload log'
      );

      const rawOutput = getRawLogs();
      expect(rawOutput).not.toContain(nestedSecret);
      expect(rawOutput).not.toContain('RAW_NESTED_TOKEN_555');
      expect(rawOutput).toContain(userEmail);

      const logs = getParsedLogs();
      const entry = logs[0] as any;
      expect(entry.user.email).toBe(userEmail);
      expect(entry.user.password).toBe('[REDACTED]');
      expect(entry.credentials.token).toBe('[REDACTED]');
    });

    it('redacts connection strings containing database credentials (DATABASE_URL)', () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const logger = createLogger({ stream });

      const secretDbPassword = 'RAW_SUPER_SECRET_DB_PASS';
      const databaseUrl = `postgresql://s2_user:${secretDbPassword}@postgres:5432/s2_assets`;

      logger.info({ DATABASE_URL: databaseUrl }, 'database connection details');

      const rawOutput = getRawLogs();
      expect(rawOutput).not.toContain(secretDbPassword);

      const logs = getParsedLogs();
      const entry = logs[0] as any;
      expect(entry.DATABASE_URL).toBe('[REDACTED]');
    });

    it('redacts sensitive headers when logging request objects', () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const logger = createLogger({ stream });

      const rawBearerToken = 'RAW_SECRET_BEARER_TOKEN';
      const rawSessionCookie = 'session=RAW_SECRET_SESSION_ID';

      logger.info(
        {
          headers: {
            authorization: `Bearer ${rawBearerToken}`,
            cookie: rawSessionCookie,
            'content-type': 'application/json',
          },
        },
        'incoming request headers'
      );

      const rawOutput = getRawLogs();
      expect(rawOutput).not.toContain(rawBearerToken);
      expect(rawOutput).not.toContain('RAW_SECRET_SESSION_ID');
      expect(rawOutput).toContain('application/json');

      const logs = getParsedLogs();
      const entry = logs[0] as any;
      expect(entry.headers.authorization).toBe('[REDACTED]');
      expect(entry.headers.cookie).toBe('[REDACTED]');
      expect(entry.headers['content-type']).toBe('application/json');
    });

    it('redacts secrets across different operational log levels (warn, error, debug)', () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const logger = createLogger({ stream, level: 'debug' });

      const warnSecret = 'RAW_WARN_SECRET_111';
      const errorSecret = 'RAW_ERROR_SECRET_222';
      const debugSecret = 'RAW_DEBUG_SECRET_333';

      logger.warn({ secret: warnSecret }, 'warning condition');
      logger.error({ password: errorSecret }, 'error condition');
      logger.debug({ token: debugSecret }, 'debug trace');

      const rawOutput = getRawLogs();
      expect(rawOutput).not.toContain(warnSecret);
      expect(rawOutput).not.toContain(errorSecret);
      expect(rawOutput).not.toContain(debugSecret);

      const logs = getParsedLogs();
      expect(logs.length).toBe(3);
      expect(logs[0].secret).toBe('[REDACTED]');
      expect(logs[1].password).toBe('[REDACTED]');
      expect(logs[2].token).toBe('[REDACTED]');
    });

    it('preserves non-sensitive operational metadata while redacting secrets', () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const logger = createLogger({ stream });

      const sensitiveKey = 'SUPER_SENSITIVE_API_KEY';
      logger.info(
        {
          event: 'session_authenticated',
          userId: '123e4567-e89b-12d3-a456-426614174000',
          role: 'ADMINISTRATOR',
          status: 200,
          token: sensitiveKey,
        },
        'session established'
      );

      const rawOutput = getRawLogs();
      expect(rawOutput).not.toContain(sensitiveKey);
      expect(rawOutput).toContain('session_authenticated');
      expect(rawOutput).toContain('123e4567-e89b-12d3-a456-426614174000');
      expect(rawOutput).toContain('ADMINISTRATOR');

      const logs = getParsedLogs();
      const entry = logs[0] as any;
      expect(entry.event).toBe('session_authenticated');
      expect(entry.userId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(entry.role).toBe('ADMINISTRATOR');
      expect(entry.status).toBe(200);
      expect(entry.token).toBe('[REDACTED]');
    });
  });

  describe('Fastify Operational Request Logging Integration', () => {
    it('redacts sensitive headers in Fastify HTTP requests', async () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const loggerOptions = getLoggerOptions({ stream });

      const app = Fastify({ logger: loggerOptions });

      app.get('/test-auth', async (req) => {
        req.log.info({ headers: req.headers }, 'handling test-auth route');
        return { ok: true };
      });

      await app.ready();

      const rawSecretBearer = 'RAW_HTTP_BEARER_SECRET_TOKEN_777';
      const rawCookieSecret = 'RAW_COOKIE_SECRET_VAL_888';

      const response = await app.inject({
        method: 'GET',
        url: '/test-auth',
        headers: {
          authorization: `Bearer ${rawSecretBearer}`,
          cookie: `session_token=${rawCookieSecret}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const rawLogs = getRawLogs();
      expect(rawLogs).not.toContain(rawSecretBearer);
      expect(rawLogs).not.toContain(rawCookieSecret);

      const parsedLogs = getParsedLogs();
      const headerLog = parsedLogs.find(
        (entry) => (entry as any).msg === 'handling test-auth route'
      ) as any;
      expect(headerLog).toBeDefined();
      expect(headerLog.headers).toBeDefined();
      expect(headerLog.headers.authorization).toBe('[REDACTED]');
      expect(headerLog.headers.cookie).toBe('[REDACTED]');

      await app.close();
    });

    it('redacts sensitive request body fields in Fastify HTTP requests', async () => {
      const { stream, getRawLogs, getParsedLogs } = createLogCapture();
      const loggerOptions = getLoggerOptions({ stream });

      const app = Fastify({ logger: loggerOptions });

      app.post('/test-login', async (req) => {
        req.log.info({ body: req.body }, 'processing login payload');
        return { ok: true };
      });

      await app.ready();

      const rawSubmittedPassword = 'RAW_SUBMITTED_PASSWORD_SECRET';

      const response = await app.inject({
        method: 'POST',
        url: '/test-login',
        payload: {
          username: 'testuser',
          password: rawSubmittedPassword,
        },
      });

      expect(response.statusCode).toBe(200);

      const rawLogs = getRawLogs();
      expect(rawLogs).not.toContain(rawSubmittedPassword);
      expect(rawLogs).toContain('testuser');

      const parsedLogs = getParsedLogs();
      const bodyLog = parsedLogs.find(
        (entry) => (entry as any).msg === 'processing login payload'
      ) as any;
      expect(bodyLog).toBeDefined();
      expect(bodyLog.body).toBeDefined();
      expect(bodyLog.body.username).toBe('testuser');
      expect(bodyLog.body.password).toBe('[REDACTED]');

      await app.close();
    });
  });
});
