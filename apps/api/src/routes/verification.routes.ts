import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars } from '../services/control-characters.ts';
import { AssetRetiredError } from '../services/retirement-read.service.ts';
import { RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';
import { DISCREPANCIES, JOINED_AS, VerificationReadService, type Discrepancy } from '../services/verification-read.service.ts';
import {
  VerificationRoundHasResultsError,
  VerificationRoundNotClosedError,
  VerificationRoundService,
  type EditVerificationRoundInput,
} from '../services/verification-round.service.ts';
import {
  AnotherVerificationRoundOpenError,
  AssetAlreadyInVerificationScopeError,
  AssetNotInVerificationScopeError,
  CurrentResultRefusal,
  EmptyVerificationScopeError,
  VerificationRoundNotOpenError,
  VerificationService,
  VerificationTargetNotFoundError,
} from '../services/verification.service.ts';

export interface VerificationRoutesOptions {
  verificationService: VerificationService;
  verificationRoundService: VerificationRoundService;
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

// #125 Q11: what a Late Addition takes: a registered Asset not in the open Round, and why it is added.
const LateAdditionSchema = z
  .object({
    asset_id: z.string(),
    reason: z.string(),
    retry_token: z.string().optional(),
  })
  .strict();

// F006-T6 (#131): a close names only the version of the Round it read; a Reopen and a void add their reason (#125 Q9,
// Q25, Q28).
const RoundVersionSchema = z
  .object({
    expected_version: z.number().int().min(1),
    retry_token: z.string().optional(),
  })
  .strict();

const ReasonedRoundSchema = z
  .object({
    expected_version: z.number().int().min(1),
    reason: z.string(),
    retry_token: z.string().optional(),
  })
  .strict();

// #125 Q27: an edit sets an open Round's name, fiscal year or notes. Its start date and Scope Snapshot are not fields.
const EditVerificationRoundSchema = z
  .object({
    expected_version: z.number().int().min(1),
    name: z.string().optional(),
    fiscal_year: z.number().optional(),
    notes: z.string().nullable().optional(),
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

// A Round's entries (#125 AR-14, AV-19, AV-21, P5): a search of the Scope Snapshot, filters by current result, by a
// Discrepancy, by how an Asset joined and by snapshot Location, and a page read as on the Asset list. An Asset name is free text, so the
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
    joined_as: z.enum(JOINED_AS).optional(),
    // "ยังไม่มี action ต่อ" takes one value; leaving it out lists every entry (F006-T7, Q19).
    awaiting_action: z
      .literal('true')
      .transform(() => true as const)
      .optional(),
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
  if (err instanceof StaleBeforeConflictError) {
    return { ...errorBody(err.statusCode, err.code, err.message), current_values: err.current_values, expected_values: err.expected_values };
  }
  if (err instanceof AssetRetiredError) {
    return { ...errorBody(err.statusCode, err.code, err.message), asset: err.asset };
  }
  if (
    err instanceof EmptyVerificationScopeError ||
    err instanceof VerificationRoundNotOpenError ||
    err instanceof VerificationRoundNotClosedError ||
    err instanceof VerificationRoundHasResultsError ||
    err instanceof AssetNotInVerificationScopeError ||
    err instanceof AssetAlreadyInVerificationScopeError ||
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
  const { verificationService, verificationRoundService, verificationReadService, capabilityService } = options;

  // Answers a write on an existing Round: its id from the path, its body by `schema`, and its refusals.
  const roundWrite =
    <T extends { retry_token?: string }>(schema: z.ZodType<T>, status: number, write: (actorId: string, roundId: string, input: Omit<T, 'retry_token'>, retryToken: string) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        return reply.status(400).send(invalidRoundId());
      }
      const parsed = parseWrite(schema, request);
      if ('refusal' in parsed) {
        return reply.status(400).send(parsed.refusal);
      }
      try {
        const { retry_token: _retryToken, ...input } = parsed.data;
        return reply.status(status).send(await write(request.user!.id, id.trim().toLowerCase(), input, parsed.retryToken));
      } catch (err) {
        const refusal = refusalOf(err);
        if (!refusal) {
          throw err;
        }
        return reply.status(refusal.statusCode).send(refusal);
      }
    };

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
   * PATCH /verification-rounds/:id
   * Edits an open Round's name, fiscal year or notes, against the version the client read ("แก้ไขข้อมูลรอบ", F006-T6).
   * Protected: requires 'verification:manage' capability (Asset Custodian)
   */
  fastify.patch(
    '/verification-rounds/:id',
    { preHandler: [requireCapability('verification:manage')] },
    roundWrite(EditVerificationRoundSchema, 200, (actorId, roundId, input, retryToken) =>
      verificationRoundService.edit(actorId, roundId, input as EditVerificationRoundInput, { retryToken })
    )
  );

  /**
   * POST /verification-rounds/:id/close
   * Closes an open Round, storing its counts at that moment ("ปิดรอบ", F006-T6).
   * Protected: requires 'verification:manage' capability (Asset Custodian)
   */
  fastify.post(
    '/verification-rounds/:id/close',
    { preHandler: [requireCapability('verification:manage')] },
    roundWrite(RoundVersionSchema, 201, (actorId, roundId, input, retryToken) => verificationRoundService.close(actorId, roundId, input, { retryToken }))
  );

  /**
   * POST /verification-rounds/:id/reopen
   * Opens a Closed Round again, with a reason ("เปิดรอบอีกครั้ง", F006-T6).
   * Protected: requires 'verification:correct' capability (Asset Custodian, Administrator)
   */
  fastify.post(
    '/verification-rounds/:id/reopen',
    { preHandler: [requireCapability('verification:correct')] },
    roundWrite(ReasonedRoundSchema, 201, (actorId, roundId, input, retryToken) => verificationRoundService.reopen(actorId, roundId, input, { retryToken }))
  );

  /**
   * POST /verification-rounds/:id/void
   * Voids an open Round that holds no result, with a reason ("ยกเลิกรอบ", F006-T6).
   * Protected: requires 'verification:correct' capability (Asset Custodian, Administrator)
   */
  fastify.post(
    '/verification-rounds/:id/void',
    { preHandler: [requireCapability('verification:correct')] },
    roundWrite(ReasonedRoundSchema, 201, (actorId, roundId, input, retryToken) => verificationRoundService.void(actorId, roundId, input, { retryToken }))
  );

  /**
   * POST /verification-rounds/:id/late-additions
   * Adds an Asset that is not in the open Round to its Scope Snapshot, with a reason ("เพิ่มเข้ารอบภายหลัง", F006-T5).
   * Protected: requires 'verification:manage' capability (Asset Custodian)
   */
  fastify.post('/verification-rounds/:id/late-additions', { preHandler: [requireCapability('verification:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    const write = parseWrite(LateAdditionSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await verificationService.addLateAddition(request.user!.id, id.trim().toLowerCase(), input, { retryToken: write.retryToken }));
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
   * One Round with its filters, counts and history (F006-T1), whether the viewer may close and edit it, or
   * reopen and void it (F006-T6), and whether they may send a result Found ชำรุด for repair (F006-T7) or move an Asset
   * from a result with "Location ไม่ตรงทะเบียน" (F006-T8).
   * Protected: requires 'asset:view' capability
   */
  fastify.get('/verification-rounds/:id', { preHandler: [requireCapability('asset:view')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(invalidRoundId());
    }
    reply.header('Cache-Control', 'no-store');
    const round = await verificationReadService.read(id.trim().toLowerCase());
    if (!round) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Verification Round not found'));
    }
    const canManageVerification = await capabilityService.hasCapability(request.user!.id, 'verification:manage');
    const canCorrectVerification = await capabilityService.hasCapability(request.user!.id, 'verification:correct');
    // "ส่งซ่อม" on a row Found ชำรุด (F006-T7, #125 Q22).
    const canRecordRepair = await capabilityService.hasCapability(request.user!.id, 'repair:record');
    // "ย้าย" on a row with "Location ไม่ตรงทะเบียน" (F006-T8, #125 Q22).
    const canReassign = await capabilityService.hasCapability(request.user!.id, 'assignment:reassign');
    return reply.status(200).send({
      ...round,
      can_manage_verification: canManageVerification,
      can_correct_verification: canCorrectVerification,
      can_record_repair: canRecordRepair,
      can_reassign: canReassign,
    });
  });

  /**
   * GET /verification-rounds/:id/entries
   * A page of the Round's Scope Snapshot, searchable (F006-T1), filtered by result (F006-T2), Discrepancy and
   * snapshot Location (F006-T3), by Late Addition (F006-T5), and by "ยังไม่มี action ต่อ" (F006-T7). The logger names a request by its path, so a search stays out of the logs.
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
