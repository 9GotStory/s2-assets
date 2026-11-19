import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import type { CapabilityService } from '../services/capability.service.ts';
import type { CatalogListKind } from '../services/catalog-list-entries.ts';
import { CatalogListNameTakenError, type CatalogListService } from '../services/catalog-list.service.ts';
import { RetryTokenConflictError } from '../services/service-errors.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface CatalogListRoutesOptions {
  catalogListService: CatalogListService;
  capabilityService: CapabilityService;
}

const AddEntrySchema = z.object({ name: z.string(), retry_token: z.string().optional() }).strict();

// Each list's path.
const PATHS: Record<CatalogListKind, string> = { brand: '/brands', 'material-category': '/material-categories' };

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof CatalogListNameTakenError) {
    return { ...errorBody(err.statusCode, err.code, err.message), entry: err.entry };
  }
  if (err instanceof RetryTokenConflictError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/** F008-T4 (#179): the Brand (ยี่ห้อ) and Material Category (หมวดวัสดุ) lists of the Stock Material catalog (#175 Q3, Q4, P5). */
export const catalogListRoutes: FastifyPluginAsync<CatalogListRoutesOptions> = async (fastify, options) => {
  const { catalogListService, capabilityService } = options;

  for (const [kind, path] of Object.entries(PATHS) as [CatalogListKind, string][]) {
    /**
     * GET /brands, GET /material-categories
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
     * POST /brands, POST /material-categories
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
  }
};
