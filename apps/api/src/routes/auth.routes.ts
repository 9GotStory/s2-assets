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
import { AuthenticationError } from '../plugins/auth.ts';

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
  // 1. Validate required security plugins are registered (Finding 1)
  // Auth routes strictly depend on T020 Auth Plugin and T021 CSRF Plugin.
  // Partial or standalone initialization without security enforcement is rejected (fails closed).
  const hasAuthPlugin = Boolean(
    (fastify.hasDecorator('authenticate') || typeof (fastify as any).authenticate === 'function') &&
    (fastify.hasDecorator('setSessionCookie') || fastify.hasReplyDecorator('setSessionCookie')) &&
    (fastify.hasDecorator('clearSessionCookie') || fastify.hasReplyDecorator('clearSessionCookie'))
  );

  if (!hasAuthPlugin) {
    throw new Error('Auth routes require Fastify Auth Plugin (T020) to be registered.');
  }

  const hasCsrfPlugin = Boolean(
    (fastify.hasDecorator('csrfProtection') || typeof (fastify as any).csrfProtection === 'function') &&
    (fastify.hasDecorator('generateCsrf') || fastify.hasReplyDecorator('generateCsrf'))
  );

  if (!hasCsrfPlugin) {
    throw new Error('Auth routes require Fastify CSRF Plugin (T021) to be registered.');
  }

  // 2. Resolve authoritative services established by T020 (Finding 2)
  // Prioritize authoritative Fastify decorator instances.
  let userService: UserService | undefined = fastify.userService;
  let sessionService: SessionService | undefined = fastify.sessionService;

  // If explicit injected services are provided, require strict identity equality against authoritative instances
  if (options.userService) {
    if (userService && options.userService !== userService) {
      throw new Error('Injected userService does not match authoritative Fastify userService instance.');
    }
    userService = options.userService;
  }

  if (options.sessionService) {
    if (sessionService && options.sessionService !== sessionService) {
      throw new Error('Injected sessionService does not match authoritative Fastify sessionService instance.');
    }
    sessionService = options.sessionService;
  }

  // Do not construct an unnecessary second DB pool if authoritative services exist
  let internalPool: pg.Pool | null = null;
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

  // Close internal database pool only if created by this plugin (preserve externally owned connections)
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

      // Set secure session cookie strictly using the official T020 decorator
      if (typeof reply.setSessionCookie === 'function') {
        reply.setSessionCookie(sessionResult.token);
      } else if (typeof (fastify as any).setSessionCookie === 'function') {
        (fastify as any).setSessionCookie(reply, sessionResult.token);
      } else {
        throw new AuthenticationError(500, 'INTERNAL_SERVER_ERROR', 'Session cookie decorator is not available.');
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

      // Explicitly return a clearing session cookie strictly using the official T020 decorator
      if (typeof reply.clearSessionCookie === 'function') {
        reply.clearSessionCookie();
      } else if (typeof (fastify as any).clearSessionCookie === 'function') {
        (fastify as any).clearSessionCookie(reply);
      } else {
        throw new AuthenticationError(500, 'INTERNAL_SERVER_ERROR', 'Session cookie decorator is not available.');
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

      // Generate genuine CSRF token via official T021 integration
      // Treat missing or malfunctioning CSRF token generation as a fail-closed error
      let csrfToken: string | undefined;
      try {
        if (typeof reply.generateCsrf === 'function') {
          csrfToken = reply.generateCsrf();
        } else if (typeof (fastify as any).generateCsrf === 'function') {
          csrfToken = (fastify as any).generateCsrf(reply);
        } else {
          throw new Error('CSRF token generation decorator is not available.');
        }

        if (typeof csrfToken !== 'string' || csrfToken.trim().length === 0) {
          throw new Error('Generated CSRF token is invalid or empty.');
        }
      } catch {
        // Finding 1: Do NOT log raw error object, message, stack, or secrets.
        // Log a generic, safe diagnostic message only.
        request.log?.error?.('CSRF token generation failed during session check');
        throw new AuthenticationError(500, 'INTERNAL_SERVER_ERROR', 'An unexpected internal server error occurred.');
      }

      reply.header('x-csrf-token', csrfToken);

      return reply.status(200).send({
        user: request.user,
        csrfToken,
      });
    }
  );
};

export default authRoutes;
