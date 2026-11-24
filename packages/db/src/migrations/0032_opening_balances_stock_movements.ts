import { Kysely, sql } from 'kysely';

// F010-T2 (#233, #231): the Opening Balance (ยอดตั้งต้น) and the Stock Movement (รายการเคลื่อนไหว) table that
// Features 010 to 014 share (ADR 0003; #231 Q13, Q20, Q26, Q28, P1, P2, P10).
// - An Opening Balance is a Draft (ร่าง) until confirmed (ยืนยันแล้ว); confirm gives it a number from its own sequence,
//   unique, a number lost to a failed transaction left unused (P10). Its version orders replace, remove and confirm.
// - Each line names a Stock Material once per Opening Balance; a Draft line may leave its Unit and quantity out (#233
//   start decision 1). A confirmed line points at its one Stock Movement in effect under a unique reference, and at none
//   when voided (MSL-04); T7 (#238) voids.
// - A Stock Movement has exactly one source line (a CHECK that T3 widens with the Receipt Line), its Conversion Snapshot
//   and a signed Base Quantity; a Reversal names the one it reverses, at most once (T6 uses it). A trigger refuses every
//   UPDATE, DELETE and TRUNCATE (#231 story 61). No Current Stock is stored (MSL-06).
// - The history is append-only and starts at confirm, a Draft being no fact; T6/T7 write its other kinds.

// #231 P2: the kinds of Stock Movement Feature 010 writes so far; T3 adds the Material Receipt's.
const STOCK_MOVEMENT_KINDS = ['OPENING_BALANCE', 'REVERSAL'];

// #231 Histories: confirmed (T2), corrected and voided (T7).
const HISTORY_KINDS = ['CONFIRMED', 'CORRECTED', 'VOIDED'];

// #231 Q25: an Opening Balance holds 0 to 50 lines, at positions 0 to 49.
const MAX_LINES = 50;

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE SEQUENCE opening_balance_numbers AS bigint`.execute(db);
  await db.schema
    .createTable('opening_balances')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    // "เลขที่ยอดตั้งต้น <n>", taken at confirm (P10).
    .addColumn('opening_balance_number', 'bigint', (col) => col.unique())
    // ยอด ณ วันที่ and ที่มาของยอด (P7: 500), required at confirm only (Q25).
    .addColumn('as_of_date', 'date')
    .addColumn('source', 'varchar(500)', (col) => col.check(sql`btrim(source) <> ''`))
    // P7: at most 2000 characters.
    .addColumn('note', 'varchar(2000)', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    // Who confirmed it and when: its Recorded By and Recorded At.
    .addColumn('confirmed_by', 'uuid', (col) => col.references('users.id').onDelete('restrict'))
    .addColumn('confirmed_at', 'timestamptz')
    .addCheckConstraint(
      'opening_balances_confirmed_check',
      sql`(confirmed_at IS NULL) = (confirmed_by IS NULL)
          AND (confirmed_at IS NULL) = (opening_balance_number IS NULL)
          AND (confirmed_at IS NULL OR (as_of_date IS NOT NULL AND source IS NOT NULL))`
    )
    .execute();
  await sql`ALTER SEQUENCE opening_balance_numbers OWNED BY opening_balances.opening_balance_number`.execute(db);
  // The list, newest first (#233 start decision 4).
  await db.schema.createIndex('idx_opening_balances_created_at').on('opening_balances').columns(['created_at desc', 'id desc']).execute();

  await db.schema
    .createTable('opening_balance_lines')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('opening_balance_id', 'uuid', (col) => col.references('opening_balances.id').onDelete('restrict').notNull())
    .addColumn('position', 'smallint', (col) => col.notNull().check(sql`position >= 0 AND position < ${sql.lit(MAX_LINES)}`))
    .addColumn('stock_material_id', 'uuid', (col) => col.references('stock_materials.id').onDelete('restrict').notNull())
    .addColumn('unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict'))
    .addColumn('quantity', 'numeric(18, 4)', (col) => col.check(sql`quantity > 0`))
    // P7: at most 500 characters.
    .addColumn('note', 'varchar(500)', (col) => col.check(sql`btrim(note) <> ''`))
    // Its one Stock Movement in effect (MSL-04); none while Draft and once voided.
    .addColumn('stock_movement_id', 'uuid', (col) => col.unique())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addUniqueConstraint('opening_balance_lines_opening_balance_id_position_key', ['opening_balance_id', 'position'])
    // Each Stock Material at most once per Opening Balance (Q13, story 42).
    .addUniqueConstraint('opening_balance_lines_stock_material_once', ['opening_balance_id', 'stock_material_id'])
    .addCheckConstraint('opening_balance_lines_in_effect_check', sql`stock_movement_id IS NULL OR (unit_id IS NOT NULL AND quantity IS NOT NULL AND NOT is_voided)`)
    .execute();
  // A Stock Material is in effect in at most one Opening Balance (Q20, story 63): the lock check's backstop.
  await sql`CREATE UNIQUE INDEX opening_balance_lines_one_in_effect_per_stock_material ON opening_balance_lines (stock_material_id) WHERE stock_movement_id IS NOT NULL`.execute(db);

  await db.schema
    .createTable('stock_movements')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('stock_material_id', 'uuid', (col) => col.references('stock_materials.id').onDelete('restrict').notNull())
    .addColumn('kind', 'varchar(40)', (col) => col.notNull().check(sql`kind IN (${sql.join(STOCK_MOVEMENT_KINDS.map((kind) => sql.lit(kind)))})`))
    // Its source line; later features add their columns to stock_movements_one_source_line.
    .addColumn('opening_balance_line_id', 'uuid', (col) => col.references('opening_balance_lines.id').onDelete('restrict'))
    // For a Reversal, the Stock Movement it takes back, which is reversed at most once.
    .addColumn('reverses_stock_movement_id', 'uuid', (col) => col.references('stock_movements.id').onDelete('restrict').unique())
    .addColumn('effective_date', 'date', (col) => col.notNull())
    .addColumn('original_quantity', 'numeric(18, 4)', (col) => col.notNull().check(sql`original_quantity > 0`))
    .addColumn('original_unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict').notNull())
    // The Conversion Snapshot: the Base Unit and the factor of the Original Unit then.
    .addColumn('base_unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict').notNull())
    .addColumn('conversion_factor', 'numeric(18, 4)', (col) => col.notNull().check(sql`conversion_factor > 0`))
    // Signed: a Reversal takes stock back.
    .addColumn('base_quantity', 'numeric(18, 4)', (col) => col.notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addCheckConstraint('stock_movements_one_source_line', sql`num_nonnulls(opening_balance_line_id) = 1`)
    .addCheckConstraint(
      'stock_movements_reversal_check',
      sql`(kind = 'REVERSAL') = (reverses_stock_movement_id IS NOT NULL) AND (CASE WHEN kind = 'REVERSAL' THEN base_quantity < 0 ELSE base_quantity > 0 END)`
    )
    // A source line's reference names a movement of that line.
    .addUniqueConstraint('stock_movements_id_opening_balance_line_id_key', ['id', 'opening_balance_line_id'])
    .execute();
  // Current Stock and the running balance of one Stock Material, by Effective Date then Recorded At (#231 P3).
  await db.schema.createIndex('idx_stock_movements_stock_material').on('stock_movements').columns(['stock_material_id', 'effective_date', 'recorded_at', 'id']).execute();
  await sql`ALTER TABLE opening_balance_lines
              ADD CONSTRAINT opening_balance_lines_stock_movement_fkey
              FOREIGN KEY (stock_movement_id, id) REFERENCES stock_movements (id, opening_balance_line_id) ON DELETE RESTRICT`.execute(db);

  // Nobody changes or removes a Stock Movement, not even through the database (#231 story 61, Q26, P2).
  await sql`CREATE FUNCTION refuse_stock_movement_change() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'Stock Movements are append-only: % refused', TG_OP USING ERRCODE = 'restrict_violation';
            END
            $$`.execute(db);
  await sql`CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
            FOR EACH ROW EXECUTE FUNCTION refuse_stock_movement_change()`.execute(db);
  await sql`CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
            FOR EACH STATEMENT EXECUTE FUNCTION refuse_stock_movement_change()`.execute(db);

  // An Opening Balance's history: one entry per version from confirm on, each holding the facts it records, with names
  // as they were then (#175 P6), and a reason for a correction or a void (T7).
  await db.schema
    .createTable('opening_balance_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('opening_balance_id', 'uuid', (col) => col.references('opening_balances.id').onDelete('restrict').notNull())
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version >= 1`))
    .addColumn('kind', 'varchar(40)', (col) => col.notNull().check(sql`kind IN (${sql.join(HISTORY_KINDS.map((kind) => sql.lit(kind)))})`))
    .addColumn('facts', 'jsonb', (col) => col.notNull())
    // P7: at most 2000 characters.
    .addColumn('reason', 'varchar(2000)', (col) => col.check(sql`btrim(reason) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('opening_balance_history_opening_balance_id_version_key', ['opening_balance_id', 'version'])
    .addCheckConstraint('opening_balance_history_reason_by_kind', sql`(kind = 'CONFIRMED') = (reason IS NULL)`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while an Opening Balance, a Stock Movement or a retry receipt of their writes exists
  // (#231 P10). Lines and history exist only with their Opening Balance, so this covers them too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM opening_balances)
            + (SELECT count(*) FROM stock_movements)
            + (SELECT count(*) FROM registration_retry_tokens WHERE operation LIKE 'opening-balance:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0].count) > 0) {
    throw new Error('Refusing destructive rollback: Opening Balances, Stock Movements or their retry receipts exist');
  }

  await db.schema.dropTable('opening_balance_history').execute();
  await sql`ALTER TABLE opening_balance_lines DROP CONSTRAINT opening_balance_lines_stock_movement_fkey`.execute(db);
  await db.schema.dropTable('stock_movements').execute();
  await sql`DROP FUNCTION refuse_stock_movement_change()`.execute(db);
  await db.schema.dropTable('opening_balance_lines').execute();
  // Dropping the table drops the sequence it owns.
  await db.schema.dropTable('opening_balances').execute();
}
