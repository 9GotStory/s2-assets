import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import pg from 'pg';
import { errorHandler } from '../plugins/error-handler.ts';
import type { DatabaseClient } from '../services/session.service.ts';

export const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 3000;

export interface HealthRoutesOptions {
  databaseUrl?: string;
  db?: DatabaseClient | pg.Pool | pg.Client | any;
  timeoutMs?: number;
}

export class HealthError extends Error {
  statusCode: number;
  code: string;

  constructor(
    statusCode: number = 503,
    code: string = 'SERVICE_UNAVAILABLE',
    message: string = 'Service temporarily unavailable.'
  ) {
    super(message);
    this.name = 'HealthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class HealthCheckError extends HealthError {}

/**
 * Executes a fresh database connectivity check using SELECT 1 with a bounded timeout.
 * Rejects if the check times out, throws a connection error, or fails.
 */
async function checkDbConnectivity(
  db: { query: (text: string, params?: unknown[]) => Promise<any> },
  timeoutMs: number = DEFAULT_CONNECTIVITY_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Database connectivity check timed out'));
    }, timeoutMs);
  });

  const queryPromise = Promise.resolve().then(() => db.query('SELECT 1'));
  queryPromise.catch(() => {
    // Suppress unhandled rejection if timeoutPromise rejects first
  });

  try {
    await Promise.race([queryPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Health & Readiness Routes Plugin (T030 - User Story 3)
 *
 * Mounts:
 * - GET /health: Liveness probe verifying application process is responsive. No database dependency.
 * - GET /ready: Readiness probe gating on fresh PostgreSQL connectivity check (SELECT 1).
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  fastify: FastifyInstance,
  options: HealthRoutesOptions = {}
): Promise<void> => {
  // Ensure route errors strictly conform to the standardized error contract
  fastify.setErrorHandler(errorHandler);

  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_CONNECTIVITY_TIMEOUT_MS;

  // Resolve database client according to strict dependency precedence:
  // 1. Explicitly injected db client
  // 2. Explicit databaseUrl used to create a single plugin-owned pool
  // No silent fallback to ambient environment variables or other databases
  let internalPool: pg.Pool | null = null;
  let dbClient: { query: (text: string, params?: unknown[]) => Promise<any> } | null = null;

  if (options.db && typeof (options.db as any).query === 'function') {
    dbClient = options.db;
  } else if (!options.db && typeof options.databaseUrl === 'string' && options.databaseUrl.trim().length > 0) {
    try {
      internalPool = new pg.Pool({
        connectionString: options.databaseUrl,
        connectionTimeoutMillis: timeoutMs,
      });
      internalPool.on('error', () => {
        // Suppress unhandled error events on idle clients during database outages
      });
      dbClient = internalPool;
    } catch {
      internalPool = null;
      dbClient = null;
    }
  }

  // Register onClose cleanup for plugin-owned connection pools.
  // Externally injected database clients must NEVER be closed.
  if (internalPool) {
    fastify.addHook('onClose', async () => {
      await internalPool?.end();
    });
  }

  // GET /health — Liveness probe (public route, no database check)
  fastify.get(
    '/health',
    {
      config: {
        public: true,
        isPublic: true,
      },
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      return { status: 'ok' };
    }
  );

  // GET /ready — Readiness probe (public route, fresh SELECT 1 check)
  fastify.get(
    '/ready',
    {
      config: {
        public: true,
        isPublic: true,
      },
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      if (!dbClient || typeof dbClient.query !== 'function') {
        throw new HealthError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');
      }

      try {
        await checkDbConnectivity(dbClient, timeoutMs);
      } catch {
        throw new HealthError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');
      }

      return { status: 'ok' };
    }
  );
};

export default healthRoutes;
