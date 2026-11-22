import { z } from 'zod';
import { errorBody } from './write-request.ts';
import { hasDisallowedControlChars, hasStrictControlChars } from '../services/control-characters.ts';
import { REQUESTABLE_MATERIAL_NAME_MAX_LENGTH } from '../services/requestable-material.service.ts';

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

// A search of the Requestable Material list. It searches the name, which is one line, so it refuses every control
// character as the name does (CODING_STANDARDS.md). F009-T4 (#206): the Requester's search of the offered ones too.
export const requestableMaterialSearchField = z
  .string()
  .refine((text) => !hasStrictControlChars(text), 'must not contain control characters')
  .transform((text) => text.trim())
  .refine((text) => text.length > 0, 'must not be blank')
  .refine((text) => text.length <= REQUESTABLE_MATERIAL_NAME_MAX_LENGTH, `must be at most ${REQUESTABLE_MATERIAL_NAME_MAX_LENGTH} characters`)
  .optional();

// A search of the Stock Material list. It searches the Specification, which is free text, so it keeps tab and line
// breaks inside it as that field does and refuses the rest (CODING_STANDARDS.md). F009-T2 (#204): the Stock
// Materials a Requestable Material may choose from are found the same way.
export const stockMaterialSearchField = z
  .string()
  .refine((text) => !hasDisallowedControlChars(text), 'must not contain control characters')
  .refine((text) => Buffer.byteLength(text, 'utf8') <= 4096, 'must be at most 4096 bytes')
  .transform((text) => text.trim())
  .refine((text) => text.length > 0, 'must not be blank')
  .optional();
