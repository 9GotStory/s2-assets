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

describe('Asset Registry Migration Integration (Seam C)', () => {
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

  it('verifies 0002_asset_registry migration file exists', () => {
    expect(fs.existsSync(migrationFolder)).toBe(true);
    const files = fs.readdirSync(migrationFolder);
    expect(files).toContain('0002_asset_registry.ts');
  });

  it('preserves foundation data during upgrade and creates registry tables', async () => {
    // 1. Run migration up for 0001_foundation only
    const foundationResult = await runMigrator({
      command: 'up',
      databaseUrl,
      migrationFolder,
    });
    expect(foundationResult.error).toBeUndefined();
    expect(foundationResult.results?.[0]?.migrationName).toBe('0001_foundation');

    // 2. Insert test foundation user and session
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    let testUserId: string;
    try {
      const userRes = await client.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('custodian_test', 'hash123', true)
        RETURNING id;
      `);
      testUserId = userRes.rows[0].id;

      await client.query(`
        INSERT INTO sessions (id, user_id, expires_at)
        VALUES ('sess_123', $1, now() + interval '1 day');
      `, [testUserId]);
    } finally {
      await client.end();
    }

    // 3. Upgrade to latest (applies 0002_asset_registry)
    const upgradeResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(upgradeResult.error).toBeUndefined();
    const assetMigration = upgradeResult.results?.find(
      (m) => m.migrationName === '0002_asset_registry'
    );
    expect(assetMigration).toBeDefined();
    expect(assetMigration?.status).toBe('Success');
    expect(assetMigration?.direction).toBe('Up');

    // 4. Verify foundation user and session remain intact
    const verifyClient = new Client({ connectionString: databaseUrl });
    await verifyClient.connect();

    try {
      const userCheck = await verifyClient.query(
        'SELECT username, is_active FROM users WHERE id = $1',
        [testUserId]
      );
      expect(userCheck.rows[0].username).toBe('custodian_test');
      expect(userCheck.rows[0].is_active).toBe(true);

      const sessionCheck = await verifyClient.query(
        'SELECT user_id FROM sessions WHERE id = $1',
        ['sess_123']
      );
      expect(sessionCheck.rows[0].user_id).toBe(testUserId);

      // Verify registry tables exist
      const tablesResult = await verifyClient.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
      `);
      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('asset_history');
      expect(tableNames).toContain('registration_retry_tokens');

      // Verify assets columns
      const assetsCols = await verifyClient.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'assets'
        ORDER BY ordinal_position;
      `);
      const assetColNames = assetsCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(assetColNames).toContain('id');
      expect(assetColNames).toContain('asset_number');
      expect(assetColNames).toContain('serial_number');
      expect(assetColNames).toContain('name');
      expect(assetColNames).toContain('category');
      expect(assetColNames).toContain('organization_unit');
      expect(assetColNames).toContain('source_reference');
      expect(assetColNames).toContain('source_notes');
      expect(assetColNames).toContain('registered_by');
      expect(assetColNames).toContain('recorded_at');
      expect(assetColNames).toContain('created_at');
      expect(assetColNames).toContain('updated_at');

      // Verify asset_history columns
      const historyCols = await verifyClient.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'asset_history'
        ORDER BY ordinal_position;
      `);
      const historyColNames = historyCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(historyColNames).toContain('id');
      expect(historyColNames).toContain('asset_id');
      expect(historyColNames).toContain('action');
      expect(historyColNames).toContain('actor_id');
      expect(historyColNames).toContain('recorded_at');
      expect(historyColNames).toContain('payload');

      // Verify registration_retry_tokens columns
      const retryCols = await verifyClient.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'registration_retry_tokens'
        ORDER BY ordinal_position;
      `);
      const retryColNames = retryCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(retryColNames).toContain('token');
      expect(retryColNames).toContain('actor_id');
      expect(retryColNames).toContain('operation');
      expect(retryColNames).toContain('payload_fingerprint');
      expect(retryColNames).toContain('response_status');
      expect(retryColNames).toContain('response_body');

      // Verify roles populated
      const rolesRes = await verifyClient.query('SELECT id FROM roles ORDER BY id');
      const roleIds = rolesRes.rows.map((r: { id: string }) => r.id);
      expect(roleIds).toContain('ASSET_CUSTODIAN');
      expect(roleIds).toContain('ADMINISTRATOR');
      expect(roleIds).toContain('READ_ONLY');
      expect(roleIds).toContain('SYSTEM_MAINTAINER');
    } finally {
      await verifyClient.end();
    }
  });

  it('supports rolling back 0002_asset_registry without removing foundation tables', async () => {
    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });

    expect(rollbackResult.error).toBeUndefined();
    expect(rollbackResult.results?.[0]?.migrationName).toBe('0002_asset_registry');
    expect(rollbackResult.results?.[0]?.direction).toBe('Down');
    expect(rollbackResult.results?.[0]?.status).toBe('Success');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      const tablesResult = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('assets', 'asset_history', 'registration_retry_tokens', 'users');
      `);
      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNames).not.toContain('assets');
      expect(tableNames).not.toContain('asset_history');
      expect(tableNames).not.toContain('registration_retry_tokens');
      expect(tableNames).toContain('users');
    } finally {
      await client.end();
    }
  });

  it('can re-apply 0002_asset_registry cleanly after rollback', async () => {
    const reapplyResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(reapplyResult.error).toBeUndefined();
    expect(reapplyResult.results?.[0]?.migrationName).toBe('0002_asset_registry');
    expect(reapplyResult.results?.[0]?.direction).toBe('Up');
    expect(reapplyResult.results?.[0]?.status).toBe('Success');
  });
});
