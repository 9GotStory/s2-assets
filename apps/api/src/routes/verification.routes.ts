import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import { RetryTokenConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';
import { DISCREPANCIES, VerificationReadService, type Discrepancy } from '../services/verification-read.service.ts';
import {
  AnotherVerificationRoundOpenError,
  AssetNotInVerificationScopeError,
  CurrentResultRefusal,
  EmptyVerificationScopeError,
  VerificationRoundNotOpenError,
  VerificationService,
  VerificationTargetNotFoundError,
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

// #125 Q6, Q7, Q8: what a first result for one Asset takes. Its context, the assignment it is compared with,
// and the Discrepancies derived from them are the server's, never given.
const RecordVerificationSchema = z
  .object({
    result: z.enum(['FOUND', 'NOT_FOUND']),
    condition: z.enum(['NORMAL', 'DAMAGED']).nullable().optional(),
    observed_location_id: z.string().nullable().optional(),
    label_missing_or_damaged: z.boolean().optional(),
    data_mismatch: z.boolean().optional(),
    data_mismatch_note: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    verification_date: z.string().nullable().optional(),
    // F006-T4 (#129): the current revision a Re-verification saw; left out for a first result.
    expected_revision_id: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// #125 Q18: what a Verification Correction takes: the current revision the user saw, and why it is voided.
const CorrectVerificationSchema = z
  .object({
    verification_revision_id: z.string(),
    reason: z.string(),
    retry_token: z.string().optional(),
  })
  .strict();

// A Round's entries (#125 AR-14, AV-19, P5): a search of the Scope Snapshot, filters by current result, by a
// Discrepancy and by snapshot Location, and a page read as on the Asset list. An Asset name is free text, so the
// search keeps tab and line breaks inside it and refuses the other control characters (CODING_STANDARDS.md).
const ScopeEntryQuerySchema = z
  .object({
    search: z
      .string()
      .refine((text) => !hasDisallowedControlChars(text), 'must not contain control characters')
      .refine((text) => Buffer.byteLength(text, 'utf8') <= 4096, 'must be at most 4096 bytes')
      .transform((text) => text.trim())
      .refine((text) => text.length > 0, 'must not be blank')
      .optional(),
    result: z.enum(['FOUND', 'NOT_FOUND', 'NOT_YET_VERIFIED']).optional(),
    discrepancy: z.enum(DISCREPANCIES as [Discrepancy, ...Discrepancy[]]).optional(),
    location_id: z
      .string()
      .refine(isValidUuid, 'must be a valid UUID')
      .transform((id) => id.trim().toLowerCase())
      .optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof AnotherVerificationRoundOpenError) {
    return { ...errorBody(err.statusCode, err.code, err.message), open_round: err.open_round };
  }
  if (err instanceof CurrentResultRefusal) {
    return { ...errorBody(err.statusCode, err.code, err.message), current: err.current };
  }
  if (
    err instanceof EmptyVerificationScopeError ||
    err instanceof VerificationRoundNotOpenError ||
    err instanceof AssetNotInVerificationScopeError ||
    err instanceof VerificationTargetNotFoundError ||
    err instanceof RetryTokenConflictError ||
    err instanceof ValidationError
  ) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

const invalidRoundId = () => errorBody(400, 'INVALID_ID', 'Verification Round ID must be a valid UUID string');
const invalidAssetId = () => errorBody(400, 'INVALID_ID', 'Asset ID must be a valid UUID string');

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
      return reply.status(201).send(await verificationService.open(request.user!.id, input, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /verification-rounds/:id/assets/:assetId/verifications
   * Records an Asset's first result in the open Round, Found or Not Found (F006-T2), or a Re-verification over
   * the current revision it saw (F006-T4). A QR link that opens the
   * Asset page grants nothing: this write alone records, under its capability (#125 AV-04).
   * Protected: requires 'verification:record' capability (Verification Staff, Asset Custodian)
   */
  fastify.post('/verification-rounds/:id/assets/:assetId/verifications', { preHandler: [requireCapability('verification:record')] }, async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    if (!isValidUuid(assetId)) {
      return reply.status(400).send(invalidAssetId());
    }
    const write = parseWrite(RecordVerificationSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await verificationService.record(request.user!.id, id.trim().toLowerCase(), assetId.trim().toLowerCase(), input, { retryToken: write.retryToken });
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
   * POST /verification-rounds/:id/assets/:assetId/verification-corrections
   * Voids the Asset's current result in the open Round, with a reason ("ยกเลิกรายการ (บันทึกผิด)", F006-T4).
   * Protected: requires 'verification:correct' capability (Asset Custodian, Administrator)
   */
  fastify.post('/verification-rounds/:id/assets/:assetId/verification-corrections', { preHandler: [requireCapability('verification:correct')] }, async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    if (!isValidUuid(assetId)) {
      return reply.status(400).send(invalidAssetId());
    }
    const write = parseWrite(CorrectVerificationSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const corrected = await verificationService.correct(request.user!.id, id.trim().toLowerCase(), assetId.trim().toLowerCase(), input, { retryToken: write.retryToken });
      return reply.status(201).send(corrected);
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
   * A page of the Round's Scope Snapshot, searchable (F006-T1), filtered by result (F006-T2), Discrepancy and
   * snapshot Location (F006-T3). The logger names a request by its path, so a search stays out of the logs.
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
    const { limit = 25, offset = 0, ...filters } = parsed.data;
    const page = await verificationReadService.entries(id.trim().toLowerCase(), { ...filters, limit, offset });
    if (!page) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Verification Round not found'));
    }
    return reply.status(200).send(page);
  });

  /**
   * GET /verification-rounds/:id/assets/:assetId/verifications
   * Every revision of the Asset in the Round, newest first, voided ones with their Verification Correction (F006-T4).
   * Protected: requires 'asset:view' capability
   */
  fastify.get('/verification-rounds/:id/assets/:assetId/verifications', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id, assetId } = request.params as { id: string; assetId: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    if (!isValidUuid(assetId)) {
      return reply.status(400).send(invalidAssetId());
    }
    const items = await verificationReadService.revisionsOf(id.trim().toLowerCase(), assetId.trim().toLowerCase());
    if (!items) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Asset not found in the Verification Round'));
    }
    return reply.status(200).send({ items });
  });

  /**
   * GET /assets/:id/verifications
   * The Asset's current result in every Round it belongs to, newest start date first ("ผลตรวจประจำปี", F006-T2).
   * Protected: requires 'asset:view' capability, like the Asset itself
   */
  fastify.get('/assets/:id/verifications', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidAssetId());
    }
    const items = await verificationReadService.verificationsOfAsset(id.trim().toLowerCase());
    if (!items) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Asset not found'));
    }
    return reply.status(200).send({ items });
  });
};
