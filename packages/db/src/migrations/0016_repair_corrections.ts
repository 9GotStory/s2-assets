import { Kysely, sql } from 'kysely';

// F005-T6 (#104, #98 Q18): a Repair Correction fixes a Repair fact that was recorded wrong. An amendment
// leaves the corrected values on the fact, and a void sets its is_voided; nothing is deleted. The record
// keeps the reason and the before and after of every field changed, as a Loan Correction does (0012).

// The facts a correction can name, one per record.
const TARGETS = ['repair_record_id', 'repair_outcome_id'] as const;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('repair_corrections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('repair_record_id', 'uuid', (col) => col.references('repair_records.id').onDelete('restrict'))
    .addColumn('repair_outcome_id', 'uuid', (col) => col.references('repair_outcomes.id').onDelete('restrict'))
    .addColumn('action', 'varchar(10)', (col) => col.notNull().check(sql`action IN ('AMENDED', 'VOIDED')`))
    .addColumn('reason', 'text', (col) => col.notNull().check(sql`btrim(reason) <> ''`))
    // The before and after of every field an amendment changed; a void changes no field.
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addCheckConstraint('repair_corrections_one_target', sql`num_nonnulls(repair_record_id, repair_outcome_id) = 1`)
    .addCheckConstraint(
      'repair_corrections_amendment_lists_changes',
      sql`CASE WHEN jsonb_typeof(changes) = 'array' THEN (action = 'AMENDED') = (jsonb_array_length(changes) > 0) ELSE false END`
    )
    .execute();

  for (const target of TARGETS) {
    // A fact is voided at most once.
    await sql`CREATE UNIQUE INDEX ${sql.ref(`repair_corrections_one_void_${target}`)}
      ON repair_corrections (${sql.ref(target)}) WHERE action = 'VOIDED' AND ${sql.ref(target)} IS NOT NULL`.execute(db);
    await sql`CREATE INDEX ${sql.ref(`idx_repair_corrections_${target}`)}
      ON repair_corrections (${sql.ref(target)}) WHERE ${sql.ref(target)} IS NOT NULL`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any correction record or Repair Correction retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM repair_corrections`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'repair:correct:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Repair Corrections or Repair Correction retry receipts exist');
  }

  await db.schema.dropTable('repair_corrections').execute();
}
