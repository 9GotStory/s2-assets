import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { RETIREMENT_METHODS } from '../services/retirement-read.service.ts';
import { isValidUuid } from '../services/capability.service.ts';
import { RetirementRefusedError, RetirementService, type CorrectRetirementInput, type RecordRetirementInput } from '../services/retirement.service.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface RetirementRoutesOptions {
  retirementService: RetirementService;
}

// #154 Q2, Q4, Q15: what a Retirement takes. The Asset is named by the path.
const RecordRetirementSchema = z
  .object({
    retirement_date: z.string(),
    retirement_method: z.enum(RETIREMENT_METHODS),
    retirement_reference: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// #154 Q9, P2: an amendment names the fields it changes; a void names none. Either names the version the
// client read and a reason.
const CorrectRetirementSchema = z
  .object({
    expected_version: z.number().int().min(1),
    action: z.enum(['AMEND', 'VOID']),
    reason: z.string(),
    changes: z
      .object({
        retirement_date: z.string().optional(),
        retirement_method: z.enum(RETIREMENT_METHODS).optional(),
        retirement_reference: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RetirementRefusedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), asset: err.asset };
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

export const retirementRoutes: FastifyPluginAsync<RetirementRoutesOptions> = async (fastify, options) => {
  const { retirementService } = options;

  /**
   * POST /assets/:id/retirements
   * Records that the Asset left use for good ("จำหน่าย", F007-T1).
   * Protected: requires 'retirement:record' capability (Asset Custodian)
   */
  fastify.post('/assets/:id/retirements', { preHandler: [requireCapability('retirement:record')] }, async (request, reply) => {
    const write = parseWrite(RecordRetirementSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { id } = request.params as { id: string };
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await retirementService.record(request.user!.id, id, input as RecordRetirementInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /retirements/:id/corrections
   * Amends or voids a Retirement recorded wrong, with a reason ("แก้ไขรายการที่บันทึกผิด", "ยกเลิกรายการ",
   * F007-T5), against the version the client read.
   * Protected: requires 'retirement:correct' capability (Asset Custodian, Administrator)
   */
  fastify.post('/retirements/:id/corrections', { preHandler: [requireCapability('retirement:correct')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Retirement ID must be a valid UUID string'));
    }
    const write = parseWrite(CorrectRetirementSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await retirementService.correct(request.user!.id, id.trim().toLowerCase(), input as CorrectRetirementInput, { retryToken: write.retryToken });
      return reply.status(201).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });
};
