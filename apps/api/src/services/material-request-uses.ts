import type pg from 'pg';

// F009-T8 (#210): the read the Requestable Material module asks the Material Request module through before its
// Request Unit changes (#202 P2; CODING_STANDARDS, "A feature's code gets its own files"). A leaf of the Material
// Request module: it imports nothing but pg's types.

/**
 * Whether any Requested Item, Pending or Cancelled (#210 start decision 3), asks for the Requestable Material
 * `requestableMaterialId`.
 *
 * It takes no lock. A Material Request locks each Requestable Material it asks for `FOR SHARE` before it adds its
 * Requested Items, so a caller that holds the Requestable Material `FOR UPDATE` and reads this in a statement of its
 * own sees each one that committed while it waited (PostgreSQL 18, §13.2.1).
 */
export async function requestedItemsUse(client: pg.PoolClient, requestableMaterialId: string): Promise<boolean> {
  const res = await client.query('SELECT EXISTS (SELECT 1 FROM requested_items WHERE requestable_material_id = $1) AS used', [requestableMaterialId]);
  return res.rows[0].used;
}
