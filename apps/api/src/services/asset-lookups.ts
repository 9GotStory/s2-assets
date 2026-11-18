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

/**
 * Locks a registered Asset in share mode, as a write that adds a fact about it without changing it does: a
 * Retirement locks the Asset for update, so the two serialize and the later sees the earlier (#154 Q24). Answers
 * what a refusal names the Asset by, or null for none.
 */
export async function lockAssetForShare(client: pg.PoolClient, assetId: string): Promise<{ id: string; name: string | null; asset_number: string | null } | null> {
  const res = await client.query('SELECT id, name, asset_number FROM assets WHERE id = $1 FOR SHARE', [assetId]);
  return res.rows[0] ?? null;
}

// An Asset as a warning names it.
export interface WarnedAsset {
  asset_id: string;
  name: string | null;
  asset_number: string | null;
}

/**
 * Reads what a warning names each of `assetIds` by, and returns the lookup of one of them: its name and
 * number, null for one not found.
 */
export async function warnedAssetLookup(db: pg.Pool | any, assetIds: string[]): Promise<(assetId: string) => WarnedAsset> {
  const res = await db.query('SELECT id, name, asset_number FROM assets WHERE id = ANY($1::uuid[])', [assetIds]);
  const found = new Map<string, WarnedAsset>(res.rows.map(({ id, name, asset_number }: any) => [id, { asset_id: id, name, asset_number }]));
  return (assetId) => found.get(assetId) ?? { asset_id: assetId, name: null, asset_number: null };
}
