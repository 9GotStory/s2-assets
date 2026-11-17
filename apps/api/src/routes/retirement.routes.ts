import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { RETIREMENT_METHODS } from '../services/retirement-read.service.ts';
import { RetirementRefusedError, RetirementService, type RecordRetirementInput } from '../services/retirement.service.ts';
import { NotFoundError, RetryTokenConflictError } from '../services/service-errors.ts';
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

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RetirementRefusedError) {
    return { ...errorBody(err.statusCode, err.code, err.message), asset: err.asset };
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
};
