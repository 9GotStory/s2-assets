import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

describe('Database Migrations Integration', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
      process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    }
    if (!process.env.DOCKER_HOST) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1001;
      const podmanSocket = `/run/user/${uid}/podman/podman.sock`;
      if (fs.existsSync(podmanSocket)) {
        process.env.DOCKER_HOST = `unix://${podmanSocket}`;
      }
    }

    container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
    databaseUrl = container.getConnectionUri();
  }, 60_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  }, 30_000);

  it('verifies migration directory exists', () => {
    expect(fs.existsSync(migrationFolder)).toBe(true);
    const files = fs.readdirSync(migrationFolder);
    expect(files).toContain('0001_foundation.ts');
  });

  it('successfully applies the 0001_foundation migration to a clean database', async () => {
    const result = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(result.error).toBeUndefined();
    expect(result.results).toBeDefined();
    expect(result.results!.length).toBeGreaterThan(0);

    const foundationMigration = result.results!.find(
      (m) => m.migrationName === '0001_foundation',
    );
    expect(foundationMigration).toBeDefined();
    expect(foundationMigration?.direction).toBe('Up');
    expect(foundationMigration?.status).toBe('Success');
  });

  it('creates the foundation tables and schema in the database', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      const tablesResult = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name;
      `);

      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('roles');
      expect(tableNames).toContain('user_roles');
      expect(tableNames).toContain('kysely_migration');

      // Check users table columns
      const usersCols = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'users'
        ORDER BY ordinal_position;
      `);
      const userColNames = usersCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(userColNames).toContain('id');
      expect(userColNames).toContain('username');
      expect(userColNames).toContain('password_hash');
      expect(userColNames).toContain('is_active');
      expect(userColNames).toContain('created_at');
      expect(userColNames).toContain('updated_at');

      // Check sessions table columns
      const sessionsCols = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'sessions'
        ORDER BY ordinal_position;
      `);
      const sessionColNames = sessionsCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(sessionColNames).toContain('id');
      expect(sessionColNames).toContain('user_id');
      expect(sessionColNames).toContain('expires_at');
      expect(sessionColNames).toContain('created_at');

      // Check roles table columns
      const rolesCols = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'roles'
        ORDER BY ordinal_position;
      `);
      const roleColNames = rolesCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(roleColNames).toContain('id');
      expect(roleColNames).toContain('description');

      // Check user_roles table columns
      const userRolesCols = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'user_roles'
        ORDER BY ordinal_position;
      `);
      const userRoleColNames = userRolesCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(userRoleColNames).toContain('user_id');
      expect(userRoleColNames).toContain('role_id');
    } finally {
      await client.end();
    }
  });

  it('is idempotent when running latest again with no pending migrations', async () => {
    const rerunResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(rerunResult.error).toBeUndefined();
    expect(rerunResult.results?.length ?? 0).toBe(0);
  });

  it('supports rolling back the migration with down command', async () => {
    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });

    expect(rollbackResult.error).toBeUndefined();
    expect(rollbackResult.results).toBeDefined();
    expect(rollbackResult.results!.length).toBe(1);
    expect(rollbackResult.results![0].direction).toBe('Down');
    expect(rollbackResult.results![0].status).toBe('Success');

    // If 0002_asset_registry was the latest migration rolled back, roll back 0001_foundation to verify clean teardown
    if (rollbackResult.results![0].migrationName === '0002_asset_registry') {
      const rollbackFoundation = await runMigrator({
        command: 'down',
        databaseUrl,
        migrationFolder,
      });
      expect(rollbackFoundation.error).toBeUndefined();
      expect(rollbackFoundation.results).toBeDefined();
      expect(rollbackFoundation.results![0].migrationName).toBe('0001_foundation');
      expect(rollbackFoundation.results![0].direction).toBe('Down');
      expect(rollbackFoundation.results![0].status).toBe('Success');
    } else {
      expect(rollbackResult.results![0].migrationName).toBe('0001_foundation');
    }

    // Verify tables are dropped
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      const tablesResult = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('users', 'sessions', 'roles', 'user_roles');
      `);
      expect(tablesResult.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('can re-apply the migration after rollback', async () => {
    const reapplyResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(reapplyResult.error).toBeUndefined();
    expect(reapplyResult.results).toBeDefined();
    expect(reapplyResult.results!.length).toBeGreaterThan(0);
    const foundationMigration = reapplyResult.results!.find((m) => m.migrationName === '0001_foundation');
    expect(foundationMigration).toBeDefined();
    expect(foundationMigration!.direction).toBe('Up');
    expect(foundationMigration!.status).toBe('Success');
  });
});
