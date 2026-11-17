import { Kysely, sql } from 'kysely';

// F006-T8 (#133, #125 Q13, AV-15, MR-12): a single Reassignment may cite the Verification Revision with "Location
// ไม่ตรงทะเบียน" that led to it, so the timeline traces it back to the Round. A Bulk Reassignment cites none. The
// server decides what may be cited; the database keeps the citation pointing at a revision that exists. Voiding
// that revision later leaves the Reassignment citing it: nothing cascades (P1).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('assignment_events')
    .addColumn('verification_revision_id', 'uuid', (col) => col.references('verification_revisions.id').onDelete('restrict'))
    .execute();
  await db.schema
    .alterTable('assignment_events')
    .addCheckConstraint(
      'assignment_events_verification_revision_on_single_reassignment',
      sql`verification_revision_id IS NULL OR (kind = 'REASSIGNMENT' AND bulk_reference IS NULL)`
    )
    .execute();

  // A result reads the Reassignments that cite it: "ย้ายแล้ว" (Q19).
  await sql`CREATE INDEX idx_assignment_events_verification_revision
    ON assignment_events (verification_revision_id) WHERE verification_revision_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Reassignment cites a Verification Revision.
  const citing = await sql<{ count: string }>`SELECT count(*)::text AS count FROM assignment_events WHERE verification_revision_id IS NOT NULL`.execute(db);
  if (Number(citing.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Reassignments cite a Verification Revision');
  }

  await sql`DROP INDEX idx_assignment_events_verification_revision`.execute(db);
  await db.schema.alterTable('assignment_events').dropConstraint('assignment_events_verification_revision_on_single_reassignment').execute();
  await db.schema.alterTable('assignment_events').dropColumn('verification_revision_id').execute();
}
