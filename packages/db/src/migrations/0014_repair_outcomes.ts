import { Kysely, sql } from 'kysely';

// F005-T2 (#100, #98): a Repair Outcome records how a Repair Record ended, usable or not. Recording one
// also sets the record's has-outcome summary in the same transaction, so that the record leaves Under
// Repair. Nothing here touches an assignment fact (RM-05, MR-17).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('repair_outcomes')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('repair_record_id', 'uuid', (col) => col.references('repair_records.id').onDelete('restrict').notNull())
    // ใช้งานได้, or ซ่อมไม่ได้ (ใช้งานไม่ได้ for maintenance) (#98 Q10, Q16).
    .addColumn('outcome', 'varchar(20)', (col) => col.notNull().check(sql`outcome IN ('USABLE', 'NOT_USABLE')`))
    .addColumn('outcome_date', 'date', (col) => col.notNull())
    .addColumn('note', 'text', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('document_reference', 'text', (col) => col.check(sql`btrim(document_reference) <> ''`))
    .addColumn('next_recommended_maintenance_date', 'date')
    // The record's cost before this outcome set it, so that voiding the outcome restores it (#98 Q22).
    .addColumn('cost_before', 'numeric(12, 2)', (col) => col.check(sql`cost_before >= 0`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    // #98 Q7: after the Outcome Date.
    .addCheckConstraint('repair_outcomes_next_recommended_maintenance_date', sql`next_recommended_maintenance_date > outcome_date`)
    .execute();

  await sql`CREATE UNIQUE INDEX repair_outcomes_one_per_record
    ON repair_outcomes (repair_record_id) WHERE NOT is_voided`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Repair Outcome or Repair Outcome retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM repair_outcomes`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'repair:outcome:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Repair Outcomes or Repair Outcome retry receipts exist');
  }

  await db.schema.dropTable('repair_outcomes').execute();
}
