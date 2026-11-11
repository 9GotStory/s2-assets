import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid } from '../services/capability.service.ts';
import { RepairReadService } from '../services/repair-read.service.ts';
import { RepairService, RepairStartRefusedError, type StartRepairInput } from '../services/repair.service.ts';
import { NotFoundError, RetryTokenConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface RepairRoutesOptions {
  repairService: RepairService;
  repairReadService: RepairReadService;
}

// #98 Q22: what a Repair Start takes. Its Repair Outcome and Repair Source arrive with F005-T2 and T5.
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
    retry_token: z.string().optional(),
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RepairStartRefusedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), asset: err.asset };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

export const repairRoutes: FastifyPluginAsync<RepairRoutesOptions> = async (fastify, options) => {
  const { repairService, repairReadService } = options;

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
   * GET /repairs/:id
   * One Repair Record (F005-T1). Every field goes to every reader, cost and Repairer included (#98 Q2).
   * Protected: requires 'asset:view' capability, like the Asset it names
   */
  fastify.get('/repairs/:id', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Repair Record ID must be a valid UUID string'));
    }
    const record = await repairReadService.read(id.trim().toLowerCase());
    if (!record) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Repair Record not found'));
    }
    return reply.status(200).send(record);
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
