import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { invalidQueryBody, pageQueryFields, requestableMaterialSearchField, stockMaterialSearchField } from './list-query.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import type { RequestableMaterialReadService } from '../services/requestable-material-read.service.ts';
import {
  RequestableMaterialNameTakenError,
  type AddCompatibleStockMaterialInput,
  type ChangeDetailsInput,
  type CreateRequestableMaterialInput,
  type EndCompatibleStockMaterialInput,
  type RenameInput,
  type RequestableMaterialService,
  type StatusChangeInput,
} from '../services/requestable-material.service.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface RequestableMaterialRoutesOptions {
  requestableMaterialService: RequestableMaterialService;
  requestableMaterialReadService: RequestableMaterialReadService;
  capabilityService: CapabilityService;
}

// #202 Q5: what creating a Requestable Material takes; the service checks each value and names it when refused.
const CreateRequestableMaterialSchema = z
  .object({
    name: z.string(),
    request_unit_id: z.string(),
    whole_number_only: z.boolean().optional(),
    description: z.string().nullable().optional(),
    retry_token: z.string().optional(),
  })
  .strict();

// F009-T2 (#204): adding a Compatible Stock Material, at the version of the Requestable Material the request read.
const AddCompatibleStockMaterialSchema = z
  .object({
    stock_material_id: z.string(),
    expected_version: z.number().int().positive(),
    retry_token: z.string().optional(),
  })
  .strict();

// F009-T2 (#204): ending a Compatible Stock Material, at the version of the Requestable Material the request read.
const EndCompatibleStockMaterialSchema = z
  .object({
    expected_version: z.number().int().positive(),
    retry_token: z.string().optional(),
  })
  .strict();

// F009-T8 (#210): a Rename, at the version the request read; the service checks the name and names it when refused.
const RenameSchema = z
  .object({
    expected_version: z.number().int().positive(),
    name: z.string(),
    retry_token: z.string().optional(),
  })
  .strict();

// F009-T8 (#210): the Other Details, each stated, at the version the request read; the service checks each value.
const ChangeDetailsSchema = z
  .object({
    expected_version: z.number().int().positive(),
    description: z.string().nullable(),
    whole_number_only: z.boolean(),
    request_unit_id: z.string(),
    retry_token: z.string().optional(),
  })
  .strict();

// F009-T7 (#209): making a Requestable Material Inactive or reactivating it, at the version the request read.
const StatusChangeSchema = z
  .object({
    expected_version: z.number().int().positive(),
    retry_token: z.string().optional(),
  })
  .strict();

const RequestableMaterialListQuerySchema = z
  .object({
    search: requestableMaterialSearchField,
    // F009-T7 (#209): ใช้งานอยู่ by default, หยุดใช้, or ทั้งหมด (#202 Q19).
    status: z.enum(['active', 'inactive', 'all']).optional(),
    ...pageQueryFields,
  })
  .strict();

// F009-T2 (#204): the Stock Materials to choose from, found as the Stock Material list finds them.
const StockMaterialChoicesQuerySchema = z
  .object({
    search: stockMaterialSearchField,
    ...pageQueryFields,
  })
  .strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof RequestableMaterialNameTakenError) {
    return { ...errorBody(err.statusCode, err.code, err.message), entry: err.entry };
  }
  if (err instanceof StaleBeforeConflictError) {
    return { ...errorBody(err.statusCode, err.code, err.message), current_values: err.current_values, expected_values: err.expected_values };
  }
  if (err instanceof RetryTokenConflictError || err instanceof NotFoundError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/** F009-T1 (#203): the Requestable Materials (วัสดุสำหรับขอเบิก), kept by the Supply Officer (#202 Q5, Q18, Q19). */
export const requestableMaterialRoutes: FastifyPluginAsync<RequestableMaterialRoutesOptions> = async (fastify, options) => {
  const { requestableMaterialService, requestableMaterialReadService, capabilityService } = options;

  /**
   * GET /requestable-materials
   * The Requestable Materials by name, a page at a time, found by text in the name ignoring case and repeated spaces,
   * the active ones unless a status is asked for (F009-T7), with `can_manage` telling the page whether to offer adding one (#202 P9).
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/requestable-materials', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = RequestableMaterialListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search, status = 'active' } = parsed.data;
    const list = await requestableMaterialReadService.list({ search, status, limit, offset });
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...list, can_manage: canManage });
  });

  /**
   * GET /requestable-materials/:id
   * One Requestable Material with every field and its history (#202 Q17, Q19), and `can_manage` for its actions.
   * Protected: requires 'material:view' capability
   */
  fastify.get('/requestable-materials/:id', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    const requestable = await requestableMaterialReadService.read(id.trim().toLowerCase());
    if (!requestable) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Requestable Material not found'));
    }
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ ...requestable, can_manage: canManage });
  });

  /**
   * GET /requestable-materials/:id/stock-material-choices
   * The active Stock Materials a Supply Officer may add as Compatible Stock Materials, found by text as in the Stock
   * Material list, a page at a time, each saying whether its active Units include the Request Unit (F009-T2, #202 Q19).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.get('/requestable-materials/:id/stock-material-choices', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    const parsed = StockMaterialChoicesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, search } = parsed.data;
    const choices = await requestableMaterialReadService.stockMaterialChoices(id.trim().toLowerCase(), { search, limit, offset });
    if (!choices) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Requestable Material not found'));
    }
    return reply.status(200).send(choices);
  });

  /**
   * POST /requestable-materials
   * Creates a Requestable Material with its Request Unit ("เพิ่มวัสดุสำหรับขอเบิก", F009-T1).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/requestable-materials', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(CreateRequestableMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      return reply.status(201).send(await requestableMaterialService.create(request.user!.id, input as CreateRequestableMaterialInput, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });

  /**
   * POST /requestable-materials/:id/compatible-stock-materials
   * Adds a Compatible Stock Material ("วัสดุที่ใช้จ่ายได้", F009-T2) at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/requestable-materials/:id/compatible-stock-materials', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    const write = parseWrite(AddCompatibleStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await requestableMaterialService.addCompatibleStockMaterial(request.user!.id, id.trim().toLowerCase(), input as AddCompatibleStockMaterialInput, {
        retryToken: write.retryToken,
      });
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
   * POST /requestable-materials/:id/compatible-stock-materials/:stockMaterialId/end
   * Ends a current Compatible Stock Material ("เลิก", F009-T2) at the version the request read; it can be added again.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/requestable-materials/:id/compatible-stock-materials/:stockMaterialId/end', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id, stockMaterialId } = request.params as { id: string; stockMaterialId: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    if (!isValidUuid(stockMaterialId)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const write = parseWrite(EndCompatibleStockMaterialSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await requestableMaterialService.endCompatibleStockMaterial(
        request.user!.id,
        id.trim().toLowerCase(),
        stockMaterialId.trim().toLowerCase(),
        input as EndCompatibleStockMaterialInput,
        { retryToken: write.retryToken }
      );
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
   * POST /requestable-materials/:id/rename
   * Renames the Requestable Material ("เปลี่ยนชื่อ", F009-T8) to fix its spelling, at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/requestable-materials/:id/rename', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    const write = parseWrite(RenameSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await requestableMaterialService.rename(request.user!.id, id.trim().toLowerCase(), input as RenameInput, { retryToken: write.retryToken });
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
   * PUT /requestable-materials/:id/details
   * Changes the Other Details ("แก้ไขข้อมูลอื่น", F009-T8): the description, the whole-number setting and the Request
   * Unit, at the version the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.put('/requestable-materials/:id/details', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
    }
    const write = parseWrite(ChangeDetailsSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      const { retry_token: _retryToken, ...input } = write.data;
      const recorded = await requestableMaterialService.changeDetails(request.user!.id, id.trim().toLowerCase(), input as ChangeDetailsInput, { retryToken: write.retryToken });
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
   * POST /requestable-materials/:id/inactivate, POST /requestable-materials/:id/reactivate
   * Makes the Requestable Material Inactive ("หยุดใช้") or reactivates it ("เปิดใช้อีกครั้ง", F009-T7) at the version
   * the request read.
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  // Each path is written out, so a search for it finds this file (CLAUDE.md, Checks).
  const statusRoutes = [
    ['/requestable-materials/:id/inactivate', 'inactivate'],
    ['/requestable-materials/:id/reactivate', 'reactivate'],
  ] as const;
  for (const [path, action] of statusRoutes) {
    fastify.post(path, { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Requestable Material ID must be a valid UUID string'));
      }
      const write = parseWrite(StatusChangeSchema, request);
      if ('refusal' in write) {
        return reply.status(400).send(write.refusal);
      }
      try {
        const { retry_token: _retryToken, ...input } = write.data;
        const recorded = await requestableMaterialService[action](request.user!.id, id.trim().toLowerCase(), input as StatusChangeInput, { retryToken: write.retryToken });
        return reply.status(200).send(recorded);
      } catch (err) {
        const refusal = refusalOf(err);
        if (!refusal) {
          throw err;
        }
        return reply.status(refusal.statusCode).send(refusal);
      }
    });
  }
};
