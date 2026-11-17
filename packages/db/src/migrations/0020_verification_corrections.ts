import { Kysely, sql } from 'kysely';

// F006-T4 (#129, #125 Q18): a Verification Correction voids the current Verification Revision of an Asset in an
// open Round, with a reason (ยกเลิกรายการ). The revision stays, its is_voided set, and the latest revision not
// voided becomes the current result again. The record keeps the revision it voided, the reason, the actor and
// Recorded At; a revision is voided at most once.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('verification_corrections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('verification_revision_id', 'uuid', (col) => col.references('verification_revisions.id').onDelete('restrict').notNull())
    .addColumn('reason', 'text', (col) => col.notNull().check(sql`btrim(reason) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('verification_corrections_one_per_revision', ['verification_revision_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Verification Correction or retry receipt of one exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM verification_corrections`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation = 'verification:correct'`.execute(db);
  if ([facts, receipts].some((res) => Number(res.rows[0]?.count || '0') > 0)) {
    throw new Error('Refusing destructive rollback: Verification Corrections or retry receipts of one exist');
  }

  await db.schema.dropTable('verification_corrections').execute();
}
