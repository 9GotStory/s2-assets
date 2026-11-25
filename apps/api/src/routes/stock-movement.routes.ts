import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import { fiscalYearQueryField, invalidQueryBody, pageQueryFields } from './list-query.ts';
import { errorBody } from './write-request.ts';
import { isValidUuid } from '../services/capability.service.ts';
import type { StockMovementReadService } from '../services/stock-movements.ts';

export interface StockMovementRoutesOptions {
  stockMovementReadService: StockMovementReadService;
}

// #231 story 51: a Fiscal Year (ปีงบประมาณ), and a page.
const StockLedgerQuerySchema = z.object({ fiscal_year: fiscalYearQueryField, ...pageQueryFields }).strict();

/** F010-T4 (#235): a Stock Material's Stock Movements (รายการเคลื่อนไหว), read by every material:view holder (#231 Q3, Q23). */
export const stockMovementRoutes: FastifyPluginAsync<StockMovementRoutesOptions> = async (fastify, options) => {
  const { stockMovementReadService } = options;

  /**
   * GET /stock-materials/:id/stock-movements
   * The Stock Movements of a Stock Material, Inactive or not, oldest first in the business timeline, a page at a time,
   * each with its source and the balance after it, by Fiscal Year, with the Fiscal Years it has (#231 P6; #235 start
   * decisions 2–4).
   * Protected: requires 'material:view' capability (Supply Officer, Administrator, Read-only User)
   */
  fastify.get('/stock-materials/:id/stock-movements', { preHandler: [requireCapability('material:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send(errorBody(400, 'INVALID_ID', 'Stock Material ID must be a valid UUID string'));
    }
    const parsed = StockLedgerQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidQueryBody(parsed.error));
    }
    const { limit = 25, offset = 0, fiscal_year: fiscalYear } = parsed.data;
    const ledger = await stockMovementReadService.ledgerOf(id.trim().toLowerCase(), { fiscalYear, limit, offset });
    if (!ledger) {
      return reply.status(404).send(errorBody(404, 'NOT_FOUND', 'Stock Material not found'));
    }
    return reply.status(200).send(ledger);
  });
};
