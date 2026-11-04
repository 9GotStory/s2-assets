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

export type PublicRouteRule =
  | string
  | RegExp
  | {
      url: string | RegExp;
      methods?: readonly string[] | string;
    };

export const DEFAULT_PUBLIC_BOOTSTRAP_ROUTES: readonly string[] = [
  '/auth/login',
];

export const BOOTSTRAP_LOGIN_RULE: PublicRouteRule = {
  url: '/auth/login',
  methods: ['POST'],
};

export const TEST_CSRF_BOOTSTRAP_RULE: PublicRouteRule = {
  url: '/test-csrf-token',
  methods: ['GET', 'HEAD'],
};

export interface SessionCookieOptions {
  cookieName?: string;
  secure?: boolean;
  maxAge?: number; // in seconds
  expires?: Date;
  domain?: string;
  // Disallowed overrides typed as unknown to gracefully handle caller attempts and ignore/reject them
  httpOnly?: unknown;
  sameSite?: unknown;
  path?: unknown;
}

export interface AuthPluginOptions {
  databaseUrl?: string;
  db?: DatabaseClient | any;
  sessionService?: SessionService;
  userService?: UserService;
  cookieName?: string;
  secure?: boolean;
  sessionTtlMs?: number;
  publicRoutes?: (string | RegExp | PublicRouteRule)[];
  allowTestCsrfRoute?: boolean;
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
 * Sets a secure session cookie on the reply following strictly enforced security policies:
 * HttpOnly: true, SameSite: 'lax', Path: '/', Secure: true (in production).
 * Callers CANNOT weaken HttpOnly, SameSite, or Path invariants.
 * Lifetime overrides exceeding the 8-hour maximum policy are rejected.
 */
export function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  options?: SessionCookieOptions
): FastifyReply {
  const isSecure = resolveCookieSecure(options?.secure);
  const cookieName = options?.cookieName ?? DEFAULT_COOKIE_NAME;

  // Rigidly enforce security invariants: callers CANNOT override HttpOnly, SameSite, or Path
  const httpOnly = true;
  const sameSite = 'lax' as const;
  const path = '/';

  // Validate lifetime overrides: cannot exceed 8 hours
  let maxAge = DEFAULT_SESSION_TTL_SECONDS;
  if (options?.maxAge !== undefined) {
    if (typeof options.maxAge !== 'number' || !Number.isFinite(options.maxAge) || options.maxAge <= 0) {
      throw new Error('Cookie maxAge must be a positive number');
    }
    if (options.maxAge > DEFAULT_SESSION_TTL_SECONDS) {
      throw new Error(`Cookie maxAge cannot exceed 8 hours (${DEFAULT_SESSION_TTL_SECONDS} seconds)`);
    }
    maxAge = Math.floor(options.maxAge);
  }

  let expires: Date = new Date(Date.now() + maxAge * 1000);
  if (options?.expires !== undefined) {
    if (!(options.expires instanceof Date) || isNaN(options.expires.getTime())) {
      throw new Error('Invalid cookie expiration date');
    }
    const now = Date.now();
    const maxExpiryMs = now + DEFAULT_SESSION_TTL_SECONDS * 1000;
    if (options.expires.getTime() <= now) {
      throw new Error('Cookie expiration cannot be in the past');
    }
    if (options.expires.getTime() > maxExpiryMs) {
      throw new Error(`Cookie expiration cannot exceed 8 hours (${DEFAULT_SESSION_TTL_SECONDS} seconds)`);
    }
    expires = options.expires;
  }

  return reply.setCookie(cookieName, rawToken, {
    path,
    httpOnly,
    sameSite,
    secure: isSecure,
    maxAge,
    expires,
    ...(options?.domain ? { domain: options.domain } : {}),
  });
}

/**
 * Explicitly clears the session cookie by instructing the browser to delete it immediately,
 * rigidly preserving matching security attributes (HttpOnly: true, SameSite: Lax, Path: /, Secure).
 */
export function clearSessionCookie(
  reply: FastifyReply,
  options?: SessionCookieOptions
): FastifyReply {
  const isSecure = resolveCookieSecure(options?.secure);
  const cookieName = options?.cookieName ?? DEFAULT_COOKIE_NAME;

  // Rigidly retain matching security invariants and path on deletion
  const httpOnly = true;
  const sameSite = 'lax' as const;
  const path = '/';

  return reply.setCookie(cookieName, '', {
    path,
    httpOnly,
    sameSite,
    secure: isSecure,
    maxAge: 0,
    expires: new Date(0),
    ...(options?.domain ? { domain: options.domain } : {}),
  });
}

export function normalizeRoutePath(path: string): string {
  const stripped = path.split('?')[0].trim();
  if (!stripped || stripped === '/') {
    return '/';
  }
  return stripped.replace(/\/+$/, '') || '/';
}

function matchesUrlRule(pattern: string | RegExp, rawUrl: string, routerPath: string): boolean {
  if (typeof pattern === 'string') {
    const normalizedPattern = normalizeRoutePath(pattern);
    return rawUrl === normalizedPattern || routerPath === normalizedPattern;
  }
  if (pattern instanceof RegExp) {
    return pattern.test(rawUrl) || pattern.test(routerPath);
  }
  return false;
}

function matchesMethodRule(
  methods: readonly string[] | string | undefined,
  requestMethod: string
): boolean {
  if (!methods) {
    return true;
  }
  if (Array.isArray(methods)) {
    return methods.map((m) => m.toUpperCase()).includes(requestMethod);
  }
  if (typeof methods === 'string') {
    return methods.toUpperCase() === requestMethod;
  }
  return false;
}

/**
 * Determines whether a given request is explicitly declared as a public route.
 * Explicit protected declarations (auth: true, requireAuth: true, protected: true)
 * ALWAYS take precedence over public-route allowlists, bootstrap exceptions, and regex patterns.
 * Fails closed by default on all unmarked routes.
 */
export function isRouteExplicitlyPublic(
  request: FastifyRequest,
  publicRoutes: readonly PublicRouteRule[]
): boolean {
  const config = request.routeOptions?.config as Record<string, any> | undefined;

  // 1. Explicit protected declarations ALWAYS take precedence over any public allowlists or patterns -> FAIL CLOSED
  const isProtectedDeclared = Boolean(
    config?.auth === true ||
    config?.requireAuth === true ||
    config?.protected === true
  );

  if (isProtectedDeclared) {
    return false;
  }

  // Explicit non-public declarations fail closed
  if (config?.public === false || config?.isPublic === false) {
    return false;
  }

  // 2. Explicit route-level declaration
  const isPublicDeclared = Boolean(
    config?.public === true ||
    config?.isPublic === true
  );

  if (isPublicDeclared) {
    return true;
  }

  // 3. Match against configured public routes and bootstrap allowlist
  const rawUrl = request.url ? normalizeRoutePath(request.url) : '';
  const routerPath = request.routeOptions?.url
    ? normalizeRoutePath(request.routeOptions.url)
    : rawUrl;
  const requestMethod = (request.method || '').toUpperCase();

  for (const rule of publicRoutes) {
    if (typeof rule === 'string' || rule instanceof RegExp) {
      if (matchesUrlRule(rule, rawUrl, routerPath)) {
        return true;
      }
    } else if (typeof rule === 'object' && rule !== null && 'url' in rule) {
      if (
        matchesUrlRule(rule.url, rawUrl, routerPath) &&
        matchesMethodRule(rule.methods, requestMethod)
      ) {
        return true;
      }
    }
  }

  // Default: NOT public (fails closed by default)
  return false;
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

  const isProduction = process.env.NODE_ENV === 'production';
  const allowTestCsrf =
    options.allowTestCsrfRoute === true ||
    (!isProduction && options.allowTestCsrfRoute !== false);

  const bootstrapRules: PublicRouteRule[] = [BOOTSTRAP_LOGIN_RULE];
  if (allowTestCsrf) {
    bootstrapRules.push(TEST_CSRF_BOOTSTRAP_RULE);
  }

  const allowedPublicRoutes: readonly PublicRouteRule[] = options.publicRoutes
    ? [...bootstrapRules, ...options.publicRoutes]
    : bootstrapRules;

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

  // 8. Fail-closed global route authentication hook
  // Unmarked routes in the application scope require authentication by default.
  // Unauthenticated access is permitted ONLY through explicit public declarations.
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRouteExplicitlyPublic(request, allowedPublicRoutes)) {
      return;
    }

    // Fail closed by default on all other routes
    await authenticate(request, reply);
  });
};

// Global plugin encapsulation escape (fastify-plugin contract)
(authPlugin as any)[Symbol.for('skip-override')] = true;

export default authPlugin;
