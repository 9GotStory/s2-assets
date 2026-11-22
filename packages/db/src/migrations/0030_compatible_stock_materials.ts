import { Kysely, sql } from 'kysely';

// F009-T2 (#204, #202): the Compatible Stock Materials (วัสดุที่ใช้จ่ายได้) a Supply Officer confirms for a Requestable
// Material (MRQ-15, MRQ-26): one row per pair of Requestable Material and Stock Material, whether it is current, and
// no number of its own, as one Request Unit is one of that Unit of the Stock Material (P1, ADR 0002). A Stock Material
// may fulfil several Requestable Materials and the reverse (MRQ-27). Ending one makes it not current and adding it
// again makes the same row current; nothing is deleted (MRQ-30, Q8). The Requestable Material's history gains the
// kinds of an add and an end (Q17).

// The kinds of change a Requestable Material's history records before and after this migration (#202 Q17).
const HISTORY_KINDS_BEFORE = ['CREATED', 'RENAMED', 'DETAILS_CHANGED', 'INACTIVATED', 'REACTIVATED'];
const HISTORY_KINDS = [...HISTORY_KINDS_BEFORE, 'COMPATIBLE_STOCK_MATERIAL_ADDED', 'COMPATIBLE_STOCK_MATERIAL_ENDED'];

const replaceHistoryKinds = async (db: Kysely<any>, kinds: string[]): Promise<void> => {
  await sql`ALTER TABLE requestable_material_history DROP CONSTRAINT requestable_material_history_kind_check`.execute(db);
  await sql`ALTER TABLE requestable_material_history ADD CONSTRAINT requestable_material_history_kind_check
            CHECK (kind IN (${sql.join(kinds.map((kind) => sql.lit(kind)))}))`.execute(db);
};

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('compatible_stock_materials')
    .addColumn('requestable_material_id', 'uuid', (col) => col.references('requestable_materials.id').onDelete('restrict').notNull())
    .addColumn('stock_material_id', 'uuid', (col) => col.references('stock_materials.id').onDelete('restrict').notNull())
    // Current (ใช้อยู่) until ended (เลิกแล้ว); adding the pair again makes it current again (P1).
    .addColumn('is_current', 'boolean', (col) => col.defaultTo(true).notNull())
    .addPrimaryKeyConstraint('compatible_stock_materials_pkey', ['requestable_material_id', 'stock_material_id'])
    .execute();
  // The Requestable Materials a Stock Material fulfils, which the Units write of F009-T3 asks about (Q15).
  await db.schema.createIndex('idx_compatible_stock_materials_stock_material').on('compatible_stock_materials').column('stock_material_id').execute();

  // The new kinds are longer than the 30 characters 0029 allowed.
  await sql`ALTER TABLE requestable_material_history ALTER COLUMN kind TYPE varchar(40)`.execute(db);
  await replaceHistoryKinds(db, HISTORY_KINDS);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Compatible Stock Material, a history entry of an add or an end, or a retry
  // receipt of either exists (#202 P8).
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM compatible_stock_materials)
            + (SELECT count(*) FROM requestable_material_history WHERE kind IN ('COMPATIBLE_STOCK_MATERIAL_ADDED', 'COMPATIBLE_STOCK_MATERIAL_ENDED'))
            + (SELECT count(*) FROM registration_retry_tokens WHERE operation LIKE 'compatible-stock-material:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Compatible Stock Materials, their history or their retry receipts exist');
  }

  // The type first: changing it rebuilds the CHECK, which is then written as 0029 wrote it.
  await sql`ALTER TABLE requestable_material_history ALTER COLUMN kind TYPE varchar(30)`.execute(db);
  await replaceHistoryKinds(db, HISTORY_KINDS_BEFORE);
  await db.schema.dropTable('compatible_stock_materials').execute();
}
