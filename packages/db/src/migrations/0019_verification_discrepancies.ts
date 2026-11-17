import { Kysely, sql } from 'kysely';

// F006-T3 (#128, #125): a Found result may name the Observed Location, a Location Reference List entry left out
// when it matched (#125 Q7, AV-07), and tick the two Discrepancies Verification Staff note themselves:
// ป้าย/QR หายหรือชำรุด (AR-14) and ข้อมูลไม่ตรงทะเบียน with its note (AV-08). "Location ไม่ตรงทะเบียน" and
// "ชำรุด" are derived on read, never stored. As with the rest of a revision, no write updates them (Q15).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('verification_revisions')
    .addColumn('observed_location_id', 'uuid', (col) => col.references('locations.id').onDelete('restrict'))
    .addColumn('label_missing_or_damaged', 'boolean', (col) => col.defaultTo(false).notNull())
    .addColumn('data_mismatch', 'boolean', (col) => col.defaultTo(false).notNull())
    .addColumn('data_mismatch_note', 'text', (col) => col.check(sql`btrim(data_mismatch_note) <> ''`))
    .execute();
  await db.schema
    .alterTable('verification_revisions')
    .addCheckConstraint(
      'verification_revisions_found_discrepancies',
      sql`result = 'FOUND' OR (observed_location_id IS NULL AND NOT label_missing_or_damaged AND NOT data_mismatch)`
    )
    .execute();
  await db.schema
    .alterTable('verification_revisions')
    .addCheckConstraint('verification_revisions_data_mismatch_note', sql`data_mismatch = (data_mismatch_note IS NOT NULL)`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any revision holds an Observed Location or a flag.
  const facts = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM verification_revisions
    WHERE observed_location_id IS NOT NULL OR label_missing_or_damaged OR data_mismatch`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Verification Revisions hold an Observed Location or a Discrepancy flag');
  }

  await db.schema
    .alterTable('verification_revisions')
    .dropConstraint('verification_revisions_data_mismatch_note')
    .execute();
  await db.schema
    .alterTable('verification_revisions')
    .dropConstraint('verification_revisions_found_discrepancies')
    .execute();
  await db.schema
    .alterTable('verification_revisions')
    .dropColumn('data_mismatch_note')
    .dropColumn('data_mismatch')
    .dropColumn('label_missing_or_damaged')
    .dropColumn('observed_location_id')
    .execute();
}
