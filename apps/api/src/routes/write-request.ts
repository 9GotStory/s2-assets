import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

// Feature 002's deterministic error shape: a refusal a route replies with itself. Anything thrown past the
// route answers error-handler.ts's envelope instead, { error: { code, message, request_id, details } },
// as a 403 or a 500 does.
export const errorBody = (statusCode: number, code: string, message: string) => ({ statusCode, code, error: code, message });

const RETRY_TOKEN_MAX_LENGTH = 128;

// The retry token of a request, from its header or its body, or why there is none to use.
const retryTokenOf = (
  headers: FastifyRequest['headers'],
  bodyToken: string | undefined
): { token: string } | { refusal: string } => {
  const fromHeader = (headers['x-retry-token'] as string | undefined)?.trim();
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

// A request body once validated, or the answer that refuses it.
export const parseBody = <T>(schema: z.ZodType<T>, request: FastifyRequest): { data: T } | { refusal: ReturnType<typeof errorBody> } => {
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    return { refusal: errorBody(400, 'VALIDATION_FAILED', `Invalid request payload: ${issues}`) };
  }
  return { data: parsed.data };
};

// A write request once validated, with its retry token, or the answer that refuses it.
export const parseWrite = <T extends { retry_token?: string }>(
  schema: z.ZodType<T>,
  request: FastifyRequest
): { data: T; retryToken: string } | { refusal: ReturnType<typeof errorBody> } => {
  const parsed = parseBody(schema, request);
  if ('refusal' in parsed) {
    return parsed;
  }
  const retry = retryTokenOf(request.headers, parsed.data.retry_token);
  return 'refusal' in retry
    ? { refusal: errorBody(400, 'VALIDATION_FAILED', retry.refusal) }
    : { data: parsed.data, retryToken: retry.token };
};
