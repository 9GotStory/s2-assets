import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
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

  it('verifies migration directory exists and contains all required migration files', () => {
    expect(fs.existsSync(migrationFolder)).toBe(true);
    const files = fs.readdirSync(migrationFolder);
    expect(files).toContain('0001_foundation.ts');
    expect(files).toContain('0002_asset_registry.ts');
    expect(files).toContain('0003_acquisitions.ts');
    expect(files).toContain('0004_evidence.ts');
    expect(files).toContain('0005_reference_context.ts');
  });

  it('successfully applies all migrations to a clean database in 0001 -> 0002 -> 0003 -> 0004 -> 0005 order', async () => {
    const result = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(result.error).toBeUndefined();
    expect(result.results).toBeDefined();
    expect(result.results!.length).toBe(5);

    expect(result.results![0].migrationName).toBe('0001_foundation');
    expect(result.results![0].direction).toBe('Up');
    expect(result.results![0].status).toBe('Success');

    expect(result.results![1].migrationName).toBe('0002_asset_registry');
    expect(result.results![1].direction).toBe('Up');
    expect(result.results![1].status).toBe('Success');

    expect(result.results![2].migrationName).toBe('0003_acquisitions');
    expect(result.results![2].direction).toBe('Up');
    expect(result.results![2].status).toBe('Success');

    expect(result.results![3].migrationName).toBe('0004_evidence');
    expect(result.results![3].direction).toBe('Up');
    expect(result.results![3].status).toBe('Success');

    expect(result.results![4].migrationName).toBe('0005_reference_context');
    expect(result.results![4].direction).toBe('Up');
    expect(result.results![4].status).toBe('Success');
  });

  it('creates the schema and tables in the database across foundation, asset registry, and acquisitions', async () => {
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
      // Foundation tables
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('roles');
      expect(tableNames).toContain('user_roles');
      expect(tableNames).toContain('kysely_migration');

      // Asset Registry tables
      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('asset_history');
      expect(tableNames).toContain('registration_retry_tokens');

      // Acquisitions table
      expect(tableNames).toContain('acquisitions');

      // Evidence tables
      expect(tableNames).toContain('evidence_records');
      expect(tableNames).toContain('evidence_asset_links');
      expect(tableNames).toContain('evidence_history');

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

      // Check assets table columns (including acquisition_id)
      const assetCols = await client.query(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'assets'
        ORDER BY ordinal_position;
      `);
      const assetColNames = assetCols.rows.map((r: { column_name: string }) => r.column_name);
      expect(assetColNames).toContain('id');
      expect(assetColNames).toContain('name');
      expect(assetColNames).toContain('asset_number');
      expect(assetColNames).toContain('serial_number');
      expect(assetColNames).toContain('registered_by');
      expect(assetColNames).toContain('acquisition_id');
      const acqIdCol = assetCols.rows.find((r: { column_name: string }) => r.column_name === 'acquisition_id');
      expect(acqIdCol?.is_nullable).toBe('YES');

      // Check acquisitions table columns
      const acqCols = await client.query(`
        SELECT column_name, data_type
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

  it('supports complete ordered rollback (0005 -> 0004 -> 0003 -> 0002 -> 0001) on an empty database with complete schema teardown', async () => {
    // 0. Roll back 0005_reference_context: the lists go and the T1 placeholder column returns
    const rollback0005 = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollback0005.error).toBeUndefined();
    expect(rollback0005.results).toHaveLength(1);
    expect(rollback0005.results![0].migrationName).toBe('0005_reference_context');
    expect(rollback0005.results![0].direction).toBe('Down');
    expect(rollback0005.results![0].status).toBe('Success');

    const referenceClient = new Client({ connectionString: databaseUrl });
    await referenceClient.connect();
    try {
      const listTables = await referenceClient.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('locations', 'organization_units', 'persons');
      `);
      expect(listTables.rows).toHaveLength(0);
      const placeholder = await referenceClient.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assets' AND column_name IN ('organization_unit', 'legacy_organization_unit_text', 'location_id');
      `);
      expect(placeholder.rows.map((r: { column_name: string }) => r.column_name)).toEqual(['organization_unit']);
    } finally {
      await referenceClient.end();
    }

    // 1. Roll back 0004_evidence
    const rollback0004 = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollback0004.error).toBeUndefined();
    expect(rollback0004.results).toHaveLength(1);
    expect(rollback0004.results![0].migrationName).toBe('0004_evidence');
    expect(rollback0004.results![0].direction).toBe('Down');
    expect(rollback0004.results![0].status).toBe('Success');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      // Verify evidence tables dropped, while 0003, 0002, and foundation remain
      const tablesAfter0004 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('evidence_records', 'evidence_asset_links', 'evidence_history', 'acquisitions', 'assets', 'users');
      `);
      const tableNamesAfter0004 = tablesAfter0004.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNamesAfter0004).not.toContain('evidence_records');
      expect(tableNamesAfter0004).not.toContain('evidence_asset_links');
      expect(tableNamesAfter0004).not.toContain('evidence_history');
      expect(tableNamesAfter0004).toContain('acquisitions');
      expect(tableNamesAfter0004).toContain('assets');
      expect(tableNamesAfter0004).toContain('users');

      // 2. Roll back 0003_acquisitions
      const rollback0003 = await runMigrator({
        command: 'down',
        databaseUrl,
        migrationFolder,
      });
      expect(rollback0003.error).toBeUndefined();
      expect(rollback0003.results).toHaveLength(1);
      expect(rollback0003.results![0].migrationName).toBe('0003_acquisitions');
      expect(rollback0003.results![0].direction).toBe('Down');
      expect(rollback0003.results![0].status).toBe('Success');

      // Verify acquisitions table and assets.acquisition_id dropped, while 0002 and foundation remain
      const tablesAfter0003 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('acquisitions', 'assets', 'users');
      `);
      const tableNamesAfter0003 = tablesAfter0003.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNamesAfter0003).not.toContain('acquisitions');
      expect(tableNamesAfter0003).toContain('assets');
      expect(tableNamesAfter0003).toContain('users');

      const colAfter0003 = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assets' AND column_name = 'acquisition_id';
      `);
      expect(colAfter0003.rows).toHaveLength(0);

      const migrationsAfter0003 = await client.query(`
        SELECT name FROM kysely_migration ORDER BY name;
      `);
      expect(migrationsAfter0003.rows.map((r: { name: string }) => r.name)).toEqual([
        '0001_foundation',
        '0002_asset_registry',
      ]);

      // 3. Roll back 0002_asset_registry
      const rollback0002 = await runMigrator({
        command: 'down',
        databaseUrl,
        migrationFolder,
      });
      expect(rollback0002.error).toBeUndefined();
      expect(rollback0002.results).toHaveLength(1);
      expect(rollback0002.results![0].migrationName).toBe('0002_asset_registry');
      expect(rollback0002.results![0].direction).toBe('Down');
      expect(rollback0002.results![0].status).toBe('Success');

      const tablesAfter0002 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('assets', 'asset_history', 'registration_retry_tokens', 'users');
      `);
      const tableNamesAfter0002 = tablesAfter0002.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNamesAfter0002).not.toContain('assets');
      expect(tableNamesAfter0002).not.toContain('asset_history');
      expect(tableNamesAfter0002).not.toContain('registration_retry_tokens');
      expect(tableNamesAfter0002).toContain('users');

      const migrationsAfter0002 = await client.query(`
        SELECT name FROM kysely_migration ORDER BY name;
      `);
      expect(migrationsAfter0002.rows.map((r: { name: string }) => r.name)).toEqual([
        '0001_foundation',
      ]);

      // 4. Roll back 0001_foundation
      const rollback0001 = await runMigrator({
        command: 'down',
        databaseUrl,
        migrationFolder,
      });
      expect(rollback0001.error).toBeUndefined();
      expect(rollback0001.results).toHaveLength(1);
      expect(rollback0001.results![0].migrationName).toBe('0001_foundation');
      expect(rollback0001.results![0].direction).toBe('Down');
      expect(rollback0001.results![0].status).toBe('Success');

      // Verify complete schema teardown: zero application tables remain
      const tablesAfter0001 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%';
      `);
      expect(tablesAfter0001.rows).toHaveLength(0);

      const migrationsAfter0001 = await client.query(`
        SELECT name FROM kysely_migration ORDER BY name;
      `);
      expect(migrationsAfter0001.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('can re-apply all migrations after rollback in ordered 0001 -> 0002 -> 0003 -> 0004 -> 0005 sequence and restores full schema', async () => {
    const reapplyResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    expect(reapplyResult.error).toBeUndefined();
    expect(reapplyResult.results).toBeDefined();
    expect(reapplyResult.results!).toHaveLength(5);

    expect(reapplyResult.results![0].migrationName).toBe('0001_foundation');
    expect(reapplyResult.results![0].direction).toBe('Up');
    expect(reapplyResult.results![0].status).toBe('Success');

    expect(reapplyResult.results![1].migrationName).toBe('0002_asset_registry');
    expect(reapplyResult.results![1].direction).toBe('Up');
    expect(reapplyResult.results![1].status).toBe('Success');

    expect(reapplyResult.results![2].migrationName).toBe('0003_acquisitions');
    expect(reapplyResult.results![2].direction).toBe('Up');
    expect(reapplyResult.results![2].status).toBe('Success');

    expect(reapplyResult.results![3].migrationName).toBe('0004_evidence');
    expect(reapplyResult.results![3].direction).toBe('Up');
    expect(reapplyResult.results![3].status).toBe('Success');

    expect(reapplyResult.results![4].migrationName).toBe('0005_reference_context');
    expect(reapplyResult.results![4].direction).toBe('Up');
    expect(reapplyResult.results![4].status).toBe('Success');

    // Verify all application tables exist again
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const tablesResult = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('users', 'sessions', 'roles', 'user_roles', 'assets', 'asset_history', 'registration_retry_tokens', 'acquisitions', 'evidence_records', 'evidence_asset_links', 'evidence_history', 'locations', 'organization_units', 'persons');
      `);
      expect(tablesResult.rows).toHaveLength(14);

      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assets' AND column_name = 'acquisition_id';
      `);
      expect(colCheck.rows).toHaveLength(1);
    } finally {
      await client.end();
    }

    // Verify idempotency
    const recheckResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(recheckResult.error).toBeUndefined();
    expect(recheckResult.results?.length ?? 0).toBe(0);
  });

  it('refuses destructive rollback of 0003_acquisitions when meaningful acquisition or link data exists and leaves data intact', async () => {
    // Roll back empty 0005_reference_context and 0004_evidence first so current state is at 0003_acquisitions
    const down0005 = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(down0005.error).toBeUndefined();
    expect(down0005.results![0].migrationName).toBe('0005_reference_context');

    const down0004 = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(down0004.error).toBeUndefined();
    expect(down0004.results![0].migrationName).toBe('0004_evidence');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    let userId: string;
    let acquisitionId: string;
    let assetId: string;

    try {
      const userRes = await client.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('rollback_refusal_user', 'hash_test', true)
        RETURNING id;
      `);
      userId = userRes.rows[0].id;

      const acqRes = await client.query(`
        INSERT INTO acquisitions (acquisition_type, total_amount, currency, source_reference, notes, created_by)
        VALUES ('Purchase Order', 12345.67, 'THB', 'PO-REFUSAL-001', 'Critical acquisition data', $1)
        RETURNING id;
      `, [userId]);
      acquisitionId = acqRes.rows[0].id;

      const assetRes = await client.query(`
        INSERT INTO assets (name, asset_number, serial_number, registered_by, acquisition_id)
        VALUES ('Critical Linked Asset', 'ASSET-REFUSE-001', 'SN-REFUSE-001', $1, $2)
        RETURNING id;
      `, [userId, acquisitionId]);
      assetId = assetRes.rows[0].id;
    } finally {
      await client.end();
    }

    // Attempting down migration with meaningful acquisition data must fail
    const rollbackAttempt = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollbackAttempt.error).toBeDefined();
    expect(String(rollbackAttempt.error)).toContain('Refusing destructive rollback: meaningful Acquisition or link data exists');

    // Independently verify acquisition and link data are completely intact in PostgreSQL
    const verifyClient = new Client({ connectionString: databaseUrl });
    await verifyClient.connect();
    try {
      const acqCheck = await verifyClient.query('SELECT * FROM acquisitions WHERE id = $1', [acquisitionId]);
      expect(acqCheck.rows).toHaveLength(1);
      expect(acqCheck.rows[0].acquisition_type).toBe('Purchase Order');
      expect(acqCheck.rows[0].total_amount).toBe('12345.67');
      expect(acqCheck.rows[0].notes).toBe('Critical acquisition data');

      const assetCheck = await verifyClient.query('SELECT * FROM assets WHERE id = $1', [assetId]);
      expect(assetCheck.rows).toHaveLength(1);
      expect(assetCheck.rows[0].acquisition_id).toBe(acquisitionId);

      // Verify 0003_acquisitions remains recorded as applied
      const migCheck = await verifyClient.query(`SELECT name FROM kysely_migration WHERE name = '0003_acquisitions'`);
      expect(migCheck.rows).toHaveLength(1);

      // Clean up test records
      await verifyClient.query('DELETE FROM assets WHERE id = $1', [assetId]);
      await verifyClient.query('DELETE FROM acquisitions WHERE id = $1', [acquisitionId]);
      await verifyClient.query('DELETE FROM users WHERE id = $1', [userId]);
    } finally {
      await verifyClient.end();
    }
  });

  it('verifies populated 0002 -> 0003 upgrade preserves assets, history, roles, user_roles, sessions, and retry tokens', async () => {
    // 1. Roll back 0003_acquisitions cleanly now that meaningful data is cleaned up
    const rollbackTo0002 = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollbackTo0002.error).toBeUndefined();
    expect(rollbackTo0002.results![0].migrationName).toBe('0003_acquisitions');

    // 2. Populate 0002 database state with full domain entities: roles, user_roles, users, sessions, assets, history, retry tokens
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const testUserId = crypto.randomUUID();
    const testRoleId = 'CUSTOM_TEST_ROLE';
    const testSessionId = `sess_${crypto.randomUUID()}`;
    const testAssetId = crypto.randomUUID();
    const testHistoryId = crypto.randomUUID();
    const testRetryToken = `retry_token_${crypto.randomUUID()}`;

    try {
      // User
      await client.query(`
        INSERT INTO users (id, username, password_hash, is_active)
        VALUES ($1, 'upgrade_preservation_user', 'hash_upgrade', true);
      `, [testUserId]);

      // Role & User Role
      await client.query(`
        INSERT INTO roles (id, description)
        VALUES ($1, 'Role for upgrade preservation test');
      `, [testRoleId]);

      await client.query(`
        INSERT INTO user_roles (user_id, role_id)
        VALUES ($1, $2);
      `, [testUserId, testRoleId]);

      // Session
      await client.query(`
        INSERT INTO sessions (id, user_id, expires_at)
        VALUES ($1, $2, now() + interval '7 days');
      `, [testSessionId, testUserId]);

      // Asset (0002 schema without acquisition_id)
      await client.query(`
        INSERT INTO assets (id, name, asset_number, serial_number, registered_by)
        VALUES ($1, 'Preserved Core Server', 'ASSET-UPG-001', 'SN-UPG-001', $2);
      `, [testAssetId, testUserId]);

      // Asset History (with structured JSON payload)
      await client.query(`
        INSERT INTO asset_history (id, asset_id, action, actor_id, payload)
        VALUES ($1, $2, 'REGISTERED', $3, '{"name": "Preserved Core Server", "model": "PowerEdge R740"}');
      `, [testHistoryId, testAssetId, testUserId]);

      // Registration Retry Token (with structured fingerprint and response JSON)
      await client.query(`
        INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
        VALUES ($1, $2, 'asset:register', 'sha256:fingerprint_preservation_upgrade', 201, '{"id": "preserved-asset-id", "status": "registered"}');
      `, [testRetryToken, testUserId]);
    } finally {
      await client.end();
    }

    // 3. Upgrade from 0002 to 0003_acquisitions
    const upgradeResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(upgradeResult.error).toBeUndefined();
    expect(upgradeResult.results).toHaveLength(3);
    expect(upgradeResult.results![0].migrationName).toBe('0003_acquisitions');
    expect(upgradeResult.results![0].direction).toBe('Up');
    expect(upgradeResult.results![0].status).toBe('Success');
    expect(upgradeResult.results![1].migrationName).toBe('0004_evidence');
    expect(upgradeResult.results![1].direction).toBe('Up');
    expect(upgradeResult.results![1].status).toBe('Success');
    expect(upgradeResult.results![2].migrationName).toBe('0005_reference_context');
    expect(upgradeResult.results![2].direction).toBe('Up');
    expect(upgradeResult.results![2].status).toBe('Success');

    // 4. Assert comprehensive preservation of all 0002 and foundation facts
    const verifyClient = new Client({ connectionString: databaseUrl });
    await verifyClient.connect();

    try {
      // User preservation
      const userCheck = await verifyClient.query('SELECT username, is_active FROM users WHERE id = $1', [testUserId]);
      expect(userCheck.rows[0].username).toBe('upgrade_preservation_user');
      expect(userCheck.rows[0].is_active).toBe(true);

      // Role & User Role preservation
      const roleCheck = await verifyClient.query('SELECT id, description FROM roles WHERE id = $1', [testRoleId]);
      expect(roleCheck.rows[0].id).toBe(testRoleId);
      expect(roleCheck.rows[0].description).toBe('Role for upgrade preservation test');

      const userRoleCheck = await verifyClient.query('SELECT role_id FROM user_roles WHERE user_id = $1', [testUserId]);
      expect(userRoleCheck.rows[0].role_id).toBe(testRoleId);

      // Session preservation
      const sessionCheck = await verifyClient.query('SELECT user_id FROM sessions WHERE id = $1', [testSessionId]);
      expect(sessionCheck.rows[0].user_id).toBe(testUserId);

      // Asset preservation: Stable ID, facts, and new acquisition_id column is NULL
      const assetCheck = await verifyClient.query('SELECT id, name, asset_number, serial_number, registered_by, acquisition_id FROM assets WHERE id = $1', [testAssetId]);
      expect(assetCheck.rows).toHaveLength(1);
      expect(assetCheck.rows[0].id).toBe(testAssetId);
      expect(assetCheck.rows[0].name).toBe('Preserved Core Server');
      expect(assetCheck.rows[0].asset_number).toBe('ASSET-UPG-001');
      expect(assetCheck.rows[0].serial_number).toBe('SN-UPG-001');
      expect(assetCheck.rows[0].registered_by).toBe(testUserId);
      expect(assetCheck.rows[0].acquisition_id).toBeNull();

      // Asset History preservation: exact JSON payload
      const historyCheck = await verifyClient.query('SELECT action, actor_id, payload FROM asset_history WHERE id = $1', [testHistoryId]);
      expect(historyCheck.rows).toHaveLength(1);
      expect(historyCheck.rows[0].action).toBe('REGISTERED');
      expect(historyCheck.rows[0].actor_id).toBe(testUserId);
      expect(historyCheck.rows[0].payload).toEqual({
        name: 'Preserved Core Server',
        model: 'PowerEdge R740',
      });

      // Registration Retry Token preservation: exact fingerprint, status, response JSON
      const tokenCheck = await verifyClient.query('SELECT operation, actor_id, payload_fingerprint, response_status, response_body FROM registration_retry_tokens WHERE token = $1', [testRetryToken]);
      expect(tokenCheck.rows).toHaveLength(1);
      expect(tokenCheck.rows[0].operation).toBe('asset:register');
      expect(tokenCheck.rows[0].actor_id).toBe(testUserId);
      expect(tokenCheck.rows[0].payload_fingerprint).toBe('sha256:fingerprint_preservation_upgrade');
      expect(tokenCheck.rows[0].response_status).toBe(201);
      expect(tokenCheck.rows[0].response_body).toEqual({
        id: 'preserved-asset-id',
        status: 'registered',
      });

      // Acquisitions schema exists
      const acqTableCheck = await verifyClient.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'acquisitions'`);
      expect(acqTableCheck.rows).toHaveLength(1);
    } finally {
      await verifyClient.end();
    }
  });
});
