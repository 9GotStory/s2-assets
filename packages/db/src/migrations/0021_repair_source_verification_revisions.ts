import { Kysely, sql } from 'kysely';

// F006-T7 (#132, #125 Q12): a Repair Record's Repair Source may be the Verification Revision Found ชำรุด that led
// to it, as well as a Loan Return (0015). A record cites at most one. The server decides what may be cited; the
// database keeps the citation pointing at a revision that exists. Voiding that revision later leaves the record
// citing it: nothing cascades (P1).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repair_records')
    .addColumn('repair_source_verification_revision_id', 'uuid', (col) => col.references('verification_revisions.id').onDelete('restrict'))
    .execute();
  await db.schema
    .alterTable('repair_records')
    .addCheckConstraint('repair_records_one_repair_source', sql`num_nonnulls(repair_source_loan_return_id, repair_source_verification_revision_id) <= 1`)
    .execute();

  // A result reads the Repair Records that cite it: "ส่งซ่อมแล้ว" (Q19).
  await sql`CREATE INDEX idx_repair_records_repair_source_verification_revision
    ON repair_records (repair_source_verification_revision_id) WHERE repair_source_verification_revision_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Repair Record cites a Verification Revision.
  const sources = await sql<{ count: string }>`SELECT count(*)::text AS count FROM repair_records WHERE repair_source_verification_revision_id IS NOT NULL`.execute(db);
  if (Number(sources.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Repair Records cite a Verification Revision');
  }

  await sql`DROP INDEX idx_repair_records_repair_source_verification_revision`.execute(db);
  await db.schema.alterTable('repair_records').dropConstraint('repair_records_one_repair_source').execute();
  await db.schema.alterTable('repair_records').dropColumn('repair_source_verification_revision_id').execute();
}
