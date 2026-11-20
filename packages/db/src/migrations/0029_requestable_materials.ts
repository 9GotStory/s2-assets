import { Kysely, sql } from 'kysely';

// F009-T1 (#203, #202): the Requestable Material (วัสดุสำหรับขอเบิก) kept by the Supply Officer (Q5): a name in the
// words of the work, unique ignoring case and repeated spaces, Inactive ones included (Q6), as for the Unit list of
// 0025_material_catalog; one Request Unit (หน่วยที่ขอ) from the shared Unit list (MRQ-28); whether its quantities must
// be whole; a description; Inactive from T7; and a version (Q17). Its history is append-only and takes the kinds T7
// and T8 write too, so they need no migration (#203 decision 2, comment 7041198954); T2 adds its own kinds.

// The kinds of change a Requestable Material's history records up to T8, but those of T2 (Q17).
const HISTORY_KINDS = ['CREATED', 'RENAMED', 'DETAILS_CHANGED', 'INACTIVATED', 'REACTIVATED'];

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('requestable_materials')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull().check(sql`btrim(name) <> ''`))
    .addColumn('request_unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict').notNull())
    // Whole-number-only by default (Q5).
    .addColumn('whole_number_only', 'boolean', (col) => col.defaultTo(true).notNull())
    // #202 P7: at most 2000 characters.
    .addColumn('description', 'varchar(2000)', (col) => col.check(sql`btrim(description) <> ''`))
    // Inactive (หยุดใช้) from F009-T7; nothing is deleted (Q6).
    .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
    // The version a write on the Requestable Material expects (Q17).
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();
  // One Requestable Material per name, ignoring case and repeated spaces, Inactive ones included (Q6).
  await sql`CREATE UNIQUE INDEX requestable_materials_name_unique ON requestable_materials (lower(regexp_replace(btrim(name), ' +', ' ', 'g')))`.execute(db);
  await db.schema.createIndex('idx_requestable_materials_request_unit').on('requestable_materials').column('request_unit_id').execute();

  // A Requestable Material's history: one entry per change, at the version it produced, with the before and after of
  // each value it recorded, the Unit name as it was then (Q17, #175 P6). Nothing updates or deletes an entry.
  await db.schema
    .createTable('requestable_material_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('requestable_material_id', 'uuid', (col) => col.references('requestable_materials.id').onDelete('restrict').notNull())
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version >= 1`))
    .addColumn('kind', 'varchar(30)', (col) => col.notNull().check(sql`kind IN (${sql.join(HISTORY_KINDS.map((kind) => sql.lit(kind)))})`))
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('requestable_material_history_requestable_material_id_version', ['requestable_material_id', 'version'])
    .addCheckConstraint('requestable_material_history_lists_changes', sql`jsonb_typeof(changes) = 'array' AND changes <> '[]'::jsonb`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Requestable Material or a retry receipt of its writes exists (#202 P8).
  // History exists only with its entry, so this covers it too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM requestable_materials)
            + (SELECT count(*) FROM registration_retry_tokens WHERE operation LIKE 'requestable-material:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Requestable Materials or their retry receipts exist');
  }

  await db.schema.dropTable('requestable_material_history').execute();
  await db.schema.dropTable('requestable_materials').execute();
}
