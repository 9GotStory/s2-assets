/**
 * @file Authorization Middleware (T025 - User Story 2)
 *
 * Implements server-side, capability-based authorization middleware as a reusable Fastify preHandler.
 * Enforces capabilities authoritatively per-request via CapabilityService (T024).
 *
 * ============================================================================
 * T026 Integration Contract & CapabilityService Dependency Resolution
 * ============================================================================
 *
 * 1. Usage in T026 Protected Routes:
 *    Routes (such as `GET /system/info`) import and apply `requireCapability`:
 *    ```ts
 *    import { requireCapability } from '../middleware/authorization.ts';
 *
 *    fastify.get(
 *      '/info',
 *      {
 *        preHandler: [requireCapability('system:maintain')],
 *      },
 *      async (request, reply) => {
 *        return { status: 'ok', system: { ... } };
 *      }
 *    );
 *    ```
 *
 * 2. Dependency Resolution for CapabilityService:
 *    The middleware dynamically resolves `CapabilityService` using the following precedence:
 *    a) Explicit middleware option: `requireCapability('system:maintain', { capabilityService })`
 *    b) Request-scoped decorator: `request.capabilityService`
 *    c) Fastify server-scoped decorator: `request.server.capabilityService` (or `fastify.capabilityService`)
 *
 *    In T026 or application bootstrap, decorate the Fastify instance or pass the service:
 *    ```ts
 *    const capabilityService = new CapabilityService({ db });
 *    fastify.decorate('capabilityService', capabilityService);
 *    ```
 *
 * 3. Fail-Closed Invariants:
 *    - If CapabilityService is missing or not registered: throws HTTP 500 INTERNAL_SERVER_ERROR.
 *    - If authentication context (T020 request.session / request.user) is missing or mismatched: throws HTTP 401 UNAUTHORIZED.
 *    - If user does not possess the required capability: throws HTTP 403 FORBIDDEN.
 *    - If database query fails during evaluation: throws HTTP 500 INTERNAL_SERVER_ERROR / fails closed.
 *    - Unknown or unmapped capabilities never grant access (HTTP 403 FORBIDDEN).
 *    - Client-supplied claims (headers, query, body) are strictly ignored.
 *    - Role grants/revocations in PostgreSQL take effect immediately on next request without re-login.
 *    - Per-request authorization cache prevents redundant database checks within the same request lifecycle.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { CapabilityService, isKnownCapability } from '../services/capability.service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    capabilityService?: CapabilityService;
  }
  interface FastifyRequest {
    capabilityService?: CapabilityService;
  }
}

export interface AuthorizationMiddlewareOptions {
  capabilityService?: CapabilityService;
}

export class AuthorizationError extends Error {
  statusCode: number;
  code: string;

  constructor(
    statusCode: number = 403,
    code: string = 'FORBIDDEN',
    message: string = 'Permission denied'
  ) {
    super(message);
    this.name = 'AuthorizationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const AUTHORIZED_CAPABILITIES = Symbol.for('s2.authorized_capabilities');

/**
 * Fastify preHandler authorization middleware factory.
 * Enforces server-side capability requirements using authoritative CapabilityService state.
 *
 * @param requiredCapability The capability string required to access the route (e.g. 'system:maintain')
 * @param options Optional configuration including explicit CapabilityService instance
 * @returns Fastify preHandler hook function
 */
export function requireCapability(
  requiredCapability: string,
  options?: AuthorizationMiddlewareOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function capabilityPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply
  ): Promise<void> {
    // 1. Authoritative Authentication Boundary (T020)
    // Never trust client-supplied headers, query parameters, or request body.
    const session = (request as any).session;
    const user = (request as any).user;

    if (
      !session ||
      typeof session !== 'object' ||
      typeof session.user_id !== 'string' ||
      session.user_id.trim().length === 0
    ) {
      throw new AuthorizationError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (
      !user ||
      typeof user !== 'object' ||
      typeof user.id !== 'string' ||
      user.id.trim().length === 0
    ) {
      throw new AuthorizationError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Strict identity consistency: session.user_id must match authenticated user.id
    if (session.user_id !== user.id) {
      throw new AuthorizationError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Fail closed if user is explicitly deactivated/disabled
    if (user.is_active === false) {
      throw new AuthorizationError(403, 'FORBIDDEN', 'Permission denied');
    }

    // 2. Resolve CapabilityService Dependency
    let capabilityService: CapabilityService | undefined = options?.capabilityService;
    if (!capabilityService) {
      const reqService = (request as any).capabilityService;
      if (reqService && typeof reqService.hasCapability === 'function') {
        capabilityService = reqService;
      } else {
        const serverService = (request.server as any).capabilityService;
        if (serverService && typeof serverService.hasCapability === 'function') {
          capabilityService = serverService;
        }
      }
    }

    if (!capabilityService || typeof capabilityService.hasCapability !== 'function') {
      throw new AuthorizationError(
        500,
        'INTERNAL_SERVER_ERROR',
        'An unexpected internal server error occurred.'
      );
    }

    // 3. Avoid Duplicate Authorization Checks Within the Same Request Lifecycle
    let authorizedCaps = (request as any)[AUTHORIZED_CAPABILITIES] as Set<string> | undefined;
    if (!authorizedCaps) {
      authorizedCaps = new Set<string>();
      (request as any)[AUTHORIZED_CAPABILITIES] = authorizedCaps;
    }

    if (authorizedCaps.has(requiredCapability)) {
      return;
    }

    // 4. Unknown Capabilities Fail Closed Immediately
    if (!isKnownCapability(requiredCapability)) {
      throw new AuthorizationError(403, 'FORBIDDEN', 'Permission denied');
    }

    // 5. Authoritative Server-Side PostgreSQL Capability Evaluation
    const userId = session.user_id;
    let hasCap = false;

    try {
      hasCap = await capabilityService.hasCapability(userId, requiredCapability);
    } catch {
      // Any database or service failure must fail closed
      throw new AuthorizationError(
        500,
        'INTERNAL_SERVER_ERROR',
        'An unexpected internal server error occurred.'
      );
    }

    if (!hasCap) {
      throw new AuthorizationError(403, 'FORBIDDEN', 'Permission denied');
    }

    // Record verified capability for this request instance only (no cross-request caching)
    authorizedCaps.add(requiredCapability);
  };
}

export default requireCapability;
