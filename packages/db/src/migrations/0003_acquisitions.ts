import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Create acquisitions table (D1, D3, ACQ-01..08)
  await db.schema
    .createTable('acquisitions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull()
    )
    .addColumn('acquisition_type', 'text')
    .addColumn('acquisition_date', 'date')
    .addColumn('total_amount', 'numeric(18, 2)')
    .addColumn('currency', 'varchar(3)')
    .addColumn('source_reference', 'text')
    .addColumn('notes', 'text')
    .addColumn('recorded_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('created_by', 'uuid', (col) =>
      col.references('users.id').onDelete('restrict').notNull()
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .execute();

  // Index on recorded_at for acquisitions ordering
  await db.schema
    .createIndex('idx_acquisitions_recorded_at')
    .on('acquisitions')
    .column('recorded_at')
    .execute();

  // 2. Add nullable acquisition_id foreign key column to assets table (no cascading deletion)
  await db.schema
    .alterTable('assets')
    .addColumn('acquisition_id', 'uuid', (col) =>
      col.references('acquisitions.id').onDelete('restrict')
    )
    .execute();

  // Index on assets.acquisition_id for linked-assets retrieval
  await db.schema
    .createIndex('idx_assets_acquisition_id')
    .on('assets')
    .column('acquisition_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse destructive rollback if meaningful Acquisition or link data exists
  const acqCountRes = await sql<{ count: string }>`SELECT count(*)::text as count FROM acquisitions`.execute(db);
  const linkCountRes = await sql<{ count: string }>`SELECT count(*)::text as count FROM assets WHERE acquisition_id IS NOT NULL`.execute(db);
  const acqCount = Number(acqCountRes.rows[0]?.count || '0');
  const linkCount = Number(linkCountRes.rows[0]?.count || '0');

  if (acqCount > 0 || linkCount > 0) {
    throw new Error('Refusing destructive rollback: meaningful Acquisition or link data exists');
  }

  await db.schema.dropIndex('idx_assets_acquisition_id').ifExists().execute();
  await db.schema.alterTable('assets').dropColumn('acquisition_id').execute();
  await db.schema.dropTable('acquisitions').ifExists().execute();
}
