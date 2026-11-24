import { Kysely, sql } from 'kysely';

// F010-T1 (#232, #231 MRC-06, MRC-09, MRC-10, MRC-11, Q6, Q12, P7, P10): the Source Party (แหล่งที่มา) and Source Type
// (วิธีได้มา) lists, each following the Brand list of 0027_brands_material_categories: one entry per name ignoring case
// and repeated spaces, Inactive entries included, and a history of its own. A Source Party also holds an optional note
// (#232 decision 1). Nothing is seeded (Q6). Material Receipts name them from T3 (#234).

// Each list, with its history table and the column of the history that names one of its entries.
const LISTS = [
  { table: 'source_parties', history: 'source_party_history', column: 'source_party_id' },
  { table: 'source_types', history: 'source_type_history', column: 'source_type_id' },
] as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const { table, history, column } of LISTS) {
    let entries = db.schema
      .createTable(table)
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
      .addColumn('name', 'varchar(200)', (col) => col.notNull().check(sql`btrim(name) <> ''`));
    if (table === 'source_parties') {
      entries = entries.addColumn('note', 'varchar(2000)', (col) => col.check(sql`btrim(note) <> ''`));
    }
    await entries
      .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
      .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version > 0`))
      .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
      .addColumn('updated_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
      .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
      .execute();
    await sql`CREATE UNIQUE INDEX ${sql.ref(`${table}_name_unique`)} ON ${sql.table(table)} (lower(regexp_replace(btrim(name), ' +', ' ', 'g')))`.execute(db);

    // One maintenance change of an entry, at the entry version it produced, as in brand_history.
    await db.schema
      .createTable(history)
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
      .addColumn(column, 'uuid', (col) => col.references(`${table}.id`).onDelete('restrict').notNull())
      .addColumn('version', 'integer', (col) => col.notNull().check(sql`version > 0`))
      .addColumn('action', 'varchar(20)', (col) => col.notNull().check(sql`action IN ('CREATED', 'CHANGED')`))
      .addColumn('changes', 'jsonb', (col) => col.notNull())
      .addColumn('actor_id', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
      .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
      .addUniqueConstraint(`${history}_${column}_version`, [column, 'version'])
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Source Party, a Source Type or a retry receipt of theirs exists (P10). An
  // entry's history exists only with the entry, so this covers it too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM source_parties) + (SELECT count(*) FROM source_types)
            + (SELECT count(*) FROM registration_retry_tokens
               WHERE operation LIKE 'source-party:%' OR operation LIKE 'source-type:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Source Parties, Source Types or their retry receipts exist');
  }

  for (const { table, history } of [...LISTS].reverse()) {
    await db.schema.dropTable(history).execute();
    await db.schema.dropTable(table).execute();
  }
}
