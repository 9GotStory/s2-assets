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

export const STANDARD_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'NOT_ACCEPTABLE',
  'REQUEST_TIMEOUT',
  'CONFLICT',
  'GONE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_ENTITY',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
  'NOT_IMPLEMENTED',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'VALIDATION_FAILED',
]);

export const APPROVED_CUSTOM_ERROR_CODES = new Set([
  'USER_ALREADY_EXISTS',
  'INVALID_CREDENTIALS',
  'USER_NOT_FOUND',
  'USER_DISABLED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'SESSION_NOT_FOUND',
  'INSUFFICIENT_PERMISSIONS',
  'RESOURCE_CONFLICT',
  'RATE_LIMIT_EXCEEDED',
  'CSRF_TOKEN_INVALID',
  'DATABASE_ERROR',
]);

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

export const SAFE_ERROR_MESSAGES = new Set([
  'The provided request data is invalid.',
  'Bad request',
  'Malformed request parameters',
  'Authentication required',
  'Permission denied',
  'Requested resource not found',
  'Resource not found',
  'Method not allowed',
  'Not acceptable',
  'Request timeout',
  'Conflict',
  'User already active',
  'User already exists',
  'Resource gone',
  'Unsupported media type',
  'Unprocessable entity',
  'Too many requests',
  'An unexpected internal server error occurred.',
  'Service temporarily unavailable.',
  'Gateway timeout',
]);

export const ALLOWLISTED_VALIDATION_DESCRIPTIONS = new Set([
  'Required field missing',
  'Invalid value',
  'Invalid type',
  'Invalid format',
  'Minimum length requirement not met',
  'Maximum length requirement not met',
  'Value out of range',
  'Field not allowed',
]);

const KEYWORD_TO_DESCRIPTION_MAP: Record<string, string> = {
  required: 'Required field missing',
  minLength: 'Minimum length requirement not met',
  maxLength: 'Maximum length requirement not met',
  type: 'Invalid type',
  format: 'Invalid format',
  pattern: 'Invalid format',
  minimum: 'Value out of range',
  maximum: 'Value out of range',
  exclusiveMinimum: 'Value out of range',
  exclusiveMaximum: 'Value out of range',
  additionalProperties: 'Field not allowed',
  enum: 'Invalid value',
};

const ERROR_CODE_FORMAT = /^[A-Z][A-Z0-9_]{1,63}$/;
const DISALLOWED_CODE_PREFIXES = ['FST_', 'ERR_', 'NODE_', 'PG_', 'SQL_'];
const SENSITIVE_CODE_KEYWORDS = [
  'SECRET',
  'PASSWORD',
  'TOKEN',
  'KEY',
  'CREDENTIAL',
  'DATABASE',
  'URL',
  'POSTGRES',
  'STACK',
  'INTERNAL',
  'QUERY',
];

export function isTrustedErrorCode(code: unknown): code is string {
  if (typeof code !== 'string') return false;

  if (STANDARD_ERROR_CODES.has(code) || APPROVED_CUSTOM_ERROR_CODES.has(code)) {
    return true;
  }

  if (!ERROR_CODE_FORMAT.test(code)) {
    return false;
  }

  for (const prefix of DISALLOWED_CODE_PREFIXES) {
    if (code.startsWith(prefix)) {
      return false;
    }
  }

  for (const keyword of SENSITIVE_CODE_KEYWORDS) {
    if (code.includes(keyword)) {
      return false;
    }
  }

  return true;
}

export function sanitizeFieldName(rawField: string): string {
  const field = rawField.trim();
  if (/^[a-zA-Z0-9_.[\]-]+$/.test(field) && field.length <= 64) {
    return field;
  }
  return 'invalid_field';
}

export function resolveValidationDescription(keyword?: string, rawMessage?: string): string {
  if (keyword && KEYWORD_TO_DESCRIPTION_MAP[keyword]) {
    return KEYWORD_TO_DESCRIPTION_MAP[keyword];
  }
  if (rawMessage && ALLOWLISTED_VALIDATION_DESCRIPTIONS.has(rawMessage)) {
    return rawMessage;
  }
  return 'Invalid value';
}

export function extractValidationDetails(
  error: unknown,
  request?: FastifyRequest
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const err = error as Record<string, any>;

  // 1. Process Fastify AJV validation results with strictly allowlisted descriptions
  if (Array.isArray(err?.validation)) {
    for (const item of err.validation) {
      if (!item || typeof item !== 'object') continue;
      let rawField = '';
      if (item.params?.missingProperty && typeof item.params.missingProperty === 'string') {
        rawField = item.params.missingProperty;
      } else if (item.instancePath && typeof item.instancePath === 'string') {
        rawField = item.instancePath.replace(/^\//, '').replace(/\//g, '.');
      } else if (item.dataPath && typeof item.dataPath === 'string') {
        rawField = item.dataPath.replace(/^\./, '');
      }

      const field = rawField ? sanitizeFieldName(rawField) : 'invalid_field';
      const description = resolveValidationDescription(item.keyword, item.message);
      details[field] = description;
    }
  }

  // 2. Process Zod issues if present with strictly allowlisted descriptions
  if (Array.isArray(err?.issues)) {
    for (const issue of err.issues) {
      if (!issue || typeof issue !== 'object') continue;
      const rawField = Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : 'root';
      const field = sanitizeFieldName(rawField);
      let description = 'Invalid value';
      if (issue.code === 'invalid_type') {
        description = 'Invalid type';
      } else if (issue.code === 'too_small') {
        description = 'Minimum length requirement not met';
      } else if (issue.code === 'too_big') {
        description = 'Maximum length requirement not met';
      } else if (issue.code === 'invalid_string') {
        description = 'Invalid format';
      } else if (typeof issue.message === 'string' && ALLOWLISTED_VALIDATION_DESCRIPTIONS.has(issue.message)) {
        description = issue.message;
      }
      details[field] = description;
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
      if (typeof prop === 'string') {
        const safeProp = sanitizeFieldName(prop);
        if (!(safeProp in details)) {
          if (data[prop] === undefined || data[prop] === null || data[prop] === '') {
            details[safeProp] = 'Required field missing';
          }
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
    code = 'VALIDATION_FAILED';
  } else if (isTrustedErrorCode(err?.code)) {
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
    if (SAFE_ERROR_MESSAGES.has(rawMessage)) {
      message = rawMessage;
    } else {
      message = STATUS_CODE_TO_DEFAULT_MESSAGE[statusCode] || 'Bad request';
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
