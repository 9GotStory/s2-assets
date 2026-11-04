import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { CapabilityService } from '../services/capability.service.ts';
import { isReferenceKind, ReferenceError, ReferenceService } from '../services/reference.service.ts';

export interface ReferenceRoutesOptions {
  referenceService?: ReferenceService;
  capabilityService?: CapabilityService;
  db?: any;
}

const ListQuerySchema = z
  .object({
    include_inactive: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

const CreateBodySchema = z.object({ name: z.string() }).strict();

const UpdateBodySchema = z
  .object({
    expected_version: z.number().int().positive(),
    name: z.string().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.status(statusCode).send({ statusCode, code, message });

/**
 * T4 (#25): reference lists for Asset reference context (D7-A).
 * - GET /references/:kind lists entries for every registry viewer ('asset:view'), with
 *   `can_maintain` telling the page whether to offer maintenance.
 * - POST /references/:kind adds and POST /references/:kind/:id renames, deactivates or
 *   reactivates an entry; both need 'reference:maintain' (ADMINISTRATOR, D3).
 */
export const referenceRoutes: FastifyPluginAsync<ReferenceRoutesOptions> = async (fastify, options) => {
  const referenceService = options.referenceService ?? new ReferenceService({ db: options.db });
  const capabilityService: CapabilityService =
    options.capabilityService ?? (fastify as any).capabilityService ?? new CapabilityService({ db: options.db });

  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  const handleError = (reply: FastifyReply, err: unknown, request: any) => {
    if (err instanceof ReferenceError) {
      return sendError(reply, err.statusCode, err.code, err.message);
    }
    request.log.error(err);
    return sendError(reply, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  };

  fastify.get('/:kind', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { kind } = request.params as { kind: string };
    if (!isReferenceKind(kind)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Unknown reference list');
    }
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Invalid list query');
    }
    try {
      const page = await referenceService.list(kind, {
        includeInactive: query.data.include_inactive === 'true',
        limit: query.data.limit ?? 200,
        offset: query.data.offset ?? 0,
      });
      const canMaintain = await capabilityService.hasCapability((request as any).user.id, 'reference:maintain');
      return { ...page, can_maintain: canMaintain };
    } catch (err) {
      return handleError(reply, err, request);
    }
  });

  fastify.post('/:kind', { preHandler: [requireCapability('reference:maintain')] }, async (request, reply) => {
    const { kind } = request.params as { kind: string };
    if (!isReferenceKind(kind)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Unknown reference list');
    }
    const body = CreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Body must be exactly { name }');
    }
    try {
      const entry = await referenceService.create(kind, (request as any).user.id, body.data.name);
      return reply.status(201).send(entry);
    } catch (err) {
      return handleError(reply, err, request);
    }
  });

  fastify.post('/:kind/:id', { preHandler: [requireCapability('reference:maintain')] }, async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!isReferenceKind(kind)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Unknown reference list');
    }
    const body = UpdateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Body must be { expected_version, name?, is_active? }');
    }
    try {
      return await referenceService.update(kind, (request as any).user.id, id, body.data);
    } catch (err) {
      return handleError(reply, err, request);
    }
  });
};
