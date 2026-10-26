import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AcquisitionService, type CreateAcquisitionInput } from '../services/acquisition.service.ts';
import { CapabilityService } from '../services/capability.service.ts';
import { ValidationError, RetryTokenConflictError } from '../services/asset.service.ts';

export interface AcquisitionRoutesOptions {
  acquisitionService?: AcquisitionService;
  capabilityService?: CapabilityService;
  db?: any;
}

const CreateAcquisitionSchema = z
  .object({
    acquisition_type: z.string().nullable().optional(),
    acquisition_date: z.string().nullable().optional(),
    total_amount: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    source_reference: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    retry_token: z.string().nullable().optional(),
  })
  .strict();

const EXACT_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isExactUuid(val: unknown): val is string {
  return typeof val === 'string' && EXACT_UUID_REGEX.test(val);
}

const STRICT_INTEGER_REGEX = /^(0|[1-9]\d*)$/;

const PaginationQuerySchema = z.object({
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
  includeAssets: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
});

export const acquisitionRoutes: FastifyPluginAsync<AcquisitionRoutesOptions> = async (
  fastify,
  options
) => {
  const db = options.db || (fastify as any).db;
  const acquisitionService =
    options.acquisitionService ||
    (fastify as any).acquisitionService ||
    new AcquisitionService({ db });

  const capabilityService: CapabilityService =
    options.capabilityService ||
    (fastify as any).capabilityService ||
    new CapabilityService({ db });

  const requireCapability = (capability: string) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user || !user.id) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authenticated session required',
        });
      }

      const hasGrant = await capabilityService.hasCapability(user.id, capability);
      if (!hasGrant) {
        return reply.status(403).send({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: `Forbidden: requires '${capability}' capability`,
        });
      }
    };
  };

  /**
   * POST /
   * Create a lightweight Acquisition reference (D1, D3, ACQ-01..08)
   * Protected: requires 'acquisition:create' capability (Asset Custodian)
   */
  fastify.post(
    '/',
    {
      preHandler: [requireCapability('acquisition:create')],
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

      const parsed = CreateAcquisitionSchema.safeParse(request.body || {});
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

      const body = parsed.data as CreateAcquisitionInput & { retry_token?: string };

      const headerTokenRaw = request.headers['x-retry-token'];
      const headerToken = typeof headerTokenRaw === 'string' ? headerTokenRaw.trim() : undefined;
      const bodyTokenRaw = (request.body as any)?.retry_token;
      const bodyToken = typeof bodyTokenRaw === 'string' ? bodyTokenRaw.trim() : undefined;

      // Reject contradictory header and body retry tokens before writes
      if (headerToken !== undefined && bodyToken !== undefined && headerToken !== bodyToken) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message: 'Contradictory retry token in header and body',
        });
      }

      const retryToken = headerToken || bodyToken;
      if (!retryToken || retryToken.trim() === '') {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message: 'Missing or blank retry token: acquisition creation requires a nonblank retry token',
        });
      }

      try {
        const result = await acquisitionService.createAcquisition(user.id, body, {
          retryToken,
        });
        return reply.status(201).send(result);
      } catch (err: any) {
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
   * Retrieve Acquisition details and linked Assets (D3, ACQ-01..08)
   * Protected: requires 'acquisition:view' capability (Asset Custodian, Administrator, Read-only User)
   */
  fastify.get(
    '/:id',
    {
      preHandler: [requireCapability('acquisition:view')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      const { id } = (request.params || {}) as { id: string };

      if (!isExactUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'INVALID_ID',
          error: 'INVALID_ID',
          message: 'Acquisition ID must be an exact well-formed UUID string',
        });
      }

      const parsedQuery = PaginationQuerySchema.safeParse(request.query || {});
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

      const { limit, offset } = parsedQuery.data;

      // Check if user also has 'asset:view' to disclose linked asset details
      const canViewAssets = await capabilityService.hasCapability(user.id, 'asset:view');

      const result = await acquisitionService.getAcquisitionById(id, {
        includeAssets: canViewAssets,
        limit,
        offset,
      });

      if (!result) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
          message: 'Acquisition not found',
        });
      }

      return reply.status(200).send(result);
    }
  );
};

export default acquisitionRoutes;
