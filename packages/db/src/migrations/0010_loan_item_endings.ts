import { Kysely, sql } from 'kysely';

// F004-T2 (#76, #74): an ending fact records how one LoanItem ended, a Loan Return or a Not Returned.
// The two kinds are one table, as #74 models them, so that one constraint ties the Condition and the
// reason to the kind. Nothing here touches an assignment fact (LR-10, MR-15).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('loan_item_endings')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('loan_item_id', 'uuid', (col) => col.references('loan_items.id').onDelete('restrict').notNull())
    .addColumn('kind', 'varchar(20)', (col) => col.notNull())
    // The Return Date, or the date a Not Returned became known.
    .addColumn('ending_date', 'date', (col) => col.notNull())
    .addColumn('condition', 'varchar(20)', (col) => col.check(sql`condition IN ('NORMAL', 'DAMAGED')`))
    .addColumn('condition_note', 'text', (col) => col.check(sql`btrim(condition_note) <> ''`))
    .addColumn('reason', 'text', (col) => col.check(sql`btrim(reason) <> ''`))
    .addColumn('document_reference', 'text', (col) => col.check(sql`btrim(document_reference) <> ''`))
    .addColumn('remark', 'text', (col) => col.check(sql`btrim(remark) <> ''`))
    // What every item of one recording shares (#74 Q29).
    .addColumn('action_reference', 'uuid', (col) => col.notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addCheckConstraint(
      'loan_item_endings_kind_fields',
      sql`CASE kind
        WHEN 'LOAN_RETURN' THEN condition IS NOT NULL AND reason IS NULL
        WHEN 'NOT_RETURNED' THEN condition IS NULL AND condition_note IS NULL AND reason IS NOT NULL
        ELSE false
      END`
    )
    .execute();

  // A Not Returned item that turns up has both facts (#74 Q21), so the limit is per kind.
  await sql`CREATE UNIQUE INDEX loan_item_endings_one_of_each_kind_per_item
    ON loan_item_endings (loan_item_id, kind) WHERE NOT is_voided`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any ending fact or Loan Return retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM loan_item_endings`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'loan:return:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Loan ending facts or Loan Return retry receipts exist');
  }

  await db.schema.dropTable('loan_item_endings').execute();
}
