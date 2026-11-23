import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields, requestableMaterialSearchField } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid } from '../services/capability.service.ts';
import type { MaterialRequestReadService } from '../services/material-request-read.service.ts';
import { NotPendingError, RequestableMaterialNotOfferedError, type MaterialRequestService } from '../services/material-request.service.ts';
import type { RequestableMaterialReadService } from '../services/requestable-material-read.service.ts';
import { MATERIAL_REQUEST_STATES, type MaterialRequestState } from '../services/material-request-state.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface MaterialRequestRoutesOptions {
  materialRequestService: MaterialRequestService;
  materialRequestReadService: MaterialRequestReadService;
  requestableMaterialReadService: RequestableMaterialReadService;
}

// #202 Q10: what creating a Material Request takes; the service checks each value and names the Requested Item by its
// position when it refuses one.
const CreateMaterialRequestSchema = z
  .object({
    note: z.string().nullable().optional(),
    requested_items: z.array(
      z
        .object({
          requestable_material_id: z.string(),
          requested_quantity: z.string(),
          note: z.string().nullable().optional(),
        })
        .strict()
    ),
    retry_token: z.string().optional(),
  })
  .strict();

// F009-T5 (#207): a Cancel, at the version of the Material Request the request read, with an optional note (P4).
const CancelSchema = z
  .object({
    expected_version: z.number().int().positive(),
    note: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

const OfferedRequestableMaterialQuerySchema = z
  .object({
    search: requestableMaterialSearchField,
    ...pageQueryFields,
  })
  .strict();

// "คำขอของฉัน": a state filter, every state by default, each named in lower case (#202 Q19).
const STATE_FILTERS = Object.fromEntries(MATERIAL_REQUEST_STATES.map((state) => [state.toLowerCase(), state])) as Record<Lowercase<MaterialRequestState>, MaterialRequestState>;
const MyMaterialRequestQuerySchema = z
  .object({
    state: z.enum(['all', ...(Object.keys(STATE_FILTERS) as Lowercase<MaterialRequestState>[])]).optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RequestableMaterialNotOfferedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), position: err.position };
  }
  // A Cancel refused with the current state (Q20; #207 start decision 1).
  if (err instanceof StaleBeforeConflictError) {
    return { ...errorBody(err.statusCode, err.code, err.message), current_values: err.current_values, expected_values: err.expected_values };
  }
  if (err instanceof NotPendingError) {
    return { ...errorBody(err.statusCode, err.code, err.message), current_values: err.current_values };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/**
 * F009-T4 (#206): the Requester's Material Requests (คำขอเบิก): the offered Requestable Materials to ask for, creating a
 * Material Request, "คำขอของฉัน" and a Material Request's page (#202 Q1, Q18, Q19, P5, P9).
 */
export const materialRequestRoutes: FastifyPluginAsync<MaterialRequestRoutesOptions> = async (fastify, options) => {
  const { materialRequestService, materialRequestReadService, requestableMaterialReadService } = options;

  /**
   * GET /offered-requestable-materials
   * The Requestable Materials offered to Requesters, by name, a page at a time, found by text in the name ignoring case
   * and repeated spaces (#202 Q9, Q18).
   * Protected: requires 'material-request:create' capability (Requester)
   */
  fastify.get('/offered-requestable-materials', { preHandler: [requireCapability('material-request:create')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = OfferedRequestableMaterialQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search } = parsed.data;
    return reply.status(200).send(await requestableMaterialReadService.offeredList({ search, limit, offset }));
  });

  /**
   * POST /material-requests
   * Creates a Material Request of its Requested Items ("สร้างคำขอเบิก"), answering its Request Number.
   * Protected: requires 'material-request:create' capability (Requester)
   */
  fastify.post('/material-requests', { preHandler: [requireCapability('material-request:create')] }, async (request, reply) => {
    const write = parseWrite(CreateMaterialRequestSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await materialRequestService.create(request.user!.id, input, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  // Runs a Cancel `write` and answers it, or its refusal.
  const cancelled = async (write: () => Promise<unknown>) => {
    try {
      return { statusCode: 200, body: await write() };
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return { statusCode: refusal.statusCode, body: refusal };
    }
  };

  /**
   * POST /material-requests/:id/cancel
   * Cancels every Pending Requested Item of the caller's Material Request ("ยกเลิกคำขอเบิก", F009-T5) at the version
   * the request read, with an optional note (#202 MRQ-19, Q12, P4). Another person's answers as if it did not exist.
   * Protected: requires 'material-request:create' capability (Requester)
   */
  fastify.post('/material-requests/:id/cancel', { preHandler: [requireCapability('material-request:create')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Material Request ID must be a valid UUID string'));
    }
    const write = parseWrite(CancelSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await cancelled(() => materialRequestService.cancelMaterialRequest(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * POST /material-requests/:id/requested-items/:requestedItemId/cancel
   * Cancels one Pending Requested Item of the caller's Material Request ("ยกเลิก", F009-T5) at the version the request
   * read, with an optional note (#202 MRQ-19, Q12, P4). Another person's answers as if it did not exist.
   * Protected: requires 'material-request:create' capability (Requester)
   */
  fastify.post('/material-requests/:id/requested-items/:requestedItemId/cancel', { preHandler: [requireCapability('material-request:create')] }, async (request, reply) => {
    const { id, requestedItemId } = request.params as { id: string; requestedItemId: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Material Request ID must be a valid UUID string'));
    }
    if (!isValidUuid(requestedItemId)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requested Item ID must be a valid UUID string'));
    }
    const write = parseWrite(CancelSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    const { retry_token: _retryToken, ...input } = write.data;
    const answer = await cancelled(() =>
      materialRequestService.cancelRequestedItem(request.user!.id, id.trim().toLowerCase(), requestedItemId.trim().toLowerCase(), input, { retryToken: write.retryToken })
    );
    return reply.status(answer.statusCode).send(answer.body);
  });

  /**
   * GET /my-material-requests
   * "คำขอของฉัน": the caller's own Material Requests, newest first, a page at a time, by state (#202 Q19).
   * Protected: requires 'material-request:create' capability (Requester)
   */
  fastify.get('/my-material-requests', { preHandler: [requireCapability('material-request:create')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = MyMaterialRequestQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, state = 'all' } = parsed.data;
    const filters = { limit, offset, ...(state === 'all' ? {} : { state: STATE_FILTERS[state] }) };
    return reply.status(200).send(await materialRequestReadService.listOf(request.user!.id, filters));
  });

  /**
   * GET /material-requests/:id
   * A Material Request with its Requested Items and history (#202 Q19). Another person's answers as if it did not
   * exist (P5).
   * Protected: requires 'material-request:create' capability (Requester)
   */
  fastify.get('/material-requests/:id', { preHandler: [requireCapability('material-request:create')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Material Request ID must be a valid UUID string'));
    }
    const materialRequest = await materialRequestReadService.read(id.trim().toLowerCase());
    if (!materialRequest || materialRequest.requested_by !== request.user!.id) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Material Request not found'));
    }
    return reply.status(200).send(materialRequest);
  });
};
