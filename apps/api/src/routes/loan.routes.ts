import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError, ValidationError } from '../services/asset.service.ts';
import { isCalendarDate } from '../services/assignment.service.ts';
import { CapabilityService, isValidUuid } from '../services/capability.service.ts';
import { LoanItemsNotReturnableError, LoanReturnService, type RecordLoanReturnInput } from '../services/loan-return.service.ts';
import { AssetsNotLendableError, LoanService, type StartLoanInput } from '../services/loan.service.ts';

export interface LoanRoutesOptions {
  loanService: LoanService;
  loanReturnService: LoanReturnService;
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

// #74 Q29: the recorder is the signed-in user, so nothing names who brought an item back.
const RecordLoanReturnSchema = z
  .object({
    expected_version: z.number().int().min(1),
    return_date: z.string(),
    document_reference: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
    items: z.array(
      z
        .object({
          loan_item_id: z.string(),
          condition: z.enum(['NORMAL', 'DAMAGED']),
          condition_note: z.string().nullable().optional(),
        })
        .strict()
    ),
    retry_token: z.string().optional(),
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof AssetsNotLendableError) {
    return { ...errorBody(err.statusCode, err.code, err.message), assets: err.assets };
  }
  if (err instanceof LoanItemsNotReturnableError) {
    return { ...errorBody(err.statusCode, err.code, err.message), items: err.items };
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

export const loanRoutes: FastifyPluginAsync<LoanRoutesOptions> = async (fastify, options) => {
  const { loanService, loanReturnService, capabilityService } = options;

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
   * POST /loans/:id/returns
   * Records a Loan Return for one or more items of a Loan, all of it or none (F004-T2).
   * Protected: requires 'loan:record' capability (Asset Custodian)
   */
  fastify.post('/loans/:id/returns', { preHandler: [requireCapability('loan:record')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Loan ID must be a valid UUID string'));
    }

    const write = parseWrite(RecordLoanReturnSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const result = await loanReturnService.record(request.user!.id, id.trim().toLowerCase(), input as RecordLoanReturnInput, {
        retryToken: write.retryToken,
      });
      return reply.status(201).send(result);
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
   * With ?return_date=YYYY-MM-DD, each Outstanding item also says where it goes back to on that date (F004-T2).
   * Protected: requires 'asset:view' capability, like the Assets it names
   */
  fastify.get('/loans/:id', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Loan ID must be a valid UUID string'));
    }
    const { return_date: returnDate } = request.query as { return_date?: unknown };
    if (returnDate !== undefined && (typeof returnDate !== 'string' || !isCalendarDate(returnDate))) {
      return reply.status(400).send(errorBody(400, 'VALIDATION_FAILED', 'return_date must be a date (YYYY-MM-DD)'));
    }

    const canRecordLoan = await capabilityService.hasCapability(request.user!.id, 'loan:record');
    const loan = await loanService.read(id.trim().toLowerCase(), { includePhone: canRecordLoan, returnDate });
    if (!loan) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Loan not found'));
    }
    return reply.status(200).send({ ...loan, can_record_loan: canRecordLoan });
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
