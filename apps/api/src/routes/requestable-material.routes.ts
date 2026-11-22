import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasStrictControlChars } from '../services/control-characters.ts';
import type { RequestableMaterialReadService } from '../services/requestable-material-read.service.ts';
import {
  REQUESTABLE_MATERIAL_NAME_MAX_LENGTH,
  RequestableMaterialNameTakenError,
  type CreateRequestableMaterialInput,
  type RequestableMaterialService,
} from '../services/requestable-material.service.ts';
import { RetryTokenConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface RequestableMaterialRoutesOptions {
  requestableMaterialService: RequestableMaterialService;
  requestableMaterialReadService: RequestableMaterialReadService;
  capabilityService: CapabilityService;
}

// #202 Q5: what creating a Requestable Material takes; the service checks each value and names it when refused.
const CreateRequestableMaterialSchema = z
  .object({
    name: z.string(),
    request_unit_id: z.string(),
    whole_number_only: z.boolean().optional(),
    description: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

const RequestableMaterialListQuerySchema = z
  .object({
    // It searches the name, which is one line, so it refuses every control character as the name does
    // (CODING_STANDARDS.md).
    search: z
      .string()
      .refine((text) => !hasStrictControlChars(text), 'must not contain control characters')
      .transform((text) => text.trim())
      .refine((text) => text.length > 0, 'must not be blank')
      .refine((text) => text.length <= REQUESTABLE_MATERIAL_NAME_MAX_LENGTH, `must be at most ${REQUESTABLE_MATERIAL_NAME_MAX_LENGTH} characters`)
      .optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RequestableMaterialNameTakenError) {
    return { ...errorBody(err.statusCode, err.code, err.message), entry: err.entry };
  }
  if (err instanceof RetryTokenConflictError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/** F009-T1 (#203): the Requestable Materials (วัสดุสำหรับขอเบิก), kept by the Supply Officer (#202 Q5, Q18, Q19). */
export const requestableMaterialRoutes: FastifyPluginAsync<RequestableMaterialRoutesOptions> = async (fastify, options) => {
  const { requestableMaterialService, requestableMaterialReadService, capabilityService } = options;

  /**
   * GET /requestable-materials
   * The Requestable Materials by name, a page at a time, found by text in the name ignoring case and repeated spaces,
   * with `can_manage` telling the page whether to offer adding one (#202 P9).
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/requestable-materials', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = RequestableMaterialListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search } = parsed.data;
    const list = await requestableMaterialReadService.list({ search, limit, offset });
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...list, can_manage: canManage });
  });

  /**
   * GET /requestable-materials/:id
   * One Requestable Material with every field and its history (#202 Q17, Q19), and `can_manage` for its actions.
   * Protected: requires 'material:view' capability
   */
  fastify.get('/requestable-materials/:id', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    const requestable = await requestableMaterialReadService.read(id.trim().toLowerCase());
    if (!requestable) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Requestable Material not found'));
    }
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...requestable, can_manage: canManage });
  });

  /**
   * POST /requestable-materials
   * Creates a Requestable Material with its Request Unit ("เพิ่มวัสดุสำหรับขอเบิก", F009-T1).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/requestable-materials', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(CreateRequestableMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await requestableMaterialService.create(request.user!.id, input as CreateRequestableMaterialInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });
};
