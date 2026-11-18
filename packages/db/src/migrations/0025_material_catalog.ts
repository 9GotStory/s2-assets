import { Kysely, sql } from 'kysely';

// F008-T1 (#176, #175): the Stock Material catalog kept by the new Supply Officer role (Q1, P8). The Unit list
// follows the Reference List pattern of Feature 002, with a history of its own (P5, P6). A Stock Material has its
// Units, exactly one of them its Base Unit (MC-04), and an append-only history (Q18). The history and the Units
// already hold what T3, T5 and T7 write (Alternate Units, a Material Correction, Inactive), so those need no
// migration.

// Every kind of change a Stock Material's history records (#175 Q18).
const HISTORY_KINDS = ['CREATED', 'CORRECTED', 'DETAILS_CHANGED', 'UNITS_CHANGED', 'MINIMUM_STOCK_CHANGED', 'INACTIVATED', 'REACTIVATED'];

export async function up(db: Kysely<any>): Promise<void> {
  await sql`INSERT INTO roles (id, description) VALUES ('SUPPLY_OFFICER', 'Supply Officer')`.execute(db);

  await db.schema
    .createTable('units')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull().check(sql`btrim(name) <> ''`))
    .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version > 0`))
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('updated_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();
  // One entry per name, ignoring case and repeated spaces, Inactive entries included (#175 Q20).
  await sql`CREATE UNIQUE INDEX units_name_unique ON units (lower(regexp_replace(btrim(name), ' +', ' ', 'g')))`.execute(db);

  // One maintenance change of a Unit list entry, at the entry version it produced, as in reference_entry_history.
  await db.schema
    .createTable('unit_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict').notNull())
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version > 0`))
    .addColumn('action', 'varchar(20)', (col) => col.notNull().check(sql`action IN ('CREATED', 'CHANGED')`))
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('actor_id', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('unit_history_unit_id_version', ['unit_id', 'version'])
    .execute();

  await db.schema
    .createTable('stock_materials')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull().check(sql`btrim(name) <> ''`))
    .addColumn('model', 'varchar(200)', (col) => col.check(sql`btrim(model) <> ''`))
    .addColumn('specification', 'varchar(500)', (col) => col.check(sql`btrim(specification) <> ''`))
    .addColumn('note', 'text', (col) => col.check(sql`btrim(note) <> ''`))
    // Inactive (หยุดใช้) from F008-T7; nothing is deleted (#175 Q13).
    .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
    // The version a write on the Stock Material expects (#175 Q23).
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();

  // One Unit of a Stock Material (#175 Q5, Q6, P1): its Base Unit converts at 1 and is never Inactive; an
  // Alternate Unit converts straight to the Base Unit at a factor above 0, kept exactly to four decimal places.
  await db.schema
    .createTable('stock_material_units')
    .addColumn('stock_material_id', 'uuid', (col) => col.references('stock_materials.id').onDelete('restrict').notNull())
    .addColumn('unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict').notNull())
    .addColumn('is_base', 'boolean', (col) => col.notNull())
    .addColumn('conversion_factor', 'numeric(18, 4)', (col) => col.notNull().check(sql`conversion_factor > 0`))
    .addColumn('whole_number_only', 'boolean', (col) => col.defaultTo(true).notNull())
    .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
    .addPrimaryKeyConstraint('stock_material_units_pkey', ['stock_material_id', 'unit_id'])
    .addCheckConstraint('stock_material_units_base_unit', sql`NOT is_base OR (conversion_factor = 1 AND is_active)`)
    .execute();
  // At most one Base Unit per Stock Material; the service writes exactly one with it (MC-04).
  await sql`CREATE UNIQUE INDEX stock_material_units_one_base_unit ON stock_material_units (stock_material_id) WHERE is_base`.execute(db);
  await sql`CREATE INDEX idx_stock_material_units_unit ON stock_material_units (unit_id)`.execute(db);

  // A Stock Material's history: one entry per change, at the version it produced, with the before and after of each
  // value it recorded, Unit names as they were then (#175 Q18, P6). Nothing updates or deletes an entry.
  await db.schema
    .createTable('stock_material_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('stock_material_id', 'uuid', (col) => col.references('stock_materials.id').onDelete('restrict').notNull())
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version >= 1`))
    .addColumn('kind', 'varchar(30)', (col) => col.notNull().check(sql`kind IN (${sql.join(HISTORY_KINDS.map((kind) => sql.lit(kind)))})`))
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    // A Material Correction's reason (Q11).
    .addColumn('reason', 'text', (col) => col.check(sql`btrim(reason) <> ''`))
    // The note made with an Inactive (Q13).
    .addColumn('note', 'text', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('stock_material_history_stock_material_id_version', ['stock_material_id', 'version'])
    .addCheckConstraint('stock_material_history_lists_changes', sql`jsonb_typeof(changes) = 'array' AND changes <> '[]'::jsonb`)
    .addCheckConstraint('stock_material_history_reason_with_correction', sql`(kind = 'CORRECTED') = (reason IS NOT NULL)`)
    .addCheckConstraint('stock_material_history_note_with_inactive', sql`note IS NULL OR kind = 'INACTIVATED'`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Supply Officer, a Unit, a Stock Material or a catalog retry receipt
  // exists (#175 P8). Unit and Stock Material history exists only with its entry, so this covers it too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM user_roles WHERE role_id = 'SUPPLY_OFFICER')
            + (SELECT count(*) FROM units) + (SELECT count(*) FROM stock_materials)
            + (SELECT count(*) FROM registration_retry_tokens WHERE operation LIKE 'unit:%' OR operation LIKE 'stock-material:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Supply Officers, Units, Stock Materials or catalog retry receipts exist');
  }

  await db.schema.dropTable('stock_material_history').execute();
  await db.schema.dropTable('stock_material_units').execute();
  await db.schema.dropTable('stock_materials').execute();
  await db.schema.dropTable('unit_history').execute();
  await db.schema.dropTable('units').execute();
  await sql`DELETE FROM roles WHERE id = 'SUPPLY_OFFICER'`.execute(db);
}
