import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import pg from 'pg';
import { loadConfig, type Config } from './config/env.ts';
import { createLogger, getLoggerOptions, type AppLoggerOptions } from './plugins/logger.ts';
import { errorHandler, errorHandlerPlugin } from './plugins/error-handler.ts';
import {
  csrfPlugin,
  isValidSigningSecret,
  type CsrfPluginOptions,
} from './plugins/csrf.ts';
import { authPlugin, type AuthPluginOptions } from './plugins/auth.ts';
import { authRoutes } from './routes/auth.routes.ts';
import { systemRoutes } from './routes/system.routes.ts';
import { healthRoutes } from './routes/health.routes.ts';
import { UserService, type DatabaseClient } from './services/user.service.ts';
import { SessionService } from './services/session.service.ts';
import { CapabilityService } from './services/capability.service.ts';

export interface AppOptions {
  config?: Partial<Config>;
  databaseUrl?: string;
  db?: DatabaseClient | pg.Pool | pg.Client | any;
  secure?: boolean;
  cookieSecret?: string;
  logger?: boolean | AppLoggerOptions | any;
  sessionTtlMs?: number;
  plugin?: (app: FastifyInstance) => Promise<void> | void;
}

/**
 * Builds and composes the Fastify application.
 *
 * Invariants enforced:
 * 1. Factory never calls listen() — listener lifecycle is owned by server entrypoint.
 * 2. Factory never registers process signal handlers (SIGINT/SIGTERM).
 * 3. Single PostgreSQL connection pool is owned and cleaned up on close if not injected.
 * 4. Injected database clients remain caller-owned and are never closed by the app.
 * 5. Plugin order: Error handler -> Logger -> CSRF -> Auth -> Routes.
 * 6. Public routes: /health and /ready at root; /auth/login bootstrap exception.
 * 7. Protected by default: all other unmarked routes fail closed with HTTP 401.
 * 8. /system/info requires authentication and 'system:maintain' capability.
 * 9. Test helper routes (like /test-csrf-token) are strictly forbidden and not registered.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  // 1. Resolve runtime environment and configuration
  const nodeEnv = options.config?.NODE_ENV ?? process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const secure = options.secure ?? (isProduction ? true : false);

  // 2. Resolve database client and pool ownership
  let ownedPool: pg.Pool | null = null;
  let dbClient: DatabaseClient | any = options.db;

  if (!dbClient) {
    const rawDbUrl =
      options.databaseUrl ??
      options.config?.DATABASE_URL ??
      process.env.DATABASE_URL;

    if (!rawDbUrl || typeof rawDbUrl !== 'string' || rawDbUrl.trim().length === 0) {
      throw new Error('Configuration validation failed: DATABASE_URL is required');
    }

    const trimmedUrl = rawDbUrl.trim();
    if (!trimmedUrl.startsWith('postgresql://')) {
      throw new Error('Configuration validation failed: DATABASE_URL must start with postgresql://');
    }

    try {
      ownedPool = new pg.Pool({ connectionString: trimmedUrl });
      ownedPool.on('error', (err) => {
        // Redact secrets if logging pool idle error
        app.log?.error?.(err, 'Unexpected error on idle database pool client');
      });
      dbClient = ownedPool;
    } catch (poolErr) {
      if (ownedPool) {
        await ownedPool.end().catch(() => {});
      }
      throw poolErr;
    }
  }

  // 3. Configure Fastify server options
  const fastifyOpts: FastifyServerOptions = {};

  if (options.logger === false) {
    fastifyOpts.logger = false;
  } else if (options.logger && typeof options.logger.info === 'function') {
    fastifyOpts.loggerInstance = options.logger;
  } else if (typeof options.logger === 'object' && options.logger !== null) {
    fastifyOpts.logger = getLoggerOptions(options.logger);
  } else {
    fastifyOpts.logger = getLoggerOptions();
  }

  const app = Fastify(fastifyOpts);

  try {
    // 4. Register standardized error handler
    await app.register(errorHandlerPlugin);

    // Fallback 404 handler strictly adhering to API error contract
    app.setNotFoundHandler(
      {
        config: {
          public: true,
          isPublic: true,
        },
      } as any,
      (request, reply) => {
        const notFoundErr = new Error('Requested resource not found') as Error & {
          statusCode: number;
          code: string;
        };
        notFoundErr.statusCode = 404;
        notFoundErr.code = 'NOT_FOUND';
        return errorHandler(notFoundErr as any, request, reply);
      }
    );

    // 5. Register CSRF protection plugin before Auth plugin
    const cookieSecret =
      options.cookieSecret ??
      process.env.COOKIE_SECRET ??
      process.env.CSRF_SECRET;

    const isSigned = isProduction || Boolean(cookieSecret);

    const csrfOpts: CsrfPluginOptions = {
      secure,
      signed: isSigned,
      ...(cookieSecret ? { cookieSecret } : {}),
    };

    await app.register(csrfPlugin, csrfOpts);

    // 6. Instantiate authoritative domain services sharing the resolved DB client
    const userService = new UserService({ db: dbClient });
    const sessionService = new SessionService({
      db: dbClient,
      ttlMs: options.sessionTtlMs,
    });
    const capabilityService = new CapabilityService({ db: dbClient });

    if (!app.hasDecorator('capabilityService')) {
      app.decorate('capabilityService', capabilityService);
    }

    // 7. Register Auth plugin in effective application scope
    // Note: allowTestCsrfRoute is explicitly false to prevent test route exposure
    const authOpts: AuthPluginOptions = {
      db: dbClient,
      userService,
      sessionService,
      secure,
      allowTestCsrfRoute: false,
      publicRoutes: [
        { url: '/health', methods: ['GET', 'HEAD'] },
        { url: '/ready', methods: ['GET', 'HEAD'] },
      ],
    };

    await app.register(authPlugin, authOpts);

    // 8. Register route modules
    // Auth routes mounted once under /auth
    await app.register(authRoutes, {
      prefix: '/auth',
      userService,
      sessionService,
    });

    // System routes mounted once under /system
    await app.register(systemRoutes, {
      prefix: '/system',
      capabilityService,
      db: dbClient,
    });

    // Health and readiness routes mounted at root
    await app.register(healthRoutes, {
      db: dbClient,
    });

    // 9. Register connection pool lifecycle hook for application-owned pool
    if (ownedPool) {
      app.addHook('onClose', async () => {
        await ownedPool?.end();
      });
    }

    // 10. Execute caller-provided test/extension plugin before finalizing
    if (options.plugin) {
      await options.plugin(app);
    }

    // 11. Finalize plugin registration without listening
    await app.ready();

    return app;
  } catch (initErr) {
    // If initialization fails, release any acquired resources before rethrowing
    if (ownedPool) {
      await ownedPool.end().catch(() => {});
    }
    throw initErr;
  }
}

export const createApp = buildApp;
export default buildApp;
