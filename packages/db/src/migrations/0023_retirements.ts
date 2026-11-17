import { Kysely, sql } from 'kysely';

// F007-T1 (#155, #154): a Retirement records that one Asset left use for good, through an external disposal
// process that has already finished. The Asset gains no status column: Retired is derived on read from a
// Retirement not voided (DR-07, Q1). Nothing here deletes or changes an Asset or any of its facts (DR-01).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('retirements')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('asset_id', 'uuid', (col) => col.references('assets.id').onDelete('restrict').notNull())
    .addColumn('retirement_date', 'date', (col) => col.notNull())
    // #154 Q2: ขาย, แลกเปลี่ยน, โอนให้หน่วยงานอื่น, แปรสภาพหรือทำลาย, จำหน่ายเป็นสูญ.
    .addColumn('retirement_method', 'varchar(30)', (col) =>
      col.notNull().check(sql`retirement_method IN ('SALE', 'EXCHANGE', 'HANDOVER_TO_OTHER_AGENCY', 'CONVERSION_OR_DESTRUCTION', 'DECLARED_LOSS')`)
    )
    // #154 Q15: one optional text for the external document; the system stores no file (DR-06).
    .addColumn('retirement_reference', 'text', (col) => col.check(sql`btrim(retirement_reference) <> ''`))
    .addColumn('note', 'text', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .execute();

  // #154 P2: an Asset has at most one Retirement not voided.
  await sql`CREATE UNIQUE INDEX retirements_one_not_voided_per_asset
    ON retirements (asset_id) WHERE NOT is_voided`.execute(db);
  await sql`CREATE INDEX idx_retirements_asset ON retirements (asset_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Retirement or Retirement retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM retirements`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'retirement:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Retirements or Retirement retry receipts exist');
  }

  await db.schema.dropTable('retirements').execute();
}
