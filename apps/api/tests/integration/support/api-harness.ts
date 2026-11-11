import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { runMigrator } from '../../../../../packages/db/src/migrator.ts';
import { buildApp } from '../../../src/app.ts';
import type { AppLoggerOptions } from '../../../src/plugins/logger.ts';
import type { Role } from '../../../src/services/capability.service.ts';
import { SessionService } from '../../../src/services/session.service.ts';
import { UserService } from '../../../src/services/user.service.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../../packages/db/src/migrations');
const POOL_END_TIMEOUT_MS = 5_000;

export type Actor = { id: string; cookie: string; csrf: string };

export interface ApiHarness {
  app: FastifyInstance;
  // A pool of its own on the application's database, for observers and lock holders.
  pool: pg.Pool;
  // Creates an active user holding `role`, with a real session and CSRF token.
  actor: (username: string, role: Role) => Promise<Actor>;
  post: (actor: Actor, url: string, payload: unknown, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
  get: (actor: Actor, url: string) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

/**
 * Seam A's composed application over a disposable PostgreSQL, migrated to the latest schema. Call it
 * in `beforeAll` with a 120-second timeout, and `close` it in `afterAll`.
 */
export async function startApiHarness(options: { clock?: () => Date; logger?: AppLoggerOptions } = {}): Promise<ApiHarness> {
  const container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
  const databaseUrl = container.getConnectionUri();
  const { error } = await runMigrator({ command: 'latest', databaseUrl, migrationFolder });
  if (error) {
    throw error;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const sessionService = new SessionService({ db: pool });
  const app = await buildApp({
    db: pool,
    cookieSecret: 'test-secret-at-least-32-chars-long-api-harness',
    logger: options.logger ?? false,
    clock: options.clock,
  });
  const passwordHash = await UserService.hashPassword('Password123!');

  return {
    app,
    pool,
    actor: async (username, role) => {
      const res = await pool.query(
        'INSERT INTO users (username, password_hash, is_active) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash]
      );
      const id: string = res.rows[0].id;
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, role]);

      const session = await sessionService.createSession(id);
      const sessionCookie = `session=${session.token}`;
      const check = await app.inject({ method: 'GET', url: '/auth/session-check', headers: { cookie: sessionCookie } });
      const setCookie = check.headers['set-cookie'];
      const csrfCookie = setCookie
        ? Array.isArray(setCookie)
          ? setCookie.map((c: string) => c.split(';')[0]).join('; ')
          : setCookie.split(';')[0]
        : '';
      return {
        id,
        cookie: csrfCookie ? `${sessionCookie}; ${csrfCookie}` : sessionCookie,
        csrf: JSON.parse(check.body).csrfToken || '',
      };
    },
    post: (actor, url, payload, headers = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie: actor.cookie, 'x-csrf-token': actor.csrf, 'content-type': 'application/json', ...headers },
        payload: payload as any,
      }),
    get: (actor, url) => app.inject({ method: 'GET', url, headers: { cookie: actor.cookie } }),
    close: async () => {
      await app.close();
      // pool.end() waits for every checked-out connection, so one left behind by a failing test would
      // hang the file instead of letting it fail. Stopping the container drops that connection.
      await Promise.race([pool.end(), delay(POOL_END_TIMEOUT_MS, undefined, { ref: false })]);
      await container.stop();
    },
  };
}
