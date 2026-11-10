import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError, ValidationError } from '../services/asset.service.ts';
import { isCalendarDate } from '../services/assignment.service.ts';
import { CapabilityService, isValidUuid } from '../services/capability.service.ts';
import { hasStrictControlChars } from '../services/control-characters.ts';
import { LoanItemsNotReturnableError, LoanReturnService, type RecordLoanReturnInput } from '../services/loan-return.service.ts';
import { AssetsNotLendableError, LoanItemsNotOutstandingError, LoanService, type StartLoanInput } from '../services/loan.service.ts';
import { NotReturnedService, type RecordNotReturnedInput } from '../services/not-returned.service.ts';
import { DueDateExtensionService, type RecordDueDateExtensionInput } from '../services/due-date-extension.service.ts';

export interface LoanRoutesOptions {
  loanService: LoanService;
  loanReturnService: LoanReturnService;
  notReturnedService: NotReturnedService;
  dueDateExtensionService: DueDateExtensionService;
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

// #74 Q21: a date it became known and a reason, shared by every item named.
const RecordNotReturnedSchema = z
  .object({
    expected_version: z.number().int().min(1),
    not_returned_date: z.string(),
    reason: z.string(),
    items: z.array(z.object({ loan_item_id: z.string() }).strict()),
    retry_token: z.string().optional(),
  })
  .strict();

// #74 Q6, Q28: one new date and an optional reason for every item named.
const RecordDueDateExtensionSchema = z
  .object({
    expected_version: z.number().int().min(1),
    new_due_date: z.string(),
    reason: z.string().nullable().optional(),
    items: z.array(z.object({ loan_item_id: z.string() }).strict()),
    retry_token: z.string().optional(),
  })
  .strict();

// The Loan list's query: each filter narrows the list on its own, and a page is read as on the Asset list.
// A repeated parameter arrives as an array and is refused.
const LoanListQuerySchema = z
  .object({
    status: z.enum(['OUTSTANDING', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED']).optional(),
    // "เกินกำหนด" takes one value; leaving it out lists every Loan.
    overdue: z.literal('true').optional(),
    borrower_kind: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
    // A name is one line, so a control character, even at an end, can match none (CODING_STANDARDS.md).
    borrower_name: z
      .string()
      .refine((name) => !hasStrictControlChars(name), 'must not contain control characters')
      .refine((name) => Buffer.byteLength(name, 'utf8') <= 4096, 'must be at most 4096 bytes')
      .transform((name) => name.trim())
      .refine((name) => name.length > 0, 'must not be blank')
      .optional(),
    borrower_person_id: z.string().refine(isValidUuid, 'must be a valid UUID').optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/, 'must be a canonical positive integer')
      .transform(Number)
      .refine((limit) => limit <= 100, 'must be between 1 and 100')
      .optional(),
    offset: z
      .string()
      .regex(/^(0|[1-9]\d*)$/, 'must be a canonical non-negative integer')
      .transform(Number)
      .refine((offset) => offset <= 2147483647, 'must be between 0 and 2147483647')
      .optional(),
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof AssetsNotLendableError) {
    return { ...errorBody(err.statusCode, err.code, err.message), assets: err.assets };
  }
  if (err instanceof LoanItemsNotReturnableError || err instanceof LoanItemsNotOutstandingError) {
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

// The answer to a write on an existing Loan, for the handler to send: 201 with what it recorded, or
// the refusal of its id, its body or its facts.
const answerOfWriteOnLoan = async <T extends { retry_token?: string }>(
  request: FastifyRequest,
  schema: z.ZodType<T>,
  write: (loanId: string, input: Omit<T, 'retry_token'>, retryToken: string) => Promise<unknown>
): Promise<{ statusCode: number; body: unknown }> => {
  const { id } = request.params as { id: string };
  if (!isValidUuid(id)) {
    return { statusCode: 400, body: errorBody(400, 'INVALID_ID', 'Loan ID must be a valid UUID string') };
  }
  const parsed = parseWrite(schema, request);
  if ('refusal' in parsed) {
    return { statusCode: 400, body: parsed.refusal };
  }
  try {
    const { retry_token: _retryToken, ...input } = parsed.data;
    return { statusCode: 201, body: await write(id.trim().toLowerCase(), input, parsed.retryToken) };
  } catch (err) {
    const refusal = refusalOf(err);
    if (!refusal) {
      throw err;
    }
    return { statusCode: refusal.statusCode, body: refusal };
  }
};

export const loanRoutes: FastifyPluginAsync<LoanRoutesOptions> = async (fastify, options) => {
  const { loanService, loanReturnService, notReturnedService, dueDateExtensionService, capabilityService } = options;


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
    const { statusCode, body } = await answerOfWriteOnLoan(request, RecordLoanReturnSchema, (loanId, input, retryToken) =>
      loanReturnService.record(request.user!.id, loanId, input as RecordLoanReturnInput, { retryToken })
    );
    return reply.status(statusCode).send(body);
  });

  /**
   * POST /loans/:id/not-returned
   * Closes one or more Outstanding items of a Loan as Not Returned ("ปิดโดยไม่ได้รับคืน"), all of them or none (F004-T5).
   * Protected: requires 'loan:record' capability (Asset Custodian)
   */
  fastify.post('/loans/:id/not-returned', { preHandler: [requireCapability('loan:record')] }, async (request, reply) => {
    const { statusCode, body } = await answerOfWriteOnLoan(request, RecordNotReturnedSchema, (loanId, input, retryToken) =>
      notReturnedService.record(request.user!.id, loanId, input as RecordNotReturnedInput, { retryToken })
    );
    return reply.status(statusCode).send(body);
  });

  /**
   * POST /loans/:id/due-date-extensions
   * Moves the Due Date of one or more Outstanding items of a Loan later ("เลื่อนกำหนดคืน"), all of them or none (F004-T5).
   * Protected: requires 'loan:record' capability (Asset Custodian)
   */
  fastify.post('/loans/:id/due-date-extensions', { preHandler: [requireCapability('loan:record')] }, async (request, reply) => {
    const { statusCode, body } = await answerOfWriteOnLoan(request, RecordDueDateExtensionSchema, (loanId, input, retryToken) =>
      dueDateExtensionService.record(request.user!.id, loanId, input as RecordDueDateExtensionInput, { retryToken })
    );
    return reply.status(statusCode).send(body);
  });

  /**
   * GET /loans
   * The Loan list ("รายการยืม"), latest Loan Date first (F004-T3). It never carries a phone number,
   * and the logger names a request by its path, so a search by Borrower stays out of the logs (LR-15).
   * Protected: requires 'asset:view' capability, like a Loan
   */
  fastify.get('/loans', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = LoanListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`).join(', ');
      return reply.status(400).send(errorBody(400, 'VALIDATION_FAILED', `Invalid query: ${issues}`));
    }
    const { borrower_person_id: personId, overdue, limit = 25, offset = 0, ...filters } = parsed.data;
    return reply.status(200).send(
      await loanService.list({ ...filters, overdue: overdue === 'true', borrower_person_id: personId?.trim().toLowerCase(), limit, offset })
    );
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
