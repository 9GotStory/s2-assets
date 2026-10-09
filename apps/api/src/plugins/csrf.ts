import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrfProtection from '@fastify/csrf-protection';

export const DEFAULT_CSRF_COOKIE_NAME = '_csrf';
export const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
export const UNSAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  // Disallowed overrides typed as unknown to prevent caller weakening
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
  secret?: string;
  cookieSecret?: string;
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
 * Resolves whether CSRF secret cookies must be signed.
 * In production, cookie signing is strictly enforced for cookie tossing resistance.
 * In test/development, explicit options decide (default: false).
 */
export function resolveCookieSigned(optionsSigned?: boolean): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  return optionsSigned ?? false;
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

  // Explicit route config protection takes precedence -> fail closed (Finding 3)
  const config = request.routeOptions?.config as Record<string, any> | undefined;
  if (
    config?.csrf === true ||
    config?.requireCsrf === true ||
    config?.protected === true ||
    config?.auth === true ||
    config?.requireAuth === true
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

  // 1. Explicit protection declarations ALWAYS take precedence -> FAIL CLOSED (Finding 3)
  if (
    config?.csrf === true ||
    config?.requireCsrf === true ||
    config?.protected === true ||
    config?.auth === true ||
    config?.requireAuth === true
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

/**
 * Enforces rigid cookie attributes preventing callers from weakening httpOnly, sameSite, path, or secure in production.
 */
export function sanitizeCallerCookieOptions(
  opts?: CsrfCookieOptions & { userInfo?: string },
  defaultSecure: boolean = false,
  defaultDomain?: string,
  defaultSigned: boolean = false
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: resolveCookieSecure(opts?.secure ?? defaultSecure),
  };

  if (defaultSigned || opts?.signed) {
    sanitized.signed = true;
  }

  const domain = opts?.domain ?? defaultDomain;
  if (domain && isValidCookieDomain(domain)) {
    sanitized.domain = domain.trim();
  }

  if (opts?.userInfo !== undefined) {
    sanitized.userInfo = opts.userInfo;
  }

  return sanitized;
}

declare module 'fastify' {
  interface FastifyInstance {
    generateCsrf: (reply: FastifyReply, options?: CsrfCookieOptions) => string;
  }
}

export const csrfPlugin: FastifyPluginAsync<CsrfPluginOptions> = async (
  fastify: FastifyInstance,
  options: CsrfPluginOptions = {}
): Promise<void> => {
  const cookieKey = options.cookieName ?? options.cookieKey ?? DEFAULT_CSRF_COOKIE_NAME;
  const pluginSecure = resolveCookieSecure(options.secure);
  const isSigned = resolveCookieSigned(options.signed);
  const pluginDomain =
    options.domain && isValidCookieDomain(options.domain) ? options.domain.trim() : undefined;
  const exemptRoutes = options.exemptRoutes ?? [];

  // Finding 2 — Cookie tossing resistance:
  // When signing is required (production or signed: true), verify trusted configuration is present.
  const trustedSecret =
    options.cookieSecret ??
    options.secret ??
    process.env.COOKIE_SECRET ??
    process.env.CSRF_SECRET;

  const hasConfiguredSigner = Boolean(
    fastify.hasDecorator('unsignCookie') ||
    typeof (fastify as any).unsignCookie === 'function'
  );

  if (isSigned) {
    if (!hasConfiguredSigner) {
      if (!fastify.parseCookie && !fastify.hasRequestDecorator('cookies')) {
        if (!trustedSecret || typeof trustedSecret !== 'string' || trustedSecret.trim().length === 0) {
          throw new Error(
            'CSRF cookie signing is required (in production or when signed: true) but no valid cookie signing secret is configured. ' +
            'Provide a trusted secret via options (secret or cookieSecret) or register @fastify/cookie with secret.'
          );
        }
      } else {
        throw new Error(
          'CSRF cookie signing is required but @fastify/cookie was already registered without a signing secret. ' +
          'Register @fastify/cookie with a secret to resist cookie tossing.'
        );
      }
    } else if (trustedSecret !== undefined && (typeof trustedSecret !== 'string' || trustedSecret.trim().length === 0)) {
      throw new Error('Invalid empty cookie signing secret provided.');
    }
  }

  // 1. Ensure @fastify/cookie is registered
  if (!fastify.parseCookie && !fastify.hasRequestDecorator('cookies')) {
    await fastify.register(fastifyCookie, {
      secret: trustedSecret && trustedSecret.trim().length > 0 ? trustedSecret.trim() : undefined,
    });
  }

  // 2. Register official @fastify/csrf-protection plugin (Finding 1)
  const resolvedCookieOpts: Record<string, unknown> = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: pluginSecure,
    signed: isSigned,
  };
  if (pluginDomain) {
    resolvedCookieOpts.domain = pluginDomain;
  }

  const csrfProtOptions: Record<string, unknown> = {
    cookieKey,
    cookieOpts: resolvedCookieOpts,
    sessionPlugin: '@fastify/cookie',
    getToken: (req: FastifyRequest) => getCsrfToken(req) || '',
    ...(typeof options.getUserInfo === 'function' ? { getUserInfo: options.getUserInfo } : {}),
    ...(options.csrfOpts ? { csrfOpts: options.csrfOpts } : {}),
  };

  await fastify.register(fastifyCsrfProtection, csrfProtOptions as any);

  // 3. Wrap reply.generateCsrf on Reply prototype to enforce rigid cookie security attributes
  const replySym = Object.getOwnPropertySymbols(fastify).find(
    (s) => s.description === 'fastify.Reply'
  );
  const ReplyClass = replySym ? (fastify as any)[replySym] : undefined;
  if (ReplyClass?.prototype?.generateCsrf) {
    const originalGenerateCsrf = ReplyClass.prototype.generateCsrf;
    ReplyClass.prototype.generateCsrf = function (
      this: FastifyReply,
      opts?: CsrfCookieOptions & { userInfo?: string }
    ) {
      const sanitized = sanitizeCallerCookieOptions(opts, pluginSecure, pluginDomain, isSigned);
      return originalGenerateCsrf.call(this, sanitized);
    };
  }

  // Also hook onRequest to ensure instance/route-level replies enforce rigid cookie attributes
  const kCsrfWrapped = Symbol.for('fastify.csrf.generateCsrfWrapped');
  fastify.addHook('onRequest', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (typeof reply.generateCsrf === 'function' && !(reply.generateCsrf as any)[kCsrfWrapped]) {
      const orig = reply.generateCsrf;
      const wrapped = function (
        this: FastifyReply,
        opts?: CsrfCookieOptions & { userInfo?: string }
      ) {
        const sanitized = sanitizeCallerCookieOptions(opts, pluginSecure, pluginDomain, isSigned);
        return orig.call(this, sanitized as any);
      };
      (wrapped as any)[kCsrfWrapped] = true;
      (reply as any).generateCsrf = wrapped;
    }
  });

  // 4. Decorate Fastify Instance with generateCsrf for full compatibility
  if (!fastify.hasDecorator('generateCsrf')) {
    fastify.decorate('generateCsrf', function (
      reply: FastifyReply,
      opts?: CsrfCookieOptions & { userInfo?: string }
    ) {
      return (reply as any).generateCsrf(opts);
    });
  }

  // 5. Wrap fastify.csrfProtection to handle both callback and hook invocations safely
  const officialCsrfProtection = fastify.csrfProtection;
  (fastify as any).csrfProtection = function (
    this: FastifyInstance,
    req: FastifyRequest,
    reply: FastifyReply,
    next?: (err?: Error) => void
  ) {
    const nextFn = typeof next === 'function' ? next : () => {};
    return officialCsrfProtection.call(this, req, reply, nextFn);
  };

  // 6. Map CSRF errors to standard HTTP 403 CSRF_TOKEN_INVALID envelope
  fastify.addHook('onError', async (_request: FastifyRequest, _reply: FastifyReply, error: any) => {
    if (
      error?.code === 'FST_CSRF_MISSING_SECRET' ||
      error?.code === 'FST_CSRF_INVALID_TOKEN' ||
      error?.name === 'CsrfError'
    ) {
      error.code = 'CSRF_TOKEN_INVALID';
      error.message = 'Permission denied';
      error.statusCode = 403;
    }
  });

  // 7. Global fail-closed preHandler hook across all routes
  fastify.addHook('preHandler', (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    // Safe read-only HTTP methods (GET, HEAD, OPTIONS) are exempt unless explicitly configured
    if (isSafeMethod(request.method || '')) {
      const config = request.routeOptions?.config as Record<string, any> | undefined;
      if (config?.csrf !== true && config?.requireCsrf !== true) {
        return done();
      }
    }

    // Check bootstrap login exception or route exemption
    if (isRouteCsrfExempt(request, exemptRoutes)) {
      return done();
    }

    // Delegate to official CSRF protection
    fastify.csrfProtection(request, reply, done);
  });
};

// Global plugin encapsulation escape (fastify-plugin contract)
(csrfPlugin as any)[Symbol.for('skip-override')] = true;

export default csrfPlugin;
