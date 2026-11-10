import { Kysely, sql } from 'kysely';

// F004-T6 (#80, #74 Q18, Q25): a Loan Correction fixes a Loan fact that was recorded wrong. An amendment
// leaves the corrected values on the fact, and a void sets its is_voided; nothing is deleted. The record
// keeps the reason and the before and after of every field changed, except the phone number (#74 Q24).

// The facts a correction can name, one per record, as the reference-entry history names its entry.
const TARGETS = ['loan_id', 'loan_item_id', 'loan_item_ending_id', 'due_date_extension_id'] as const;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('loan_corrections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('loan_id', 'uuid', (col) => col.references('loans.id').onDelete('restrict'))
    .addColumn('loan_item_id', 'uuid', (col) => col.references('loan_items.id').onDelete('restrict'))
    .addColumn('loan_item_ending_id', 'uuid', (col) => col.references('loan_item_endings.id').onDelete('restrict'))
    .addColumn('due_date_extension_id', 'uuid', (col) => col.references('loan_due_date_extensions.id').onDelete('restrict'))
    .addColumn('action', 'varchar(10)', (col) => col.notNull().check(sql`action IN ('AMENDED', 'VOIDED')`))
    .addColumn('reason', 'text', (col) => col.notNull().check(sql`btrim(reason) <> ''`))
    // The before and after of every field an amendment changed; a void changes no field.
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addCheckConstraint('loan_corrections_one_target', sql`num_nonnulls(loan_id, loan_item_id, loan_item_ending_id, due_date_extension_id) = 1`)
    .addCheckConstraint(
      'loan_corrections_amendment_lists_changes',
      sql`CASE WHEN jsonb_typeof(changes) = 'array' THEN (action = 'AMENDED') = (jsonb_array_length(changes) > 0) ELSE false END`
    )
    .execute();

  for (const target of TARGETS) {
    // A fact is voided at most once.
    await sql`CREATE UNIQUE INDEX ${sql.ref(`loan_corrections_one_void_${target}`)}
      ON loan_corrections (${sql.ref(target)}) WHERE action = 'VOIDED' AND ${sql.ref(target)} IS NOT NULL`.execute(db);
    await sql`CREATE INDEX ${sql.ref(`idx_loan_corrections_${target}`)}
      ON loan_corrections (${sql.ref(target)}) WHERE ${sql.ref(target)} IS NOT NULL`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any correction record or Loan Correction retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM loan_corrections`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'loan:correct:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Loan corrections or Loan Correction retry receipts exist');
  }

  await db.schema.dropTable('loan_corrections').execute();
}
