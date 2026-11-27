import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import type { OpeningBalanceReadService } from '../services/opening-balance-read.service.ts';
import {
  MAX_OPENING_BALANCE_LINES,
  OpeningBalanceNotConfirmableError,
  OpeningBalanceNotConfirmedError,
  OpeningBalanceNotCorrectableError,
  OpeningBalanceNotDraftError,
  OpeningBalanceVoidedError,
  type OpeningBalanceService,
} from '../services/opening-balance.service.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface OpeningBalanceRoutesOptions {
  openingBalanceService: OpeningBalanceService;
  openingBalanceReadService: OpeningBalanceReadService;
  capabilityService: CapabilityService;
}

// #231 Q13, Q25; #233 start decision 1: a Draft as saved, which may be incomplete. The service checks each field.
const draftFields = {
  as_of_date: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  lines: z
    .array(
      z
        .object({
          stock_material_id: z.string(),
          unit_id: z.string().nullable().optional(),
          quantity: z.string().nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .strict()
    )
    // One over the cap reaches the service, which names it.
    .max(MAX_OPENING_BALANCE_LINES + 1),
  retry_token: z.string().optional(),
};

const CreateDraftSchema = z.object(draftFields).strict();
const ReplaceDraftSchema = z.object({ ...draftFields, expected_version: z.number().int().positive() }).strict();
const ExpectedVersionSchema = z.object({ expected_version: z.number().int().positive(), retry_token: z.string().optional() }).strict();

// F010-T7 (#238; #231 P5): a correction sends the whole Opening Balance as it should be: its header, each recorded line by
// its id and each new line without one, the lines it voids, a reason and the version it read, as a Receipt Correction
// does (T6). The service checks each field and names it when refused.
const CorrectSchema = z
  .object({
    expected_version: z.number().int().positive(),
    as_of_date: z.string(),
    source: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    lines: z
      .array(
        z
          .object({
            line_id: z.string().nullable().optional(),
            stock_material_id: z.string(),
            unit_id: z.string(),
            quantity: z.string(),
            note: z.string().nullable().optional(),
            recalculate: z.boolean().optional(),
          })
          .strict()
      )
      // One over the cap reaches the service, which names it.
      .max(MAX_OPENING_BALANCE_LINES + 1),
    voided_line_ids: z.array(z.string()).max(MAX_OPENING_BALANCE_LINES).optional(),
    reason: z.string(),
    retry_token: z.string().optional(),
  })
  .strict();

// F010-T7 (#238): the void of a whole Opening Balance sends a reason and the version it read.
const VoidSchema = z.object({ expected_version: z.number().int().positive(), reason: z.string(), retry_token: z.string().optional() }).strict();

// #233 start decision 4: ร่าง, ยืนยันแล้ว, ยกเลิกแล้ว (F010-T7) or ทั้งหมด, and a search over the number, the source (free text, so tab and
// line breaks are kept inside it, CODING_STANDARDS) and the lines' Stock Material names.
const STATE_FILTERS = { draft: 'DRAFT', confirmed: 'CONFIRMED', voided: 'VOIDED' } as const;
const OpeningBalanceListQuerySchema = z
  .object({
    search: z
      .string()
      .refine((text) => !hasDisallowedControlChars(text), 'must not contain control characters')
      .transform((text) => text.trim())
      .refine((text) => text.length > 0, 'must not be blank')
      .refine((text) => text.length <= 500, 'must be at most 500 characters')
      .optional(),
    state: z.enum(['all', 'draft', 'confirmed', 'voided']).optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof OpeningBalanceNotConfirmableError || err instanceof OpeningBalanceNotCorrectableError) {
    return { ...errorBody(err.statusCode, err.code, err.message), problems: err.problems };
  }
  if (err instanceof StaleBeforeConflictError || err instanceof OpeningBalanceNotDraftError || err instanceof OpeningBalanceNotConfirmedError || err instanceof OpeningBalanceVoidedError) {
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

const INVALID_ID = errorBody(400, 'INVALID_ID', 'Opening Balance ID must be a valid UUID string');

/** F010-T2 (#233): the Opening Balances (ยอดตั้งต้น), kept by the Supply Officer and read by every material:view holder. */
export const openingBalanceRoutes: FastifyPluginAsync<OpeningBalanceRoutesOptions> = async (fastify, options) => {
  const { openingBalanceService, openingBalanceReadService, capabilityService } = options;

  /**
   * GET /opening-balances
   * The Opening Balances, newest first, a page at a time, by state and found by text in the number, the source or a
   * line's Stock Material name, Drafts included (P8), with `can_manage` for "เพิ่มยอดตั้งต้น".
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/opening-balances', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = OpeningBalanceListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search, state = 'all' } = parsed.data;
    const list = await openingBalanceReadService.list({ search, limit, offset, ...(state === 'all' ? {} : { state: STATE_FILTERS[state] }) });
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...list, can_manage: canManage });
  });

  /**
   * GET /opening-balances/:id
   * One Opening Balance with its lines, their Stock Movements and its history, and `can_manage` for its actions.
   * Protected: requires 'material:view' capability
   */
  fastify.get('/opening-balances/:id', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const openingBalance = await openingBalanceReadService.read(id.trim().toLowerCase());
    if (!openingBalance) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Opening Balance not found'));
    }
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...openingBalance, can_manage: canManage });
  });

  /**
   * POST /opening-balances
   * Saves a new Draft (ร่าง), which may be incomplete (Q25).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/opening-balances', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(CreateDraftSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(201, () => openingBalanceService.create(request.user!.id, input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * PUT /opening-balances/:id
   * Replaces the whole Draft at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.put('/opening-balances/:id', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(ReplaceDraftSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => openingBalanceService.replace(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /opening-balances/:id/remove
   * Removes the Draft with its lines for good, at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/opening-balances/:id/remove', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(ExpectedVersionSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => openingBalanceService.remove(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /opening-balances/:id/confirm
   * Confirms the Draft at the version the request read ("ยืนยันยอดตั้งต้น"), adding its Stock Movements.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/opening-balances/:id/confirm', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(ExpectedVersionSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => openingBalanceService.confirm(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /opening-balances/:id/correct
   * F010-T7 (#238): a correction ("แก้ไขรายการที่บันทึกผิด") of a confirmed Opening Balance, with a reason, at the version
   * the request read: each fix that changes stock adds a Reversal and, where something did happen, a new Stock Movement.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/opening-balances/:id/correct', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(CorrectSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => openingBalanceService.correct(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /opening-balances/:id/void
   * F010-T7 (#238): voids the whole confirmed Opening Balance ("ยกเลิกรายการ"), with a reason, at the version the request
   * read: every line's Stock Movement in effect is reversed, and it stays shown as ยกเลิกแล้ว.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/opening-balances/:id/void', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(INVALID_ID);
    }
    const write = parseWrite(VoidSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await answered(200, () => openingBalanceService.void(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });
};
