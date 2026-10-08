import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('username', 'varchar', (col) => col.unique().notNull())
    .addColumn('password_hash', 'varchar', (col) => col.notNull())
    .addColumn('is_active', 'boolean', (col) => col.defaultTo(true).notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'varchar', (col) => col.primaryKey().notNull())
    .addColumn('user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('cascade').notNull(),
    )
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();

  await db.schema
    .createTable('roles')
    .addColumn('id', 'varchar', (col) => col.primaryKey().notNull())
    .addColumn('description', 'varchar', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('user_roles')
    .addColumn('user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('cascade').notNull(),
    )
    .addColumn('role_id', 'varchar', (col) =>
      col.references('roles.id').onDelete('cascade').notNull(),
    )
    .addPrimaryKeyConstraint('user_roles_pk', ['user_id', 'role_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('user_roles').ifExists().execute();
  await db.schema.dropTable('sessions').ifExists().execute();
  await db.schema.dropTable('roles').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
}
