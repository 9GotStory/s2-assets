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
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  }, 30_000);

  it('verifies 0002_asset_registry and 0003_acquisitions migration files exist', () => {
    expect(fs.existsSync(migrationFolder)).toBe(true);
    const files = fs.readdirSync(migrationFolder);
    expect(files).toContain('0002_asset_registry.ts');
    expect(files).toContain('0003_acquisitions.ts');
    expect(files).toContain('0004_evidence.ts');
  });

  it('preserves foundation and 0002 data during upgrade, creates acquisitions table and links', async () => {
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

    // 3. Upgrade to 0002_asset_registry
    const assetRegistryResult = await runMigrator({
      command: 'up',
      databaseUrl,
      migrationFolder,
    });
    expect(assetRegistryResult.error).toBeUndefined();
    expect(assetRegistryResult.results?.[0]?.migrationName).toBe('0002_asset_registry');
    expect(assetRegistryResult.results?.[0]?.status).toBe('Success');

    // Insert an asset under 0002 schema to test preservation during 0003 upgrade
    const client002 = new Client({ connectionString: databaseUrl });
    await client002.connect();
    let preExistingAssetId: string;
    try {
      const assetRes = await client002.query(`
        INSERT INTO assets (name, asset_number, serial_number, registered_by)
        VALUES ('Pre-existing Laptop', 'ASSET-PRE-001', 'SN-PRE-001', $1)
        RETURNING id;
      `, [testUserId]);
      preExistingAssetId = assetRes.rows[0].id;

      await client002.query(`
        INSERT INTO asset_history (asset_id, action, actor_id, payload)
        VALUES ($1, 'REGISTERED', $2, '{"name": "Pre-existing Laptop"}');
      `, [preExistingAssetId, testUserId]);

      await client002.query(`
        INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
        VALUES ('token-pre-001', $1, 'asset:register', 'fingerprint123', 201, '{"status": "ok"}');
      `, [testUserId]);
    } finally {
      await client002.end();
    }

    // 4. Upgrade to 0003_acquisitions
    const acqUpgradeResult = await runMigrator({
      command: 'up',
      databaseUrl,
      migrationFolder,
    });
    expect(acqUpgradeResult.error).toBeUndefined();
    expect(acqUpgradeResult.results?.[0]?.migrationName).toBe('0003_acquisitions');
    expect(acqUpgradeResult.results?.[0]?.status).toBe('Success');
    expect(acqUpgradeResult.results?.[0]?.direction).toBe('Up');

    // 5. Verify foundation user, session, 0002 asset, and retry token remain intact
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

      // Verify pre-existing asset preserved and acquisition_id is null
      const assetCheck = await verifyClient.query(
        'SELECT id, name, asset_number, serial_number, acquisition_id FROM assets WHERE id = $1',
        [preExistingAssetId]
      );
      expect(assetCheck.rows.length).toBe(1);
      expect(assetCheck.rows[0].name).toBe('Pre-existing Laptop');
      expect(assetCheck.rows[0].asset_number).toBe('ASSET-PRE-001');
      expect(assetCheck.rows[0].serial_number).toBe('SN-PRE-001');
      expect(assetCheck.rows[0].acquisition_id).toBeNull();

      // Verify pre-existing history preserved with exact JSON payload
      const historyCheck = await verifyClient.query(
        'SELECT action, actor_id, payload FROM asset_history WHERE asset_id = $1',
        [preExistingAssetId]
      );
      expect(historyCheck.rows.length).toBe(1);
      expect(historyCheck.rows[0].action).toBe('REGISTERED');
      expect(historyCheck.rows[0].actor_id).toBe(testUserId);
      expect(historyCheck.rows[0].payload).toEqual({ name: 'Pre-existing Laptop' });

      // Verify retry token preserved with exact fingerprint, response_status, and response_body JSON
      const tokenCheck = await verifyClient.query(
        'SELECT operation, actor_id, payload_fingerprint, response_status, response_body FROM registration_retry_tokens WHERE token = $1',
        ['token-pre-001']
      );
      expect(tokenCheck.rows.length).toBe(1);
      expect(tokenCheck.rows[0].operation).toBe('asset:register');
      expect(tokenCheck.rows[0].actor_id).toBe(testUserId);
      expect(tokenCheck.rows[0].payload_fingerprint).toBe('fingerprint123');
      expect(tokenCheck.rows[0].response_status).toBe(201);
      expect(tokenCheck.rows[0].response_body).toEqual({ status: 'ok' });

      // Verify acquisitions table exists
      const tablesResult = await verifyClient.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
      `);
      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNames).toContain('acquisitions');
      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('asset_history');
      expect(tableNames).toContain('registration_retry_tokens');

      // Verify acquisitions columns
      const acqCols = await verifyClient.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'acquisitions'
        ORDER BY ordinal_position;
      `);
      const acqColNames = acqCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(acqColNames).toContain('id');
      expect(acqColNames).toContain('acquisition_type');
      expect(acqColNames).toContain('acquisition_date');
      expect(acqColNames).toContain('total_amount');
      expect(acqColNames).toContain('currency');
      expect(acqColNames).toContain('source_reference');
      expect(acqColNames).toContain('notes');
      expect(acqColNames).toContain('recorded_at');
      expect(acqColNames).toContain('created_by');

      // Verify assets.acquisition_id column exists
      const assetCols = await verifyClient.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'assets' AND column_name = 'acquisition_id';
      `);
      expect(assetCols.rows.length).toBe(1);
      expect(assetCols.rows[0].is_nullable).toBe('YES');

      // 6. Test FK orphan rejection: inserting asset with invalid acquisition_id must fail
      let fkErrorCaught = false;
      try {
        await verifyClient.query(`
          INSERT INTO assets (name, registered_by, acquisition_id)
          VALUES ('Orphan Asset', $1, 'c0000000-0000-4000-8000-000000000099');
        `, [testUserId]);
      } catch (err: any) {
        fkErrorCaught = true;
        expect(err?.code).toBe('23503'); // foreign_key_violation
      }
      expect(fkErrorCaught).toBe(true);
    } finally {
      await verifyClient.end();
    }
  });

  it('refuses destructive rollback when meaningful Acquisition or link data exists', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    let testAcqId: string;
    try {
      const userRes = await client.query('SELECT id FROM users LIMIT 1');
      const userId = userRes.rows[0].id;

      const acqRes = await client.query(`
        INSERT INTO acquisitions (acquisition_type, total_amount, currency, created_by)
        VALUES ('Purchase Order', 5000.00, 'THB', $1)
        RETURNING id;
      `, [userId]);
      testAcqId = acqRes.rows[0].id;
    } finally {
      await client.end();
    }

    // Attempting down migration with meaningful acquisition data must fail
    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollbackResult.error).toBeDefined();

    // Clean up test acquisition
    const cleanClient = new Client({ connectionString: databaseUrl });
    await cleanClient.connect();
    try {
      await cleanClient.query('DELETE FROM acquisitions WHERE id = $1', [testAcqId]);
    } finally {
      await cleanClient.end();
    }
  });

  it('supports rolling back 0003_acquisitions cleanly when empty without removing 0002 or foundation tables', async () => {
    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });

    expect(rollbackResult.error).toBeUndefined();
    expect(rollbackResult.results?.[0]?.migrationName).toBe('0003_acquisitions');
    expect(rollbackResult.results?.[0]?.direction).toBe('Down');
    expect(rollbackResult.results?.[0]?.status).toBe('Success');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      const tablesResult = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('acquisitions', 'assets', 'users');
      `);
      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNames).not.toContain('acquisitions');
      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('users');

      const colCheck = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'assets' AND column_name = 'acquisition_id';
      `);
      expect(colCheck.rows.length).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('can re-apply 0003_acquisitions cleanly after rollback', async () => {
    const reapplyResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(reapplyResult.error).toBeUndefined();
    const acqMigration = reapplyResult.results?.find((m) => m.migrationName === '0003_acquisitions');
    expect(acqMigration).toBeDefined();
    expect(acqMigration?.direction).toBe('Up');
    expect(acqMigration?.status).toBe('Success');
  });
});
