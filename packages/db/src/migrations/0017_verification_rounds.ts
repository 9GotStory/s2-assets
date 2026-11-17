import { Kysely, sql } from 'kysely';

// F006-T1 (#126, #125): a Verification Round records one check of a fixed set of Assets, its Scope Snapshot,
// and its history. The scope entries and the history already hold what the later tickets write (a Late
// Addition; an edit, close, reopen or void), so those need no migration. Verification Staff is a new role.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`INSERT INTO roles (id, description) VALUES ('VERIFICATION_STAFF', 'Verification Staff')`.execute(db);

  await db.schema
    .createTable('verification_rounds')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('name', 'text', (col) => col.notNull().check(sql`btrim(name) <> ''`))
    // A Buddhist-era year used as a label only (#125 Q2).
    .addColumn('fiscal_year', 'integer', (col) => col.notNull().check(sql`fiscal_year BETWEEN 1000 AND 9999`))
    .addColumn('start_date', 'date', (col) => col.notNull())
    .addColumn('notes', 'text', (col) => col.check(sql`btrim(notes) <> ''`))
    .addColumn('state', 'varchar(10)', (col) => col.defaultTo('OPEN').notNull().check(sql`state IN ('OPEN', 'CLOSED', 'VOIDED')`))
    .addColumn('opened_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .execute();

  // #125 Q17: at most one Round is open at a time.
  await sql`CREATE UNIQUE INDEX verification_rounds_one_open ON verification_rounds (state) WHERE state = 'OPEN'`.execute(db);

  // The OrganizationUnits and Locations a Round was opened with; a Round with none covers the whole register (Q3).
  await db.schema
    .createTable('verification_round_filters')
    .addColumn('verification_round_id', 'uuid', (col) => col.references('verification_rounds.id').onDelete('restrict').notNull())
    .addColumn('organization_unit_id', 'uuid', (col) => col.references('organization_units.id').onDelete('restrict'))
    .addColumn('location_id', 'uuid', (col) => col.references('locations.id').onDelete('restrict'))
    .addCheckConstraint('verification_round_filters_one_entry', sql`num_nonnulls(organization_unit_id, location_id) = 1`)
    .addUniqueConstraint('verification_round_filters_organization_unit', ['verification_round_id', 'organization_unit_id'])
    .addUniqueConstraint('verification_round_filters_location', ['verification_round_id', 'location_id'])
    .execute();

  // One Asset in a Round, with how it joined and the Scope Snapshot taken then (#125 Q4, Q11, Q15). No write
  // updates a snapshot: the stored values are the record.
  await db.schema
    .createTable('verification_scope_entries')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('verification_round_id', 'uuid', (col) => col.references('verification_rounds.id').onDelete('restrict').notNull())
    .addColumn('asset_id', 'uuid', (col) => col.references('assets.id').onDelete('restrict').notNull())
    .addColumn('joined_as', 'varchar(20)', (col) => col.notNull().check(sql`joined_as IN ('OPENING', 'LATE_ADDITION')`))
    // A Late Addition's reason; who added it and when are recorded_by and recorded_at, as for an opening entry.
    .addColumn('reason', 'text', (col) => col.check(sql`btrim(reason) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('asset_number', 'varchar')
    .addColumn('serial_number', 'varchar')
    .addColumn('name', 'varchar')
    .addColumn('category', 'varchar')
    // The Current Assignment when the Asset joined, each dimension an entry, read by its current name, and Legacy text.
    .addColumn('location_id', 'uuid', (col) => col.references('locations.id').onDelete('restrict'))
    .addColumn('legacy_location_text', 'text')
    .addColumn('organization_unit_id', 'uuid', (col) => col.references('organization_units.id').onDelete('restrict'))
    .addColumn('legacy_organization_unit_text', 'text')
    .addColumn('responsible_person_id', 'uuid', (col) => col.references('persons.id').onDelete('restrict'))
    .addColumn('legacy_responsible_person_text', 'text')
    // The version a write on the entry's current result expects (#125 AV-23).
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .addCheckConstraint('verification_scope_entries_late_addition_reason', sql`(joined_as = 'LATE_ADDITION') = (reason IS NOT NULL)`)
    .addUniqueConstraint('verification_scope_entries_verification_round_id_asset_id', ['verification_round_id', 'asset_id'])
    .execute();
  await sql`CREATE INDEX idx_verification_scope_entries_asset ON verification_scope_entries (asset_id)`.execute(db);

  // A Round's history: one event per open, edit, close, reopen or void (#125 Q10, Q27, Q28, P4).
  await db.schema
    .createTable('verification_round_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('verification_round_id', 'uuid', (col) => col.references('verification_rounds.id').onDelete('restrict').notNull())
    .addColumn('kind', 'varchar(10)', (col) => col.notNull().check(sql`kind IN ('OPENED', 'EDITED', 'CLOSED', 'REOPENED', 'VOIDED')`))
    .addColumn('reason', 'text', (col) => col.check(sql`btrim(reason) <> ''`))
    // An edit's before and after of each field it changed.
    .addColumn('changes', 'jsonb', (col) => col.defaultTo(sql`'[]'::jsonb`).notNull())
    // A close's counts at that moment.
    .addColumn('found_count', 'integer', (col) => col.check(sql`found_count >= 0`))
    .addColumn('not_found_count', 'integer', (col) => col.check(sql`not_found_count >= 0`))
    .addColumn('not_yet_verified_count', 'integer', (col) => col.check(sql`not_yet_verified_count >= 0`))
    .addColumn('discrepancy_count', 'integer', (col) => col.check(sql`discrepancy_count >= 0`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addCheckConstraint('verification_round_events_reason_required', sql`kind NOT IN ('REOPENED', 'VOIDED') OR reason IS NOT NULL`)
    .addCheckConstraint(
      'verification_round_events_edit_lists_changes',
      sql`jsonb_typeof(changes) = 'array' AND (kind = 'EDITED') = (changes <> '[]'::jsonb)`
    )
    .addCheckConstraint(
      'verification_round_events_close_counts',
      sql`(kind = 'CLOSED') = (num_nonnulls(found_count, not_found_count, not_yet_verified_count, discrepancy_count) = 4)
          AND num_nulls(found_count, not_found_count, not_yet_verified_count, discrepancy_count) IN (0, 4)`
    )
    .execute();
  await sql`CREATE INDEX idx_verification_round_events_round ON verification_round_events (verification_round_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any Round, Verification retry receipt or Verification Staff user exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM verification_rounds`.execute(db);
  const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM registration_retry_tokens WHERE operation LIKE 'verification:%'`.execute(db);
  const holders = await sql<{ count: string }>`SELECT count(*)::text AS count FROM user_roles WHERE role_id = 'VERIFICATION_STAFF'`.execute(db);
  if ([facts, receipts, holders].some((res) => Number(res.rows[0]?.count || '0') > 0)) {
    throw new Error('Refusing destructive rollback: Verification Rounds, Verification retry receipts or Verification Staff users exist');
  }

  await db.schema.dropTable('verification_round_events').execute();
  await db.schema.dropTable('verification_scope_entries').execute();
  await db.schema.dropTable('verification_round_filters').execute();
  await db.schema.dropTable('verification_rounds').execute();
  await sql`DELETE FROM roles WHERE id = 'VERIFICATION_STAFF'`.execute(db);
}
