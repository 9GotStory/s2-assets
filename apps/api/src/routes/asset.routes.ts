import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { requireCapability } from '../middleware/authorization.ts';
import {
  AssetService,
  DuplicateCandidateWarningError,
  RetryTokenConflictError,
  type RegisterAssetInput,
} from '../services/asset.service.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';

export interface AssetRoutesOptions {
  assetService?: AssetService;
  capabilityService?: CapabilityService;
  db?: any;
}

export const assetRoutes: FastifyPluginAsync<AssetRoutesOptions> = async (
  fastify,
  options
) => {
  const assetService =
    options.assetService ??
    new AssetService({ db: options.db ?? fastify.capabilityService });

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
      const { asset_number, serial_number } = (request.query || {}) as {
        asset_number?: string;
        serial_number?: string;
      };
      const candidates = await assetService.getDuplicateCandidates(
        asset_number,
        serial_number
      );
      return reply.status(200).send({ candidates });
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

      const body = (request.body || {}) as RegisterAssetInput & { retry_token?: string };
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

        if (err.message && err.message.includes('required')) {
          return reply.status(400).send({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            error: 'VALIDATION_ERROR',
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

      return reply.status(200).send(result);
    }
  );
};

export default assetRoutes;
