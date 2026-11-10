import type pg from 'pg';

// Lookups of the Asset module that other services use. This module imports no service, so
// loan.service.ts can use it while asset.service.ts imports loan.service.ts (#78).

// A case-insensitive literal substring pattern for ILIKE ... ESCAPE '\'.
export const containsPattern = (value: string): string =>
  `%${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

/** Whether an Asset is registered. */
export async function assetExists(db: pg.Pool | any, assetId: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM assets WHERE id = $1', [assetId]);
  return res.rows.length > 0;
}
