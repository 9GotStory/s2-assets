import { Kysely, sql } from 'kysely';

// F004-T1 (#75, #74): a Loan records that one Borrower took one or more Assets for a time, and a
// LoanItem is one Asset of it. Nothing here touches an assignment fact (LR-10, MR-15).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('loans')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('borrower_kind', 'varchar(20)', (col) => col.notNull())
    .addColumn('borrower_person_id', 'uuid', (col) => col.references('persons.id').onDelete('restrict'))
    .addColumn('borrower_contact_name', 'text', (col) => col.check(sql`btrim(borrower_contact_name) <> ''`))
    .addColumn('borrower_organization_name', 'text', (col) => col.check(sql`btrim(borrower_organization_name) <> ''`))
    .addColumn('borrower_phone', 'text', (col) => col.check(sql`btrim(borrower_phone) <> ''`))
    .addColumn('loan_date', 'date', (col) => col.notNull())
    .addColumn('authorizer_person_id', 'uuid', (col) => col.references('persons.id').onDelete('restrict'))
    .addColumn('document_reference', 'text', (col) => col.check(sql`btrim(document_reference) <> ''`))
    .addColumn('remark', 'text', (col) => col.check(sql`btrim(remark) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    // An Internal Borrower is a Person entry; an External Borrower is at least a contact name (LR-02, LR-15).
    .addCheckConstraint(
      'loans_borrower_fields',
      sql`CASE borrower_kind
        WHEN 'INTERNAL' THEN borrower_person_id IS NOT NULL
          AND num_nonnulls(borrower_contact_name, borrower_organization_name, borrower_phone) = 0
        WHEN 'EXTERNAL' THEN borrower_person_id IS NULL AND borrower_contact_name IS NOT NULL
        ELSE false
      END`
    )
    .execute();

  await db.schema
    .createTable('loan_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('loan_id', 'uuid', (col) => col.references('loans.id').onDelete('restrict').notNull())
    .addColumn('asset_id', 'uuid', (col) => col.references('assets.id').onDelete('restrict').notNull())
    // The Due Date as first recorded.
    .addColumn('due_date', 'date', (col) => col.notNull())
    .addColumn('lending_condition', 'varchar(20)', (col) => col.notNull().check(sql`lending_condition IN ('NORMAL', 'DAMAGED')`))
    .addColumn('lending_condition_note', 'text', (col) => col.check(sql`btrim(lending_condition_note) <> ''`))
    // The one stored summary, so that the database can enforce LR-11 (#74).
    .addColumn('ending_kind', 'varchar(20)', (col) =>
      col.defaultTo('NONE').notNull().check(sql`ending_kind IN ('NONE', 'LOAN_RETURN', 'NOT_RETURNED')`)
    )
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addUniqueConstraint('loan_items_one_per_loan_and_asset', ['loan_id', 'asset_id'])
    .execute();

  // LR-11, and the guard on an Asset that ended Not Returned (#74 Q21): either item keeps the Asset from a new Loan.
  await sql`CREATE UNIQUE INDEX loan_items_one_outstanding_or_not_returned_per_asset
    ON loan_items (asset_id) WHERE NOT is_voided AND ending_kind IN ('NONE', 'NOT_RETURNED')`.execute(db);
  await sql`CREATE INDEX idx_loan_items_asset ON loan_items (asset_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Loan fact or Loan retry receipt exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM loans`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'loan:%'`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0 || Number(receipts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Loan facts or Loan retry receipts exist');
  }

  await db.schema.dropTable('loan_items').execute();
  await db.schema.dropTable('loans').execute();
}
