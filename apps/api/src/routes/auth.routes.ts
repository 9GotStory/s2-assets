import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import pg from 'pg';
import {
  UserService,
  type SafeUser,
} from '../services/user.service.ts';
import {
  SessionService,
  type Session,
} from '../services/session.service.ts';
import {
  AuthenticationError,
  setSessionCookie,
  clearSessionCookie,
} from '../plugins/auth.ts';

export interface AuthRoutesOptions {
  databaseUrl?: string;
  db?: any;
  userService?: UserService;
  sessionService?: SessionService;
  secure?: boolean;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify: FastifyInstance,
  options: AuthRoutesOptions = {}
): Promise<void> => {
  // Resolve services: reuse Fastify instance decorators where provided, then options, then database fallback
  let internalPool: pg.Pool | null = null;
  let userService: UserService | undefined =
    fastify.userService ?? options.userService;
  let sessionService: SessionService | undefined =
    fastify.sessionService ?? options.sessionService;

  if (!userService || !sessionService) {
    let dbClient = options.db ?? (fastify as any).pg?.pool ?? (fastify as any).pg;
    if (!dbClient) {
      if (options.databaseUrl) {
        internalPool = new pg.Pool({ connectionString: options.databaseUrl });
        dbClient = internalPool;
      } else if (process.env.DATABASE_URL) {
        internalPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        dbClient = internalPool;
      }
    }

    if (!userService && dbClient) {
      userService = new UserService({ db: dbClient });
    }
    if (!sessionService && dbClient) {
      sessionService = new SessionService({ db: dbClient });
    }
  }

  // Close internal database pool only if created by this plugin
  if (internalPool) {
    fastify.addHook('onClose', async () => {
      await internalPool?.end();
    });
  }

  // Fail closed if required services are unavailable
  if (!userService || !sessionService) {
    throw new Error('Auth routes require UserService and SessionService to be available.');
  }

  // Determine prefix-aware route paths
  const isAuthPrefixed = (fastify.prefix || '').replace(/\/+$/, '').endsWith('/auth');
  const loginPath = isAuthPrefixed ? '/login' : '/auth/login';
  const logoutPath = isAuthPrefixed ? '/logout' : '/auth/logout';
  const sessionCheckPath = isAuthPrefixed ? '/session-check' : '/auth/session-check';

  // 1. POST /auth/login
  fastify.post(
    loginPath,
    {
      config: {
        isPublic: true,
        public: true,
      },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { username?: string; password?: string } }>,
      reply: FastifyReply
    ) => {
      const { username, password } = request.body || {};

      if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
        throw new AuthenticationError(400, 'VALIDATION_FAILED', 'The provided request data is invalid.');
      }

      let credResult;
      try {
        credResult = await userService!.verifyCredentials(username, password);
      } catch {
        throw new AuthenticationError(500, 'DATABASE_ERROR', 'An unexpected internal server error occurred.');
      }

      if (!credResult.valid || !credResult.user) {
        if (credResult.reason === 'USER_DISABLED') {
          throw new AuthenticationError(403, 'USER_DISABLED', 'Permission denied');
        }
        throw new AuthenticationError(401, 'INVALID_CREDENTIALS', 'Authentication required');
      }

      let sessionResult;
      try {
        sessionResult = await sessionService!.createSession(credResult.user.id);
      } catch {
        throw new AuthenticationError(500, 'DATABASE_ERROR', 'An unexpected internal server error occurred.');
      }

      // Set secure session cookie using Fastify helper / decorator
      if (typeof reply.setSessionCookie === 'function') {
        reply.setSessionCookie(sessionResult.token);
      } else if (typeof (fastify as any).setSessionCookie === 'function') {
        (fastify as any).setSessionCookie(reply, sessionResult.token);
      } else {
        setSessionCookie(reply, sessionResult.token, { secure: options.secure });
      }

      return reply.status(200).send({
        user: credResult.user,
      });
    }
  );

  // 2. POST /auth/logout
  fastify.post(
    logoutPath,
    {
      config: {
        auth: true,
        requireAuth: true,
        csrf: true,
        requireCsrf: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user || !request.session) {
        if (typeof fastify.authenticate === 'function') {
          await fastify.authenticate(request, reply);
        }
      }

      if (!request.user || !request.session) {
        throw new AuthenticationError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      const rawToken = request.rawToken ?? (request as any).getSessionToken?.();
      const sessionDigest = request.session.id;

      try {
        let revoked = false;
        if (rawToken) {
          revoked = await sessionService!.revokeSession(rawToken);
        } else if (sessionDigest) {
          revoked = await sessionService!.revokeByDigest(sessionDigest);
        }

        if (!revoked) {
          throw new AuthenticationError(401, 'SESSION_NOT_FOUND', 'Authentication required');
        }
      } catch (err: any) {
        if (err instanceof AuthenticationError) {
          throw err;
        }
        throw new AuthenticationError(500, 'DATABASE_ERROR', 'An unexpected internal server error occurred.');
      }

      // Explicitly return a clearing session cookie
      if (typeof reply.clearSessionCookie === 'function') {
        reply.clearSessionCookie();
      } else if (typeof (fastify as any).clearSessionCookie === 'function') {
        (fastify as any).clearSessionCookie(reply);
      } else {
        clearSessionCookie(reply, { secure: options.secure });
      }

      return reply.status(200).send({ success: true });
    }
  );

  // 3. GET /auth/session-check
  fastify.get(
    sessionCheckPath,
    {
      config: {
        auth: true,
        requireAuth: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user || !request.session) {
        if (typeof fastify.authenticate === 'function') {
          await fastify.authenticate(request, reply);
        }
      }

      if (!request.user || !request.session) {
        throw new AuthenticationError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      // Generate CSRF token if available to supply client for subsequent state-changing requests
      let csrfToken: string | undefined;
      try {
        if (typeof (reply as any).generateCsrf === 'function') {
          csrfToken = (reply as any).generateCsrf();
        } else if (typeof (fastify as any).generateCsrf === 'function') {
          csrfToken = (fastify as any).generateCsrf(reply);
        }
      } catch {
        // Non-fatal if CSRF protection is not registered
      }

      if (csrfToken) {
        reply.header('x-csrf-token', csrfToken);
      }

      return reply.status(200).send({
        user: request.user,
        ...(csrfToken ? { csrfToken } : {}),
      });
    }
  );
};

export default authRoutes;
