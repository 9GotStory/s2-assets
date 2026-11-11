import { Kysely, sql } from 'kysely';

// F005-T1 (#99, #98): a Repair Record records that one Asset was taken out of use to be repaired or
// maintained, from its Repair Start. Nothing here touches an assignment fact (RM-05, MR-15).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('repair_records')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('asset_id', 'uuid', (col) => col.references('assets.id').onDelete('restrict').notNull())
    .addColumn('repair_kind', 'varchar(20)', (col) => col.notNull().check(sql`repair_kind IN ('REPAIR', 'MAINTENANCE')`))
    .addColumn('start_date', 'date', (col) => col.notNull())
    .addColumn('repairer_kind', 'varchar(20)', (col) => col.notNull().check(sql`repairer_kind IN ('INTERNAL', 'EXTERNAL')`))
    .addColumn('repairer_name', 'text', (col) => col.check(sql`btrim(repairer_name) <> ''`))
    .addColumn('symptom_or_work', 'text', (col) => col.notNull().check(sql`btrim(symptom_or_work) <> ''`))
    .addColumn('under_warranty', 'varchar(20)', (col) =>
      col.defaultTo('UNSPECIFIED').notNull().check(sql`under_warranty IN ('YES', 'NO', 'UNSPECIFIED')`)
    )
    .addColumn('warranty_end_date', 'date')
    // One cost per record, in baht (#98 Q8, Q22).
    .addColumn('cost', 'numeric(12, 2)', (col) => col.check(sql`cost >= 0`))
    .addColumn('document_reference', 'text', (col) => col.check(sql`btrim(document_reference) <> ''`))
    .addColumn('remark', 'text', (col) => col.check(sql`btrim(remark) <> ''`))
    // The one stored summary, so that the database can enforce one Under Repair per Asset (#98).
    .addColumn('has_outcome', 'boolean', (col) => col.defaultTo(false).notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .execute();

  // #98 Q3, Q15: an Asset is Under Repair at most once, of either kind.
  await sql`CREATE UNIQUE INDEX repair_records_one_under_repair_per_asset
    ON repair_records (asset_id) WHERE NOT is_voided AND NOT has_outcome`.execute(db);
  await sql`CREATE INDEX idx_repair_records_asset ON repair_records (asset_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Repair fact or Repair retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM repair_records`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'repair:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Repair Records or Repair retry receipts exist');
  }

  await db.schema.dropTable('repair_records').execute();
}
