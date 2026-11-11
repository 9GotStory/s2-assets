import { z } from 'zod';
import { errorBody } from './write-request.ts';

// A page of a list, read as on the Asset list: at most 100 rows from a canonical offset.
export const pageQueryFields = {
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
};

// The answer to a list query that does not parse, naming each field it failed on.
export const invalidQueryBody = (error: z.ZodError) =>
  errorBody(400, 'VALIDATION_FAILED', `Invalid query: ${error.issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`).join(', ')}`);
