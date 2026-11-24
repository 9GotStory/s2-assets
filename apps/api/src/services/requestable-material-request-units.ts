import type pg from 'pg';

// F009-T3 (#205): the read the Stock Material module asks the Requestable Material module through, before a Units
// write makes an Alternate Unit Inactive (#202 Q15, ADR 0002; CODING_STANDARDS, "A feature's code gets its own files").
// A leaf of the Requestable Material module: it imports nothing but pg's types.

/**
 * The names of the Requestable Materials, by name, for which the Stock Material `stockMaterialId` is a current
 * Compatible Stock Material asked for in one of the Units `unitIds`, under each such Unit's id. An Inactive Requestable
 * Material counts too: reactivated, it is offered again (#205 start decision 2).
 *
 * It takes no lock. Adding or ending a Compatible Stock Material locks the Stock Material `FOR SHARE`, and so must a
 * Request Unit change (#205 start decision 3), so a caller that holds the Stock Material `FOR UPDATE` and reads this in
 * a statement of its own sees each one that committed while it waited (PostgreSQL 18, §13.2.1).
 */
export async function requestableMaterialsAskedIn(client: pg.PoolClient, stockMaterialId: string, unitIds: string[]): Promise<Map<string, string[]>> {
  const res = await client.query(
    `SELECT rm.request_unit_id AS unit_id, rm.name
       FROM compatible_stock_materials c JOIN requestable_materials rm ON rm.id = c.requestable_material_id
      WHERE c.stock_material_id = $1 AND c.is_current AND rm.request_unit_id = ANY($2::uuid[])
      ORDER BY lower(rm.name) ASC, rm.id ASC`,
    [stockMaterialId, unitIds]
  );
  const askedIn = new Map<string, string[]>();
  for (const { unit_id, name } of res.rows) {
    askedIn.set(unit_id, [...(askedIn.get(unit_id) ?? []), name]);
  }
  return askedIn;
}
