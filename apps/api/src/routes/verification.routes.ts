import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import { RetryTokenConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';
import { VerificationReadService } from '../services/verification-read.service.ts';
import {
  AnotherVerificationRoundOpenError,
  EmptyVerificationScopeError,
  VerificationService,
  type OpenVerificationRoundInput,
} from '../services/verification.service.ts';

export interface VerificationRoutesOptions {
  verificationService: VerificationService;
  verificationReadService: VerificationReadService;
  capabilityService: CapabilityService;
}

// #125 Q2, Q3: what opening a Verification Round takes. Its start date is today, never given.
const OpenVerificationRoundSchema = z
  .object({
    name: z.string(),
    fiscal_year: z.number(),
    notes: z.string().nullable().optional(),
    organization_unit_ids: z.array(z.string()).optional(),
    location_ids: z.array(z.string()).optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// A Round's entries (#125 AR-14): a search of the Scope Snapshot, and a page read as on the Asset list. An
// Asset name is free text, so the search keeps tab and line breaks inside it and refuses the other control
// characters (CODING_STANDARDS.md).
const ScopeEntryQuerySchema = z
  .object({
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
  if (err instanceof AnotherVerificationRoundOpenError) {
    return { ...errorBody(err.statusCode, err.code, err.message), open_round: err.open_round };
  }
  if (err instanceof EmptyVerificationScopeError || err instanceof RetryTokenConflictError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

const invalidRoundId = () => errorBody(400, 'INVALID_ID', 'Verification Round ID must be a valid UUID string');

export const verificationRoutes: FastifyPluginAsync<VerificationRoutesOptions> = async (fastify, options) => {
  const { verificationService, verificationReadService, capabilityService } = options;

  /**
   * POST /verification-rounds
   * Opens a Verification Round with its Scope Snapshot ("เปิดรอบตรวจ", F006-T1).
   * Protected: requires 'verification:manage' capability (Asset Custodian)
   */
  fastify.post('/verification-rounds', { preHandler: [requireCapability('verification:manage')] }, async (request, reply) => {
    const write = parseWrite(OpenVerificationRoundSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await verificationService.open(request.user!.id, input as OpenVerificationRoundInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * GET /verification-rounds
   * The Round list ("รอบตรวจ"), newest start date first, and whether the viewer may open one (F006-T1).
   * Protected: requires 'asset:view' capability, like the Assets a Round covers
   */
  fastify.get('/verification-rounds', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const items = await verificationReadService.list();
    const canManageVerification = await capabilityService.hasCapability(request.user!.id, 'verification:manage');
    return reply.status(200).send({ items, can_manage_verification: canManageVerification });
  });

  /**
   * GET /verification-rounds/:id
   * One Round with its filters, counts and history (F006-T1).
   * Protected: requires 'asset:view' capability
   */
  fastify.get('/verification-rounds/:id', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    const round = await verificationReadService.read(id.trim().toLowerCase());
    if (!round) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Verification Round not found'));
    }
    return reply.status(200).send(round);
  });

  /**
   * GET /verification-rounds/:id/entries
   * A page of the Round's Scope Snapshot, searchable (F006-T1). The logger names a request by its path, so a
   * search stays out of the logs.
   * Protected: requires 'asset:view' capability
   */
  fastify.get('/verification-rounds/:id/entries', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    const parsed = ScopeEntryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search } = parsed.data;
    const page = await verificationReadService.entries(id.trim().toLowerCase(), { search, limit, offset });
    if (!page) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Verification Round not found'));
    }
    return reply.status(200).send(page);
  });
};
