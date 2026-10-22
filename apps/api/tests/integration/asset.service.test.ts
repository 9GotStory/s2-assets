import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import {
  AssetService,
  DuplicateCandidateWarningError,
  RetryTokenConflictError,
  ValidationError,
  type RegisterAssetInput,
} from '../../src/services/asset.service.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

describe('AssetService Integration Tests (Seam A - Core Service & Transactions)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let assetService: AssetService;
  let testActorId: string;
  let otherActorId: string;

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
    const databaseUrl = container.getConnectionUri();

    // Run migrations to latest
    await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });

    pool = new Pool({ connectionString: databaseUrl });
    assetService = new AssetService({ db: pool });

    // Seed test users
    const actorRes = await pool.query(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES ('custodian_alice', 'hash_a', true), ('custodian_bob', 'hash_b', true)
      RETURNING id, username;
    `);
    testActorId = actorRes.rows.find((r) => r.username === 'custodian_alice')!.id;
    otherActorId = actorRes.rows.find((r) => r.username === 'custodian_bob')!.id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    if (container) {
      await container.stop();
    }
  }, 30_000);

  beforeEach(async () => {
    // Clean registry tables before each test
    await pool.query('DELETE FROM registration_retry_tokens');
    await pool.query('DELETE FROM asset_history');
    await pool.query('DELETE FROM assets');
  });

  describe('R1: Truthful ordinary and legacy registration', () => {
    it('registers an ordinary described item with Stable ID and starting history fact', async () => {
      const input: RegisterAssetInput = {
        name: 'Dell Latitude 5420 Laptop',
        asset_number: 'AST-2026-001',
        serial_number: 'SN-ABC123XYZ',
        source_reference: 'PO-2026-88',
        source_notes: 'Delivered in good condition',
      };

      const result = await assetService.registerAsset(testActorId, input);

      expect(result.asset).toBeDefined();
      expect(result.asset.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(result.asset.name).toBe('Dell Latitude 5420 Laptop');
      expect(result.asset.asset_number).toBe('AST-2026-001');
      expect(result.asset.serial_number).toBe('SN-ABC123XYZ');
      expect(result.asset.organization_unit).toBeNull();
      expect(result.asset.category).toBeNull();
      expect(result.asset.source_reference).toBe('PO-2026-88');
      expect(result.asset.source_notes).toBe('Delivered in good condition');
      expect(result.asset.registered_by).toBe(testActorId);
      expect(result.asset.recorded_at).toBeDefined();

      // Check starting history fact committed in same transaction
      expect(result.history).toBeDefined();
      expect(result.history.action).toBe('REGISTERED');
      expect(result.history.asset_id).toBe(result.asset.id);
      expect(result.history.actor_id).toBe(testActorId);

      // Verify readback from DB
      const readback = await assetService.getAssetById(result.asset.id);
      expect(readback).not.toBeNull();
      expect(readback!.asset.id).toBe(result.asset.id);
      expect(readback!.history).toHaveLength(1);
      expect(readback!.history[0].action).toBe('REGISTERED');
    });

    it('preserves exact supplied identifiers without trimming or normalization (Finding Spec 8)', async () => {
      const untrimmedAssetNumber = '  A-01  ';
      const untrimmedSerialNumber = '  S-01  ';

      const result = await assetService.registerAsset(testActorId, {
        name: 'Untrimmed Hardware Unit',
        asset_number: untrimmedAssetNumber,
        serial_number: untrimmedSerialNumber,
      });

      expect(result.asset.asset_number).toBe(untrimmedAssetNumber);
      expect(result.asset.serial_number).toBe(untrimmedSerialNumber);

      const readback = await assetService.getAssetById(result.asset.id);
      expect(readback?.asset.asset_number).toBe(untrimmedAssetNumber);
      expect(readback?.asset.serial_number).toBe(untrimmedSerialNumber);
    });

    it('rejects ordinary registration when name is missing or blank without legacy flag', async () => {
      await expect(
        assetService.registerAsset(testActorId, {
          name: '',
          asset_number: 'AST-999',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.registerAsset(testActorId, {
          name: null as any,
          asset_number: 'AST-999',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('registers an incomplete legacy item with absent name and identifiers without placeholders', async () => {
      const input: RegisterAssetInput = {
        is_legacy: true,
        name: null,
        asset_number: null,
        serial_number: null,
        source_reference: 'Cabinet 3 Archive Tag',
        source_notes: 'Unlabeled metal cabinet found in basement storage',
      };

      const result = await assetService.registerAsset(testActorId, input);

      expect(result.asset.id).toBeDefined();
      expect(result.asset.name).toBeNull();
      expect(result.asset.asset_number).toBeNull();
      expect(result.asset.serial_number).toBeNull();
      expect(result.asset.source_reference).toBe('Cabinet 3 Archive Tag');
      expect(result.asset.source_notes).toBe('Unlabeled metal cabinet found in basement storage');
      expect(result.asset.registered_by).toBe(testActorId);

      // History fact records legacy registration
      expect(result.history.action).toBe('REGISTERED');
      expect(result.history.asset_id).toBe(result.asset.id);

      // Verify no "Unknown" string was fabricated
      const checkRes = await pool.query('SELECT * FROM assets WHERE id = $1', [result.asset.id]);
      expect(checkRes.rows[0].name).toBeNull();
      expect(checkRes.rows[0].asset_number).toBeNull();
      expect(checkRes.rows[0].serial_number).toBeNull();
    });

    it('enforces strict boolean types on is_legacy and explicit_continuation (Finding Standards 1)', async () => {
      // String booleans must be rejected rather than cast via Boolean(...)
      await expect(
        assetService.registerAsset(testActorId, {
          name: 'Some Item',
          is_legacy: 'false' as any,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.registerAsset(testActorId, {
          name: 'Some Item',
          explicit_continuation: 'false' as any,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects unapproved category and organization_unit population in T1 (Findings Spec 6 & 7)', async () => {
      await expect(
        assetService.registerAsset(testActorId, {
          name: 'Item with category',
          category: 'Unapproved taxonomy' as any,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.registerAsset(testActorId, {
          name: 'Item with org unit',
          organization_unit: 'IT Dept' as any,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('R2: Category optional and unset', () => {
    it('registers uncategorized asset and reads back as uncategorized', async () => {
      const result = await assetService.registerAsset(testActorId, {
        name: 'Office Chair Model X',
        category: null,
      });

      expect(result.asset.category).toBeNull();

      const readback = await assetService.getAssetById(result.asset.id);
      expect(readback?.asset.category).toBeNull();
    });
  });

  describe('D2: Duplicate candidate warning & explicit continuation', () => {
    it('warns when asset_number or serial_number matches existing record exactly', async () => {
      // Seed initial asset
      await assetService.registerAsset(testActorId, {
        name: 'Monitor A',
        asset_number: 'MON-100',
        serial_number: 'SER-444',
      });

      // Attempt registration with same asset_number without explicit_continuation
      await expect(
        assetService.registerAsset(testActorId, {
          name: 'Monitor B',
          asset_number: 'MON-100',
          serial_number: 'SER-555',
        })
      ).rejects.toThrow(DuplicateCandidateWarningError);

      // Attempt registration with same serial_number without explicit_continuation
      await expect(
        assetService.registerAsset(testActorId, {
          name: 'Monitor C',
          asset_number: 'MON-101',
          serial_number: 'SER-444',
        })
      ).rejects.toThrow(DuplicateCandidateWarningError);
    });

    it('returns bounded candidate records with deterministic tie-breaker (Finding Standards 3)', async () => {
      // Register multiple items with same asset number using explicit continuation
      const first = await assetService.registerAsset(testActorId, {
        name: 'Shared Item 1',
        asset_number: 'BOUNDED-NUM',
      });
      const second = await assetService.registerAsset(testActorId, {
        name: 'Shared Item 2',
        asset_number: 'BOUNDED-NUM',
        explicit_continuation: true,
      });
      const third = await assetService.registerAsset(testActorId, {
        name: 'Shared Item 3',
        asset_number: 'BOUNDED-NUM',
        explicit_continuation: true,
      });

      // Request with limit 2
      const candidates = await assetService.getDuplicateCandidates('BOUNDED-NUM', null, undefined, 2);
      expect(candidates).toHaveLength(2);

      // Verify deterministic tie-breaker: ordered by recorded_at DESC, id ASC
      expect(new Date(candidates[0].recorded_at).getTime()).toBeGreaterThanOrEqual(
        new Date(candidates[1].recorded_at).getTime()
      );

      // Empty query returns []
      expect(await assetService.getDuplicateCandidates('', '')).toEqual([]);
      expect(await assetService.getDuplicateCandidates(null, null)).toEqual([]);
    });

    it('allows registering a distinct item with explicit continuation', async () => {
      const first = await assetService.registerAsset(testActorId, {
        name: 'First Item',
        asset_number: 'SHARED-NUM-01',
      });

      const second = await assetService.registerAsset(testActorId, {
        name: 'Second Distinct Item (Same Number)',
        asset_number: 'SHARED-NUM-01',
        explicit_continuation: true,
      });

      expect(second.asset.id).not.toBe(first.asset.id);
      expect(second.asset.asset_number).toBe('SHARED-NUM-01');
      expect(second.asset.name).toBe('Second Distinct Item (Same Number)');

      // Verify two distinct records exist in database
      const countRes = await pool.query(
        'SELECT count(*)::int as count FROM assets WHERE asset_number = $1',
        ['SHARED-NUM-01']
      );
      expect(countRes.rows[0].count).toBe(2);
    });
  });

  describe('D4: Retry token idempotency & concurrent requests (Findings Standards 2 & Spec 4)', () => {
    it('replays original result when retry token and payload match', async () => {
      const token = 'retry-token-001';
      const input: RegisterAssetInput = {
        name: 'Barcode Scanner',
        asset_number: 'SCAN-001',
        serial_number: 'BC-777',
      };

      const firstAttempt = await assetService.registerAsset(testActorId, input, {
        retryToken: token,
      });

      const secondAttempt = await assetService.registerAsset(testActorId, input, {
        retryToken: token,
      });

      expect(secondAttempt.asset.id).toBe(firstAttempt.asset.id);
      expect(secondAttempt.asset.recorded_at).toBe(firstAttempt.asset.recorded_at);

      // Verify only 1 asset was inserted into DB
      const checkRes = await pool.query('SELECT count(*)::int as count FROM assets');
      expect(checkRes.rows[0].count).toBe(1);
    });

    it('handles concurrent identical requests safely without 500 or duplicate assets', async () => {
      const token = 'concurrent-identical-token';
      const input: RegisterAssetInput = {
        name: 'Concurrent Asset Registration',
        asset_number: 'CONC-AST-01',
      };

      // 8 concurrent identical requests with same token
      const promises = Array.from({ length: 8 }, () =>
        assetService.registerAsset(testActorId, input, { retryToken: token })
      );

      const results = await Promise.all(promises);

      // All 8 must succeed and return the exact same asset ID
      const expectedId = results[0].asset.id;
      for (const res of results) {
        expect(res.asset.id).toBe(expectedId);
      }

      // Exactly 1 asset row in database
      const countRes = await pool.query('SELECT count(*)::int as count FROM assets WHERE asset_number = $1', [
        'CONC-AST-01',
      ]);
      expect(countRes.rows[0].count).toBe(1);
    });

    it('fails with RetryTokenConflictError when same token is reused with different payload', async () => {
      const token = 'retry-token-002';
      const inputA: RegisterAssetInput = {
        name: 'Printer A',
        asset_number: 'PRN-01',
      };
      const inputB: RegisterAssetInput = {
        name: 'Printer B (Changed)',
        asset_number: 'PRN-02',
      };

      await assetService.registerAsset(testActorId, inputA, { retryToken: token });

      await expect(
        assetService.registerAsset(testActorId, inputB, { retryToken: token })
      ).rejects.toThrow(RetryTokenConflictError);

      // Verify second asset was NOT inserted
      const checkRes = await pool.query('SELECT count(*)::int as count FROM assets');
      expect(checkRes.rows[0].count).toBe(1);
    });

    it('scopes retry tokens by actor so distinct actors do not collide', async () => {
      const token = 'shared-token-str';
      const inputA: RegisterAssetInput = { name: 'Item Alice', asset_number: 'ITM-A' };
      const inputB: RegisterAssetInput = { name: 'Item Bob', asset_number: 'ITM-B' };

      const resAlice = await assetService.registerAsset(testActorId, inputA, { retryToken: token });
      const resBob = await assetService.registerAsset(otherActorId, inputB, { retryToken: token });

      expect(resAlice.asset.id).not.toBe(resBob.asset.id);

      const checkRes = await pool.query('SELECT count(*)::int as count FROM assets');
      expect(checkRes.rows[0].count).toBe(2);
    });
  });

  describe('Transaction Atomicity & Rollback', () => {
    it('rolls back completely if a failure occurs during asset registration', async () => {
      // Pass a non-existent actorId to violate foreign key on registered_by
      const invalidActorId = '00000000-0000-0000-0000-000000000999';

      await expect(
        assetService.registerAsset(invalidActorId, {
          name: 'Atomic Failure Test',
          asset_number: 'FAIL-01',
        })
      ).rejects.toThrow();

      // Ensure no rows in assets, asset_history or retry tokens
      const assets = await pool.query('SELECT count(*)::int as count FROM assets');
      const history = await pool.query('SELECT count(*)::int as count FROM asset_history');
      const tokens = await pool.query('SELECT count(*)::int as count FROM registration_retry_tokens');

      expect(assets.rows[0].count).toBe(0);
      expect(history.rows[0].count).toBe(0);
      expect(tokens.rows[0].count).toBe(0);
    });

    it('rolls back completely when mandatory history fact insertion fails', async () => {
      // Install temporary trigger that forces failure on asset_history insert
      await pool.query(`
        CREATE OR REPLACE FUNCTION fail_history_insert() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'forced history insertion failure';
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER test_fail_history_trigger
        BEFORE INSERT ON asset_history
        FOR EACH ROW EXECUTE FUNCTION fail_history_insert();
      `);

      try {
        await expect(
          assetService.registerAsset(testActorId, {
            name: 'Item With Failed History',
            asset_number: 'FAIL-HIST-01',
          })
        ).rejects.toThrow('forced history insertion failure');

        // Confirm asset was NOT committed
        const assets = await pool.query(
          'SELECT count(*)::int as count FROM assets WHERE asset_number = $1',
          ['FAIL-HIST-01']
        );
        expect(assets.rows[0].count).toBe(0);

        const history = await pool.query('SELECT count(*)::int as count FROM asset_history');
        expect(history.rows[0].count).toBe(0);
      } finally {
        await pool.query(`
          DROP TRIGGER IF EXISTS test_fail_history_trigger ON asset_history;
          DROP FUNCTION IF EXISTS fail_history_insert();
        `);
      }
    });
  });
});
