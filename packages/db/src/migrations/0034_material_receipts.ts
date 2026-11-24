import { Kysely, sql } from 'kysely';

// F010-T3 (#234, #231): the Material Receipt (รายการรับวัสดุ) and its Receipt Lines, and the Receipt Line as the source
// of a รับวัสดุ Stock Movement (ADR 0003; #231 MRC-01–MRC-03, MRC-05–MRC-09, MSL-04, Q4–Q9, Q25, P1, P2, P7, P10).
// - A Material Receipt is a Draft (ร่าง) until confirmed (ยืนยันรับวัสดุ), then Received (รับแล้ว): confirm gives it a
//   Receipt Number from its own sequence, unique, never restarting, a number lost to a failed transaction left unused
//   (P1). Its version orders replace, remove and confirm. It names a Source Party and a Source Type, each optional.
// - A Receipt Line names a Stock Material and Unit pair once per Material Receipt; a Draft line may leave its Unit and
//   quantity out, and two lines of one Stock Material without a Unit yet may stand in a Draft (#234 start decision 1).
//   Its optional Unit Price is per Original Unit and has no stock effect (Q8). A Received line points at its one Stock
//   Movement in effect under a unique reference, and at none when voided (MSL-04); T6/T7 (#237, #238) void.
// - stock_movements takes the Receipt Line as a second source line and the รับวัสดุ kind (MATERIAL_RECEIPT); each kind
//   other than a Reversal names the source line of its own kind.
// - The history is append-only and starts at confirm, a Draft being no fact; T6/T7 write its other kinds.

// #231 Histories: confirmed (T3), corrected (T6) and voided (T7).
const HISTORY_KINDS = ['CONFIRMED', 'CORRECTED', 'VOIDED'];

// #231 Q9: a Material Receipt holds 0 to 50 lines, at positions 0 to 49.
const MAX_LINES = 50;

// The Stock Movement kinds before and after this migration (0032; #231 P2).
const KINDS_BEFORE = ['OPENING_BALANCE', 'REVERSAL'];
const KINDS_AFTER = ['OPENING_BALANCE', 'MATERIAL_RECEIPT', 'REVERSAL'];

const kindCheck = (kinds: string[]) => sql`kind IN (${sql.join(kinds.map((kind) => sql.lit(kind)))})`;

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE SEQUENCE material_receipt_numbers AS bigint`.execute(db);
  await db.schema
    .createTable('material_receipts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    // เลขที่รับ, taken at confirm (P1).
    .addColumn('receipt_number', 'bigint', (col) => col.unique())
    // วันที่รับ, required at confirm only (Q25).
    .addColumn('received_date', 'date')
    // แหล่งที่มา and วิธีได้มา, each absent when unknown (Q6, Q12).
    .addColumn('source_party_id', 'uuid', (col) => col.references('source_parties.id').onDelete('restrict'))
    .addColumn('source_type_id', 'uuid', (col) => col.references('source_types.id').onDelete('restrict'))
    // เอกสารอ้างอิง (Q7; P7: 500) and the note (P7: 2000).
    .addColumn('receipt_reference', 'varchar(500)', (col) => col.check(sql`btrim(receipt_reference) <> ''`))
    .addColumn('note', 'varchar(2000)', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    // Who confirmed it and when: its Recorded By and Recorded At (MRC-05).
    .addColumn('confirmed_by', 'uuid', (col) => col.references('users.id').onDelete('restrict'))
    .addColumn('confirmed_at', 'timestamptz')
    .addCheckConstraint(
      'material_receipts_confirmed_check',
      sql`(confirmed_at IS NULL) = (confirmed_by IS NULL)
          AND (confirmed_at IS NULL) = (receipt_number IS NULL)
          AND (confirmed_at IS NULL OR received_date IS NOT NULL)`
    )
    .execute();
  await sql`ALTER SEQUENCE material_receipt_numbers OWNED BY material_receipts.receipt_number`.execute(db);
  // The list, newest first (#234 start comment 7133951512).
  await db.schema.createIndex('idx_material_receipts_created_at').on('material_receipts').columns(['created_at desc', 'id desc']).execute();

  await db.schema
    .createTable('material_receipt_lines')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('material_receipt_id', 'uuid', (col) => col.references('material_receipts.id').onDelete('restrict').notNull())
    .addColumn('position', 'smallint', (col) => col.notNull().check(sql`position >= 0 AND position < ${sql.lit(MAX_LINES)}`))
    .addColumn('stock_material_id', 'uuid', (col) => col.references('stock_materials.id').onDelete('restrict').notNull())
    .addColumn('unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict'))
    .addColumn('quantity', 'numeric(18, 4)', (col) => col.check(sql`quantity > 0`))
    // ราคาต่อหน่วย, per Original Unit, when known (Q8).
    .addColumn('unit_price', 'numeric(18, 4)', (col) => col.check(sql`unit_price >= 0`))
    // P7: at most 500 characters.
    .addColumn('note', 'varchar(500)', (col) => col.check(sql`btrim(note) <> ''`))
    // Its one Stock Movement in effect (MSL-04); none while Draft and once voided.
    .addColumn('stock_movement_id', 'uuid', (col) => col.unique())
    .addColumn('is_voided', 'boolean', (col) => col.defaultTo(false).notNull())
    .addUniqueConstraint('material_receipt_lines_material_receipt_id_position_key', ['material_receipt_id', 'position'])
    // A Stock Material twice only in different Units (Q9); a line without its Unit yet names no pair.
    .addUniqueConstraint('material_receipt_lines_stock_material_unit_once', ['material_receipt_id', 'stock_material_id', 'unit_id'])
    .addCheckConstraint('material_receipt_lines_in_effect_check', sql`stock_movement_id IS NULL OR (unit_id IS NOT NULL AND quantity IS NOT NULL AND NOT is_voided)`)
    .execute();

  // The Receipt Line as a Stock Movement's source, and the รับวัสดุ kind (#231 P2).
  await sql`ALTER TABLE stock_movements ADD COLUMN material_receipt_line_id uuid REFERENCES material_receipt_lines (id) ON DELETE RESTRICT`.execute(db);
  await sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check`.execute(db);
  await sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (${kindCheck(KINDS_AFTER)})`.execute(db);
  await sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_one_source_line`.execute(db);
  await sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_one_source_line CHECK (num_nonnulls(opening_balance_line_id, material_receipt_line_id) = 1)`.execute(db);
  // A kind other than a Reversal names the source line of its own kind (CODING_STANDARDS, "A relaxed constraint").
  await sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_source_line
              CHECK ((kind <> 'OPENING_BALANCE' OR opening_balance_line_id IS NOT NULL) AND (kind <> 'MATERIAL_RECEIPT' OR material_receipt_line_id IS NOT NULL))`.execute(db);
  await sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_id_material_receipt_line_id_key UNIQUE (id, material_receipt_line_id)`.execute(db);
  await db.schema.createIndex('idx_stock_movements_material_receipt_line').on('stock_movements').column('material_receipt_line_id').execute();
  await sql`ALTER TABLE material_receipt_lines
              ADD CONSTRAINT material_receipt_lines_stock_movement_fkey
              FOREIGN KEY (stock_movement_id, id) REFERENCES stock_movements (id, material_receipt_line_id) ON DELETE RESTRICT`.execute(db);

  // A Material Receipt's history: one entry per version from confirm on, each holding the facts it records, with names
  // as they were then (#175 P6), and a reason for a correction or a void (T6, T7).
  await db.schema
    .createTable('material_receipt_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('material_receipt_id', 'uuid', (col) => col.references('material_receipts.id').onDelete('restrict').notNull())
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version >= 1`))
    .addColumn('kind', 'varchar(40)', (col) => col.notNull().check(sql`kind IN (${sql.join(HISTORY_KINDS.map((kind) => sql.lit(kind)))})`))
    .addColumn('facts', 'jsonb', (col) => col.notNull())
    // P7: at most 2000 characters.
    .addColumn('reason', 'varchar(2000)', (col) => col.check(sql`btrim(reason) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('material_receipt_history_material_receipt_id_version_key', ['material_receipt_id', 'version'])
    .addCheckConstraint('material_receipt_history_reason_by_kind', sql`(kind = 'CONFIRMED') = (reason IS NULL)`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Material Receipt or a retry receipt of its writes exists (#231 P10). Lines,
  // their Stock Movements and history exist only with their Material Receipt, so this covers them too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM material_receipts)
            + (SELECT count(*) FROM registration_retry_tokens WHERE operation LIKE 'material-receipt:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0].count) > 0) {
    throw new Error('Refusing destructive rollback: Material Receipts, their Stock Movements or their retry receipts exist');
  }

  await db.schema.dropTable('material_receipt_history').execute();
  await sql`ALTER TABLE material_receipt_lines DROP CONSTRAINT material_receipt_lines_stock_movement_fkey`.execute(db);
  await sql`DROP INDEX idx_stock_movements_material_receipt_line`.execute(db);
  await sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_id_material_receipt_line_id_key`.execute(db);
  await sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_source_line`.execute(db);
  await sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_one_source_line`.execute(db);
  await sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check`.execute(db);
  await sql`ALTER TABLE stock_movements DROP COLUMN material_receipt_line_id`.execute(db);
  await sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (${kindCheck(KINDS_BEFORE)})`.execute(db);
  await sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_one_source_line CHECK (num_nonnulls(opening_balance_line_id) = 1)`.execute(db);
  await db.schema.dropTable('material_receipt_lines').execute();
  // Dropping the table drops the sequence it owns.
  await db.schema.dropTable('material_receipts').execute();
}
