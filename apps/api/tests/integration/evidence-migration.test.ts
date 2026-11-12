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

describe('Evidence Migration Integration (Seam C - T7)', () => {
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
  }, 90_000);

  afterAll(async () => {
    if (container) {
      await container.stop().catch(() => {});
    }
  });

  it('verifies 0004_evidence.ts migration file exists', () => {
    expect(fs.existsSync(migrationFolder)).toBe(true);
    const files = fs.readdirSync(migrationFolder);
    expect(files).toContain('0004_evidence.ts');
  });

  it('applies migrations 0001 -> 0004 on a clean database and creates evidence tables and indexes', async () => {
    // Step up to exactly 0004, so the rollback cases below target 0004 whatever migrations follow it.
    for (const expected of ['0001_foundation', '0002_asset_registry', '0003_acquisitions', '0004_evidence']) {
      const migResult = await runMigrator({
        command: 'up',
        databaseUrl,
        migrationFolder,
      });
      expect(migResult.error).toBeUndefined();
      expect(migResult.results?.[0]).toMatchObject({ migrationName: expected, status: 'Success' });
    }

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
      expect(tableNames).toContain('evidence_records');
      expect(tableNames).toContain('evidence_asset_links');
      expect(tableNames).toContain('evidence_history');

      // Verify indexes
      const indexesResult = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public';
      `);
      const indexNames = indexesResult.rows.map((r: { indexname: string }) => r.indexname);
      expect(indexNames).toContain('idx_evidence_records_acquisition_id');
      expect(indexNames).toContain('idx_evidence_records_recorded_at');
      expect(indexNames).toContain('idx_evidence_asset_links_asset_id');
      expect(indexNames).toContain('idx_evidence_history_evidence_id');
      expect(indexNames).toContain('idx_evidence_history_timeline');
    } finally {
      await client.end();
    }
  });

  it('refuses destructive rollback when meaningful evidence records exist', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    let evidenceId: string;
    try {
      const userRes = await client.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('evidence_tester', 'hash123', true)
        RETURNING id;
      `);
      const userId = userRes.rows[0].id;

      const evRes = await client.query(`
        INSERT INTO evidence_records (reference_text, description, created_by)
        VALUES ('REF-TEST-001', 'Test Description', $1)
        RETURNING id;
      `, [userId]);
      evidenceId = evRes.rows[0].id;
    } finally {
      await client.end();
    }

    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollbackResult.error).toBeDefined();
    expect(String(rollbackResult.error)).toContain('Refusing destructive rollback');

    // Clean up
    const cleanClient = new Client({ connectionString: databaseUrl });
    await cleanClient.connect();
    try {
      await cleanClient.query('DELETE FROM evidence_records WHERE id = $1', [evidenceId]);
    } finally {
      await cleanClient.end();
    }
  });

  it('refuses destructive rollback when evidence retry tokens exist in registration_retry_tokens', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    let actorId: string;
    try {
      const userRes = await client.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('retry_tester', 'hash123', true)
        RETURNING id;
      `);
      actorId = userRes.rows[0].id;

      await client.query(`
        INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
        VALUES ('tok_ev_123', $1, 'evidence:create', 'fp_123', 201, '{"id": "ev_1"}');
      `, [actorId]);
    } finally {
      await client.end();
    }

    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollbackResult.error).toBeDefined();
    expect(String(rollbackResult.error)).toContain('Refusing destructive rollback');

    // Clean up
    const cleanClient = new Client({ connectionString: databaseUrl });
    await cleanClient.connect();
    try {
      await cleanClient.query("DELETE FROM registration_retry_tokens WHERE operation = 'evidence:create'");
    } finally {
      await cleanClient.end();
    }
  });

  it('rolls back 0004_evidence cleanly when empty without dropping earlier tables', async () => {
    const rollbackResult = await runMigrator({
      command: 'down',
      databaseUrl,
      migrationFolder,
    });
    expect(rollbackResult.error).toBeUndefined();
    expect(rollbackResult.results?.[0]?.migrationName).toBe('0004_evidence');
    expect(rollbackResult.results?.[0]?.direction).toBe('Down');
    expect(rollbackResult.results?.[0]?.status).toBe('Success');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const tablesResult = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('evidence_records', 'evidence_asset_links', 'evidence_history', 'acquisitions', 'assets', 'users');
      `);
      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
      expect(tableNames).not.toContain('evidence_records');
      expect(tableNames).not.toContain('evidence_asset_links');
      expect(tableNames).not.toContain('evidence_history');
      expect(tableNames).toContain('acquisitions');
      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('users');
    } finally {
      await client.end();
    }
  });

  it('can reapply 0004_evidence cleanly after rollback', async () => {
    const reapplyResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(reapplyResult.error).toBeUndefined();
    const evMigration = reapplyResult.results?.find((m) => m.migrationName === '0004_evidence');
    expect(evMigration).toBeDefined();
    expect(evMigration?.direction).toBe('Up');
    expect(evMigration?.status).toBe('Success');
  });

  it('enforces version > 0 and (evidence_id, version) uniqueness in database schema', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const userRes = await client.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('schema_tester', 'hash123', true)
        RETURNING id;
      `);
      const userId = userRes.rows[0].id;

      // 1. Version 0 in evidence_records must fail check constraint
      await expect(
        client.query(`
          INSERT INTO evidence_records (reference_text, description, version, created_by)
          VALUES ('REF-CHK-01', 'Test', 0, $1);
        `, [userId])
      ).rejects.toThrow();

      // 2. Valid evidence record
      const evRes = await client.query(`
        INSERT INTO evidence_records (reference_text, description, version, created_by)
        VALUES ('REF-CHK-01', 'Test', 1, $1)
        RETURNING id;
      `, [userId]);
      const evId = evRes.rows[0].id;

      // 3. Version 0 in evidence_history must fail check constraint
      await expect(
        client.query(`
          INSERT INTO evidence_history (evidence_id, version, action, actor_id, after_state)
          VALUES ($1, 0, 'created', $2, '{"ok": true}'::jsonb);
        `, [evId, userId])
      ).rejects.toThrow();

      // 4. Version 1 in evidence_history succeeds
      await client.query(`
        INSERT INTO evidence_history (evidence_id, version, action, actor_id, after_state)
        VALUES ($1, 1, 'created', $2, '{"ok": true}'::jsonb);
      `, [evId, userId]);

      // 5. Duplicate (evidence_id, version 1) in evidence_history must fail unique constraint
      await expect(
        client.query(`
          INSERT INTO evidence_history (evidence_id, version, action, actor_id, after_state)
          VALUES ($1, 1, 'corrected', $2, '{"ok": true}'::jsonb);
        `, [evId, userId])
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });

  it('preserves populated 0003 state (exact decimals, timestamps, links, retry tokens) during 0004 upgrade', async () => {
    // Start with a clean container for pure 0001 -> 0003 then 0003 -> 0004 verification
    const freshContainer = await new PostgreSqlContainer('postgres:18.6-alpine').start();
    const freshDbUrl = freshContainer.getConnectionUri();

    try {
      // 1. Run migrations up to 0003
      await runMigrator({
        command: 'up',
        databaseUrl: freshDbUrl,
        migrationFolder,
      }); // 0001
      await runMigrator({
        command: 'up',
        databaseUrl: freshDbUrl,
        migrationFolder,
      }); // 0002
      await runMigrator({
        command: 'up',
        databaseUrl: freshDbUrl,
        migrationFolder,
      }); // 0003

      // 2. Populate meaningful data in 0001, 0002, 0003 tables
      const client = new Client({ connectionString: freshDbUrl });
      await client.connect();

      let userId: string;
      let acqId: string;
      let assetId: string;
      const testTimestamp = '2026-10-26T12:00:00.000Z';

      try {
        const uRes = await client.query(`
          INSERT INTO users (username, password_hash, is_active, created_at)
          VALUES ('pop_user', 'hash_pop', true, $1)
          RETURNING id;
        `, [testTimestamp]);
        userId = uRes.rows[0].id;

        const acqRes = await client.query(`
          INSERT INTO acquisitions (acquisition_type, acquisition_date, total_amount, currency, source_reference, created_by, recorded_at)
          VALUES ('PURCHASE', '2026-10-26', 987654.32, 'THB', 'ACQ-REF-99', $1, $2)
          RETURNING id;
        `, [userId, testTimestamp]);
        acqId = acqRes.rows[0].id;

        const assetRes = await client.query(`
          INSERT INTO assets (asset_number, name, category, registered_by, acquisition_id, recorded_at)
          VALUES ('A-999', 'Laptop', 'IT', $1, $2, $3)
          RETURNING id;
        `, [userId, acqId, testTimestamp]);
        assetId = assetRes.rows[0].id;

        await client.query(`
          INSERT INTO asset_history (asset_id, action, actor_id, payload, recorded_at)
          VALUES ($1, 'REGISTERED', $2, '{"name": "Laptop", "initial": true}'::jsonb, $3);
        `, [assetId, userId, testTimestamp]);

        await client.query(`
          INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
          VALUES ('tok_asset_99', $1, 'asset:create', 'fp_99', 201, '{"id": "a99", "custom_bytes": "exact_match_check"}');
        `, [userId]);
      } finally {
        await client.end();
      }

      // 3. Upgrade to 0004
      const upResult = await runMigrator({
        command: 'up',
        databaseUrl: freshDbUrl,
        migrationFolder,
      });
      expect(upResult.error).toBeUndefined();
      expect(upResult.results?.[0]?.migrationName).toBe('0004_evidence');

      // 4. Assert exact data, decimals, and links survived unchanged
      const verifyClient = new Client({ connectionString: freshDbUrl });
      await verifyClient.connect();
      try {
        const userCheck = await verifyClient.query(`
          SELECT id, username, created_at FROM users WHERE id = $1;
        `, [userId]);
        expect(userCheck.rows[0].id).toBe(userId);
        expect(userCheck.rows[0].username).toBe('pop_user');
        expect(new Date(userCheck.rows[0].created_at).toISOString()).toBe(new Date(testTimestamp).toISOString());

        const acqCheck = await verifyClient.query(`
          SELECT id, total_amount::text as total_amount, currency, source_reference, recorded_at
          FROM acquisitions WHERE id = $1;
        `, [acqId]);
        expect(acqCheck.rows[0].id).toBe(acqId);
        expect(acqCheck.rows[0].total_amount).toBe('987654.32');
        expect(acqCheck.rows[0].currency).toBe('THB');
        expect(acqCheck.rows[0].source_reference).toBe('ACQ-REF-99');
        expect(new Date(acqCheck.rows[0].recorded_at).toISOString()).toBe(new Date(testTimestamp).toISOString());

        const assetCheck = await verifyClient.query(`
          SELECT id, asset_number, acquisition_id, registered_by, recorded_at FROM assets WHERE id = $1;
        `, [assetId]);
        expect(assetCheck.rows[0].id).toBe(assetId);
        expect(assetCheck.rows[0].asset_number).toBe('A-999');
        expect(assetCheck.rows[0].acquisition_id).toBe(acqId);
        expect(assetCheck.rows[0].registered_by).toBe(userId);
        expect(new Date(assetCheck.rows[0].recorded_at).toISOString()).toBe(new Date(testTimestamp).toISOString());

        const histCheck = await verifyClient.query(`
          SELECT asset_id, action, actor_id, payload, recorded_at FROM asset_history WHERE asset_id = $1;
        `, [assetId]);
        expect(histCheck.rows.length).toBe(1);
        expect(histCheck.rows[0].asset_id).toBe(assetId);
        expect(histCheck.rows[0].action).toBe('REGISTERED');
        expect(histCheck.rows[0].actor_id).toBe(userId);
        expect(histCheck.rows[0].payload).toEqual({ name: 'Laptop', initial: true });
        expect(new Date(histCheck.rows[0].recorded_at).toISOString()).toBe(new Date(testTimestamp).toISOString());

        const tokenCheck = await verifyClient.query(`
          SELECT token, actor_id, operation, payload_fingerprint, response_status, response_body
          FROM registration_retry_tokens WHERE token = 'tok_asset_99';
        `);
        expect(tokenCheck.rows.length).toBe(1);
        expect(tokenCheck.rows[0].token).toBe('tok_asset_99');
        expect(tokenCheck.rows[0].actor_id).toBe(userId);
        expect(tokenCheck.rows[0].operation).toBe('asset:create');
        expect(tokenCheck.rows[0].payload_fingerprint).toBe('fp_99');
        expect(tokenCheck.rows[0].response_status).toBe(201);
        expect(tokenCheck.rows[0].response_body).toEqual({ id: 'a99', custom_bytes: 'exact_match_check' });
      } finally {
        await verifyClient.end();
      }
    } finally {
      await freshContainer.stop().catch(() => {});
    }
  }, 120_000);

  it('enforces foreign key ON DELETE RESTRICT on evidence parents, links, and history', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // 1. Create user, acquisition, asset
      const uRes = await client.query(`
        INSERT INTO users (username, password_hash, is_active)
        VALUES ('fk_tester', 'hash_fk', true)
        RETURNING id;
      `);
      const userId = uRes.rows[0].id;

      // 2. Create independent acquisition linked ONLY to evidence_records
      const acqRes = await client.query(`
        INSERT INTO acquisitions (acquisition_type, acquisition_date, source_reference, created_by)
        VALUES ('PURCHASE', '2026-10-26', 'ACQ-FK-01', $1)
        RETURNING id;
      `, [userId]);
      const acqId = acqRes.rows[0].id;

      const evRes = await client.query(`
        INSERT INTO evidence_records (reference_text, description, acquisition_id, created_by)
        VALUES ('REF-FK-01', 'FK test evidence', $1, $2)
        RETURNING id;
      `, [acqId, userId]);
      const evId = evRes.rows[0].id;

      // 3. Link independent unparented asset
      const assetRes = await client.query(`
        INSERT INTO assets (asset_number, name, category, registered_by)
        VALUES ('A-FK-01', 'Server', 'IT', $1)
        RETURNING id;
      `, [userId]);
      const assetId = assetRes.rows[0].id;

      await client.query(`
        INSERT INTO evidence_asset_links (evidence_id, asset_id)
        VALUES ($1, $2);
      `, [evId, assetId]);

      // 4. Create history
      await client.query(`
        INSERT INTO evidence_history (evidence_id, version, action, actor_id, after_state)
        VALUES ($1, 1, 'created', $2, '{"ok": true}'::jsonb);
      `, [evId, userId]);

      // 5. Deleting acquisition must be restricted by evidence_records_acquisition_id_fkey
      await expect(
        client.query('DELETE FROM acquisitions WHERE id = $1', [acqId])
      ).rejects.toThrow(/evidence_records_acquisition_id_fkey/i);

      // 6. Deleting asset must be restricted by evidence_asset_links_asset_id_fkey
      await expect(
        client.query('DELETE FROM assets WHERE id = $1', [assetId])
      ).rejects.toThrow(/evidence_asset_links_asset_id_fkey/i);

      // 7. Deleting evidence record must be restricted by evidence_asset_links / evidence_history
      await expect(
        client.query('DELETE FROM evidence_records WHERE id = $1', [evId])
      ).rejects.toThrow(/(evidence_asset_links_evidence_id_fkey|evidence_history_evidence_id_fkey)/i);
    } finally {
      await client.end();
    }
  });
});
