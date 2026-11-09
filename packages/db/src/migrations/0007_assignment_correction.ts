import { Kysely, sql } from 'kysely';

// F003-T3 (#53, #50 Q13): an Assignment Correction fixes an assignment fact that was wrong as
// recorded. The event and its changes hold the corrected values, and the correction record keeps
// the originals. A voided event stays in the timeline and takes no part in the Current Assignment.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('assignment_events')
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .execute();

  // Only a non-voided Initial Assignment counts, so a voided one can be recorded again (#50 US 15).
  await sql`DROP INDEX assignment_events_one_initial`.execute(db);
  await sql`CREATE UNIQUE INDEX assignment_events_one_initial
    ON assignment_events (asset_id) WHERE kind = 'INITIAL' AND NOT is_voided`.execute(db);

  await db.schema
    .createTable('assignment_corrections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('event_id', 'uuid', (col) => col.references('assignment_events.id').onDelete('restrict').notNull())
    .addColumn('action', 'varchar(10)', (col) => col.notNull().check(sql`action IN ('AMENDED', 'VOIDED')`))
    .addColumn('reason', 'text', (col) => col.notNull().check(sql`btrim(reason) <> ''`))
    // The before and after of every field an amendment changed; a void changes no field.
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addCheckConstraint(
      'assignment_corrections_amendment_lists_changes',
      sql`CASE WHEN jsonb_typeof(changes) = 'array' THEN (action = 'AMENDED') = (jsonb_array_length(changes) > 0) ELSE false END`
    )
    .execute();

  // An event is voided at most once.
  await sql`CREATE UNIQUE INDEX assignment_corrections_one_void
    ON assignment_corrections (event_id) WHERE action = 'VOIDED'`.execute(db);
  await db.schema
    .createIndex('idx_assignment_corrections_event')
    .on('assignment_corrections')
    .columns(['event_id', 'recorded_at', 'id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any correction record exists.
  const corrections = await sql<{ count: string }>`SELECT count(*)::text AS count FROM assignment_corrections`.execute(db);
  if (Number(corrections.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: assignment corrections exist');
  }

  await db.schema.dropTable('assignment_corrections').execute();
  await sql`DROP INDEX assignment_events_one_initial`.execute(db);
  await sql`CREATE UNIQUE INDEX assignment_events_one_initial ON assignment_events (asset_id) WHERE kind = 'INITIAL'`.execute(db);
  await db.schema.alterTable('assignment_events').dropColumn('is_voided').execute();
}
