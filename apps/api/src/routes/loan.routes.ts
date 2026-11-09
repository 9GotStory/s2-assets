import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { RetryTokenConflictError, ValidationError } from '../services/asset.service.ts';
import { CapabilityService, isValidUuid } from '../services/capability.service.ts';
import { AssetsNotLendableError, LoanService, type StartLoanInput } from '../services/loan.service.ts';

export interface LoanRoutesOptions {
  loanService: LoanService;
  capabilityService: CapabilityService;
}

// LR-15: an External Borrower gives a contact name and, when given, an organization name and a phone
// number; a field outside these is refused.
const BorrowerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('INTERNAL'), person_id: z.string() }).strict(),
  z
    .object({
      kind: z.literal('EXTERNAL'),
      contact_name: z.string(),
      organization_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
    })
    .strict(),
]);

const StartLoanSchema = z
  .object({
    assets: z.array(
      z
        .object({
          asset_id: z.string(),
          condition: z.enum(['NORMAL', 'DAMAGED']),
          condition_note: z.string().nullable().optional(),
        })
        .strict()
    ),
    borrower: BorrowerSchema,
    loan_date: z.string(),
    due_date: z.string(),
    authorizer_person_id: z.string().nullable().optional(),
    document_reference: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof AssetsNotLendableError) {
    return { ...errorBody(err.statusCode, err.code, err.message), assets: err.assets };
  }
  if (err instanceof RetryTokenConflictError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

export const loanRoutes: FastifyPluginAsync<LoanRoutesOptions> = async (fastify, options) => {
  const { loanService, capabilityService } = options;

  /**
   * POST /loans
   * Starts one Loan of 1 to 100 Assets, all of it or none (F004-T1).
   * Protected: requires 'loan:record' capability (Asset Custodian)
   */
  fastify.post('/loans', { preHandler: [requireCapability('loan:record')] }, async (request, reply) => {
    const write = parseWrite(StartLoanSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await loanService.start(request.user!.id, input as StartLoanInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * GET /loans/:id
   * One Loan with its items (F004-T1). The phone number goes only to holders of 'loan:record' (LR-15).
   * Protected: requires 'asset:view' capability, like the Assets it names
   */
  fastify.get('/loans/:id', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Loan ID must be a valid UUID string'));
    }

    const includePhone = await capabilityService.hasCapability(request.user!.id, 'loan:record');
    const loan = await loanService.read(id.trim().toLowerCase(), { includePhone });
    if (!loan) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Loan not found'));
    }
    return reply.status(200).send(loan);
  });

  /**
   * GET /assets/:id/loans
   * The Asset's LoanItems with their Loans (F004-T1).
   * Protected: requires 'asset:view' capability, like the Asset itself
   */
  fastify.get('/assets/:id/loans', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Asset ID must be a valid UUID string'));
    }

    const items = await loanService.itemsOfAsset(id.trim().toLowerCase());
    if (!items) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Asset not found'));
    }
    return reply.status(200).send({ items });
  });
};
