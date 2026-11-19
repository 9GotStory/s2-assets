import { Kysely, sql } from 'kysely';

// F008-T3 (#178): when the Base Unit changes, an Inactive Alternate Unit given no new Conversion Factor keeps none,
// rather than one that converts to the old Base Unit (#178 PO decision 1, comment 6998878850; #175 P2); the Units
// write keeps every other known factor known (decision 1 at delivery, comment 6999893572). The Base Unit and every active Alternate Unit keep a known factor, so reactivating an
// Alternate Unit takes one.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE stock_material_units ALTER COLUMN conversion_factor DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE stock_material_units ADD CONSTRAINT stock_material_units_factor_known_unless_inactive
            CHECK (conversion_factor IS NOT NULL OR (NOT is_base AND NOT is_active))`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // A factor that is unknown has no value to restore.
  const unknown = await sql<{ count: string }>`SELECT count(*)::text AS count FROM stock_material_units WHERE conversion_factor IS NULL`.execute(db);
  if (Number(unknown.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing rollback: a Conversion Factor is unknown');
  }

  await sql`ALTER TABLE stock_material_units DROP CONSTRAINT stock_material_units_factor_known_unless_inactive`.execute(db);
  await sql`ALTER TABLE stock_material_units ALTER COLUMN conversion_factor SET NOT NULL`.execute(db);
}
