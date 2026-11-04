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
export const MIN_COOKIE_SECRET_BYTES = 32;

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
 * Validates whether a provided signing secret meets the minimum length requirement.
 * Enforces at least 32 bytes of secret material.
 */
export function isValidSigningSecret(secret: unknown): secret is string {
  if (typeof secret !== 'string') return false;
  const trimmed = secret.trim();
  return Buffer.byteLength(trimmed, 'utf8') >= MIN_COOKIE_SECRET_BYTES;
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

  // 1. Explicit protection declarations ALWAYS take precedence -> FAIL CLOSED
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
  opts?: Record<string, any>,
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

  // Finding 1 — Signing Secret Strength & Configuration Distinction:
  const isCookiePluginRegistered = Boolean(
    fastify.parseCookie ||
    fastify.hasRequestDecorator('cookies')
  );

  const hasExternalSigner = Boolean(
    fastify.hasDecorator('unsignCookie') ||
    typeof (fastify as any).unsignCookie === 'function'
  );

  const localSecret =
    options.cookieSecret ??
    options.secret ??
    process.env.COOKIE_SECRET ??
    process.env.CSRF_SECRET;

  // Validate locally configured secret if provided
  if (localSecret !== undefined) {
    if (typeof localSecret !== 'string') {
      throw new Error('Supplied cookie signing secret must be a string.');
    }
    const byteLen = Buffer.byteLength(localSecret.trim(), 'utf8');
    if (byteLen < MIN_COOKIE_SECRET_BYTES) {
      throw new Error(
        `Supplied cookie signing secret is insufficient: must be at least ${MIN_COOKIE_SECRET_BYTES} bytes (got ${byteLen} bytes).`
      );
    }
  }

  if (isSigned) {
    if (isCookiePluginRegistered) {
      if (!hasExternalSigner) {
        throw new Error(
          'CSRF cookie signing is required (in production or when signed: true) but @fastify/cookie was externally registered without a signing secret. ' +
          `Ensure @fastify/cookie is registered with a secret of at least ${MIN_COOKIE_SECRET_BYTES} bytes.`
        );
      }
    } else {
      if (!localSecret || !isValidSigningSecret(localSecret)) {
        throw new Error(
          'CSRF cookie signing is required (in production or when signed: true) but no valid cookie signing secret is configured. ' +
          `Provide a secret of at least ${MIN_COOKIE_SECRET_BYTES} bytes via options (secret or cookieSecret) or environment (COOKIE_SECRET or CSRF_SECRET).`
        );
      }
    }
  }

  // 1. Ensure @fastify/cookie is registered
  if (!isCookiePluginRegistered) {
    const cookieRegOpts: Record<string, unknown> = {};
    if (localSecret && isValidSigningSecret(localSecret)) {
      cookieRegOpts.secret = localSecret.trim();
    }
    await fastify.register(fastifyCookie, cookieRegOpts);
  }

  // 2. Register official @fastify/csrf-protection plugin (Finding 1 & 2)
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

  // 3. Enforce rigid cookie security attributes via supported Fastify public hook (Finding 2)
  fastify.addHook('onRequest', async (_request: FastifyRequest, reply: FastifyReply) => {
    const originalSetCookie = reply.setCookie;
    if (typeof originalSetCookie === 'function') {
      reply.setCookie = function (name: string, value: string, cookieOptions?: any) {
        if (name === cookieKey) {
          const sanitized = sanitizeCallerCookieOptions(
            cookieOptions,
            pluginSecure,
            pluginDomain,
            isSigned
          );
          return originalSetCookie.call(this, name, value, sanitized);
        }
        return originalSetCookie.call(this, name, value, cookieOptions);
      };
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

  // 5. Map CSRF errors to standard HTTP 403 CSRF_TOKEN_INVALID envelope
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

  // 6. Global fail-closed preHandler hook across all routes
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

    // Delegate to official CSRF protection decorator directly
    fastify.csrfProtection(request, reply, done);
  });
};

// Global plugin encapsulation escape (fastify-plugin contract)
(csrfPlugin as any)[Symbol.for('skip-override')] = true;

export default csrfPlugin;
