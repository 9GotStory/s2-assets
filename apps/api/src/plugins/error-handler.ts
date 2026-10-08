import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export interface StandardApiError {
  code: string;
  message: string;
  request_id: string;
  details: Record<string, unknown>;
}

export interface StandardErrorEnvelope {
  error: StandardApiError;
}

const STATUS_CODE_TO_DEFAULT_ERROR_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const STATUS_CODE_TO_DEFAULT_MESSAGE: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  402: 'Payment required',
  403: 'Permission denied',
  404: 'Requested resource not found',
  405: 'Method not allowed',
  406: 'Not acceptable',
  408: 'Request timeout',
  409: 'Conflict',
  410: 'Resource gone',
  415: 'Unsupported media type',
  422: 'Unprocessable entity',
  429: 'Too many requests',
  500: 'An unexpected internal server error occurred.',
  503: 'Service temporarily unavailable.',
};

export function isSensitiveContent(text: string): boolean {
  return (
    /at\s+[a-zA-Z0-9_.]+\s+\(/.test(text) ||
    /\/home\//i.test(text) ||
    /\/usr\/|\/var\/|\/tmp\//i.test(text) ||
    /node_modules/i.test(text) ||
    /\.(ts|js):\d+/i.test(text) ||
    /SELECT\s+|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|QueryFailedError|PostgresDialect/i.test(text) ||
    /postgres(ql)?:\/\//i.test(text) ||
    /Bearer\s+/i.test(text) ||
    /cookie/i.test(text) ||
    /password/i.test(text) ||
    /secret/i.test(text) ||
    /token/i.test(text)
  );
}

export function extractValidationDetails(
  error: unknown,
  request?: FastifyRequest
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const err = error as Record<string, any>;

  // 1. Process Fastify AJV validation results
  if (Array.isArray(err?.validation)) {
    for (const item of err.validation) {
      if (!item || typeof item !== 'object') continue;
      let field = '';
      if (item.params?.missingProperty && typeof item.params.missingProperty === 'string') {
        field = item.params.missingProperty;
      } else if (item.instancePath && typeof item.instancePath === 'string') {
        field = item.instancePath.replace(/^\//, '').replace(/\//g, '.');
      } else if (item.dataPath && typeof item.dataPath === 'string') {
        field = item.dataPath.replace(/^\./, '');
      }

      if (field) {
        if (item.keyword === 'required') {
          details[field] = 'Required field missing';
        } else if (typeof item.message === 'string' && item.message.length > 0 && !isSensitiveContent(item.message)) {
          details[field] = item.message;
        } else {
          details[field] = 'Invalid value';
        }
      }
    }
  }

  // 2. Process Zod issues if present
  if (Array.isArray(err?.issues)) {
    for (const issue of err.issues) {
      if (!issue || typeof issue !== 'object') continue;
      const field = Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : 'root';
      const msg = typeof issue.message === 'string' && !isSensitiveContent(issue.message)
        ? issue.message
        : 'Invalid value';
      details[field] = msg;
    }
  }

  // 3. Inspect schema for missing required properties when Fastify schema validation aborted on first error
  const validationContext = (err?.validationContext || 'body') as 'body' | 'query' | 'params' | 'headers';
  const schemaObj = (request?.routeOptions?.schema as any)?.[validationContext];
  if (schemaObj && typeof schemaObj === 'object' && Array.isArray(schemaObj.required)) {
    const data = (request && typeof (request as any)[validationContext] === 'object' && (request as any)[validationContext] !== null)
      ? (request as any)[validationContext]
      : {};

    for (const prop of schemaObj.required) {
      if (typeof prop === 'string' && !(prop in details)) {
        if (data[prop] === undefined || data[prop] === null || data[prop] === '') {
          details[prop] = 'Required field missing';
        }
      }
    }
  }

  return details;
}

export function resolveRequestId(request: FastifyRequest): string {
  const header = request?.headers?.['x-request-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  if (Array.isArray(header) && header.length > 0 && typeof header[0] === 'string' && header[0].trim().length > 0) {
    return header[0].trim();
  }
  if (typeof request?.id === 'string' && request.id.length > 0) {
    return request.id;
  }
  return '';
}

export async function errorHandler(
  error: FastifyError | (Error & { statusCode?: number; code?: string; validation?: unknown[]; validationContext?: string }),
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const err = error as Record<string, any>;

  const isValidationError = Boolean(
    err?.validation !== undefined ||
    err?.code === 'FST_ERR_VALIDATION' ||
    err?.name === 'ZodError' ||
    Array.isArray(err?.issues) ||
    err?.code === 'VALIDATION_FAILED'
  );

  const rawStatus = err?.statusCode ?? err?.status;
  let statusCode = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (isValidationError && statusCode === 500) {
    statusCode = 400;
  }

  let code: string;
  if (isValidationError) {
    code = (err?.code && typeof err.code === 'string' && !err.code.startsWith('FST_ERR_') && err.code !== 'VALIDATION_FAILED')
      ? err.code
      : 'VALIDATION_FAILED';
  } else if (err?.code && typeof err.code === 'string' && !err.code.startsWith('FST_ERR_') && !/^\d+$/.test(err.code)) {
    code = err.code;
  } else {
    code = STATUS_CODE_TO_DEFAULT_ERROR_CODE[statusCode] || (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');
  }

  let message: string;
  if (isValidationError) {
    message = 'The provided request data is invalid.';
  } else if (statusCode >= 500) {
    if (statusCode === 503) {
      message = STATUS_CODE_TO_DEFAULT_MESSAGE[503];
    } else {
      message = STATUS_CODE_TO_DEFAULT_MESSAGE[500];
    }
  } else {
    const rawMessage = typeof err?.message === 'string' ? err.message.trim() : '';
    if (rawMessage.length > 0 && !isSensitiveContent(rawMessage)) {
      message = rawMessage;
    } else {
      message = STATUS_CODE_TO_DEFAULT_MESSAGE[statusCode] || 'Request failed';
    }
  }

  const requestId = resolveRequestId(request);

  const details = isValidationError ? extractValidationDetails(error, request) : {};

  const envelope: StandardErrorEnvelope = {
    error: {
      code,
      message,
      request_id: requestId,
      details,
    },
  };

  await reply.status(statusCode).type('application/json; charset=utf-8').send(envelope);
}

export const errorHandlerPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.setErrorHandler(errorHandler);
};

// Ensure Fastify plugin encapsulates globally across encapsulation scopes
(errorHandlerPlugin as any)[Symbol.for('skip-override')] = true;
