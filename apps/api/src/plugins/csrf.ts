import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createRequire } from 'node:module';

// Resolve @fastify/csrf via @fastify/csrf-protection dependency tree
const requireModule = createRequire(import.meta.url);
let FastifyCsrfConstructor: any;
try {
  FastifyCsrfConstructor = requireModule('@fastify/csrf');
} catch {
  const csrfProtPath = import.meta.resolve('@fastify/csrf-protection');
  FastifyCsrfConstructor = createRequire(csrfProtPath)('@fastify/csrf');
}

export const DEFAULT_CSRF_COOKIE_NAME = '_csrf';
export const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
export const UNSAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const kCsrfSecret = Symbol.for('fastify.csrf.secret');

export class CsrfError extends Error {
  statusCode: number;
  code: string;

  constructor(message = 'Permission denied') {
    super(message);
    this.name = 'CsrfError';
    this.statusCode = 403;
    this.code = 'CSRF_TOKEN_INVALID';
  }
}

export interface CsrfCookieOptions {
  cookieName?: string;
  secure?: boolean;
  domain?: string;
  signed?: boolean;
  userInfo?: string;
  // Disallowed overrides typed as unknown to gracefully reject/prevent caller weakening
  httpOnly?: unknown;
  sameSite?: unknown;
  path?: unknown;
}

export interface CsrfPluginOptions {
  cookieName?: string;
  cookieKey?: string;
  secure?: boolean;
  domain?: string;
  signed?: boolean;
  exemptRoutes?: readonly (string | RegExp)[];
  csrfOpts?: Record<string, unknown>;
  getUserInfo?: (req: FastifyRequest) => string | undefined;
}

/**
 * Resolves whether CSRF secret cookies must enforce Secure flag.
 * In production, Secure is strictly enforced and cannot be weakened.
 * In test/development, explicit options override the default (false).
 */
export function resolveCookieSecure(optionsSecure?: boolean): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  return optionsSecure ?? false;
}

/**
 * Validates cookie domain to prevent unnecessarily broad domains (e.g. single label or public suffixes).
 */
export function isValidCookieDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string') return false;
  const d = domain.trim();
  if (d.length === 0 || d.length > 255) return false;
  // Prevent single labels without dot, or public suffix like ".com"
  if (!d.includes('.') || /^\.[a-zA-Z0-9-]+$/.test(d)) return false;
  // Disallow whitespace, control characters, commas, semicolons
  if (/[\s;,\\]/.test(d)) return false;
  return true;
}

/**
 * Normalizes route path by removing query strings and trailing slashes.
 */
function normalizePath(rawPath: string): string {
  const withoutQuery = rawPath.split('?')[0] || '';
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/**
 * Extracts raw CSRF secret from request cookies or raw Cookie header.
 */
export function getCsrfSecret(
  request: FastifyRequest,
  cookieKey: string = DEFAULT_CSRF_COOKIE_NAME,
  signed: boolean = false
): string | undefined {
  if (request.cookies && typeof request.cookies === 'object') {
    const rawVal = request.cookies[cookieKey];
    if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
      if (signed && typeof (request as any).unsignCookie === 'function') {
        const unsigned = (request as any).unsignCookie(rawVal);
        if (unsigned && unsigned.valid && typeof unsigned.value === 'string' && unsigned.value.trim().length > 0) {
          return unsigned.value.trim();
        }
        return undefined;
      }
      return rawVal.trim();
    }
  }

  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader === 'string' && cookieHeader.length > 0) {
    let rawVal: string | undefined;
    if (typeof (request.server as any).parseCookie === 'function') {
      const parsed = (request.server as any).parseCookie(cookieHeader);
      rawVal = parsed[cookieKey];
    } else {
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieKey}=([^;]+)`));
      if (match && match[1]) {
        rawVal = decodeURIComponent(match[1].trim());
      }
    }

    if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
      if (signed && typeof (request as any).unsignCookie === 'function') {
        const unsigned = (request as any).unsignCookie(rawVal);
        if (unsigned && unsigned.valid && typeof unsigned.value === 'string' && unsigned.value.trim().length > 0) {
          return unsigned.value.trim();
        }
        return undefined;
      }
      return rawVal.trim();
    }
  }

  return undefined;
}

/**
 * Extracts CSRF token from x-csrf-token request header.
 */
export function getCsrfToken(request: FastifyRequest): string | undefined {
  const header = request.headers?.['x-csrf-token'];
  if (typeof header === 'string') {
    const trimmed = header.trim();
    if (trimmed.length > 0 && trimmed.length <= 1024) {
      return trimmed;
    }
    return undefined;
  }
  if (Array.isArray(header) && header.length > 0 && typeof header[0] === 'string') {
    const trimmed = header[0].trim();
    if (trimmed.length > 0 && trimmed.length <= 1024) {
      return trimmed;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Checks if the HTTP method is a safe read-only method (GET, HEAD, OPTIONS).
 */
export function isSafeMethod(method: string): boolean {
  return SAFE_HTTP_METHODS.has((method || '').toUpperCase());
}

/**
 * Determines whether a given request matches the exact unauthenticated login bootstrap exception.
 * Strictly limited to POST /auth/login.
 * Explicit route protection declarations take precedence and fail closed.
 */
export function isBootstrapLoginRoute(request: FastifyRequest): boolean {
  const method = (request.method || '').toUpperCase();
  if (method !== 'POST') {
    return false;
  }

  // Explicit route config protection takes precedence -> fail closed
  const config = request.routeOptions?.config as Record<string, any> | undefined;
  if (
    config?.csrf === true ||
    config?.requireCsrf === true ||
    config?.protected === true
  ) {
    return false;
  }

  const routerPath = request.routeOptions?.url
    ? normalizePath(request.routeOptions.url)
    : undefined;
  const rawPath = request.url ? normalizePath(request.url) : '';

  if (routerPath !== undefined && routerPath === '/auth/login') {
    return true;
  }

  return rawPath === '/auth/login';
}

/**
 * Determines whether a given route is exempt from CSRF enforcement.
 * Explicit public routes are NOT automatically exempt.
 * Safe methods (GET, HEAD, OPTIONS) are exempt unless explicitly marked as requiring CSRF.
 */
export function isRouteCsrfExempt(
  request: FastifyRequest,
  exemptRoutes: readonly (string | RegExp)[] = []
): boolean {
  const config = request.routeOptions?.config as Record<string, any> | undefined;

  // 1. Explicit protection declarations ALWAYS take precedence -> FAIL CLOSED
  if (
    config?.csrf === true ||
    config?.requireCsrf === true ||
    config?.protected === true
  ) {
    return false;
  }

  // 2. Explicit route-level exemption
  if (config?.csrf === false || config?.exemptCsrf === true) {
    return true;
  }

  // 3. Exact bootstrap login route exception (POST /auth/login only)
  if (isBootstrapLoginRoute(request)) {
    return true;
  }

  // 4. Custom configured exempt routes
  const routerPath = request.routeOptions?.url
    ? normalizePath(request.routeOptions.url)
    : undefined;
  const rawPath = request.url ? normalizePath(request.url) : '';

  for (const rule of exemptRoutes) {
    if (typeof rule === 'string') {
      const normalizedRule = normalizePath(rule);
      if (rawPath === normalizedRule || (routerPath && routerPath === normalizedRule)) {
        return true;
      }
    } else if (rule instanceof RegExp) {
      if (rule.test(rawPath) || (routerPath && rule.test(routerPath))) {
        return true;
      }
    }
  }

  // Default: NOT exempt (fails closed by default)
  return false;
}

declare module 'fastify' {
  interface FastifyInstance {
    csrfProtection: (
      req: FastifyRequest,
      reply: FastifyReply,
      done?: (err?: Error) => void
    ) => Promise<void> | void;
    generateCsrf: (reply: FastifyReply, options?: CsrfCookieOptions) => string;
  }

  interface FastifyReply {
    generateCsrf: (options?: CsrfCookieOptions & { userInfo?: string }) => string;
  }
}

export const csrfPlugin: FastifyPluginAsync<CsrfPluginOptions> = async (
  fastify: FastifyInstance,
  options: CsrfPluginOptions = {}
): Promise<void> => {
  // 1. Ensure @fastify/cookie is registered first
  if (!fastify.parseCookie && !fastify.hasRequestDecorator('cookies')) {
    await fastify.register(fastifyCookie);
  }

  const cookieKey = options.cookieName ?? options.cookieKey ?? DEFAULT_CSRF_COOKIE_NAME;
  const pluginSecure = resolveCookieSecure(options.secure);
  const pluginDomain = options.domain;
  const isSigned = options.signed ?? false;
  const exemptRoutes = options.exemptRoutes ?? [];
  const getUserInfo = options.getUserInfo;

  const csrfInstance = new FastifyCsrfConstructor(options.csrfOpts ?? {});

  // 2. Token generation helper enforcing rigid cookie security attributes
  const generateCsrfToken = (
    reply: FastifyReply,
    opts?: CsrfCookieOptions & { userInfo?: string }
  ): string => {
    const request = reply.request;
    let secret = (reply as any)[kCsrfSecret] ?? (request as any)?.[kCsrfSecret];

    if (!secret) {
      secret = getCsrfSecret(request, cookieKey, isSigned);
    }

    if (!secret) {
      secret = csrfInstance.secretSync();
      (reply as any)[kCsrfSecret] = secret;
      if (request) {
        (request as any)[kCsrfSecret] = secret;
      }

      const isSecure = resolveCookieSecure(opts?.secure ?? pluginSecure);
      const resolvedDomain =
        opts?.domain && isValidCookieDomain(opts.domain)
          ? opts.domain.trim()
          : pluginDomain && isValidCookieDomain(pluginDomain)
          ? pluginDomain.trim()
          : undefined;

      const cookieOpts: Record<string, unknown> = {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
      };

      if (resolvedDomain) {
        cookieOpts.domain = resolvedDomain;
      }
      if (isSigned) {
        cookieOpts.signed = true;
      }

      reply.setCookie(cookieKey, secret, cookieOpts as any);
    }

    const userInfo = opts?.userInfo ?? (getUserInfo && request ? getUserInfo(request) : undefined);
    return csrfInstance.create(secret, userInfo);
  };

  // 3. CSRF verification logic
  const verifyCsrf = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Safe read-only HTTP methods (GET, HEAD, OPTIONS) are exempt unless explicitly configured
    if (isSafeMethod(request.method || '')) {
      const config = request.routeOptions?.config as Record<string, any> | undefined;
      if (config?.csrf !== true && config?.requireCsrf !== true) {
        return;
      }
    }

    // Check bootstrap login exception or route exemption
    if (isRouteCsrfExempt(request, exemptRoutes)) {
      return;
    }

    // Extract secret
    let secret = (reply as any)[kCsrfSecret] ?? (request as any)[kCsrfSecret];
    if (!secret) {
      secret = getCsrfSecret(request, cookieKey, isSigned);
    }

    if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
      request.log?.warn?.('CSRF verification failed: missing or empty secret cookie');
      throw new CsrfError();
    }

    // Extract token
    const token = getCsrfToken(request);
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      request.log?.warn?.('CSRF verification failed: missing or empty x-csrf-token header');
      throw new CsrfError();
    }

    // Cryptographically verify token
    let isValid = false;
    try {
      const userInfo = getUserInfo ? getUserInfo(request) : undefined;
      isValid = csrfInstance.verify(secret, token, userInfo);
    } catch (err) {
      request.log?.warn?.({ err }, 'CSRF token cryptographic verification threw error');
      throw new CsrfError();
    }

    if (!isValid) {
      request.log?.warn?.('CSRF verification failed: invalid or tampered token');
      throw new CsrfError();
    }
  };

  // 4. Decorate Reply
  if (!fastify.hasReplyDecorator('generateCsrf')) {
    fastify.decorateReply('generateCsrf', function (
      this: FastifyReply,
      opts?: CsrfCookieOptions & { userInfo?: string }
    ) {
      return generateCsrfToken(this, opts);
    });
  }

  // 5. Decorate Fastify Instance
  if (!fastify.hasDecorator('generateCsrf')) {
    fastify.decorate('generateCsrf', function (
      reply: FastifyReply,
      opts?: CsrfCookieOptions & { userInfo?: string }
    ) {
      return generateCsrfToken(reply, opts);
    });
  }

  if (!fastify.hasDecorator('csrfProtection')) {
    fastify.decorate('csrfProtection', function (
      this: FastifyInstance,
      req: FastifyRequest,
      reply: FastifyReply,
      done?: (err?: Error) => void
    ) {
      if (typeof done === 'function') {
        verifyCsrf(req, reply)
          .then(() => done())
          .catch((err) => done(err));
        return;
      }
      return verifyCsrf(req, reply);
    });
  }

  // 6. Global fail-closed preHandler hook across all routes
  fastify.addHook('preHandler', verifyCsrf);
};

// Global plugin encapsulation escape (fastify-plugin contract)
(csrfPlugin as any)[Symbol.for('skip-override')] = true;

export default csrfPlugin;
