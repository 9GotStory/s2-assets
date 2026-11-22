import { Kysely, sql } from 'kysely';

// F009-T4 (#206, #202): the Requester (ผู้ขอเบิก) and the Material Request (คำขอเบิก) (Q1, Q10, Q13, Q14). A Material
// Request is named by a Request Number (เลขที่คำขอ) from a sequence, unique, a number lost to a failed transaction left
// unused (Q14, Q20, P3), and carries a version for the Cancels of T5 (P4). Each Requested Item (รายการที่ขอ) asks for
// one Requestable Material once, with its Requested Quantity (จำนวนที่ขอ) in NUMERIC(18,4) and the Request Unit as
// recorded (P3); it is Pending until Cancelled, and holds T5's Cancel facts already, so T5 needs no migration. The
// history is append-only and takes T5's kinds too. Nothing here is stock (MRQ-05, MRQ-07).

// The kinds of entry a Material Request's history records: created (T4), and the two Cancels of T5 (#202 Model).
const HISTORY_KINDS = ['CREATED', 'REQUESTED_ITEM_CANCELLED', 'MATERIAL_REQUEST_CANCELLED'];

// #202 Q10: a Material Request holds 1 to 50 Requested Items, at positions 0 to 49 in the order asked.
const MAX_REQUESTED_ITEMS = 50;

export async function up(db: Kysely<any>): Promise<void> {
  await sql`INSERT INTO roles (id, description) VALUES ('REQUESTER', 'Requester')`.execute(db);

  await sql`CREATE SEQUENCE material_request_numbers AS bigint`.execute(db);
  await db.schema
    .createTable('material_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('request_number', 'bigint', (col) => col.notNull().unique().defaultTo(sql`nextval('material_request_numbers')`))
    // The account that created it (Q3).
    .addColumn('requested_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    // #202 P7: at most 2000 characters.
    .addColumn('note', 'varchar(2000)', (col) => col.check(sql`btrim(note) <> ''`))
    // The version a Cancel expects (P4).
    .addColumn('version', 'integer', (col) => col.defaultTo(1).notNull().check(sql`version >= 1`))
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();
  await sql`ALTER SEQUENCE material_request_numbers OWNED BY material_requests.request_number`.execute(db);
  // "คำขอของฉัน": a Requester's Material Requests, newest first (Q19).
  await db.schema.createIndex('idx_material_requests_requested_by').on('material_requests').columns(['requested_by', 'request_number desc']).execute();

  await db.schema
    .createTable('requested_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('material_request_id', 'uuid', (col) => col.references('material_requests.id').onDelete('restrict').notNull())
    .addColumn('position', 'smallint', (col) => col.notNull().check(sql`position >= 0 AND position < ${sql.lit(MAX_REQUESTED_ITEMS)}`))
    .addColumn('requestable_material_id', 'uuid', (col) => col.references('requestable_materials.id').onDelete('restrict').notNull())
    .addColumn('requested_quantity', 'numeric(18, 4)', (col) => col.notNull().check(sql`requested_quantity > 0`))
    // The Request Unit as recorded (P3).
    .addColumn('request_unit_id', 'uuid', (col) => col.references('units.id').onDelete('restrict').notNull())
    // #202 P7: at most 500 characters.
    .addColumn('note', 'varchar(500)', (col) => col.check(sql`btrim(note) <> ''`))
    // T5's Cancel (P4): who and when, with an optional note, all blank while Pending.
    .addColumn('cancelled_by', 'uuid', (col) => col.references('users.id').onDelete('restrict'))
    .addColumn('cancelled_at', 'timestamptz')
    .addColumn('cancel_note', 'varchar(500)', (col) => col.check(sql`btrim(cancel_note) <> ''`))
    .addUniqueConstraint('requested_items_material_request_id_position_key', ['material_request_id', 'position'])
    // Each Requestable Material at most once per Material Request (Q10).
    .addUniqueConstraint('requested_items_requestable_material_once', ['material_request_id', 'requestable_material_id'])
    .addCheckConstraint('requested_items_cancelled_check', sql`(cancelled_by IS NULL) = (cancelled_at IS NULL) AND (cancel_note IS NULL OR cancelled_at IS NOT NULL)`)
    .execute();
  // The Requested Items of a Requestable Material, for T7's Pending count and T8's Request Unit change (P2, P6).
  await db.schema.createIndex('idx_requested_items_requestable_material').on('requested_items').column('requestable_material_id').execute();

  // A Material Request's history: one entry per version. A Cancel lists the Requested Items it cancelled, with its
  // note; the created entry lists nothing, the Requested Items being the record of what was asked.
  await db.schema
    .createTable('material_request_history')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('material_request_id', 'uuid', (col) => col.references('material_requests.id').onDelete('restrict').notNull())
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version >= 1`))
    .addColumn('kind', 'varchar(40)', (col) => col.notNull().check(sql`kind IN (${sql.join(HISTORY_KINDS.map((kind) => sql.lit(kind)))})`))
    .addColumn('requested_item_ids', sql`uuid[]`)
    .addColumn('note', 'varchar(500)', (col) => col.check(sql`btrim(note) <> ''`))
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addUniqueConstraint('material_request_history_material_request_id_version_key', ['material_request_id', 'version'])
    .addCheckConstraint(
      'material_request_history_lists_cancelled_items',
      sql`(kind = 'CREATED') = (requested_item_ids IS NULL) AND (kind <> 'CREATED' OR note IS NULL) AND (requested_item_ids IS NULL OR cardinality(requested_item_ids) > 0)`
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while a Requester, a Material Request or a retry receipt of its writes exists
  // (#202 P8). Requested Items and history exist only with their Material Request, so this covers them too.
  const facts = await sql<{ count: string }>`
    SELECT ((SELECT count(*) FROM user_roles WHERE role_id = 'REQUESTER')
            + (SELECT count(*) FROM material_requests)
            + (SELECT count(*) FROM registration_retry_tokens WHERE operation LIKE 'material-request:%'))::text AS count`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: Requesters, Material Requests or their retry receipts exist');
  }

  await db.schema.dropTable('material_request_history').execute();
  await db.schema.dropTable('requested_items').execute();
  // Dropping the table drops the sequence it owns.
  await db.schema.dropTable('material_requests').execute();
  await sql`DELETE FROM roles WHERE id = 'REQUESTER'`.execute(db);
}
