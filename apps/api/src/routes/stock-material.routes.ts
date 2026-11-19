import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import { RetryTokenConflictError } from '../services/service-errors.ts';
import type { StockMaterialReadService } from '../services/stock-material-read.service.ts';
import type { CreateStockMaterialInput, StockMaterialService } from '../services/stock-material.service.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface StockMaterialRoutesOptions {
  stockMaterialService: StockMaterialService;
  stockMaterialReadService: StockMaterialReadService;
  capabilityService: CapabilityService;
}

// #175 Q2, Q5, Q6: what creating a Stock Material takes in F008-T1.
const CreateStockMaterialSchema = z
  .object({
    name: z.string(),
    model: z.string().nullable().optional(),
    specification: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    base_unit: z.object({ unit_id: z.string(), whole_number_only: z.boolean().optional() }).strict(),
    retry_token: z.string().optional(),
  })
  .strict();

const StockMaterialListQuerySchema = z
  .object({
    // It searches the Specification, which is free text, so it keeps tab and line breaks inside it as that field
    // does and refuses the rest (CODING_STANDARDS.md).
    search: z
      .string()
      .refine((text) => !hasDisallowedControlChars(text), 'must not contain control characters')
      .refine((text) => Buffer.byteLength(text, 'utf8') <= 4096, 'must be at most 4096 bytes')
      .transform((text) => text.trim())
      .refine((text) => text.length > 0, 'must not be blank')
      .optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RetryTokenConflictError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/** F008-T1 (#176): the Stock Material catalog (วัสดุ), kept by the Supply Officer (#175 Q1, Q15). */
export const stockMaterialRoutes: FastifyPluginAsync<StockMaterialRoutesOptions> = async (fastify, options) => {
  const { stockMaterialService, stockMaterialReadService, capabilityService } = options;

  /**
   * GET /stock-materials
   * The Stock Materials by name, a page at a time, found by text in the name, the Model or the Specification, with
   * `can_manage` telling the page whether to offer "เพิ่มวัสดุ" (#175 P9).
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/stock-materials', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = StockMaterialListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search } = parsed.data;
    const list = await stockMaterialReadService.list({ search, limit, offset });
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...list, can_manage: canManage });
  });

  /**
   * GET /stock-materials/:id
   * One Stock Material with its Units and its history (#175 Q15, Q18), and `can_manage` for its actions.
   * Protected: requires 'material:view' capability
   */
  fastify.get('/stock-materials/:id', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const material = await stockMaterialReadService.read(id.trim().toLowerCase());
    if (!material) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Stock Material not found'));
    }
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...material, can_manage: canManage });
  });

  /**
   * POST /stock-materials
   * Creates a Stock Material with its Base Unit ("เพิ่มวัสดุ", F008-T1).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/stock-materials', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(CreateStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await stockMaterialService.create(request.user!.id, input as CreateStockMaterialInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });
};
