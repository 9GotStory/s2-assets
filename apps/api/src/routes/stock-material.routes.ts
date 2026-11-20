import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { hasDisallowedControlChars, hasStrictControlChars } from '../services/control-characters.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import type { StockMaterialReadService } from '../services/stock-material-read.service.ts';
import { ALTERNATE_UNITS_MAX } from '../services/stock-material-units.ts';
import {
  STOCK_MATERIAL_NAME_MAX_LENGTH,
  DuplicateCandidatesFoundError,
  type ChangeDetailsInput,
  type CorrectStockMaterialInput,
  type CreateStockMaterialInput,
  type InactivateStockMaterialInput,
  type ReactivateStockMaterialInput,
  type ReplaceUnitsInput,
  type StockMaterialService,
} from '../services/stock-material.service.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface StockMaterialRoutesOptions {
  stockMaterialService: StockMaterialService;
  stockMaterialReadService: StockMaterialReadService;
  capabilityService: CapabilityService;
}

// #175 Q2, Q5, Q6: what creating a Stock Material takes, its Alternate Units from F008-T3. A factor left out is
// refused by the service, which names the field as the other Unit rules do.
const CreateStockMaterialSchema = z
  .object({
    name: z.string(),
    model: z.string().nullable().optional(),
    specification: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    brand_id: z.string().nullable().optional(),
    material_category_id: z.string().nullable().optional(),
    base_unit: z.object({ unit_id: z.string(), whole_number_only: z.boolean().optional() }).strict(),
    alternate_units: z
      .array(z.object({ unit_id: z.string(), conversion_factor: z.string().nullable().optional(), whole_number_only: z.boolean().optional() }).strict())
      .max(ALTERNATE_UNITS_MAX)
      .optional(),
    // F008-T6 (#182 decision 1): a decimal string in the Base Unit, which the service checks.
    minimum_stock: z.string().nullable().optional(),
    // F008-T5 (#181): "เป็นคนละรายการ", confirming the Duplicate Candidates a warning listed (#175 P4).
    explicit_continuation: z.boolean().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// F008-T5 (#181, #175 P4): a name to look up Duplicate Candidates of, as a Stock Material's name is written (P7), and a
// Stock Material to leave out, such as the one a Material Correction corrects.
const DuplicateCandidatesQuerySchema = z
  .object({
    name: z
      .string()
      .refine((name) => !hasStrictControlChars(name), 'must not contain control characters')
      .transform((name) => name.trim())
      .refine((name) => name.length > 0, 'must not be blank')
      .refine((name) => name.length <= STOCK_MATERIAL_NAME_MAX_LENGTH, `must be at most ${STOCK_MATERIAL_NAME_MAX_LENGTH} characters`),
    exclude_stock_material_id: z
      .string()
      .refine(isValidUuid, 'must be a valid UUID')
      .transform((id) => id.trim().toLowerCase())
      .optional(),
  })
  .strict();

// F008-T3 (#178, #175 P2): the whole Unit set a Units write leaves. It replaces the set, so each Unit says its
// whole-number rule and whether it is active; the Base Unit is always active.
const ReplaceUnitsSchema = z
  .object({
    expected_version: z.number().int().positive(),
    base_unit: z.object({ unit_id: z.string(), whole_number_only: z.boolean() }).strict(),
    alternate_units: z
      .array(z.object({ unit_id: z.string(), conversion_factor: z.string().nullable().optional(), whole_number_only: z.boolean(), is_active: z.boolean() }).strict())
      .max(ALTERNATE_UNITS_MAX),
    // F008-T6 (#182 decision 2): the Minimum Stock in the new Base Unit, stated only when the Base Unit changes.
    minimum_stock: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// F008-T4 (#179, #175 Q11): the other details a write changes without a reason, each stated, null for none. The
// name, the Brand, the Model and the Specification change only through a Material Correction (F008-T5).
const ChangeDetailsSchema = z
  .object({
    expected_version: z.number().int().positive(),
    material_category_id: z.string().nullable(),
    note: z.string().nullable(),
    // F008-T6 (#182): a decimal string in the Base Unit, which the service checks and names when refused.
    minimum_stock: z.string().nullable(),
    retry_token: z.string().optional(),
  })
  .strict();

// F008-T5 (#181, #175 Q11): a Material Correction: the identity as it should have been recorded, each value stated,
// null for none, with the reason, which the service checks and names when refused.
const CorrectStockMaterialSchema = z
  .object({
    expected_version: z.number().int().positive(),
    name: z.string(),
    brand_id: z.string().nullable(),
    model: z.string().nullable(),
    specification: z.string().nullable(),
    reason: z.string(),
    // "เป็นคนละรายการ", confirming the Duplicate Candidates a warning listed (#175 P4).
    explicit_continuation: z.boolean().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// F008-T7 (#180, #175 Q13): making a Stock Material Inactive, with an optional note the service checks (P7).
const InactivateStockMaterialSchema = z
  .object({
    expected_version: z.number().int().positive(),
    note: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// F008-T7 (#180): reactivating an Inactive Stock Material takes no note (0025_material_catalog).
const ReactivateStockMaterialSchema = z
  .object({
    expected_version: z.number().int().positive(),
    retry_token: z.string().optional(),
  })
  .strict();

const StockMaterialListQuerySchema = z
  .object({
    // It searches the Specification, which is free text, so it keeps tab and line breaks inside it as that field
    // does and refuses the rest (CODING_STANDARDS.md).
    search: z
      .string()
      .refine((text) => !hasDisallowedControlChars(text), 'must not contain control characters')
      .refine((text) => Buffer.byteLength(text, 'utf8') <= 4096, 'must be at most 4096 bytes')
      .transform((text) => text.trim())
      .refine((text) => text.length > 0, 'must not be blank')
      .optional(),
    // F008-T4 (#179): a Material Category, or "none" for the Stock Materials with none (#175 Q3).
    material_category_id: z
      .string()
      .refine((value) => value === 'none' || isValidUuid(value), 'must be a valid UUID or "none"')
      // PostgreSQL reads a UUID in either case but refuses spaces around it.
      .transform((value) => value.trim())
      .optional(),
    // F008-T6 (#182): the Stock Materials with a Minimum Stock set, or still without one (#175 MC-20).
    minimum_stock: z.enum(['set', 'not_set']).optional(),
    // F008-T7 (#180): ใช้งานอยู่ by default, หยุดใช้, or ทั้งหมด (#175 MC-14, Q13).
    status: z.enum(['active', 'inactive', 'all']).optional(),
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  // F008-T5 (#181): Feature 002's DUPLICATE_CANDIDATES_FOUND, with the candidates to confirm.
  if (err instanceof DuplicateCandidatesFoundError) {
    return { ...errorBody(err.statusCode, err.code, err.message), ...err.found };
  }
  if (err instanceof StaleBeforeConflictError) {
    return { ...errorBody(err.statusCode, err.code, err.message), current_values: err.current_values, expected_values: err.expected_values };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/** F008-T1 (#176): the Stock Material catalog (วัสดุ), kept by the Supply Officer (#175 Q1, Q15). */
export const stockMaterialRoutes: FastifyPluginAsync<StockMaterialRoutesOptions> = async (fastify, options) => {
  const { stockMaterialService, stockMaterialReadService, capabilityService } = options;

  /**
   * GET /stock-materials
   * The Stock Materials by name, a page at a time, found by text in the name, the Brand's name, the Model or the
   * Specification, by Material Category (F008-T4), by whether a Minimum Stock is set (F008-T6) and by status, those in use
   * by default (F008-T7), with `can_manage` telling the page whether to offer "เพิ่มวัสดุ" (#175 P9).
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/stock-materials', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = StockMaterialListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search, material_category_id, minimum_stock, status = 'active' } = parsed.data;
    const list = await stockMaterialReadService.list({ search, material_category_id, minimum_stock, status, limit, offset });
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...list, can_manage: canManage });
  });

  /**
   * GET /stock-materials/duplicate-candidates
   * The Duplicate Candidates (รายการที่อาจซ้ำ) of a name, leaving out a Stock Material when one is given (F008-T5).
   * Protected: requires 'material:view' capability
   */
  fastify.get('/stock-materials/duplicate-candidates', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = DuplicateCandidatesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { name, exclude_stock_material_id: excludedId = null } = parsed.data;
    return reply.status(200).send(await stockMaterialReadService.duplicateCandidates(name, excludedId));
  });

  /**
   * GET /stock-materials/:id
   * One Stock Material with its Units and its history (#175 Q15, Q18), and `can_manage`, `can_inactivate` and
   * `can_reactivate` for its actions.
   * Protected: requires 'material:view' capability
   */
  fastify.get('/stock-materials/:id', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const material = await stockMaterialReadService.read(id.trim().toLowerCase());
    if (!material) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Stock Material not found'));
    }
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    // F008-T7 (#180, #175 P9): "หยุดใช้" on a Stock Material in use, "เปิดใช้อีกครั้ง" on an Inactive one.
    return reply.status(200).send({ ...material, can_manage: canManage, can_inactivate: canManage && material.is_active, can_reactivate: canManage && !material.is_active });
  });

  /**
   * POST /stock-materials
   * Creates a Stock Material with its Base Unit ("เพิ่มวัสดุ", F008-T1).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/stock-materials', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(CreateStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await stockMaterialService.create(request.user!.id, input as CreateStockMaterialInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /stock-materials/:id/corrections
   * A Material Correction ("แก้ไขรายการที่บันทึกผิด", F008-T5) of the name, Brand, Model or Specification, with a reason, at
   * the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/stock-materials/:id/corrections', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const write = parseWrite(CorrectStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await stockMaterialService.correct(request.user!.id, id.trim().toLowerCase(), input as CorrectStockMaterialInput, { retryToken: write.retryToken });
      return reply.status(200).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * PUT /stock-materials/:id/details
   * Changes the Stock Material's Material Category and note at the version the request read ("แก้ไขข้อมูลอื่น", F008-T4).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.put('/stock-materials/:id/details', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const write = parseWrite(ChangeDetailsSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await stockMaterialService.changeDetails(request.user!.id, id.trim().toLowerCase(), input as ChangeDetailsInput, { retryToken: write.retryToken });
      return reply.status(200).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * PUT /stock-materials/:id/units
   * Replaces the Stock Material's whole Unit set at the version the request read ("แก้ไขหน่วยนับ", F008-T3).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.put('/stock-materials/:id/units', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const write = parseWrite(ReplaceUnitsSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await stockMaterialService.replaceUnits(request.user!.id, id.trim().toLowerCase(), input as ReplaceUnitsInput, { retryToken: write.retryToken });
      return reply.status(200).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /stock-materials/:id/inactivate
   * Makes the Stock Material Inactive ("หยุดใช้", F008-T7), with an optional note, at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/stock-materials/:id/inactivate', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const write = parseWrite(InactivateStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await stockMaterialService.inactivate(request.user!.id, id.trim().toLowerCase(), input as InactivateStockMaterialInput, { retryToken: write.retryToken });
      return reply.status(200).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /stock-materials/:id/reactivate
   * Reactivates an Inactive Stock Material ("เปิดใช้อีกครั้ง", F008-T7) at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/stock-materials/:id/reactivate', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const write = parseWrite(ReactivateStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await stockMaterialService.reactivate(request.user!.id, id.trim().toLowerCase(), input as ReactivateStockMaterialInput, { retryToken: write.retryToken });
      return reply.status(200).send(recorded);
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });
};
