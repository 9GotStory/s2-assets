import { Kysely, sql } from 'kysely';

// F007-T5 (#159, #154 Q9, P2): a Retirement Correction fixes a Retirement recorded wrong. An amendment leaves
// the corrected values on the Retirement, and a void sets its is_voided, so the Asset is no longer Retired;
// nothing is deleted. The record keeps the reason and the before and after of every field an amendment
// changed, as a Repair Correction does (0016).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('retirement_corrections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('retirement_id', 'uuid', (col) => col.references('retirements.id').onDelete('restrict').notNull())
    .addColumn('action', 'varchar(10)', (col) => col.notNull().check(sql`action IN ('AMENDED', 'VOIDED')`))
    .addColumn('reason', 'text', (col) => col.notNull().check(sql`btrim(reason) <> ''`))
    // The before and after of every field an amendment changed. A void changes nothing besides voiding.
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addCheckConstraint(
      'retirement_corrections_amendment_lists_changes',
      sql`CASE WHEN jsonb_typeof(changes) = 'array' THEN action <> 'AMENDED' OR jsonb_array_length(changes) > 0 ELSE false END`
    )
    .execute();

  // A Retirement is voided at most once.
  await sql`CREATE UNIQUE INDEX retirement_corrections_one_void_per_retirement
    ON retirement_corrections (retirement_id) WHERE action = 'VOIDED'`.execute(db);
  await sql`CREATE INDEX idx_retirement_corrections_retirement ON retirement_corrections (retirement_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Retirement Correction or retry receipt of one exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM retirement_corrections`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'retirement:correct:%'`.execute(db);
  if ([facts, receipts].some((res) => Number(res.rows[0]?.count || '0') > 0)) {
    throw new Error('Refusing destructive rollback: Retirement Corrections or retry receipts of one exist');
  }

  await db.schema.dropTable('retirement_corrections').execute();
}
