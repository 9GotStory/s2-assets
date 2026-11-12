import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isCalendarDate } from '../services/assignment.service.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import { RepairReadService } from '../services/repair-read.service.ts';
import {
  RepairOutcomeRefusedError,
  RepairService,
  RepairSourceRefusedError,
  RepairStartRefusedError,
  type RecordRepairOutcomeInput,
  type StartRepairInput,
} from '../services/repair.service.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface RepairRoutesOptions {
  repairService: RepairService;
  repairReadService: RepairReadService;
  capabilityService: CapabilityService;
}

// #98 Q10, Q22: how a Repair Record ended. The record's one cost is set beside it.
const repairOutcomeFields = {
  outcome: z.enum(['USABLE', 'NOT_USABLE']),
  outcome_date: z.string(),
  note: z.string().nullable().optional(),
  document_reference: z.string().nullable().optional(),
  next_recommended_maintenance_date: z.string().nullable().optional(),
};

const RecordRepairOutcomeSchema = z
  .object({
    expected_version: z.number().int().min(1),
    ...repairOutcomeFields,
    cost: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// #98 Q22: what a Repair Start takes, with its Repair Outcome when both are recorded at once (Q1), and
// its Repair Source when a Loan Return recorded ชำรุด led to it (F005-T5, Q5).
const StartRepairSchema = z
  .object({
    asset_id: z.string(),
    repair_kind: z.enum(['REPAIR', 'MAINTENANCE']),
    start_date: z.string(),
    repairer: z
      .object({
        kind: z.enum(['INTERNAL', 'EXTERNAL']),
        name: z.string().nullable().optional(),
      })
      .strict(),
    symptom_or_work: z.string(),
    under_warranty: z.enum(['YES', 'NO', 'UNSPECIFIED']).optional(),
    warranty_end_date: z.string().nullable().optional(),
    cost: z.string().nullable().optional(),
    document_reference: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
    repair_source: z.object({ loan_return_id: z.string() }).strict().nullable().optional(),
    outcome: z.object(repairOutcomeFields).strict().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// The Repair list's query (#98 Q21): each filter narrows the list on its own, and a page is read as on the
// Asset list. A repeated parameter arrives as an array and is refused.
const RepairListQuerySchema = z
  .object({
    has_outcome: z.enum(['true', 'false']).optional(),
    repair_kind: z.enum(['REPAIR', 'MAINTENANCE']).optional(),
    outcome: z.enum(['USABLE', 'NOT_USABLE']).optional(),
    repairer_kind: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
    // It searches the symptom or work, which is free text, so it keeps tab and line breaks inside it as that
    // field does and refuses the rest (CODING_STANDARDS.md).
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
  if (err instanceof RepairStartRefusedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), asset: err.asset };
  }
  if (err instanceof RepairSourceRefusedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), repair_source: err.repair_source };
  }
  if (err instanceof RepairOutcomeRefusedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), record: err.record };
  }
  if (err instanceof StaleBeforeConflictError) {
    return {
      ...errorBody(err.statusCode, err.code, err.message),
      current_values: err.current_values,
      expected_values: err.expected_values,
    };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

export const repairRoutes: FastifyPluginAsync<RepairRoutesOptions> = async (fastify, options) => {
  const { repairService, repairReadService, capabilityService } = options;

  /**
   * POST /repairs
   * Sends one Asset for repair or maintenance ("ส่งซ่อม", F005-T1).
   * Protected: requires 'repair:record' capability (Asset Custodian)
   */
  fastify.post('/repairs', { preHandler: [requireCapability('repair:record')] }, async (request, reply) => {
    const write = parseWrite(StartRepairSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await repairService.start(request.user!.id, input as StartRepairInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /repairs/:id/outcome
   * Records how a Repair Record ended ("บันทึกผลการซ่อม", F005-T2), against the version the client read.
   * Protected: requires 'repair:record' capability (Asset Custodian)
   */
  fastify.post('/repairs/:id/outcome', { preHandler: [requireCapability('repair:record')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Repair Record ID must be a valid UUID string'));
    }
    const write = parseWrite(RecordRepairOutcomeSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await repairService.recordOutcome(request.user!.id, id.trim().toLowerCase(), input as RecordRepairOutcomeInput, {
        retryToken: write.retryToken,
      });
      return reply.status(201).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * GET /repairs
   * The Repair list ("รายการซ่อม/บำรุงรักษา"), newest Start Date first (F005-T3). The logger names a
   * request by its path, so a search stays out of the logs.
   * Protected: requires 'asset:view' capability, like a Repair Record
   */
  fastify.get('/repairs', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = RepairListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { has_outcome: hasOutcome, limit = 25, offset = 0, ...filters } = parsed.data;
    return reply
      .status(200)
      .send(await repairReadService.list({ ...filters, has_outcome: hasOutcome === undefined ? undefined : hasOutcome === 'true', limit, offset }));
  });

  /**
   * GET /repairs/:id
   * One Repair Record with its outcome (F005-T1, T2). Every field goes to every reader, cost and Repairer
   * included (#98 Q2).
   * With ?outcome_date=YYYY-MM-DD, it also says where the Asset goes back to on that date (F005-T2, MR-16).
   * Protected: requires 'asset:view' capability, like the Asset it names
   */
  fastify.get('/repairs/:id', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Repair Record ID must be a valid UUID string'));
    }
    const { outcome_date: outcomeDate } = request.query as { outcome_date?: unknown };
    if (outcomeDate !== undefined && (typeof outcomeDate !== 'string' || !isCalendarDate(outcomeDate))) {
      return reply.status(400).send(errorBody(400, 'VALIDATION_FAILED', 'outcome_date must be a date (YYYY-MM-DD)'));
    }
    const record = await repairReadService.read(id.trim().toLowerCase(), { outcomeDate });
    if (!record) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Repair Record not found'));
    }
    const canRecordRepair = await capabilityService.hasCapability(request.user!.id, 'repair:record');
    return reply.status(200).send({ ...record, can_record_repair: canRecordRepair });
  });

  /**
   * GET /assets/:id/repairs
   * The Asset's Repair Records, newest Start Date first (F005-T1).
   * Protected: requires 'asset:view' capability, like the Asset itself
   */
  fastify.get('/assets/:id/repairs', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Asset ID must be a valid UUID string'));
    }
    const records = await repairReadService.recordsOfAsset(id.trim().toLowerCase());
    if (!records) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Asset not found'));
    }
    return reply.status(200).send({ records });
  });
};
