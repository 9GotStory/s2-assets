import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  EvidenceService,
  ValidationError,
  NotFoundError,
  ConflictError,
  RetryTokenConflictError,
  ForbiddenError,
  UnauthorizedError,
  isStrictUuid,
  type CreateEvidenceInput,
  type CorrectEvidenceInput,
} from '../services/evidence.service.ts';
import { hasStrictControlChars } from '../services/control-characters.ts';
import { CapabilityService } from '../services/capability.service.ts';

export interface EvidenceRoutesOptions {
  evidenceService?: EvidenceService;
  capabilityService?: CapabilityService;
  db?: any;
}

const STRICT_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_INTEGER_REGEX = /^(0|[1-9]\d*)$/;

const CreateEvidenceSchema = z
  .object({
    reference_type: z.string().nullable().optional(),
    reference_text: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    acquisition_id: z
      .string()
      .regex(STRICT_UUID_REGEX, 'Invalid acquisition_id format')
      .nullable()
      .optional(),
    asset_ids: z
      .array(z.string().regex(STRICT_UUID_REGEX, 'Invalid asset_id format'))
      .optional(),
    retry_token: z.string().nullable().optional(),
  })
  .strict();

const CorrectEvidenceSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
    reference_type: z.string().nullable().optional(),
    reference_text: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    acquisition_id: z
      .string()
      .regex(STRICT_UUID_REGEX, 'Invalid acquisition_id format')
      .nullable()
      .optional(),
    add_asset_ids: z
      .array(z.string().regex(STRICT_UUID_REGEX, 'Invalid asset_id format'))
      .optional(),
    remove_asset_ids: z
      .array(z.string().regex(STRICT_UUID_REGEX, 'Invalid asset_id format'))
      .optional(),
    retry_token: z.string().nullable().optional(),
  })
  .strict();

const ListEvidenceQuerySchema = z.object({
  acquisition_id: z.string().optional(),
  asset_id: z.string().optional(),
  limit: z
    .string()
    .optional()
    .refine((val) => val === undefined || STRICT_INTEGER_REGEX.test(val), {
      message: 'limit must be a canonical integer string',
    })
    .transform((val) => (val !== undefined ? Number(val) : 25))
    .refine((num) => num >= 1 && num <= 100, {
      message: 'limit must be between 1 and 100',
    }),
  offset: z
    .string()
    .optional()
    .refine((val) => val === undefined || STRICT_INTEGER_REGEX.test(val), {
      message: 'offset must be a canonical integer string',
    })
    .transform((val) => (val !== undefined ? Number(val) : 0))
    .refine((num) => num >= 0 && num <= 2147483647, {
      message: 'offset must be a non-negative integer',
    }),
});

const GetEvidenceQuerySchema = z.object({
  asset_limit: z
    .string()
    .optional()
    .refine((val) => val === undefined || STRICT_INTEGER_REGEX.test(val), {
      message: 'asset_limit must be a canonical integer string',
    })
    .transform((val) => (val !== undefined ? Number(val) : 25))
    .refine((num) => num >= 1 && num <= 100, {
      message: 'asset_limit must be between 1 and 100',
    }),
  asset_offset: z
    .string()
    .optional()
    .refine((val) => val === undefined || STRICT_INTEGER_REGEX.test(val), {
      message: 'asset_offset must be a canonical integer string',
    })
    .transform((val) => (val !== undefined ? Number(val) : 0))
    .refine((num) => num >= 0 && num <= 2147483647, {
      message: 'asset_offset must be a non-negative integer',
    }),
});

const HistoryQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .refine((val) => val === undefined || STRICT_INTEGER_REGEX.test(val), {
      message: 'limit must be a canonical integer string',
    })
    .transform((val) => (val !== undefined ? Number(val) : 25))
    .refine((num) => num >= 1 && num <= 100, {
      message: 'limit must be between 1 and 100',
    }),
  offset: z
    .string()
    .optional()
    .refine((val) => val === undefined || STRICT_INTEGER_REGEX.test(val), {
      message: 'offset must be a canonical integer string',
    })
    .transform((val) => (val !== undefined ? Number(val) : 0))
    .refine((num) => num >= 0 && num <= 2147483647, {
      message: 'offset must be a non-negative integer',
    }),
});

export const evidenceRoutes: FastifyPluginAsync<EvidenceRoutesOptions> = async (
  fastify,
  opts
) => {
  const capabilityService =
    opts.capabilityService ||
    (fastify as any).capabilityService ||
    new CapabilityService({ db: (fastify as any).db || opts.db });

  const evidenceService =
    opts.evidenceService ||
    (fastify as any).evidenceService ||
    new EvidenceService({
      db: (fastify as any).db || opts.db,
      capabilityService,
    });

  if (typeof (evidenceService as any).setCapabilityService === 'function') {
    (evidenceService as any).setCapabilityService(capabilityService);
  }

  // Hook to guarantee Cache-Control: no-store on all responses
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // 1. POST /evidence — Create Evidence record (B1, B2, B3, B4, F1, F2)
  fastify.post(
    '/',
    {
      bodyLimit: 1048576, // 1 MiB
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      // Check D3 action capability
      const hasCreateCap = await capabilityService.hasCapability(user.id, 'evidence:create');
      if (!hasCreateCap) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:create' capability",
        });
      }

      const hasViewCap = await capabilityService.hasCapability(user.id, 'evidence:view');
      if (!hasViewCap) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:view' capability for created evidence",
        });
      }

      const parsed = CreateEvidenceSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message:
            'Invalid request payload: ' +
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const body = parsed.data as CreateEvidenceInput & { retry_token?: string };

      const headerTokenRaw = request.headers['x-retry-token'];
      const headerToken = typeof headerTokenRaw === 'string' ? headerTokenRaw : undefined;
      const bodyTokenRaw = (request.body as any)?.retry_token;
      const bodyToken = typeof bodyTokenRaw === 'string' ? bodyTokenRaw : undefined;

      // Reject contradictory header and body retry tokens before writes
      if (headerToken !== undefined && bodyToken !== undefined && headerToken !== bodyToken) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'CONTRADICTORY_RETRY_TOKEN',
          message: 'Header x-retry-token and body retry_token conflict',
        });
      }

      const effectiveToken = headerToken ?? bodyToken;
      if (!effectiveToken || typeof effectiveToken !== 'string' || effectiveToken.trim().length === 0) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'retry_token is required',
        });
      }

      if (effectiveToken.length > 128) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'retry_token must not exceed 128 characters',
        });
      }
      if (hasStrictControlChars(effectiveToken)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'retry_token must not contain control characters',
        });
      }

      // Check D3 parent view grants before mutation
      if (body.acquisition_id) {
        const hasAcqView = await capabilityService.hasCapability(user.id, 'acquisition:view');
        if (!hasAcqView) {
          return reply.status(403).send({
            statusCode: 403,
            code: 'FORBIDDEN',
            message: "Forbidden: requires 'acquisition:view' capability for target acquisition",
          });
        }
      }

      if (body.asset_ids && body.asset_ids.length > 0) {
        const hasAssetView = await capabilityService.hasCapability(user.id, 'asset:view');
        if (!hasAssetView) {
          return reply.status(403).send({
            statusCode: 403,
            code: 'FORBIDDEN',
            message: "Forbidden: requires 'asset:view' capability for linked assets",
          });
        }
      }

      const sessionId = (request as any).session?.id ?? null;

      try {
        const result = await evidenceService.createEvidence(user.id, body, effectiveToken, sessionId);
        return reply.status(201).send({
          id: result.id,
          version: result.version,
          history_id: result.history_id,
        });
      } catch (err: any) {
        if (err instanceof UnauthorizedError) {
          return reply.status(401).send({
            statusCode: 401,
            code: err.code || 'UNAUTHORIZED',
            message: err.message,
          });
        }
        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: err.code || 'VALIDATION_FAILED',
            message: err.message,
          });
        }
        if (err instanceof ConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: err.code || 'CONFLICT',
            message: err.message,
          });
        }
        if (err instanceof RetryTokenConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: err.code || 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            message: err.message,
          });
        }
        if (err instanceof ForbiddenError) {
          return reply.status(403).send({
            statusCode: 403,
            code: err.code || 'FORBIDDEN',
            message: err.message,
          });
        }
        request.log.error(err);
        return reply.status(500).send({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred',
        });
      }
    }
  );

  // 2. GET /evidence — Contextual List Evidence by Acquisition or Asset (B1, B3, F2, F6)
  fastify.get(
    '/',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      const hasView = await capabilityService.hasCapability(user.id, 'evidence:view');
      if (!hasView) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:view' capability",
        });
      }

      const parsedQuery = ListEvidenceQuerySchema.safeParse(request.query || {});
      if (!parsedQuery.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message:
            'Invalid query parameters: ' +
            parsedQuery.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const { acquisition_id, asset_id, limit, offset } = parsedQuery.data;

      // Exactly one selector is required
      if (!acquisition_id && !asset_id) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Either acquisition_id or asset_id query parameter must be provided',
        });
      }
      if (acquisition_id && asset_id) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Cannot filter by both acquisition_id and asset_id',
        });
      }

      if (acquisition_id && !isStrictUuid(acquisition_id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Invalid acquisition_id format',
        });
      }
      if (asset_id && !isStrictUuid(asset_id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Invalid asset_id format',
        });
      }

      const hasAcqView = await capabilityService.hasCapability(user.id, 'acquisition:view');
      const hasAssetView = await capabilityService.hasCapability(user.id, 'asset:view');

      // Check selector parent view capability
      if (acquisition_id && !hasAcqView) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'acquisition:view' capability",
        });
      }
      if (asset_id && !hasAssetView) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'asset:view' capability",
        });
      }

      try {
        const result = await evidenceService.listEvidence(
          { acquisition_id, asset_id },
          limit,
          offset,
          { hasAcquisitionView: hasAcqView, hasAssetView: hasAssetView }
        );
        const canCreate = await capabilityService.hasCapability(user.id, 'evidence:create');
        const canCorrect = await capabilityService.hasCapability(user.id, 'evidence:correct');

        return reply.status(200).send({
          ...result,
          can_create: canCreate,
          can_correct: canCorrect,
        });
      } catch (err: any) {
        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: err.code || 'VALIDATION_FAILED',
            message: err.message,
          });
        }
        if (err instanceof NotFoundError) {
          return reply.status(404).send({
            statusCode: 404,
            code: err.code || 'NOT_FOUND',
            message: err.message,
          });
        }
        request.log.error(err);
        return reply.status(500).send({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred',
        });
      }
    }
  );

  // 3. GET /evidence/:id — Direct Evidence lookup by UUID with paginated linked assets (B1, B3, F2, F6)
  fastify.get(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      const hasView = await capabilityService.hasCapability(user.id, 'evidence:view');
      if (!hasView) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:view' capability",
        });
      }

      const { id } = request.params;
      if (!isStrictUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Invalid evidence ID format',
        });
      }

      const parsedQuery = GetEvidenceQuerySchema.safeParse(request.query || {});
      if (!parsedQuery.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message:
            'Invalid query parameters: ' +
            parsedQuery.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }
      const { asset_limit, asset_offset } = parsedQuery.data;

      try {
        const record = await evidenceService.getEvidenceById(id, asset_limit, asset_offset);

        // D3: Check all-parent disclosure view grants (F2)
        if (record.acquisition_id) {
          const hasAcqView = await capabilityService.hasCapability(user.id, 'acquisition:view');
          if (!hasAcqView) {
            return reply.status(403).send({
              statusCode: 403,
              code: 'FORBIDDEN',
              message: "Forbidden: requires 'acquisition:view' capability for disclosed acquisition",
            });
          }
        }

        if (record.asset_ids_total > 0) {
          const hasAssetView = await capabilityService.hasCapability(user.id, 'asset:view');
          if (!hasAssetView) {
            return reply.status(403).send({
              statusCode: 403,
              code: 'FORBIDDEN',
              message: "Forbidden: requires 'asset:view' capability for disclosed assets",
            });
          }
        }

        return reply.status(200).send(record);
      } catch (err: any) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({
            statusCode: 404,
            code: 'NOT_FOUND',
            message: 'Evidence record not found',
          });
        }
        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: err.code || 'VALIDATION_FAILED',
            message: err.message,
          });
        }
        request.log.error(err);
        return reply.status(500).send({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred',
        });
      }
    }
  );

  // 4. GET /evidence/:id/history — Protected paginated history trace (B4, F2, F6)
  fastify.get(
    '/:id/history',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      const hasView = await capabilityService.hasCapability(user.id, 'evidence:view');
      if (!hasView) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:view' capability",
        });
      }

      const { id } = request.params;
      if (!isStrictUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Invalid evidence ID format',
        });
      }

      const parsedQuery = HistoryQuerySchema.safeParse(request.query || {});
      if (!parsedQuery.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message:
            'Invalid query parameters: ' +
            parsedQuery.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const { limit, offset } = parsedQuery.data;

      try {
        // Authorize current and historical parent disclosure/counts independently of page contents (F2)
        const disclosure = await evidenceService.getEvidenceParentDisclosure(id);
        const hasAcqView = await capabilityService.hasCapability(user.id, 'acquisition:view');
        const hasAssetView = await capabilityService.hasCapability(user.id, 'asset:view');

        if (disclosure.hasAcquisition && !hasAcqView) {
          return reply.status(403).send({
            statusCode: 403,
            code: 'FORBIDDEN',
            message: "Forbidden: requires 'acquisition:view' capability for historical acquisition",
          });
        }

        if (disclosure.hasAssets && !hasAssetView) {
          return reply.status(403).send({
            statusCode: 403,
            code: 'FORBIDDEN',
            message: "Forbidden: requires 'asset:view' capability for historical assets",
          });
        }

        const result = await evidenceService.getEvidenceHistory(id, limit, offset);
        return reply.status(200).send(result);
      } catch (err: any) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({
            statusCode: 404,
            code: 'NOT_FOUND',
            message: 'Evidence record not found',
          });
        }
        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: err.code || 'VALIDATION_FAILED',
            message: err.message,
          });
        }
        request.log.error(err);
        return reply.status(500).send({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred',
        });
      }
    }
  );

  // 5. POST /evidence/:id/correct — Reasoned correction with concurrency checks (B1, B2, B3, B4, F1, F2, F4)
  fastify.post(
    '/:id/correct',
    {
      bodyLimit: 1048576, // 1 MiB
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      // Check D3 action capability
      const hasCorrectCap = await capabilityService.hasCapability(user.id, 'evidence:correct');
      if (!hasCorrectCap) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:correct' capability",
        });
      }

      const hasViewCap = await capabilityService.hasCapability(user.id, 'evidence:view');
      if (!hasViewCap) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: "Forbidden: requires 'evidence:view' capability",
        });
      }

      const { id } = request.params;
      if (!isStrictUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Invalid evidence ID format',
        });
      }

      const parsed = CorrectEvidenceSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message:
            'Invalid request payload: ' +
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const body = parsed.data as CorrectEvidenceInput & { retry_token?: string };

      const headerTokenRaw = request.headers['x-retry-token'];
      const headerToken = typeof headerTokenRaw === 'string' ? headerTokenRaw : undefined;
      const bodyTokenRaw = (request.body as any)?.retry_token;
      const bodyToken = typeof bodyTokenRaw === 'string' ? bodyTokenRaw : undefined;

      // Reject contradictory retry tokens
      if (headerToken !== undefined && bodyToken !== undefined && headerToken !== bodyToken) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'CONTRADICTORY_RETRY_TOKEN',
          message: 'Header x-retry-token and body retry_token conflict',
        });
      }

      const effectiveToken = headerToken ?? bodyToken;
      if (!effectiveToken || typeof effectiveToken !== 'string' || effectiveToken.trim().length === 0) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'retry_token is required',
        });
      }

      if (effectiveToken.length > 128) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'retry_token must not exceed 128 characters',
        });
      }
      if (hasStrictControlChars(effectiveToken)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'retry_token must not contain control characters',
        });
      }

      // Check initial parent view grants: before and after state
      try {
        const current = await evidenceService.getEvidenceById(id);

        if (current.acquisition_id) {
          const hasAcqView = await capabilityService.hasCapability(user.id, 'acquisition:view');
          if (!hasAcqView) {
            return reply.status(403).send({
              statusCode: 403,
              code: 'FORBIDDEN',
              message:
                "Forbidden: requires 'acquisition:view' capability for current acquisition",
            });
          }
        }

        if (current.asset_ids_total > 0) {
          const hasAssetView = await capabilityService.hasCapability(user.id, 'asset:view');
          if (!hasAssetView) {
            return reply.status(403).send({
              statusCode: 403,
              code: 'FORBIDDEN',
              message: "Forbidden: requires 'asset:view' capability for current assets",
            });
          }
        }

        // Target acquisition grant
        if (body.acquisition_id) {
          const hasAcqView = await capabilityService.hasCapability(user.id, 'acquisition:view');
          if (!hasAcqView) {
            return reply.status(403).send({
              statusCode: 403,
              code: 'FORBIDDEN',
              message:
                "Forbidden: requires 'acquisition:view' capability for target acquisition",
            });
          }
        }

        // Added / removed assets grants
        const touchedAssetCount =
          (body.add_asset_ids?.length || 0) + (body.remove_asset_ids?.length || 0);
        if (touchedAssetCount > 0) {
          const hasAssetView = await capabilityService.hasCapability(user.id, 'asset:view');
          if (!hasAssetView) {
            return reply.status(403).send({
              statusCode: 403,
              code: 'FORBIDDEN',
              message: "Forbidden: requires 'asset:view' capability for touched assets",
            });
          }
        }
      } catch (err: any) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({
            statusCode: 404,
            code: 'NOT_FOUND',
            message: 'Evidence record not found',
          });
        }
        throw err;
      }

      const sessionId = (request as any).session?.id ?? null;

      try {
        const result = await evidenceService.correctEvidence(
          id,
          user.id,
          body,
          effectiveToken,
          sessionId
        );
        return reply.status(200).send({
          id: result.id,
          version: result.version,
          history_id: result.history_id,
        });
      } catch (err: any) {
        if (err instanceof UnauthorizedError) {
          return reply.status(401).send({
            statusCode: 401,
            code: err.code || 'UNAUTHORIZED',
            message: err.message,
          });
        }
        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: err.code || 'VALIDATION_FAILED',
            message: err.message,
          });
        }
        if (err instanceof ConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: err.code || 'CONFLICT',
            message: err.message,
          });
        }
        if (err instanceof RetryTokenConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: err.code || 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            message: err.message,
          });
        }
        if (err instanceof NotFoundError) {
          return reply.status(404).send({
            statusCode: 404,
            code: 'NOT_FOUND',
            message: 'Evidence record not found',
          });
        }
        if (err instanceof ForbiddenError) {
          return reply.status(403).send({
            statusCode: 403,
            code: err.code || 'FORBIDDEN',
            message: err.message,
          });
        }
        request.log.error(err);
        return reply.status(500).send({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred',
        });
      }
    }
  );
};
