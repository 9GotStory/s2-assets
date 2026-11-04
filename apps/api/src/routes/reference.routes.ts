import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { CapabilityService } from '../services/capability.service.ts';
import {
  isReferenceKind,
  ReferenceListError,
  ReferenceService,
  type ReferenceKind,
} from '../services/reference.service.ts';

export interface ReferenceRoutesOptions {
  referenceService?: ReferenceService;
  capabilityService?: CapabilityService;
  db?: any;
}

const STRICT_INTEGER_REGEX = /^(0|[1-9]\d*)$/;

const ListQuerySchema = z
  .object({
    include_inactive: z.enum(['true', 'false']).optional(),
    limit: z
      .string()
      .regex(STRICT_INTEGER_REGEX)
      .transform(Number)
      .refine((num) => num >= 1 && num <= 500)
      .optional(),
    offset: z
      .string()
      .regex(STRICT_INTEGER_REGEX)
      .transform(Number)
      .refine((num) => num <= 2147483647)
      .optional(),
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

// Runs after the capability check, so an unknown list name never answers before authorization.
const requireKnownKind = async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isReferenceKind((request.params as { kind: string }).kind)) {
    return sendError(reply, 404, 'NOT_FOUND', 'Unknown reference list');
  }
};

/**
 * T4 (#25): reference lists for Asset reference context (D7-A).
 * - GET /references/:kind lists entries for every registry viewer ('asset:view'), with
 *   `can_maintain` telling the page whether to offer maintenance.
 * - POST /references/:kind adds and POST /references/:kind/:id renames, deactivates or
 *   reactivates an entry; both need 'reference:maintain' (ADMINISTRATOR, D3).
 * - GET /references/:kind/:id/history reads an entry's maintenance history ('asset:view';
 *   #25 PO decision 3).
 */
export const referenceRoutes: FastifyPluginAsync<ReferenceRoutesOptions> = async (fastify, options) => {
  const referenceService = options.referenceService ?? new ReferenceService({ db: options.db });
  const capabilityService: CapabilityService =
    options.capabilityService ?? (fastify as any).capabilityService ?? new CapabilityService({ db: options.db });

  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  const handleError = (reply: FastifyReply, err: unknown, request: any) => {
    if (err instanceof ReferenceListError) {
      return sendError(reply, err.statusCode, err.code, err.message);
    }
    request.log.error(err);
    return sendError(reply, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  };

  fastify.get('/:kind', { preHandler: [requireCapability('asset:view'), requireKnownKind] }, async (request, reply) => {
    const { kind } = request.params as { kind: ReferenceKind };
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

  fastify.get(
    '/:kind/:id/history',
    { preHandler: [requireCapability('asset:view'), requireKnownKind] },
    async (request, reply) => {
      const { kind, id } = request.params as { kind: ReferenceKind; id: string };
      try {
        return { items: await referenceService.history(kind, id) };
      } catch (err) {
        return handleError(reply, err, request);
      }
    }
  );

  fastify.post('/:kind', { preHandler: [requireCapability('reference:maintain'), requireKnownKind] }, async (request, reply) => {
    const { kind } = request.params as { kind: ReferenceKind };
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

  fastify.post('/:kind/:id', { preHandler: [requireCapability('reference:maintain'), requireKnownKind] }, async (request, reply) => {
    const { kind, id } = request.params as { kind: ReferenceKind; id: string };
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
