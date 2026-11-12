import { Kysely, sql } from 'kysely';

// F005-T5 (#103, #98): a Repair Record's Repair Source, the Loan Return recorded ชำรุด that led to it
// (LR-13, RM-08, Q5). The server decides what may be cited; the database keeps the citation pointing at
// a fact that exists. Voiding that Loan Return later leaves the record citing it: nothing cascades.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repair_records')
    .addColumn('repair_source_loan_return_id', 'uuid', (col) => col.references('loan_item_endings.id').onDelete('restrict'))
    .execute();

  // The Loan page reads the Repair Records that cite each of its Loan Returns.
  await sql`CREATE INDEX idx_repair_records_repair_source_loan_return
    ON repair_records (repair_source_loan_return_id) WHERE repair_source_loan_return_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Repair Record cites a Repair Source.
  const sources = await sql<{ count: string }>`SELECT count(*)::text AS count FROM repair_records WHERE repair_source_loan_return_id IS NOT NULL`.execute(db);
  if (Number(sources.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Repair Records cite a Repair Source');
  }

  await sql`DROP INDEX idx_repair_records_repair_source_loan_return`.execute(db);
  await db.schema.alterTable('repair_records').dropColumn('repair_source_loan_return_id').execute();
}
