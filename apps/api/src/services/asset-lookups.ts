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

// An Asset as a warning names it.
export interface WarnedAsset {
  asset_id: string;
  name: string | null;
  asset_number: string | null;
}

/** What a warning names each of `assetIds` by: each Asset's name and number, null for one not found. */
export async function warnedAssetsOf(db: pg.Pool | any, assetIds: string[]): Promise<(assetId: string) => WarnedAsset> {
  const res = await db.query('SELECT id, name, asset_number FROM assets WHERE id = ANY($1::uuid[])', [assetIds]);
  const found = new Map<string, { name: string | null; asset_number: string | null }>(res.rows.map(({ id, name, asset_number }: any) => [id, { name, asset_number }]));
  return (assetId) => ({ asset_id: assetId, name: found.get(assetId)?.name ?? null, asset_number: found.get(assetId)?.asset_number ?? null });
}
