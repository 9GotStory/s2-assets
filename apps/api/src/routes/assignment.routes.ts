import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { initialAssignmentFields } from './asset.routes.ts';
import {
  NotFoundError,
  RetryTokenConflictError,
  StaleBeforeConflictError,
  ValidationError,
} from '../services/asset.service.ts';
import { AssignmentRecordingService, type RecordAssignmentInput } from '../services/assignment-recording.service.ts';
import { isValidUuid } from '../services/capability.service.ts';

export interface AssignmentRoutesOptions {
  assignmentRecordingService: AssignmentRecordingService;
}

const RecordAssignmentSchema = z
  .object({
    kind: z.enum(['INITIAL', 'REASSIGNMENT']),
    expected_assignment_version: z.number().int().min(0),
    retry_token: z.string().optional(),
    ...initialAssignmentFields,
  })
  .strict();

// Feature 002's deterministic error shape.
const errorBody = (statusCode: number, code: string, message: string) => ({ statusCode, code, error: code, message });

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
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

const RETRY_TOKEN_MAX_LENGTH = 128;

// The retry token of a request, from its header or its body as in Feature 002's correction, or why
// there is none to use.
const retryTokenOf = (
  headers: FastifyRequest['headers'],
  bodyToken: string | undefined
): { token: string } | { refusal: string } => {
  const fromHeader = ((headers['idempotency-key'] || headers['x-retry-token']) as string | undefined)?.trim();
  const fromBody = bodyToken?.trim();
  if (fromHeader && fromBody && fromHeader !== fromBody) {
    return { refusal: 'Conflicting retry token values between header and body' };
  }
  const token = fromHeader || fromBody;
  if (!token || token.length > RETRY_TOKEN_MAX_LENGTH) {
    return { refusal: `A retry token is required: a nonblank string of at most ${RETRY_TOKEN_MAX_LENGTH} characters` };
  }
  return { token };
};

export const assignmentRoutes: FastifyPluginAsync<AssignmentRoutesOptions> = async (fastify, options) => {
  const { assignmentRecordingService } = options;

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

    const parsed = RecordAssignmentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
      return reply.status(400).send(errorBody(400, 'VALIDATION_FAILED', `Invalid request payload: ${issues}`));
    }

    const retry = retryTokenOf(request.headers, parsed.data.retry_token);
    if ('refusal' in retry) {
      return reply.status(400).send(errorBody(400, 'VALIDATION_FAILED', retry.refusal));
    }

    try {
      const result = await assignmentRecordingService.record(
        request.user!.id,
        id.trim().toLowerCase(),
        parsed.data as RecordAssignmentInput,
        { retryToken: retry.token }
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
};
