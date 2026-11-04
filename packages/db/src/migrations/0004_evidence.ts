import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Create evidence_records table (B1, B2)
  await db.schema
    .createTable('evidence_records')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull()
    )
    .addColumn('acquisition_id', 'uuid', (col) =>
      col.references('acquisitions.id').onDelete('restrict')
    )
    .addColumn('reference_type', 'text')
    .addColumn('reference_text', 'text')
    .addColumn('description', 'text')
    .addColumn('version', 'integer', (col) =>
      col.defaultTo(1).notNull().check(sql`version > 0`)
    )
    .addColumn('created_by', 'uuid', (col) =>
      col.references('users.id').onDelete('restrict').notNull()
    )
    .addColumn('recorded_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .execute();

  // Indexes on evidence_records
  await db.schema
    .createIndex('idx_evidence_records_acquisition_id')
    .on('evidence_records')
    .column('acquisition_id')
    .execute();

  await db.schema
    .createIndex('idx_evidence_records_recorded_at')
    .on('evidence_records')
    .column('recorded_at')
    .execute();

  // 2. Create evidence_asset_links table (B1: composite-unique/FK evidence_asset_links)
  await db.schema
    .createTable('evidence_asset_links')
    .addColumn('evidence_id', 'uuid', (col) =>
      col.references('evidence_records.id').onDelete('restrict').notNull()
    )
    .addColumn('asset_id', 'uuid', (col) =>
      col.references('assets.id').onDelete('restrict').notNull()
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addPrimaryKeyConstraint('evidence_asset_links_pk', ['evidence_id', 'asset_id'])
    .execute();

  await db.schema
    .createIndex('idx_evidence_asset_links_asset_id')
    .on('evidence_asset_links')
    .column('asset_id')
    .execute();

  // 3. Create evidence_history table (B4: immutable evidence_history)
  await db.schema
    .createTable('evidence_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull()
    )
    .addColumn('evidence_id', 'uuid', (col) =>
      col.references('evidence_records.id').onDelete('restrict').notNull()
    )
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version > 0`))
    .addColumn('action', 'varchar(50)', (col) => col.notNull())
    .addColumn('actor_id', 'uuid', (col) =>
      col.references('users.id').onDelete('restrict').notNull()
    )
    .addColumn('reason', 'text')
    .addColumn('before_state', 'jsonb')
    .addColumn('after_state', 'jsonb', (col) => col.notNull())
    .addColumn('link_deltas', 'jsonb')
    .addColumn('recorded_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addUniqueConstraint('evidence_history_evidence_id_version_unique', ['evidence_id', 'version'])
    .execute();

  await db.schema
    .createIndex('idx_evidence_history_evidence_id')
    .on('evidence_history')
    .column('evidence_id')
    .execute();

  await db.schema
    .createIndex('idx_evidence_history_timeline')
    .on('evidence_history')
    .columns(['evidence_id', 'recorded_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse destructive rollback if meaningful evidence/link/history OR Evidence-operation retry receipts exist
  const evCountRes = await sql<{ count: string }>`SELECT count(*)::text as count FROM evidence_records`.execute(db);
  const linkCountRes = await sql<{ count: string }>`SELECT count(*)::text as count FROM evidence_asset_links`.execute(db);
  const historyCountRes = await sql<{ count: string }>`SELECT count(*)::text as count FROM evidence_history`.execute(db);
  const retryCountRes = await sql<{ count: string }>`SELECT count(*)::text as count FROM registration_retry_tokens WHERE operation = 'evidence:create' OR operation LIKE 'evidence:correct:%'`.execute(db);

  const evCount = Number(evCountRes.rows[0]?.count || '0');
  const linkCount = Number(linkCountRes.rows[0]?.count || '0');
  const historyCount = Number(historyCountRes.rows[0]?.count || '0');
  const retryCount = Number(retryCountRes.rows[0]?.count || '0');

  if (evCount > 0 || linkCount > 0 || historyCount > 0 || retryCount > 0) {
    throw new Error('Refusing destructive rollback: meaningful evidence data or retry receipts exist');
  }

  await db.schema.dropTable('evidence_history').ifExists().execute();
  await db.schema.dropTable('evidence_asset_links').ifExists().execute();
  await db.schema.dropTable('evidence_records').ifExists().execute();
}
