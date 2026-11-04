import { Kysely, sql } from 'kysely';

// T4 (#25, D7-A): flat managed reference lists for Asset reference context. An Administrator
// adds, renames, deactivates and reactivates entries; nothing is deleted.
const REFERENCE_LIST_TABLES = ['locations', 'organization_units', 'persons'] as const;

// #25 PO decision 3: one history table records every add, rename, deactivation and reactivation
// (who, when, before → after); each row names exactly one entry, through that list's column.
const HISTORY_ENTRY_COLUMNS = [
  ['location_id', 'locations'],
  ['organization_unit_id', 'organization_units'],
  ['person_id', 'persons'],
] as const;

// Each Asset may name one entry per dimension, and keeps legacy text that matches no entry
// separately, as recorded (AR-06, AR-10). The T1 placeholder `organization_unit` column, never
// writable before D7, becomes the legacy OrganizationUnit text.
const ASSET_REFERENCE_COLUMNS = [
  ['location_id', 'locations'],
  ['organization_unit_id', 'organization_units'],
  ['responsible_person_id', 'persons'],
] as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const table of REFERENCE_LIST_TABLES) {
    await db.schema
      .createTable(table)
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
      .addColumn('name', 'varchar(200)', (col) => col.notNull().check(sql`btrim(name) <> ''`))
      .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
      .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version > 0`))
      .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
      .addColumn('updated_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
      .execute();

    // One entry per name, ignoring case and surrounding spaces.
    await sql`CREATE UNIQUE INDEX ${sql.ref(`${table}_name_unique`)} ON ${sql.table(table)} (lower(btrim(name)))`.execute(db);
  }

  let history = db.schema
    .createTable('reference_entry_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull());
  for (const [column, table] of HISTORY_ENTRY_COLUMNS) {
    history = history.addColumn(column, 'uuid', (col) => col.references(`${table}.id`).onDelete('restrict'));
  }
  await history
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version > 0`))
    .addColumn('action', 'varchar(20)', (col) => col.notNull().check(sql`action IN ('CREATED', 'CHANGED')`))
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('actor_id', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();
  await db.schema
    .alterTable('reference_entry_history')
    .addCheckConstraint(
      'reference_entry_history_one_entry',
      sql`num_nonnulls(location_id, organization_unit_id, person_id) = 1`
    )
    .execute();
  // One row per entry version; the index also serves each entry's history read.
  for (const [column] of HISTORY_ENTRY_COLUMNS) {
    await sql`CREATE UNIQUE INDEX ${sql.ref(`reference_entry_history_${column}_version`)}
      ON reference_entry_history (${sql.ref(column)}, version) WHERE ${sql.ref(column)} IS NOT NULL`.execute(db);
  }

  await db.schema.alterTable('assets').renameColumn('organization_unit', 'legacy_organization_unit_text').execute();
  await db.schema.alterTable('assets').alterColumn('legacy_organization_unit_text', (col) => col.setDataType('text')).execute();
  await db.schema.alterTable('assets').addColumn('legacy_location_text', 'text').execute();
  await db.schema.alterTable('assets').addColumn('legacy_responsible_person_text', 'text').execute();

  for (const [column, table] of ASSET_REFERENCE_COLUMNS) {
    await db.schema
      .alterTable('assets')
      .addColumn(column, 'uuid', (col) => col.references(`${table}.id`).onDelete('restrict'))
      .execute();
    await db.schema.createIndex(`idx_assets_${column}`).on('assets').column(column).execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback once any reference entry or Asset reference context exists.
  const entries = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM locations) + (SELECT count(*) FROM organization_units)
            + (SELECT count(*) FROM persons))::text AS count`.execute(db);
  const context = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM assets
    WHERE location_id IS NOT NULL OR organization_unit_id IS NOT NULL OR responsible_person_id IS NOT NULL
       OR legacy_location_text IS NOT NULL OR legacy_organization_unit_text IS NOT NULL
       OR legacy_responsible_person_text IS NOT NULL`.execute(db);
  if (Number(entries.rows[0]?.count || '0') > 0 || Number(context.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: reference entries or Asset reference context exist');
  }

  for (const [column] of ASSET_REFERENCE_COLUMNS) {
    await db.schema.alterTable('assets').dropColumn(column).execute();
  }
  await db.schema.alterTable('assets').dropColumn('legacy_responsible_person_text').execute();
  await db.schema.alterTable('assets').dropColumn('legacy_location_text').execute();
  await db.schema.alterTable('assets').alterColumn('legacy_organization_unit_text', (col) => col.setDataType('varchar')).execute();
  await db.schema.alterTable('assets').renameColumn('legacy_organization_unit_text', 'organization_unit').execute();

  // History rows exist only for entries, so the refusal above covers them too.
  await db.schema.dropTable('reference_entry_history').ifExists().execute();
  for (const table of [...REFERENCE_LIST_TABLES].reverse()) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
