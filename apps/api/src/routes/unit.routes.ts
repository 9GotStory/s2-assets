import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { errorBody, parseWrite } from './write-request.ts';
import type { CapabilityService } from '../services/capability.service.ts';
import { RetryTokenConflictError } from '../services/service-errors.ts';
import { UnitNameTakenError, type UnitService } from '../services/unit.service.ts';
import { ValidationError } from '../services/validation-error.ts';

export interface UnitRoutesOptions {
  unitService: UnitService;
  capabilityService: CapabilityService;
}

const AddUnitSchema = z.object({ name: z.string(), retry_token: z.string().optional() }).strict();

// The answer to a refused write, or null for an error that is not a refusal.
const refusalOf = (err: unknown) => {
  if (err instanceof UnitNameTakenError) {
    return { ...errorBody(err.statusCode, err.code, err.message), entry: err.entry };
  }
  if (err instanceof RetryTokenConflictError || err instanceof ValidationError) {
    return errorBody(err.statusCode, err.code, err.message);
  }
  return null;
};

/** F008-T1 (#176): the shared Unit list (หน่วยนับ) of the Stock Material catalog (#175 Q5, P5). */
export const unitRoutes: FastifyPluginAsync<UnitRoutesOptions> = async (fastify, options) => {
  const { unitService, capabilityService } = options;

  /**
   * GET /units
   * Every Unit, Inactive ones included, by name, with `can_manage` telling the page whether to offer adding one.
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/units', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const items = await unitService.list();
    const canManage = await capabilityService.hasCapability(request.user!.id, 'material:manage');
    return reply.status(200).send({ items, can_manage: canManage });
  });

  /**
   * POST /units
   * Adds a Unit to the list, from the Stock Material form or the maintenance page (#175 Q15, P5).
   * Protected: requires 'material:manage' capability (Supply Officer)
   */
  fastify.post('/units', { preHandler: [requireCapability('material:manage')] }, async (request, reply) => {
    const write = parseWrite(AddUnitSchema, request);
    if ('refusal' in write) {
      return reply.status(400).send(write.refusal);
    }
    try {
      return reply.status(201).send(await unitService.add(request.user!.id, write.data.name, { retryToken: write.retryToken }));
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) {
        throw err;
      }
      return reply.status(refusal.statusCode).send(refusal);
    }
  });
};
