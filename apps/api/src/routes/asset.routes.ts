import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import {
  AssetService,
  DuplicateCandidateWarningError,
  RetryTokenConflictError,
  ValidationError,
  type RegisterAssetInput,
} from '../services/asset.service.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';

export interface AssetRoutesOptions {
  assetService?: AssetService;
  capabilityService?: CapabilityService;
  db?: any;
}

const RegisterAssetSchema = z
  .object({
    name: z.string().nullable().optional(),
    asset_number: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    source_reference: z.string().nullable().optional(),
    source_notes: z.string().nullable().optional(),
    is_legacy: z.boolean().optional(),
    explicit_continuation: z.boolean().optional(),
    retry_token: z.string().optional(),
    category: z.null().optional(),
    organization_unit: z.null().optional(),
  })
  .strict();

const DuplicateCandidatesQuerySchema = z.object({
  asset_number: z.string().optional(),
  serial_number: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const EXACT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidExactUuid(val: unknown): val is string {
  return typeof val === 'string' && val.length === 36 && EXACT_UUID_REGEX.test(val);
}

export const assetRoutes: FastifyPluginAsync<AssetRoutesOptions> = async (
  fastify,
  options
) => {
  const assetService =
    options.assetService ??
    new AssetService({ db: options.db ?? fastify.capabilityService });

  const isSearchRequest = (request: FastifyRequest): boolean => {
    if ((request as any).isSearchRoute) {
      return true;
    }
    const routerPath = request.routeOptions?.url || (request as any).routerPath;
    if (routerPath === '/assets/search' || routerPath === '/search') {
      return true;
    }
    const rawUrl = (request as any).originalRawUrl || request.raw?.url || request.url || '';
    const cleanPath = rawUrl.split('?')[0];
    return cleanPath === '/assets/search' || cleanPath === '/search';
  };

  // Search-specific response policy (IR-F3):
  // Establish no-store Cache-Control covering 200, 400, 401, 403, 5xx, early denials and pre-handler failures.
  // Also redact query-bearing URLs from raw.url to prevent disclosure in operational logs.
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = request.raw?.url || '';
    (request as any).rawUrlLength = rawUrl.length;
    (request as any).originalRawUrl = rawUrl;
    const cleanPath = rawUrl.split('?')[0];
    if (cleanPath === '/assets/search' || cleanPath === '/search') {
      (request as any).isSearchRoute = true;
      reply.header('Cache-Control', 'no-store');
      if (request.raw) {
        request.raw.url = cleanPath;
      }
    }
  });

  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (isSearchRequest(request)) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  /**
   * GET /duplicate-candidates
   * Lookup candidate duplicate assets by exact nonempty asset_number or serial_number (D2, AR-11)
   * Protected: requires 'asset:duplicate-check' capability (Asset Custodian only)
   */
  fastify.get(
    '/duplicate-candidates',
    {
      preHandler: [requireCapability('asset:duplicate-check')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsedQuery = DuplicateCandidatesQuerySchema.safeParse(
        request.query || {}
      );
      if (!parsedQuery.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Invalid query parameters: ' +
            parsedQuery.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const { asset_number, serial_number, limit, offset } = parsedQuery.data;
      const result = await assetService.getDuplicateCandidates(
        asset_number,
        serial_number,
        undefined,
        limit,
        offset
      );
      return reply.status(200).send(result);
    }
  );

  /**
   * POST /
   * Register a single truthful or incomplete-legacy Asset with durable starting history (AR-01, AR-07, R1-R4)
   * Supports retry token idempotency contract (D4) and duplicate warning/continuation (D2)
   * Protected: requires 'asset:register' capability (Asset Custodian only)
   */
  fastify.post(
    '/',
    {
      preHandler: [requireCapability('asset:register')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user || !user.id) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authenticated session required',
        });
      }

      // Server boundary validation (Standards Finding 1)
      const parsed = RegisterAssetSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Invalid request payload: ' +
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const body = parsed.data as RegisterAssetInput & { retry_token?: string };
      const retryToken =
        (request.headers['x-retry-token'] as string) || body.retry_token;

      try {
        const result = await assetService.registerAsset(user.id, body, {
          retryToken,
        });
        return reply.status(201).send(result);
      } catch (err: any) {
        if (err instanceof DuplicateCandidateWarningError) {
          return reply.status(409).send({
            statusCode: 409,
            code: 'DUPLICATE_CANDIDATES_FOUND',
            error: 'DUPLICATE_CANDIDATES_FOUND',
            message: err.message,
            candidates: err.candidates,
            total_count: err.total_count,
            has_more: err.has_more,
            limit: err.limit,
            offset: err.offset,
          });
        }

        if (err instanceof RetryTokenConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            error: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            message: err.message,
          });
        }

        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: 'VALIDATION_FAILED',
            error: 'VALIDATION_FAILED',
            message: err.message,
          });
        }

        throw err;
      }
    }
  );

  /**
   * GET /search
   * Bounded identifier/description search (T3).
   * Supports field-based exact matching for stable_id, asset_number, serial_number,
   * case-insensitive literal substring for name, or empty browse when no criteria given.
   * Requires BOTH 'asset:search' and 'asset:view' capabilities.
   * Prevents query disclosure in operational logs via sanitized URLs and logLevel 'silent'.
   */
  fastify.get(
    '/search',
    {
      logLevel: 'silent',
      preHandler: [
        requireCapability('asset:search'),
        requireCapability('asset:view'),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Set Cache-Control header strictly
      reply.header('Cache-Control', 'no-store');

      const requestId =
        (request.headers['x-request-id'] as string) ||
        request.id ||
        (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'req-default-id');

      const sendValidationError = (details: Record<string, string>) => {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The provided request data is invalid.',
            request_id: requestId,
            details,
          },
        });
      };

      // Raw target bound: 16384 bytes
      const rawUrlLength = (request as any).rawUrlLength || request.raw.url?.length || 0;
      if (rawUrlLength > 16384) {
        return sendValidationError({ target: 'Request target URL exceeds maximum length' });
      }

      const query = (request.query || {}) as Record<string, unknown>;

      // Check for unknown parameters
      const allowedParams = new Set(['field', 'value', 'limit', 'offset']);
      for (const key of Object.keys(query)) {
        if (!allowedParams.has(key)) {
          return sendValidationError({ query: 'Unknown query parameter' });
        }
      }

      // Check for duplicate parameters (arrays in Fastify parsed query)
      for (const key of Object.keys(query)) {
        if (Array.isArray(query[key])) {
          return sendValidationError({ query: 'Duplicate parameter not allowed' });
        }
      }

      const { field, value, limit, offset } = query;

      // Type checks: field and value must be strings if present
      if (field !== undefined && typeof field !== 'string') {
        return sendValidationError({ field: 'Field must be a string' });
      }
      if (value !== undefined && typeof value !== 'string') {
        return sendValidationError({ value: 'Value must be a string' });
      }

      // Valid selector check
      const validFields = new Set(['stable_id', 'asset_number', 'serial_number', 'name']);
      if (field !== undefined && !validFields.has(field)) {
        return sendValidationError({ field: 'Invalid search field selector' });
      }

      // Complete selector check: if field is given, value must be given; if value is given, field must be given
      if (field !== undefined && value === undefined) {
        return sendValidationError({ value: 'Value is required when field is specified' });
      }
      if (value !== undefined && field === undefined) {
        return sendValidationError({ field: 'Field is required when value is specified' });
      }

      // Field specific validations
      if (field !== undefined && value !== undefined) {
        // NUL byte check
        if (value.includes('\0')) {
          return sendValidationError({ value: 'Value must not contain NUL bytes' });
        }
        // Max UTF-8 byte length 4096
        if (Buffer.byteLength(value, 'utf8') > 4096) {
          return sendValidationError({ value: 'Value exceeds maximum length of 4096 bytes' });
        }

        if (field === 'stable_id' && value !== '') {
          if (!isValidExactUuid(value)) {
            return sendValidationError({ value: 'Invalid UUID format for stable_id' });
          }
        } else if (field === 'name' && value !== '') {
          if (value.trim() === '') {
            return sendValidationError({ value: 'Search value for name must not be whitespace-only' });
          }
        }
      }

      // Limit validation
      if (limit !== undefined) {
        if (typeof limit !== 'string' && typeof limit !== 'number') {
          return sendValidationError({ limit: 'Invalid limit format' });
        }
        const limitStr = String(limit);
        if (!/^[1-9]\d*$/.test(limitStr)) {
          return sendValidationError({ limit: 'Limit must be a canonical positive integer' });
        }
        const parsedLimit = Number(limitStr);
        if (parsedLimit < 1 || parsedLimit > 100) {
          return sendValidationError({ limit: 'Limit must be between 1 and 100' });
        }
      }

      // Offset validation
      if (offset !== undefined) {
        if (typeof offset !== 'string' && typeof offset !== 'number') {
          return sendValidationError({ offset: 'Invalid offset format' });
        }
        const offsetStr = String(offset);
        if (!/^(0|[1-9]\d*)$/.test(offsetStr)) {
          return sendValidationError({ offset: 'Offset must be a canonical non-negative integer' });
        }
        const parsedOffset = Number(offsetStr);
        if (parsedOffset < 0 || parsedOffset > 2147483647) {
          return sendValidationError({ offset: 'Offset must be between 0 and 2147483647' });
        }
      }

      try {
        const result = await assetService.searchAssets({
          field: field as any,
          value: value as string | undefined,
          limit: limit as any,
          offset: offset as any,
        });

        return reply.status(200).send(result);
      } catch (err: any) {
        if (err instanceof ValidationError) {
          return sendValidationError({ query: err.message });
        }
        throw err;
      }
    }
  );

  /**
   * GET /:id
   * Retrieve Asset identity, details and starting history fact by Stable ID UUID (AR-02, AR-07, AC-25)
   * Office-wide visibility (R4): accessible to all authorized registry roles without organization segregation
   * Protected: requires 'asset:view' capability (Asset Custodian, Administrator, Read-only User)
   */
  fastify.get(
    '/:id',
    {
      preHandler: [requireCapability('asset:view')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = (request.params || {}) as { id: string };

      if (!isValidUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'INVALID_ID',
          error: 'INVALID_ID',
          message: 'Asset ID must be a valid UUID string',
        });
      }

      const result = await assetService.getAssetById(id);
      if (!result) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
          message: 'Asset not found',
        });
      }

      return reply.status(200).send(result);
    }
  );
};

export default assetRoutes;
