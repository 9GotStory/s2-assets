import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import { isValidUuid, type CapabilityService } from '../services/capability.service.ts';
import { CATALOG_LISTS, type CatalogListKind } from '../services/catalog-list-entries.ts';
import { CatalogListNameTakenError, type CatalogListEntry, type CatalogListService } from '../services/catalog-list.service.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface CatalogListRoutesOptions {
  catalogListService: CatalogListService;
  capabilityService: CapabilityService;
}

const AddEntrySchema = z.object({ name: z.string(), retry_token: z.string().optional() }).strict();

// F008-T8 (#183): renaming an entry at the version the request read (#175 Q19, Q23).
const RenameEntrySchema = z.object({ expected_version: z.number().int().positive(), name: z.string(), retry_token: z.string().optional() }).strict();

// F008-T8 (#183): making an entry Inactive or reactivating it, at the version the request read (#175 Q21, Q23).
const StatusEntrySchema = z.object({ expected_version: z.number().int().positive(), retry_token: z.string().optional() }).strict();

// Each list's path.
const PATHS: Record<CatalogListKind, string> = { unit: '/units', brand: '/brands', 'material-category': '/material-categories' };

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof CatalogListNameTakenError) {
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

// What a write to an existing entry answers: the entry it wrote, or its refusal (CODING_STANDARDS, "Helpers decide,
// handlers reply").
const outcomeOf = async (write: () => Promise<CatalogListEntry>): Promise<{ statusCode: number; body: unknown }> => {
  try {
    return { statusCode: 200, body: await write() };
  } catch (err) {
    const refusal = refusalOf(err);
    if (!refusal) {
      throw err;
    }
    return { statusCode: refusal.statusCode, body: refusal };
  }
};

/**
 * The lists of the Stock Material catalog (#175 Q3, Q4, Q5, P5): the shared Unit list (หน่วยนับ, F008-T1), and the Brand
 * (ยี่ห้อ) and Material Category (หมวดวัสดุ) lists (F008-T4).
 */
export const catalogListRoutes: FastifyPluginAsync<CatalogListRoutesOptions> = async (fastify, options) => {
  const { catalogListService, capabilityService } = options;

  for (const [kind, path] of Object.entries(PATHS) as [CatalogListKind, string][]) {
    /**
     * GET /units, GET /brands, GET /material-categories
     * Every entry, Inactive ones included, by name, with `can_manage` telling the page whether to offer adding one.
     * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
     */
    fastify.get(path, { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const items = await catalogListService.list(kind);
      const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
      return reply.status(200).send({ items, can_manage: canManage });
    });

    /**
     * POST /units, POST /brands, POST /material-categories
     * Adds an entry, from the Stock Material form or the maintenance page (#175 Q15, P5).
     * Protected: requires 'material:manage' capability (Supply Officer)
     */
    fastify.post(path, { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
      const write = parseWrite(AddEntrySchema, request);
      if ('refusal' in write) {
        return reply.status(400).send(write.refusal);
      }
      try {
        return reply.status(201).send(await catalogListService.add(request.user!.id, kind, write.data.name, { retryToken: write.retryToken }));
      } catch (err) {
        const refusal = refusalOf(err);
        if (!refusal) {
          throw err;
        }
        return reply.status(refusal.statusCode).send(refusal);
      }
    });

    /**
     * POST /units/:id/rename, POST /brands/:id/rename, POST /material-categories/:id/rename
     * Renames an entry to normalize its spelling, at the version the request read (F008-T8, #175 Q19, Q23).
     * Protected: requires 'material:manage' capability (Supply Officer)
     */
    fastify.post(`${path}/:id/rename`, { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
      const write = parseEntryWrite(RenameEntrySchema, request);
      if ('refusal' in write) {
        return reply.status(write.refusal.statusCode).send(write.refusal);
      }
      const { retry_token: _retryToken, ...input } = write.data;
      const { statusCode, body } = await outcomeOf(() => catalogListService.rename(request.user!.id, kind, write.id, input, { retryToken: write.retryToken }));
      return reply.status(statusCode).send(body);
    });

    /**
     * POST /units/:id/inactivate, POST /brands/:id/inactivate, POST /material-categories/:id/inactivate
     * Makes an entry Inactive ("หยุดใช้", F008-T8): it stays on the Stock Materials using it but is no longer offered.
     * Protected: requires 'material:manage' capability (Supply Officer)
     */
    fastify.post(`${path}/:id/inactivate`, { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
      const write = parseEntryWrite(StatusEntrySchema, request);
      if ('refusal' in write) {
        return reply.status(write.refusal.statusCode).send(write.refusal);
      }
      const { statusCode, body } = await outcomeOf(() => catalogListService.inactivate(request.user!.id, kind, write.id, write.data, { retryToken: write.retryToken }));
      return reply.status(statusCode).send(body);
    });

    /**
     * POST /units/:id/reactivate, POST /brands/:id/reactivate, POST /material-categories/:id/reactivate
     * Reactivates an Inactive entry ("เปิดใช้อีกครั้ง", F008-T8) as the same entry.
     * Protected: requires 'material:manage' capability (Supply Officer)
     */
    fastify.post(`${path}/:id/reactivate`, { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
      const write = parseEntryWrite(StatusEntrySchema, request);
      if ('refusal' in write) {
        return reply.status(write.refusal.statusCode).send(write.refusal);
      }
      const { statusCode, body } = await outcomeOf(() => catalogListService.reactivate(request.user!.id, kind, write.id, write.data, { retryToken: write.retryToken }));
      return reply.status(statusCode).send(body);
    });

    // A write to the entry the URL names once its id and body are validated, with the retry token, or the refusal.
    function parseEntryWrite<T extends { retry_token?: string }>(schema: z.ZodType<T>, request: FastifyRequest) {
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        return { refusal: errorBody(400, 'INVALID_ID', `${CATALOG_LISTS[kind].concept} ID must be a valid UUID string`) };
      }
      const write = parseWrite(schema, request);
      return 'refusal' in write ? write : { ...write, id: id.trim().toLowerCase() };
    }
  }
};
