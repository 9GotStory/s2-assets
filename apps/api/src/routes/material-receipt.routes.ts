import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import type { MaterialReceiptReadService } from '../services/material-receipt-read.service.ts';
import {
  MAX_RECEIPT_LINES,
  MaterialReceiptNotConfirmableError,
  MaterialReceiptNotDraftError,
  type MaterialReceiptService,
} from '../services/material-receipt.service.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface MaterialReceiptRoutesOptions {
  materialReceiptService: MaterialReceiptService;
  materialReceiptReadService: MaterialReceiptReadService;
  capabilityService: CapabilityService;
}

// #231 Q5–Q9, Q25; #234 start decision 1: a Draft as saved, which may be incomplete. The service checks each field.
const draftFields = {
  received_date: z.string().nullable().optional(),
  source_party_id: z.string().nullable().optional(),
  source_type_id: z.string().nullable().optional(),
  receipt_reference: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  lines: z
    .array(
      z
        .object({
          stock_material_id: z.string(),
          unit_id: z.string().nullable().optional(),
          quantity: z.string().nullable().optional(),
          unit_price: z.string().nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .strict()
    )
    // One over the cap reaches the service, which names it.
    .max(MAX_RECEIPT_LINES + 1),
  retry_token: z.string().optional(),
};

const CreateDraftSchema = z.object(draftFields).strict();
const ReplaceDraftSchema = z.object({ ...draftFields, expected_version: z.number().int().positive() }).strict();
const ExpectedVersionSchema = z.object({ expected_version: z.number().int().positive(), retry_token: z.string().optional() }).strict();

// #231 story 56: ร่าง, รับแล้ว or ทั้งหมด, and a search over the Receipt Number, the Receipt Reference (free text, so tab
// and line breaks are kept inside it, CODING_STANDARDS), the Source Party name and the lines' Stock Material names.
const STATE_FILTERS = { draft: 'DRAFT', received: 'RECEIVED' } as const;
const MaterialReceiptListQuerySchema = z
  .object({
    search: z
      .string()
      .refine((text) => !hasDisallowedControlChars(text), 'must not contain control characters')
      .transform((text) => text.trim())
      .refine((text) => text.length > 0, 'must not be blank')
      .refine((text) => text.length <= 500, 'must be at most 500 characters')
      .optional(),
    state: z.enum(['all', 'draft', 'received']).optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof MaterialReceiptNotConfirmableError) {
    return { ...errorBody(err.statusCode, err.code, err.message), problems: err.problems };
  }
  if (err instanceof StaleBeforeConflictError || err instanceof MaterialReceiptNotDraftError) {
    return { ...errorBody(err.statusCode, err.code, err.message), current_values: err.current_values, expected_values: err.expected_values };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

// Runs the write `write` and answers it with `statusCode`, or answers its refusal; an error that is not a refusal goes
// on to the error handler.
const answered = async (statusCode: number, write: () => Promise<unknown>) => {
  try {
    return { statusCode, body: await write() };
  } catch (err) {
    const refusal = refusalOf(err);
    if (!refusal) {
      throw err;
    }
    return { statusCode: refusal.statusCode, body: refusal };
  }
};

const INVALID_ID = errorBody(400, 'INVALID_ID', 'Material Receipt ID must be a valid UUID string');

/** F010-T3 (#234): the Material Receipts (รายการรับวัสดุ), kept by the Supply Officer and read by every material:view holder. */
export const materialReceiptRoutes: FastifyPluginAsync<MaterialReceiptRoutesOptions> = async (fastify, options) => {
  const { materialReceiptService, materialReceiptReadService, capabilityService } = options;

  /**
   * GET /material-receipts
   * The Material Receipts, newest first, a page at a time, by state and found by text in the Receipt Number, the Receipt
   * Reference, the Source Party name or a line's Stock Material name, Drafts included (P8), with `can_manage` for
   * "เพิ่มรายการรับวัสดุ".
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/material-receipts', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = MaterialReceiptListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search, state = 'all' } = parsed.data;
    const list = await materialReceiptReadService.list({ search, limit, offset, ...(state === 'all' ? {} : { state: STATE_FILTERS[state] }) });
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...list, can_manage: canManage });
  });

  /**
   * GET /material-receipts/:id
   * One Material Receipt with its lines, their Stock Movements and its history, and `can_manage` for its actions.
   * Protected: requires 'material:view' capability
   */
  fastify.get('/material-receipts/:id', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const materialReceipt = await materialReceiptReadService.read(id.trim().toLowerCase());
    if (!materialReceipt) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Material Receipt not found'));
    }
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...materialReceipt, can_manage: canManage });
  });

  /**
   * POST /material-receipts
   * Saves a new Draft (ร่าง), which may be incomplete (Q25).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/material-receipts', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(CreateDraftSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(201, () => materialReceiptService.create(request.user!.id, input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * PUT /material-receipts/:id
   * Replaces the whole Draft at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.put('/material-receipts/:id', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(ReplaceDraftSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => materialReceiptService.replace(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /material-receipts/:id/remove
   * Removes the Draft with its lines for good, at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/material-receipts/:id/remove', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(ExpectedVersionSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => materialReceiptService.remove(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /material-receipts/:id/confirm
   * Confirms the Draft at the version the request read ("ยืนยันรับวัสดุ"), giving it its Receipt Number and adding its
   * Stock Movements.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/material-receipts/:id/confirm', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(ExpectedVersionSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => materialReceiptService.confirm(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });
};
