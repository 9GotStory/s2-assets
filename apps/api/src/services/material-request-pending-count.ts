import type pg from 'pg';
import { requestedItemState } from './material-request-state.ts';

// F009-T7 (#209): the read the Requestable Material module asks the Material Request module through for a
// Requestable Material's page (#202 Q16, P6; CODING_STANDARDS, "A feature's code gets its own files"). A leaf of the
// Material Request module: it imports only its own state SQL and pg's types.

/**
 * How many Pending Requested Items, of every Requester, ask for the Requestable Material `requestableMaterialId`: the
 * count the Supply Officer sees before making it Inactive or ending its last Compatible Stock Material. It takes no
 * lock; the page reads it as a fact of the moment.
 */
export async function pendingRequestedItemCount(db: pg.Pool | pg.PoolClient, requestableMaterialId: string): Promise<number> {
  const res = await db.query(`SELECT count(*)::int AS n FROM requested_items i WHERE i.requestable_material_id = $1 AND ${requestedItemState('i')} = 'PENDING'`, [
    requestableMaterialId,
  ]);
  return res.rows[0].n;
}
