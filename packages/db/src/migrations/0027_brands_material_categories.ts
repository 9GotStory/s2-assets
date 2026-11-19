import { Kysely, sql } from 'kysely';

// F008-T4 (#179, #175 Q28): the Brand (ยี่ห้อ) and Material Category (หมวดวัสดุ) lists, each following the Unit list of
// 0025_material_catalog: one entry per name ignoring case and repeated spaces, Inactive entries included (Q20), and
// a history of its own (P5, P6). Nothing is seeded (Q3). A Stock Material names at most one of each (MC-12, MC-26),
// and its history gains the kind of a change of other details (Q11).

// Each list, with its history table and the column that names one of its entries in both.
const LISTS = [
  { table: 'brands', history: 'brand_history', column: 'brand_id' },
  { table: 'material_categories', history: 'material_category_history', column: 'material_category_id' },
] as const;

// The kinds of change a Stock Material's history records before and after this migration (#175 Q18).
const HISTORY_KINDS_BEFORE = ['CREATED', 'CORRECTED', 'UNITS_CHANGED', 'INACTIVATED', 'REACTIVATED'];
const HISTORY_KINDS = [...HISTORY_KINDS_BEFORE, 'DETAILS_CHANGED'];

const replaceHistoryKinds = async (db: Kysely<any>, kinds: string[]): Promise<void> => {
  await sql`ALTER TABLE stock_material_history DROP CONSTRAINT stock_material_history_kind_check`.execute(db);
  await sql`ALTER TABLE stock_material_history ADD CONSTRAINT stock_material_history_kind_check
            CHECK (kind IN (${sql.join(kinds.map((kind) => sql.lit(kind)))}))`.execute(db);
};

export async function up(db: Kysely<any>): Promise<void> {
  for (const { table, history, column } of LISTS) {
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
    await sql`CREATE UNIQUE INDEX ${sql.ref(`${table}_name_unique`)} ON ${sql.table(table)} (lower(regexp_replace(btrim(name), ' +', ' ', 'g')))`.execute(db);

    // One maintenance change of an entry, at the entry version it produced, as in unit_history.
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

    await db.schema.alterTable('stock_materials').addColumn(column, 'uuid', (col) => col.references(`${table}.id`).onDelete('restrict')).execute();
    await db.schema.createIndex(`idx_stock_materials_${column}`).on('stock_materials').column(column).execute();
  }

  await replaceHistoryKinds(db, HISTORY_KINDS);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Brand, a Material Category, a change of other details or a retry receipt
  // of theirs exists (#175 Q28). A Stock Material names an entry only while it exists, so this covers that too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM brands) + (SELECT count(*) FROM material_categories)
            + (SELECT count(*) FROM stock_material_history WHERE kind = 'DETAILS_CHANGED')
            + (SELECT count(*) FROM registration_retry_tokens
               WHERE operation LIKE 'brand:%' OR operation LIKE 'material-category:%' OR operation = 'stock-material:details'))::text AS count`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Brands, Material Categories, changes of other details or their retry receipts exist');
  }

  await replaceHistoryKinds(db, HISTORY_KINDS_BEFORE);
  for (const { table, history, column } of [...LISTS].reverse()) {
    await db.schema.alterTable('stock_materials').dropColumn(column).execute();
    await db.schema.dropTable(history).execute();
    await db.schema.dropTable(table).execute();
  }
}
