import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Ensure standard roles exist in roles table
  await sql`
    INSERT INTO roles (id, description) VALUES
      ('ASSET_CUSTODIAN', 'Asset Custodian'),
      ('ADMINISTRATOR', 'Administrator'),
      ('READ_ONLY', 'Read-only User'),
      ('SYSTEM_MAINTAINER', 'System Maintainer')
    ON CONFLICT (id) DO NOTHING
  `.execute(db);

  // 2. Create assets table (AR-01, AR-02, AR-03, AR-04, AR-06, AR-10, AR-13, D2)
  await db.schema
    .createTable('assets')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull()
    )
    .addColumn('asset_number', 'varchar')
    .addColumn('serial_number', 'varchar')
    .addColumn('name', 'varchar')
    .addColumn('category', 'varchar')
    .addColumn('organization_unit', 'varchar')
    .addColumn('source_reference', 'varchar')
    .addColumn('source_notes', 'text')
    .addColumn('registered_by', 'uuid', (col) =>
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

  // Indexes for exact duplicate candidate queries (D2)
  await db.schema
    .createIndex('idx_assets_asset_number')
    .on('assets')
    .column('asset_number')
    .execute();

  await db.schema
    .createIndex('idx_assets_serial_number')
    .on('assets')
    .column('serial_number')
    .execute();

  // 3. Create asset_history table for durable timeline starting fact and events (AR-07, AC-16)
  await db.schema
    .createTable('asset_history')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull()
    )
    .addColumn('asset_id', 'uuid', (col) =>
      col.references('assets.id').onDelete('cascade').notNull()
    )
    .addColumn('action', 'varchar', (col) => col.notNull())
    .addColumn('actor_id', 'uuid', (col) =>
      col.references('users.id').onDelete('restrict').notNull()
    )
    .addColumn('recorded_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addColumn('payload', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .execute();

  await db.schema
    .createIndex('idx_asset_history_asset_id')
    .on('asset_history')
    .column('asset_id')
    .execute();

  await db.schema
    .createIndex('idx_asset_history_asset_timeline')
    .on('asset_history')
    .columns(['asset_id', 'recorded_at'])
    .execute();

  // 4. Create registration_retry_tokens table for actor/operation-scoped replay (D4)
  await db.schema
    .createTable('registration_retry_tokens')
    .addColumn('token', 'varchar', (col) => col.notNull())
    .addColumn('actor_id', 'uuid', (col) =>
      col.references('users.id').onDelete('cascade').notNull()
    )
    .addColumn('operation', 'varchar', (col) => col.notNull())
    .addColumn('payload_fingerprint', 'varchar', (col) => col.notNull())
    .addColumn('response_status', 'integer', (col) => col.notNull())
    .addColumn('response_body', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.defaultTo(sql`now()`).notNull()
    )
    .addPrimaryKeyConstraint('registration_retry_tokens_pk', [
      'actor_id',
      'operation',
      'token',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('registration_retry_tokens').ifExists().execute();
  await db.schema.dropTable('asset_history').ifExists().execute();
  await db.schema.dropTable('assets').ifExists().execute();
}
