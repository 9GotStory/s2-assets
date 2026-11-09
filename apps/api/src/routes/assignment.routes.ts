import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { assignmentFactFields } from './asset.routes.ts';
import { errorBody, parseBody, parseWrite } from './write-request.ts';
import {
  NotFoundError,
  RetryTokenConflictError,
  StaleBeforeConflictError,
  ValidationError,
} from '../services/asset.service.ts';
import { AssignmentConflictWarningError } from '../services/assignment-conflict.ts';
import { AssignmentCorrectionService, type CorrectAssignmentInput } from '../services/assignment-correction.service.ts';
import { AssignmentRecordingService, type RecordAssignmentInput } from '../services/assignment-recording.service.ts';
import {
  BulkReassignmentService,
  InitialAssignmentRequiredError,
  type BulkReassignmentInput,
  type BulkReassignmentPreviewInput,
} from '../services/bulk-reassignment.service.ts';
import { isValidUuid } from '../services/capability.service.ts';

export interface AssignmentRoutesOptions {
  assignmentRecordingService: AssignmentRecordingService;
  assignmentCorrectionService: AssignmentCorrectionService;
  bulkReassignmentService: BulkReassignmentService;
}

const expectedVersionField = { expected_assignment_version: z.number().int().min(0) };

// What every assignment write carries besides its facts: its retry token, and whether it confirms the
// Assignment Conflicts it would create.
const writeControlFields = {
  retry_token: z.string().optional(),
  explicit_continuation: z.boolean().optional(),
};

// A write of one Asset's facts also carries the version it was made against.
const assignmentWriteFields = { ...expectedVersionField, ...writeControlFields };

const RecordAssignmentSchema = z
  .object({
    kind: z.enum(['INITIAL', 'REASSIGNMENT']),
    ...assignmentWriteFields,
    ...assignmentFactFields,
  })
  .strict();

// A value of an amended dimension: its entry and its Legacy text, either or both of which may be left empty.
const AmendedValueSchema = z
  .object({
    entry_id: z.string().nullable().optional(),
    legacy_text: z.string().nullable().optional(),
  })
  .strict();

// null removes the dimension from the fact; a side left out stays as it is.
const AmendedDimensionSchema = z
  .object({ prior: AmendedValueSchema.optional(), new: AmendedValueSchema.optional() })
  .strict()
  .nullable()
  .optional();

const correctionFields = {
  ...assignmentWriteFields,
  reason: z.string().nullable().optional(),
};

const CorrectAssignmentSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('VOID'), ...correctionFields }).strict(),
  z
    .object({
      action: z.literal('AMEND'),
      ...correctionFields,
      effective_date: z.string().nullable().optional(),
      document_reference: z.string().nullable().optional(),
      remark: z.string().nullable().optional(),
      changes: z
        .object({
          location: AmendedDimensionSchema,
          organization_unit: AmendedDimensionSchema,
          responsible_person: AmendedDimensionSchema,
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

// F003-T5 (#55): one set of facts for many Assets. The preview reads each Asset's version, and the
// write carries the versions it read.
const BulkReassignmentPreviewSchema = z.object({ asset_ids: z.array(z.string()), ...assignmentFactFields }).strict();

const BulkReassignmentSchema = z
  .object({
    assets: z.array(z.object({ asset_id: z.string(), ...expectedVersionField }).strict()),
    ...assignmentFactFields,
    ...writeControlFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof StaleBeforeConflictError) {
    return {
      ...errorBody(err.statusCode, err.code, err.message),
      current_values: err.current_values,
      expected_values: err.expected_values,
    };
  }
  if (err instanceof AssignmentConflictWarningError) {
    return { ...errorBody(err.statusCode, err.code, err.message), conflicts: err.conflicts };
  }
  if (err instanceof InitialAssignmentRequiredError) {
    return { ...errorBody(err.statusCode, err.code, err.message), assets: err.assets };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

export const assignmentRoutes: FastifyPluginAsync<AssignmentRoutesOptions> = async (fastify, options) => {
  const { assignmentRecordingService, assignmentCorrectionService, bulkReassignmentService } = options;

  /**
   * POST /:id/assignments
   * Records an Initial Assignment or a Reassignment for one Asset (F003-T2).
   * Protected: requires 'assignment:reassign' capability (Asset Custodian)
   */
  fastify.post('/:id/assignments', { preHandler: [requireCapability('assignment:reassign')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Asset ID must be a valid UUID string'));
    }

    const write = parseWrite(RecordAssignmentSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const result = await assignmentRecordingService.record(
        request.user!.id,
        id.trim().toLowerCase(),
        write.data as RecordAssignmentInput,
        { retryToken: write.retryToken }
      );
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
   * POST /bulk-reassignments/preview
   * What a Bulk Reassignment would do, saving nothing (F003-T5).
   * Protected: requires 'assignment:reassign' capability (Asset Custodian)
   */
  fastify.post('/bulk-reassignments/preview', { preHandler: [requireCapability('assignment:reassign')] }, async (request, reply) => {
    const body = parseBody(BulkReassignmentPreviewSchema, request);
    if ('refusal' in body) {
      return reply.status(400).send(body.refusal);
    }

    try {
      return reply.status(200).send(await bulkReassignmentService.preview(request.user!.id, body.data as BulkReassignmentPreviewInput));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /bulk-reassignments
   * Records one Reassignment for up to 100 Assets, all of it or none (F003-T5).
   * Protected: requires 'assignment:reassign' capability (Asset Custodian)
   */
  fastify.post('/bulk-reassignments', { preHandler: [requireCapability('assignment:reassign')] }, async (request, reply) => {
    const write = parseWrite(BulkReassignmentSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }

    try {
      const result = await bulkReassignmentService.record(request.user!.id, write.data as BulkReassignmentInput, {
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
   * POST /:id/assignments/:eventId/corrections
   * Fixes one assignment fact that was recorded wrong (F003-T3).
   * Protected: requires 'assignment:correct' capability (Asset Custodian, Administrator)
   */
  fastify.post(
    '/:id/assignments/:eventId/corrections',
    { preHandler: [requireCapability('assignment:correct')] },
    async (request, reply) => {
      const { id, eventId } = request.params as { id: string; eventId: string };
      if (!isValidUuid(id) || !isValidUuid(eventId)) {
        return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Asset and event IDs must be valid UUID strings'));
      }

      const write = parseWrite(CorrectAssignmentSchema, request);
      if ('refusal' in write) {
        return reply.status(400).send(write.refusal);
      }

      try {
        const result = await assignmentCorrectionService.correct(
          request.user!.id,
          id.trim().toLowerCase(),
          eventId.trim().toLowerCase(),
          write.data as CorrectAssignmentInput,
          { retryToken: write.retryToken }
        );
        return reply.status(201).send(result);
      } catch (err) {
        const refusal = refusalOf(err);
        if (!refusal) {
          throw err;
        }
        return reply.status(refusal.statusCode).send(refusal);
      }
    }
  );
};
