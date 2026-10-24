import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import {
  AssetService,
  DuplicateCandidateWarningError,
  NotFoundError,
  RetryTokenConflictError,
  StaleBeforeConflictError,
  ValidationError,
  type CorrectAssetInput,
  type RegisterAssetInput,
} from '../services/asset.service.ts';
import { isValidUuid, CapabilityService } from '../services/capability.service.ts';

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

const CorrectAssetSchema = z
  .object({
    name: z.string().nullable().optional(),
    asset_number: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    expected_name: z.string().nullable(),
    expected_asset_number: z.string().nullable(),
    expected_serial_number: z.string().nullable(),
    reason: z.string().nullable().optional(),
    explicit_continuation: z.boolean().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

const DuplicateCandidatesQuerySchema = z.object({
  asset_number: z.string().optional(),
  serial_number: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const assetRoutes: FastifyPluginAsync<AssetRoutesOptions> = async (
  fastify,
  options
) => {
  const capabilityService =
    options.capabilityService ??
    fastify.capabilityService ??
    (options.db ? new CapabilityService({ db: options.db }) : undefined);

  const assetService =
    options.assetService ??
    new AssetService({ db: options.db });

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

      let canCorrect = false;
      if (request.user && capabilityService) {
        canCorrect = await capabilityService.hasCapability(request.user.id, 'asset:correct');
      }

      return reply.status(200).send({
        ...result,
        can_correct: canCorrect,
      });
    }
  );

  /**
   * GET /:id/duplicate-candidates
   * Correction-scoped preview for candidate duplicate assets excluding the current asset itself (P1)
   * Protected: requires 'asset:correct' capability (Administrator, Asset Custodian)
   */
  fastify.get(
    '/:id/duplicate-candidates',
    {
      preHandler: [requireCapability('asset:correct')],
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
        offset,
        id
      );
      return reply.status(200).send(result);
    }
  );

  const correctAssetHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const user = (request as any).user;
    if (!user || !user.id) {
      return reply.status(401).send({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Authenticated session required',
      });
    }

    const { id } = (request.params || {}) as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_ID',
        error: 'INVALID_ID',
        message: 'Asset ID must be a valid UUID string',
      });
    }

    // Boundary check: conflicting retry token header and body rejected
    const headerToken = (
      (request.headers['idempotency-key'] ||
        request.headers['x-retry-token']) as string | undefined
    )?.trim();
    const bodyObj = (request.body || {}) as Record<string, unknown>;
    const bodyToken =
      typeof bodyObj.retry_token === 'string'
        ? bodyObj.retry_token.trim()
        : undefined;

    if (headerToken && bodyToken && headerToken !== bodyToken) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        error: 'VALIDATION_FAILED',
        message: 'Conflicting retry token values between header and body',
      });
    }

    const retryToken = headerToken || bodyToken;

    // Server boundary validation
    const parsed = CorrectAssetSchema.safeParse(request.body || {});
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

    const body = parsed.data as CorrectAssetInput;

    try {
      const result = await assetService.correctAsset(user.id, id, body, {
        retryToken,
      });
      return reply.status(200).send(result);
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

      if (err instanceof StaleBeforeConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          code: 'STALE_BEFORE_CONFLICT',
          error: 'STALE_BEFORE_CONFLICT',
          message: err.message,
          current_values: err.current_values,
          expected_values: err.expected_values,
        });
      }

      if (err instanceof NotFoundError) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
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
  };

  /**
   * POST /:id/correct
   * Correct metadata on an existing Asset (P1–P3)
   * Protected: requires 'asset:correct' capability (Administrator, Asset Custodian)
   */
  fastify.post(
    '/:id/correct',
    {
      preHandler: [requireCapability('asset:correct')],
    },
    correctAssetHandler
  );

  /**
   * PATCH /:id
   * RESTful partial update / correction on an existing Asset (P1–P3)
   * Protected: requires 'asset:correct' capability (Administrator, Asset Custodian)
   */
  fastify.patch(
    '/:id',
    {
      preHandler: [requireCapability('asset:correct')],
    },
    correctAssetHandler
  );
};

export default assetRoutes;
