import { Kysely, sql } from 'kysely';

// F003-T5 (#55, #50 Q4): the events of one Bulk Reassignment share a bulk reference, so the timeline
// can show them as one action. Each Asset of the batch has its own event (MR-10).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('assignment_events').addColumn('bulk_reference', 'uuid').execute();
  await db.schema
    .alterTable('assignment_events')
    .addCheckConstraint(
      'assignment_events_bulk_reference_on_reassignment',
      sql`bulk_reference IS NULL OR kind = 'REASSIGNMENT'`
    )
    .execute();

  await sql`CREATE UNIQUE INDEX assignment_events_one_per_bulk
    ON assignment_events (bulk_reference, asset_id) WHERE bulk_reference IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any event of a Bulk Reassignment exists.
  const events = await sql<{ count: string }>`SELECT count(*)::text AS count FROM assignment_events WHERE bulk_reference IS NOT NULL`.execute(db);
  if (Number(events.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Bulk Reassignment events exist');
  }

  await sql`DROP INDEX assignment_events_one_per_bulk`.execute(db);
  await db.schema.alterTable('assignment_events').dropColumn('bulk_reference').execute();
}
