import { Kysely, sql } from 'kysely';

// F004-T5 (#79, #74): a Due Date Extension moves one Outstanding LoanItem's Due Date later and keeps
// the date it replaced. A LoanItem's current Due Date is derived on read from these, never stored.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('loan_due_date_extensions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('loan_item_id', 'uuid', (col) => col.references('loan_items.id').onDelete('restrict').notNull())
    .addColumn('prior_due_date', 'date', (col) => col.notNull())
    .addColumn('new_due_date', 'date', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.check(sql`btrim(reason) <> ''`))
    // What every item of one recording shares.
    .addColumn('action_reference', 'uuid', (col) => col.notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    // An extension only ever extends; moving a date earlier is a Loan Correction (#74 Q28).
    .addCheckConstraint('loan_due_date_extensions_later', sql`new_due_date > prior_due_date`)
    .execute();

  await sql`CREATE INDEX idx_loan_due_date_extensions_item ON loan_due_date_extensions (loan_item_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Due Date Extension or its retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM loan_due_date_extensions`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'loan:due-date-extension:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Due Date Extensions or their retry receipts exist');
  }

  await db.schema.dropTable('loan_due_date_extensions').execute();
}
