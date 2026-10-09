import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fastifyCookie from '@fastify/cookie';
import pg from 'pg';
import {
  SessionService,
  isValidRawToken,
  validateSessionTtl,
  SESSION_TTL_MS,
  type Session,
  type DatabaseClient,
} from '../services/session.service.ts';
import {
  UserService,
  type SafeUser,
  type User,
} from '../services/user.service.ts';

export const DEFAULT_COOKIE_NAME = 'session';
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60; // 28,800 seconds (8 hours)

export interface SessionCookieOptions {
  cookieName?: string;
  secure?: boolean;
  path?: string;
  sameSite?: 'lax' | 'strict' | 'none';
  maxAge?: number; // in seconds
  expires?: Date;
  domain?: string;
}

export interface AuthPluginOptions {
  databaseUrl?: string;
  db?: DatabaseClient | any;
  sessionService?: SessionService;
  userService?: UserService;
  cookieName?: string;
  secure?: boolean;
  sessionTtlMs?: number;
  protectAll?: boolean;
  rolling?: boolean;
}

export class AuthenticationError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message?: string) {
    super(message || 'Authentication required');
    this.name = 'AuthenticationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Resolves whether the cookie must have the Secure flag.
 * In production, Secure is strictly enforced and cannot be weakened.
 * In development and test environments, explicit options override the default (false).
 */
export function resolveCookieSecure(optionsSecure?: boolean): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  return optionsSecure ?? false;
}

/**
 * Safely extracts the raw session token from request cookies or raw Cookie header.
 */
export function getSessionCookie(
  request: FastifyRequest,
  cookieName: string = DEFAULT_COOKIE_NAME
): string | undefined {
  if (request.cookies && typeof request.cookies === 'object') {
    const val = request.cookies[cookieName];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }

  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader === 'string' && cookieHeader.length > 0) {
    if (typeof (request.server as any).parseCookie === 'function') {
      const parsed = (request.server as any).parseCookie(cookieHeader);
      const val = parsed[cookieName];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    } else {
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
      if (match && match[1]) {
        return decodeURIComponent(match[1].trim());
      }
    }
  }

  return undefined;
}

/**
 * Sets a secure session cookie on the reply following strict security policies:
 * HttpOnly: true, SameSite: 'lax', Path: '/', Secure: true (in production).
 */
export function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  options?: SessionCookieOptions
): FastifyReply {
  const isSecure = resolveCookieSecure(options?.secure);
  const cookieName = options?.cookieName ?? DEFAULT_COOKIE_NAME;
  const path = options?.path ?? '/';
  const sameSite = options?.sameSite ?? 'lax';
  const maxAge = options?.maxAge ?? DEFAULT_SESSION_TTL_SECONDS;
  const expires = options?.expires ?? new Date(Date.now() + maxAge * 1000);

  return reply.setCookie(cookieName, rawToken, {
    path,
    httpOnly: true,
    sameSite,
    secure: isSecure,
    maxAge,
    expires,
    ...(options?.domain ? { domain: options.domain } : {}),
  });
}

/**
 * Explicitly clears the session cookie by instructing the browser to delete it immediately,
 * preserving security attributes (HttpOnly, SameSite, Path, Secure).
 */
export function clearSessionCookie(
  reply: FastifyReply,
  options?: SessionCookieOptions
): FastifyReply {
  const isSecure = resolveCookieSecure(options?.secure);
  const cookieName = options?.cookieName ?? DEFAULT_COOKIE_NAME;
  const path = options?.path ?? '/';
  const sameSite = options?.sameSite ?? 'lax';

  return reply.setCookie(cookieName, '', {
    path,
    httpOnly: true,
    sameSite,
    secure: isSecure,
    maxAge: 0,
    expires: new Date(0),
    ...(options?.domain ? { domain: options.domain } : {}),
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    sessionService: SessionService;
    userService: UserService;
    setSessionCookie: (reply: FastifyReply, rawToken: string, options?: SessionCookieOptions) => FastifyReply;
    clearSessionCookie: (reply: FastifyReply, options?: SessionCookieOptions) => FastifyReply;
  }

  interface FastifyRequest {
    user: SafeUser | null;
    session: Session | null;
    rawToken: string | null;
    isAuthenticated: () => boolean;
    getSessionToken: () => string | undefined;
  }

  interface FastifyReply {
    setSessionCookie: (rawToken: string, options?: SessionCookieOptions) => FastifyReply;
    clearSessionCookie: (options?: SessionCookieOptions) => FastifyReply;
  }
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify: FastifyInstance,
  options: AuthPluginOptions = {}
): Promise<void> => {
  // 1. Ensure @fastify/cookie is registered
  if (!fastify.parseCookie && !fastify.hasRequestDecorator('cookies')) {
    await fastify.register(fastifyCookie);
  }

  // 2. Validate TTL if explicitly passed
  if (options.sessionTtlMs !== undefined) {
    validateSessionTtl(options.sessionTtlMs);
  }

  // 3. Resolve database client & dependency injection
  let internalPool: pg.Pool | null = null;
  let dbClient = options.db;

  if (!dbClient && !options.sessionService && !options.userService) {
    if (options.databaseUrl) {
      internalPool = new pg.Pool({ connectionString: options.databaseUrl });
      dbClient = internalPool;
    } else if (process.env.DATABASE_URL) {
      internalPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      dbClient = internalPool;
    } else if ((fastify as any).pg?.pool || (fastify as any).pg) {
      dbClient = (fastify as any).pg?.pool ?? (fastify as any).pg;
    }
  }

  const sessionService =
    options.sessionService ??
    new SessionService({
      db: dbClient,
      ttlMs: options.sessionTtlMs ?? SESSION_TTL_MS,
    });

  const userService =
    options.userService ??
    new UserService({
      db: dbClient,
    });

  // Externally injected database clients must NEVER be closed by authPlugin
  if (internalPool) {
    fastify.addHook('onClose', async () => {
      await internalPool?.end();
    });
  }

  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const isSecure = resolveCookieSecure(options.secure);
  const ttlSeconds = options.sessionTtlMs
    ? Math.floor(options.sessionTtlMs / 1000)
    : DEFAULT_SESSION_TTL_SECONDS;
  const rolling = options.rolling ?? true;

  const boundSetSessionCookie = (
    reply: FastifyReply,
    rawToken: string,
    opts?: SessionCookieOptions
  ): FastifyReply => {
    return setSessionCookie(reply, rawToken, {
      cookieName,
      secure: isSecure,
      maxAge: ttlSeconds,
      ...opts,
    });
  };

  const boundClearSessionCookie = (
    reply: FastifyReply,
    opts?: SessionCookieOptions
  ): FastifyReply => {
    return clearSessionCookie(reply, {
      cookieName,
      secure: isSecure,
      ...opts,
    });
  };

  // 4. Authentication logic: verifies session digests and user state authoritatively
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // If request has already been authenticated in this request lifecycle, reuse context
    if (request.user && request.session) {
      return;
    }

    const rawToken = getSessionCookie(request, cookieName);
    if (!rawToken) {
      throw new AuthenticationError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!isValidRawToken(rawToken)) {
      throw new AuthenticationError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    let session: Session | null = null;
    try {
      session = await sessionService.validateSession(rawToken, { rolling });
    } catch {
      throw new AuthenticationError(500, 'DATABASE_ERROR', 'An unexpected internal server error occurred.');
    }

    if (!session) {
      let verifyResult;
      try {
        verifyResult = await sessionService.verifySession(rawToken);
      } catch {
        throw new AuthenticationError(500, 'DATABASE_ERROR', 'An unexpected internal server error occurred.');
      }

      if (verifyResult.reason === 'EXPIRED') {
        throw new AuthenticationError(401, 'SESSION_EXPIRED', 'Authentication required');
      }

      throw new AuthenticationError(401, 'SESSION_NOT_FOUND', 'Authentication required');
    }

    let user: User | null = null;
    try {
      user = await userService.findById(session.user_id);
    } catch {
      throw new AuthenticationError(500, 'DATABASE_ERROR', 'An unexpected internal server error occurred.');
    }

    if (!user) {
      throw new AuthenticationError(401, 'USER_NOT_FOUND', 'Authentication required');
    }

    if (!user.is_active) {
      throw new AuthenticationError(403, 'USER_DISABLED', 'Permission denied');
    }

    // Attach authenticated context (passwords and raw tokens stripped from public surfaces)
    request.user = userService.sanitizeUser(user);
    request.session = session;
    request.rawToken = rawToken;

    // Refresh client cookie lifetime with rolling expiration
    if (rolling) {
      boundSetSessionCookie(reply, rawToken);
    }
  };

  // 5. Decorate Fastify instance
  if (!fastify.hasDecorator('authenticate')) {
    fastify.decorate('authenticate', authenticate);
  }
  if (!fastify.hasDecorator('requireAuth')) {
    fastify.decorate('requireAuth', authenticate);
  }
  if (!fastify.hasDecorator('sessionService')) {
    fastify.decorate('sessionService', sessionService);
  }
  if (!fastify.hasDecorator('userService')) {
    fastify.decorate('userService', userService);
  }
  if (!fastify.hasDecorator('setSessionCookie')) {
    fastify.decorate('setSessionCookie', boundSetSessionCookie);
  }
  if (!fastify.hasDecorator('clearSessionCookie')) {
    fastify.decorate('clearSessionCookie', boundClearSessionCookie);
  }

  // 6. Decorate Request
  if (!fastify.hasRequestDecorator('user')) {
    fastify.decorateRequest('user', null);
  }
  if (!fastify.hasRequestDecorator('session')) {
    fastify.decorateRequest('session', null);
  }
  if (!fastify.hasRequestDecorator('rawToken')) {
    fastify.decorateRequest('rawToken', null);
  }
  if (!fastify.hasRequestDecorator('isAuthenticated')) {
    fastify.decorateRequest('isAuthenticated', function (this: FastifyRequest) {
      return Boolean(this.user && this.session);
    });
  }
  if (!fastify.hasRequestDecorator('getSessionToken')) {
    fastify.decorateRequest('getSessionToken', function (this: FastifyRequest) {
      return getSessionCookie(this, cookieName);
    });
  }

  // 7. Decorate Reply
  if (!fastify.hasReplyDecorator('setSessionCookie')) {
    fastify.decorateReply('setSessionCookie', function (
      this: FastifyReply,
      rawToken: string,
      opts?: SessionCookieOptions
    ) {
      return boundSetSessionCookie(this, rawToken, opts);
    });
  }
  if (!fastify.hasReplyDecorator('clearSessionCookie')) {
    fastify.decorateReply('clearSessionCookie', function (
      this: FastifyReply,
      opts?: SessionCookieOptions
    ) {
      return boundClearSessionCookie(this, opts);
    });
  }

  // 8. Enforce protected route hook
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const config = request.routeOptions?.config as
      | { auth?: boolean; requireAuth?: boolean; public?: boolean; isPublic?: boolean }
      | undefined;

    // Explicit public routes bypass authentication
    if (config?.public === true || config?.isPublic === true) {
      return;
    }

    if (options.protectAll || config?.auth === true || config?.requireAuth === true) {
      await authenticate(request, reply);
    }
  });
};

// Global plugin encapsulation escape (fastify-plugin contract)
(authPlugin as any)[Symbol.for('skip-override')] = true;

export default authPlugin;
