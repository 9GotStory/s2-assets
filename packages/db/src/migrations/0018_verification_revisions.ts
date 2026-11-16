import { Kysely, sql } from 'kysely';

// F006-T2 (#127, #125): a Verification Revision is one recorded result of an Asset in a Round, Found or Not
// Found, numbered in order within its scope entry. It keeps what the server derived when it was recorded: the
// Permanent Assignment in effect on its Verification Date (#125 Q26) and the Loan and Repair context (Q14). No
// write updates those values: they are the record (Q15). Voiding is unused until F006-T4.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('verification_revisions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('verification_scope_entry_id', 'uuid', (col) => col.references('verification_scope_entries.id').onDelete('restrict').notNull())
    .addColumn('revision_number', 'integer', (col) => col.notNull().check(sql`revision_number >= 1`))
    .addColumn('result', 'varchar(10)', (col) => col.notNull().check(sql`result IN ('FOUND', 'NOT_FOUND')`))
    // ปกติ or ชำรุด, when Found and only then (#125 Q6, AV-05).
    .addColumn('condition', 'varchar(10)', (col) => col.check(sql`condition IN ('NORMAL', 'DAMAGED')`))
    .addColumn('note', 'text', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('verification_date', 'date', (col) => col.notNull())
    // The Permanent Assignment in effect on the Verification Date, as the register showed it at recording, each
    // dimension an entry, read by its current name, and Legacy text.
    .addColumn('location_id', 'uuid', (col) => col.references('locations.id').onDelete('restrict'))
    .addColumn('legacy_location_text', 'text')
    .addColumn('organization_unit_id', 'uuid', (col) => col.references('organization_units.id').onDelete('restrict'))
    .addColumn('legacy_organization_unit_text', 'text')
    .addColumn('responsible_person_id', 'uuid', (col) => col.references('persons.id').onDelete('restrict'))
    .addColumn('legacy_responsible_person_text', 'text')
    // The LoanItem that held the Asset at recording, On Loan or Not Returned, with its Borrower and Due Date then.
    .addColumn('loan_context', 'varchar(15)', (col) => col.check(sql`loan_context IN ('ON_LOAN', 'NOT_RETURNED')`))
    .addColumn('loan_item_id', 'uuid', (col) => col.references('loan_items.id').onDelete('restrict'))
    .addColumn('loan_borrower_display', 'text')
    .addColumn('loan_due_date', 'date')
    // The Repair Record that kept the Asset Under Repair at recording, and its kind.
    .addColumn('repair_record_id', 'uuid', (col) => col.references('repair_records.id').onDelete('restrict'))
    .addColumn('repair_kind', 'varchar(15)', (col) => col.check(sql`repair_kind IN ('REPAIR', 'MAINTENANCE')`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addCheckConstraint('verification_revisions_condition_when_found', sql`(result = 'FOUND') = (condition IS NOT NULL)`)
    .addCheckConstraint(
      'verification_revisions_loan_context_whole',
      sql`num_nonnulls(loan_context, loan_item_id, loan_borrower_display, loan_due_date) IN (0, 4)`
    )
    .addCheckConstraint('verification_revisions_repair_context_whole', sql`num_nonnulls(repair_record_id, repair_kind) IN (0, 2)`)
    .addUniqueConstraint('verification_revisions_entry_revision_number', ['verification_scope_entry_id', 'revision_number'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Verification Revision or retry receipt of a result exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM verification_revisions`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation = 'verification:record'`.execute(db);
  if ([facts, receipts].some((res) => Number(res.rows[0]?.count || '0') > 0)) {
    throw new Error('Refusing destructive rollback: Verification Revisions or retry receipts of a result exist');
  }

  await db.schema.dropTable('verification_revisions').execute();
}
