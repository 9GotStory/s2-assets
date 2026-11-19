import { Kysely, sql } from 'kysely';

// F008-T6 (#182, #175 Q28): a Stock Material's optional Minimum Stock (จำนวนขั้นต่ำ) in its Base Unit, for Feature
// 010's Low Stock indicator (MC-20, Q14). It is kept exactly to four decimal places (P1) and none until someone sets
// one: nothing is guessed. Its whole-number rule follows the Base Unit (P3), which the service checks. A change is
// recorded as a change of other details or of the Units, kinds the history already takes (#182 decision 3).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('stock_materials')
    .addColumn('minimum_stock', 'numeric(18, 4)', (col) => col.check(sql`minimum_stock > 0`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Stock Material has a Minimum Stock (#175 Q28).
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM stock_materials WHERE minimum_stock IS NOT NULL`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: a Stock Material has a Minimum Stock');
  }

  await db.schema.alterTable('stock_materials').dropColumn('minimum_stock').execute();
}
