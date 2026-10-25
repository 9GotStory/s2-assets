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
  StaleBeforeConflictError,
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

      // Request with limit 2, offset 0 -> page 1
      const page1 = await assetService.getDuplicateCandidates('BOUNDED-NUM', null, undefined, 2, 0);
      expect(page1.candidates).toHaveLength(2);
      expect(page1.total_count).toBe(3);
      expect(page1.has_more).toBe(true);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      // Verify deterministic tie-breaker: ordered by recorded_at DESC, id ASC
      expect(new Date(page1.candidates[0].recorded_at).getTime()).toBeGreaterThanOrEqual(
        new Date(page1.candidates[1].recorded_at).getTime()
      );

      // Request next page: limit 2, offset 2 -> page 2
      const page2 = await assetService.getDuplicateCandidates('BOUNDED-NUM', null, undefined, 2, 2);
      expect(page2.candidates).toHaveLength(1);
      expect(page2.total_count).toBe(3);
      expect(page2.has_more).toBe(false);
      expect(page2.offset).toBe(2);

      // Empty query returns empty result with total_count: 0
      const emptyResult1 = await assetService.getDuplicateCandidates('', '');
      expect(emptyResult1.candidates).toEqual([]);
      expect(emptyResult1.total_count).toBe(0);
      expect(emptyResult1.has_more).toBe(false);

      const emptyResult2 = await assetService.getDuplicateCandidates(null, null);
      expect(emptyResult2.candidates).toEqual([]);
      expect(emptyResult2.total_count).toBe(0);
      expect(emptyResult2.has_more).toBe(false);
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

  describe('T2: Asset Correction, Idempotency & History (P1–P3, Seam A)', () => {
    it('successfully corrects metadata while preserving Stable ID, provenance, and original history fact', async () => {
      // 1. Register an asset
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Initial Name',
        asset_number: 'AST-INIT-001',
        serial_number: 'SN-INIT-001',
        source_reference: 'REF-001',
        source_notes: 'Notes 001',
      });
      const assetId = reg.asset.id;
      const originalRecordedAt = reg.asset.recorded_at;

      // 2. Correct metadata
      const correction = await assetService.correctAsset(testActorId, assetId, {
        name: 'Corrected Laptop Name',
        asset_number: 'AST-CORR-001',
        serial_number: 'SN-CORR-001',
        expected_name: 'Initial Name',
        expected_asset_number: 'AST-INIT-001',
        expected_serial_number: 'SN-INIT-001',
        reason: 'Typo in original inventory tag registration',
      }, { retryToken: crypto.randomUUID() });

      expect(correction.noop).toBe(false);
      expect(correction.asset.id).toBe(assetId); // Stable ID preserved
      expect(correction.asset.name).toBe('Corrected Laptop Name');
      expect(correction.asset.asset_number).toBe('AST-CORR-001');
      expect(correction.asset.serial_number).toBe('SN-CORR-001');
      expect(correction.asset.source_reference).toBe('REF-001'); // Provenance preserved
      expect(correction.asset.source_notes).toBe('Notes 001');
      expect(correction.asset.recorded_at).toBe(originalRecordedAt); // Initial recorded_at preserved

      // 3. Verify history fact created
      expect(correction.history).toBeDefined();
      expect(correction.history?.action).toBe('CORRECTED');
      expect(correction.history?.actor_id).toBe(testActorId);
      expect(correction.history?.payload).toEqual({
        reason: 'Typo in original inventory tag registration',
        changes: {
          name: { before: 'Initial Name', after: 'Corrected Laptop Name' },
          asset_number: { before: 'AST-INIT-001', after: 'AST-CORR-001' },
          serial_number: { before: 'SN-INIT-001', after: 'SN-CORR-001' },
        },
      });

      // 4. Verify detail query returns both starting fact and correction fact
      const detail = await assetService.getAssetById(assetId);
      expect(detail).not.toBeNull();
      expect(detail?.history.length).toBe(2);
      expect(detail?.history[0].action).toBe('REGISTERED');
      expect(detail?.history[1].action).toBe('CORRECTED');
    });

    it('requires a mandatory non-blank reason for any correction', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Reason Test Item',
        asset_number: 'AST-RSN-001',
      });

      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'New Name',
            expected_name: 'Reason Test Item',
            expected_asset_number: 'AST-RSN-001',
            expected_serial_number: null,
            reason: '',
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow('Mandatory non-blank reason is required for correction');

      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'New Name',
            expected_name: 'Reason Test Item',
            expected_asset_number: 'AST-RSN-001',
            expected_serial_number: null,
            reason: '   ',
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow('Mandatory non-blank reason is required for correction');
    });

    it('detects and rejects stale expected-before conflicts (optimistic locking)', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Stale Check Item',
        asset_number: 'AST-STALE-001',
      });

      // Provide outdated expected_name
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'Updated Name',
            expected_name: 'Wrong Old Name',
            expected_asset_number: 'AST-STALE-001',
            expected_serial_number: null,
            reason: 'Attempt update with stale before state',
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow('Current asset state differs from expected before values');
    });

    it('handles no-op submission without creating history or modifying timestamps', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'No-Op Asset',
        asset_number: 'AST-NOOP-001',
        serial_number: 'SN-NOOP-001',
      });

      const initialUpdatedAt = reg.asset.updated_at;

      // Submit identical values
      const res = await assetService.correctAsset(
        testActorId,
        reg.asset.id,
        {
          name: 'No-Op Asset',
          asset_number: 'AST-NOOP-001',
          serial_number: 'SN-NOOP-001',
          expected_name: 'No-Op Asset',
          expected_asset_number: 'AST-NOOP-001',
          expected_serial_number: 'SN-NOOP-001',
          reason: 'Attempted change with identical values',
        },
        { retryToken: crypto.randomUUID() }
      );

      expect(res.noop).toBe(true);
      expect(res.history).toBeNull();
      expect(res.asset.updated_at).toBe(initialUpdatedAt);

      // Verify no new row in asset_history
      const historyRows = await pool.query(
        'SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1',
        [reg.asset.id]
      );
      expect(historyRows.rows[0].count).toBe(1); // Only starting REGISTERED fact
    });


    it('enforces truthful name on ordinary assets while allowing null name on legacy assets', async () => {
      // Ordinary asset
      const ordinary = await assetService.registerAsset(testActorId, {
        name: 'Ordinary Item',
        asset_number: 'AST-ORD-01',
      });
      await expect(
        assetService.correctAsset(
          testActorId,
          ordinary.asset.id,
          {
            name: '',
            expected_name: 'Ordinary Item',
            expected_asset_number: 'AST-ORD-01',
            expected_serial_number: null,
            reason: 'Try to clear ordinary name',
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow('Truthful item name/description is required for ordinary assets');

      // Legacy asset
      const legacy = await assetService.registerAsset(testActorId, {
        name: 'Initial Legacy Name',
        asset_number: 'AST-LEG-01',
        is_legacy: true,
      });
      const correctedLegacy = await assetService.correctAsset(
        testActorId,
        legacy.asset.id,
        {
          name: null,
          expected_name: 'Initial Legacy Name',
          expected_asset_number: 'AST-LEG-01',
          expected_serial_number: null,
          reason: 'Genuine absence of name in legacy paper record',
        },
        { retryToken: crypto.randomUUID() }
      );
      expect(correctedLegacy.asset.name).toBeNull();
    });

    it('self-excludes current asset during duplicate check', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Item Self Dup',
        asset_number: 'AST-SELF-01',
        serial_number: 'SN-SELF-01',
      });

      // Correcting name while keeping same asset_number does not trigger duplicate warning against itself
      const res = await assetService.correctAsset(
        testActorId,
        reg.asset.id,
        {
          name: 'Corrected Name Only',
          asset_number: 'AST-SELF-01',
          serial_number: 'SN-SELF-01',
          expected_name: 'Item Self Dup',
          expected_asset_number: 'AST-SELF-01',
          expected_serial_number: 'SN-SELF-01',
          reason: 'Change name only',
          explicit_continuation: false,
        },
        { retryToken: crypto.randomUUID() }
      );

      expect(res.asset.name).toBe('Corrected Name Only');
      expect(res.asset.asset_number).toBe('AST-SELF-01');
    });

    it('warns on duplicate identifiers on ANOTHER asset and requires explicit continuation', async () => {
      // Asset A
      await assetService.registerAsset(testActorId, {
        name: 'Existing Asset A',
        asset_number: 'AST-COLLIDE-99',
      });

      // Asset B
      const assetB = await assetService.registerAsset(testActorId, {
        name: 'Asset B',
        asset_number: 'AST-DISTINCT-01',
      });

      // Try correcting Asset B's asset_number to match Asset A's without explicit continuation
      await expect(
        assetService.correctAsset(
          testActorId,
          assetB.asset.id,
          {
            asset_number: 'AST-COLLIDE-99',
            expected_name: 'Asset B',
            expected_asset_number: 'AST-DISTINCT-01',
            expected_serial_number: null,
            reason: 'Correcting to existing number',
            explicit_continuation: false,
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow(DuplicateCandidateWarningError);

      // Now with explicit_continuation: true, correction proceeds
      const res = await assetService.correctAsset(
        testActorId,
        assetB.asset.id,
        {
          asset_number: 'AST-COLLIDE-99',
          expected_name: 'Asset B',
          expected_asset_number: 'AST-DISTINCT-01',
          expected_serial_number: null,
          reason: 'Confirmed distinct physical item sharing number',
          explicit_continuation: true,
        },
        { retryToken: crypto.randomUUID() }
      );

      expect(res.asset.asset_number).toBe('AST-COLLIDE-99');
    });

    it('F-04: evaluates duplicate warning predicate on changed identifiers only (changed-number/unchanged-matching-serial, inverse, and both-changed)', async () => {
      // 1. Seed existing asset A
      await assetService.registerAsset(testActorId, {
        name: 'Asset Alpha',
        asset_number: 'AST-PRED-ALPHA',
        serial_number: 'SN-PRED-SHARED',
      });

      // 2. Seed asset B sharing serial_number with Asset A via explicit continuation
      const assetB = await assetService.registerAsset(testActorId, {
        name: 'Asset Beta',
        asset_number: 'AST-PRED-BETA',
        serial_number: 'SN-PRED-SHARED',
        explicit_continuation: true,
      });

      // Case A: Changed asset_number to a unique value, unchanged serial_number (which matches Asset Alpha)
      // Because serial_number did NOT change, it must NOT warn on the unchanged serial_number match!
      const corrA = await assetService.correctAsset(
        testActorId,
        assetB.asset.id,
        {
          asset_number: 'AST-PRED-BETA-UNIQUE',
          expected_name: 'Asset Beta',
          expected_asset_number: 'AST-PRED-BETA',
          expected_serial_number: 'SN-PRED-SHARED',
          reason: 'Updating asset number uniquely',
          explicit_continuation: false,
        },
        { retryToken: crypto.randomUUID() }
      );
      expect(corrA.asset.asset_number).toBe('AST-PRED-BETA-UNIQUE');

      // Case B: Changed asset_number to match Asset Alpha's asset_number -> triggers duplicate warning!
      await expect(
        assetService.correctAsset(
          testActorId,
          assetB.asset.id,
          {
            asset_number: 'AST-PRED-ALPHA',
            expected_name: 'Asset Beta',
            expected_asset_number: 'AST-PRED-BETA-UNIQUE',
            expected_serial_number: 'SN-PRED-SHARED',
            reason: 'Colliding number',
            explicit_continuation: false,
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow(DuplicateCandidateWarningError);

      // Case C: Inverse - unchanged asset_number, changed serial_number to a unique value
      // Does not warn on unchanged asset_number, succeeds cleanly
      const corrC = await assetService.correctAsset(
        testActorId,
        assetB.asset.id,
        {
          serial_number: 'SN-PRED-BETA-UNIQUE',
          expected_name: 'Asset Beta',
          expected_asset_number: 'AST-PRED-BETA-UNIQUE',
          expected_serial_number: 'SN-PRED-SHARED',
          reason: 'Updating serial uniquely',
          explicit_continuation: false,
        },
        { retryToken: crypto.randomUUID() }
      );
      expect(corrC.asset.serial_number).toBe('SN-PRED-BETA-UNIQUE');

      // Case D: Changed serial_number to match Asset Alpha's serial_number -> triggers duplicate warning!
      await expect(
        assetService.correctAsset(
          testActorId,
          assetB.asset.id,
          {
            serial_number: 'SN-PRED-SHARED',
            expected_name: 'Asset Beta',
            expected_asset_number: 'AST-PRED-BETA-UNIQUE',
            expected_serial_number: 'SN-PRED-BETA-UNIQUE',
            reason: 'Colliding serial',
            explicit_continuation: false,
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow(DuplicateCandidateWarningError);

      // Case E: Both changed - changing both to collide with Asset Alpha -> warns
      await expect(
        assetService.correctAsset(
          testActorId,
          assetB.asset.id,
          {
            asset_number: 'AST-PRED-ALPHA',
            serial_number: 'SN-PRED-SHARED',
            expected_name: 'Asset Beta',
            expected_asset_number: 'AST-PRED-BETA-UNIQUE',
            expected_serial_number: 'SN-PRED-BETA-UNIQUE',
            reason: 'Colliding both',
            explicit_continuation: false,
          },
          { retryToken: crypto.randomUUID() }
        )
      ).rejects.toThrow(DuplicateCandidateWarningError);
    });

    it('supports idempotent retries with scoped retry tokens and replaying matching committed results', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Original Laptop',
        asset_number: 'AST-RETRY-01',
        serial_number: 'SN-RETRY-01',
      });

      const token = 'correct-retry-token-' + crypto.randomUUID();
      const input = {
        name: 'Corrected Laptop Retry',
        expected_name: 'Original Laptop',
        expected_asset_number: 'AST-RETRY-01',
        expected_serial_number: 'SN-RETRY-01',
        reason: 'Correct typo with token',
      };

      // 1. First execution
      const firstRes = await assetService.correctAsset(testActorId, reg.asset.id, input, {
        retryToken: token,
      });
      expect(firstRes.asset.name).toBe('Corrected Laptop Retry');
      expect(firstRes.history).toBeDefined();
      const historyId = firstRes.history?.id;

      // 2. Replay with identical token and payload
      // Note: In DB, name is now 'Corrected Laptop Retry', but input has expected_name: 'Original Laptop'.
      // The replay must succeed and return the committed result without checking expected-before against the updated DB!
      const replayRes = await assetService.correctAsset(testActorId, reg.asset.id, input, {
        retryToken: token,
      });

      expect(replayRes.asset.name).toBe('Corrected Laptop Retry');
      expect(replayRes.history?.id).toBe(historyId);

      // Verify only ONE correction history fact exists in database
      const countRes = await pool.query(
        "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [reg.asset.id]
      );
      expect(countRes.rows[0].count).toBe(1);

      // 3. Replay with SAME token but DIFFERENT payload must fail with RetryTokenConflictError
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            ...input,
            name: 'Completely Different Name',
          },
          { retryToken: token }
        )
      ).rejects.toThrow(RetryTokenConflictError);
    });

    it('allows legitimate clearing of erroneous asset_number to null without blanket prohibition', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Asset With Wrong Number',
        asset_number: 'ERRONEOUS-1234',
        serial_number: 'SN-CLEAR-01',
      });

      // Clear the erroneous asset_number by explicitly setting asset_number to null
      const res = await assetService.correctAsset(
        testActorId,
        reg.asset.id,
        {
          name: 'Asset With Wrong Number',
          asset_number: null,
          serial_number: 'SN-CLEAR-01',
          expected_name: 'Asset With Wrong Number',
          expected_asset_number: 'ERRONEOUS-1234',
          expected_serial_number: 'SN-CLEAR-01',
          reason: 'แก้ไขเนื่องจากบันทึกเลขครุภัณฑ์ผิดพลาด แท้จริงไม่มีเลขติดตัวเครื่อง',
        },
        { retryToken: crypto.randomUUID() }
      );

      expect(res.asset.asset_number).toBeNull();
      const dbRow = await pool.query('SELECT asset_number FROM assets WHERE id = $1', [reg.asset.id]);
      expect(dbRow.rows[0].asset_number).toBeNull();
    });

    it('allows no-op correction without reason, and writes no metadata, history, or retry ledger', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'No-Op Asset',
        asset_number: 'NOOP-001',
        serial_number: 'SN-NOOP-01',
      });

      const token = crypto.randomUUID();
      const res = await assetService.correctAsset(
        testActorId,
        reg.asset.id,
        {
          name: 'No-Op Asset',
          asset_number: 'NOOP-001',
          serial_number: 'SN-NOOP-01',
          expected_name: 'No-Op Asset',
          expected_asset_number: 'NOOP-001',
          expected_serial_number: 'SN-NOOP-01',
        } as any,
        { retryToken: token }
      );

      expect(res.noop).toBe(true);
      expect(res.history).toBeNull();

      // Verify no 'CORRECTED' history fact was inserted
      const histRes = await pool.query(
        "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [reg.asset.id]
      );
      expect(histRes.rows[0].count).toBe(0);

      // Verify no retry ledger entry was written on no-op
      const tokenRes = await pool.query(
        'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
        [token]
      );
      expect(tokenRes.rows[0].count).toBe(0);
    });

    it('strictly requires all three expected-before own properties and rejects missing ones', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Strict Expected Asset',
        asset_number: 'STRICT-001',
      });

      const token = crypto.randomUUID();

      // Missing expected_name
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'New Name',
            asset_number: 'STRICT-001',
            serial_number: null,
            expected_asset_number: 'STRICT-001',
            expected_serial_number: null,
            reason: 'Missing expected_name',
          } as any,
          { retryToken: token }
        )
      ).rejects.toThrow(ValidationError);

      // Missing expected_asset_number
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'New Name',
            asset_number: 'STRICT-001',
            serial_number: null,
            expected_name: 'Strict Expected Asset',
            expected_serial_number: null,
            reason: 'Missing expected_asset_number',
          } as any,
          { retryToken: token }
        )
      ).rejects.toThrow(ValidationError);

      // Missing expected_serial_number
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'New Name',
            asset_number: 'STRICT-001',
            serial_number: null,
            expected_name: 'Strict Expected Asset',
            expected_asset_number: 'STRICT-001',
            reason: 'Missing expected_serial_number',
          } as any,
          { retryToken: token }
        )
      ).rejects.toThrow(ValidationError);
    });

    it('preserves exact nonempty identifiers verbatim without trimming internal or outer spacing', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Verbatim Asset',
        asset_number: 'VERBATIM-ORIG',
      });

      const res = await assetService.correctAsset(
        testActorId,
        reg.asset.id,
        {
          name: 'Verbatim Asset',
          asset_number: '  SPACED-NUMBER  ',
          serial_number: '  SPACED-SN  ',
          expected_name: 'Verbatim Asset',
          expected_asset_number: 'VERBATIM-ORIG',
          expected_serial_number: null,
          reason: 'Preserve exact identifiers verbatim',
        },
        { retryToken: crypto.randomUUID() }
      );

      expect(res.asset.asset_number).toBe('  SPACED-NUMBER  ');
      expect(res.asset.serial_number).toBe('  SPACED-SN  ');
    });

    it('strictly requires a nonblank retryToken in options and rejects missing/blank token with ValidationError', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Token Required Asset',
        asset_number: 'TR-001',
      });

      // Missing options
      await expect(
        assetService.correctAsset(testActorId, reg.asset.id, {
          name: 'Updated Name',
          expected_name: 'Token Required Asset',
          expected_asset_number: 'TR-001',
          expected_serial_number: null,
          reason: 'Testing token requirement',
        })
      ).rejects.toThrow(/retry token/i);

      // Empty string token
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'Updated Name',
            expected_name: 'Token Required Asset',
            expected_asset_number: 'TR-001',
            expected_serial_number: null,
            reason: 'Testing token requirement',
          },
          { retryToken: '' }
        )
      ).rejects.toThrow(/retry token/i);

      // Whitespace-only token
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'Updated Name',
            expected_name: 'Token Required Asset',
            expected_asset_number: 'TR-001',
            expected_serial_number: null,
            reason: 'Testing token requirement',
          },
          { retryToken: '   ' }
        )
      ).rejects.toThrow(/retry token/i);
    });

    it('rejects whitespace-different payload under committed token and leaves exactly one audit entry', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Original WS Asset',
        asset_number: 'WS-001',
      });

      const retryToken = crypto.randomUUID();
      // First correction with trailing space in name
      const res1 = await assetService.correctAsset(
        testActorId,
        reg.asset.id,
        {
          name: 'Spaced Name ',
          expected_name: 'Original WS Asset',
          expected_asset_number: 'WS-001',
          expected_serial_number: null,
          reason: 'First correction with trailing space',
        },
        { retryToken }
      );
      expect(res1.asset.name).toBe('Spaced Name ');

      // Second correction with same token but without trailing space (different payload)
      await expect(
        assetService.correctAsset(
          testActorId,
          reg.asset.id,
          {
            name: 'Spaced Name',
            expected_name: 'Original WS Asset',
            expected_asset_number: 'WS-001',
            expected_serial_number: null,
            reason: 'First correction with trailing space',
          },
          { retryToken }
        )
      ).rejects.toThrow(RetryTokenConflictError);

      // Verify exactly one CORRECTED history record exists
      const historyRes = await pool.query(
        "SELECT id, action, payload FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [reg.asset.id]
      );
      expect(historyRes.rows.length).toBe(1);

      // Verify database name is still the verbatim first name 'Spaced Name '
      const assetRes = await pool.query('SELECT name FROM assets WHERE id = $1', [reg.asset.id]);
      expect(assetRes.rows[0].name).toBe('Spaced Name ');
    });

    it('guarantees atomic coherent snapshot across assets and history tables during concurrent correction commit in production getAssetById', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Before Snapshot Name',
        asset_number: 'SNAP-001',
      });

      let interleaveTriggered = false;
      const originalConnect = pool.connect.bind(pool);

      const interceptedPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await originalConnect();
          const origQuery = client.query.bind(client);

          client.query = async function (textOrConfig: any, ...args: any[]) {
            const result = await origQuery(textOrConfig, ...args);
            const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig?.text || '';

            // Deterministically interleave right after reading the assets table inside production getAssetById
            if (text.includes('FROM assets') && !interleaveTriggered) {
              interleaveTriggered = true;
              const retryToken = crypto.randomUUID();
              await assetService.correctAsset(
                testActorId,
                reg.asset.id,
                {
                  name: 'After Snapshot Name',
                  expected_name: 'Before Snapshot Name',
                  expected_asset_number: 'SNAP-001',
                  expected_serial_number: null,
                  reason: 'Concurrent correction commit during production getAssetById read',
                },
                { retryToken }
              );
            }
            return result;
          };
          return client;
        },
      };

      const testService = new AssetService({ db: interceptedPool });

      // Call actual production getAssetById()
      const result = await testService.getAssetById(reg.asset.id);

      expect(interleaveTriggered).toBe(true);
      expect(result).not.toBeNull();
      // Asset facts must match the snapshot taken at query start
      expect(result!.asset.name).toBe('Before Snapshot Name');

      // History facts must also match the exact same snapshot (zero CORRECTED rows seen)
      const correctedHistory = result!.history.filter((h) => h.action === 'CORRECTED');
      expect(correctedHistory.length).toBe(0);

      // Verify that outside the snapshot, the database did commit 'After Snapshot Name' and the CORRECTED history row
      const checkOutside = await assetService.getAssetById(reg.asset.id);
      expect(checkOutside!.asset.name).toBe('After Snapshot Name');
      const outsideHistory = checkOutside!.history.filter((h) => h.action === 'CORRECTED');
      expect(outsideHistory.length).toBe(1);
    });

    it('rolls back completely when failure occurs during audit history insertion after UPDATE', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Rollback Audit Asset',
        asset_number: 'RBA-001',
      });

      // Install temporary trigger that fails during audit insertion
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_fail_audit_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'CORRECTED' AND NEW.payload->>'reason' = 'FAIL_AUDIT_INSERTION_NOW' THEN
            RAISE EXCEPTION 'simulated failure during audit insertion';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        CREATE TRIGGER trg_test_fail_audit
        BEFORE INSERT ON asset_history
        FOR EACH ROW EXECUTE FUNCTION test_fail_audit_insert();
      `);

      const retryToken = crypto.randomUUID();
      try {
        await expect(
          assetService.correctAsset(
            testActorId,
            reg.asset.id,
            {
              name: 'Should Be Rolled Back',
              expected_name: 'Rollback Audit Asset',
              expected_asset_number: 'RBA-001',
              expected_serial_number: null,
              reason: 'FAIL_AUDIT_INSERTION_NOW',
            },
            { retryToken }
          )
        ).rejects.toThrow(/simulated failure during audit insertion/);

        // Check DB: assets table was updated in SQL, but transaction rollback restored it!
        const dbAsset = await pool.query('SELECT name FROM assets WHERE id = $1', [reg.asset.id]);
        expect(dbAsset.rows[0].name).toBe('Rollback Audit Asset');

        // Check DB: zero CORRECTED history rows
        const histRes = await pool.query(
          "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
          [reg.asset.id]
        );
        expect(histRes.rows[0].count).toBe(0);

        // Check DB: zero retry token rows
        const tokenRes = await pool.query(
          'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
          [retryToken]
        );
        expect(tokenRes.rows[0].count).toBe(0);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS trg_test_fail_audit ON asset_history;');
        await pool.query('DROP FUNCTION IF EXISTS test_fail_audit_insert();');
      }
    });

    it('rolls back completely when failure occurs during retry token ledger insertion', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Rollback Ledger Asset',
        asset_number: 'RBL-001',
      });

      const failToken = 'FAIL_LEDGER_TEST_TOKEN';
      // Install temporary trigger that fails during retry ledger insertion
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_fail_ledger_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'FAIL_LEDGER_TEST_TOKEN' THEN
            RAISE EXCEPTION 'simulated failure during retry ledger insertion';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        CREATE TRIGGER trg_test_fail_ledger
        BEFORE INSERT ON registration_retry_tokens
        FOR EACH ROW EXECUTE FUNCTION test_fail_ledger_insert();
      `);

      try {
        await expect(
          assetService.correctAsset(
            testActorId,
            reg.asset.id,
            {
              name: 'Should Be Rolled Back',
              expected_name: 'Rollback Ledger Asset',
              expected_asset_number: 'RBL-001',
              expected_serial_number: null,
              reason: 'Testing ledger failure rollback',
            },
            { retryToken: failToken }
          )
        ).rejects.toThrow(/simulated failure during retry ledger insertion/);

        // Check DB: assets table was updated in SQL, but rollback restored it!
        const dbAsset = await pool.query('SELECT name FROM assets WHERE id = $1', [reg.asset.id]);
        expect(dbAsset.rows[0].name).toBe('Rollback Ledger Asset');

        // Check DB: zero CORRECTED history rows
        const histRes = await pool.query(
          "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
          [reg.asset.id]
        );
        expect(histRes.rows[0].count).toBe(0);

        // Check DB: zero retry token rows
        const tokenRes = await pool.query(
          'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
          [failToken]
        );
        expect(tokenRes.rows[0].count).toBe(0);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS trg_test_fail_ledger ON registration_retry_tokens;');
        await pool.query('DROP FUNCTION IF EXISTS test_fail_ledger_insert();');
      }
    });

    it('handles concurrent identical correction requests safely returning identical response with exactly one audit row and one ledger row', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Concurrent Identical Asset',
        asset_number: 'CI-001',
      });

      const sharedToken = crypto.randomUUID();
      const payload = {
        name: 'Updated Name Concurrently',
        expected_name: 'Concurrent Identical Asset',
        expected_asset_number: 'CI-001',
        expected_serial_number: null,
        reason: 'Concurrent test reason',
      };

      const [res1, res2] = await Promise.all([
        assetService.correctAsset(testActorId, reg.asset.id, payload, { retryToken: sharedToken }),
        assetService.correctAsset(testActorId, reg.asset.id, payload, { retryToken: sharedToken }),
      ]);

      expect(res1.asset.name).toBe('Updated Name Concurrently');
      expect(res2.asset.name).toBe('Updated Name Concurrently');
      expect(res1.asset.updated_at).toBe(res2.asset.updated_at);

      // Check DB: exactly one CORRECTED history row
      const histRes = await pool.query(
        "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [reg.asset.id]
      );
      expect(histRes.rows[0].count).toBe(1);

      // Check DB: exactly one retry token row
      const tokenRes = await pool.query(
        'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
        [sharedToken]
      );
      expect(tokenRes.rows[0].count).toBe(1);
    });

    it('handles concurrent conflicting payloads under same retry token: one commits and one throws RetryTokenConflictError', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Concurrent Conflict Asset',
        asset_number: 'CC-001',
      });

      const sharedToken = crypto.randomUUID();
      const payloadA = {
        name: 'Payload A',
        expected_name: 'Concurrent Conflict Asset',
        expected_asset_number: 'CC-001',
        expected_serial_number: null,
        reason: 'Reason A',
      };
      const payloadB = {
        name: 'Payload B',
        expected_name: 'Concurrent Conflict Asset',
        expected_asset_number: 'CC-001',
        expected_serial_number: null,
        reason: 'Reason B',
      };

      const results = await Promise.allSettled([
        assetService.correctAsset(testActorId, reg.asset.id, payloadA, { retryToken: sharedToken }),
        assetService.correctAsset(testActorId, reg.asset.id, payloadB, { retryToken: sharedToken }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RetryTokenConflictError);

      // Exactly one CORRECTED audit record in database
      const histRes = await pool.query(
        "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [reg.asset.id]
      );
      expect(histRes.rows[0].count).toBe(1);
    });

    it('handles competing corrections with distinct valid tokens: one commits, competitor rejected with StaleBeforeConflictError, no lost update', async () => {
      const reg = await assetService.registerAsset(testActorId, {
        name: 'Distinct Tokens Asset',
        asset_number: 'DT-001',
      });

      const tokenA = crypto.randomUUID();
      const tokenB = crypto.randomUUID();

      const payloadA = {
        name: 'Winner A Name',
        expected_name: 'Distinct Tokens Asset',
        expected_asset_number: 'DT-001',
        expected_serial_number: null,
        reason: 'Reason A distinct token',
      };
      const payloadB = {
        name: 'Competitor B Name',
        expected_name: 'Distinct Tokens Asset',
        expected_asset_number: 'DT-001',
        expected_serial_number: null,
        reason: 'Reason B distinct token',
      };

      const results = await Promise.allSettled([
        assetService.correctAsset(testActorId, reg.asset.id, payloadA, { retryToken: tokenA }),
        assetService.correctAsset(testActorId, reg.asset.id, payloadB, { retryToken: tokenB }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason).toBeInstanceOf(StaleBeforeConflictError);

      // Verify no lost update: DB reflects the fulfilled winner
      const winnerName = fulfilled[0].value.asset.name;
      const assetRes = await pool.query('SELECT name FROM assets WHERE id = $1', [reg.asset.id]);
      expect(assetRes.rows[0].name).toBe(winnerName);

      // Exactly one CORRECTED audit record in database
      const histRes = await pool.query(
        "SELECT count(*)::int as count FROM asset_history WHERE asset_id = $1 AND action = 'CORRECTED'",
        [reg.asset.id]
      );
      expect(histRes.rows[0].count).toBe(1);

      // Scoped committed ledger outcome: only the winning token has a committed record
      const winningToken = winnerName === 'Winner A Name' ? tokenA : tokenB;
      const losingToken = winnerName === 'Winner A Name' ? tokenB : tokenA;

      const tokenWinRes = await pool.query(
        'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
        [winningToken]
      );
      expect(tokenWinRes.rows[0].count).toBe(1);

      const tokenLoseRes = await pool.query(
        'SELECT count(*)::int as count FROM registration_retry_tokens WHERE token = $1',
        [losingToken]
      );
      expect(tokenLoseRes.rows[0].count).toBe(0);
    });
  });

  describe('searchAssets Integration Tests (Seam A - T3)', () => {
    it('performs exact identifier search on asset_number, serial_number, and stable_id', async () => {
      const a1 = await assetService.registerAsset(testActorId, {
        name: 'Server Rack A',
        asset_number: 'SRV-001',
        serial_number: 'SN-RACK-01',
      });
      const a2 = await assetService.registerAsset(testActorId, {
        name: 'Server Rack B',
        asset_number: 'SRV-002',
        serial_number: 'SN-RACK-02',
      });

      // Exact asset_number
      const resAssetNum = await assetService.searchAssets({
        field: 'asset_number',
        value: 'SRV-001',
      });
      expect(resAssetNum.items).toHaveLength(1);
      expect(resAssetNum.items[0].id).toBe(a1.asset.id);
      expect(resAssetNum.items[0].asset_number).toBe('SRV-001');
      expect(resAssetNum.total_count).toBe(1);
      expect(resAssetNum.has_more).toBe(false);

      // Exact serial_number
      const resSerial = await assetService.searchAssets({
        field: 'serial_number',
        value: 'SN-RACK-02',
      });
      expect(resSerial.items).toHaveLength(1);
      expect(resSerial.items[0].id).toBe(a2.asset.id);
      expect(resSerial.total_count).toBe(1);

      // Exact stable_id UUID
      const resId = await assetService.searchAssets({
        field: 'stable_id',
        value: a1.asset.id,
      });
      expect(resId.items).toHaveLength(1);
      expect(resId.items[0].id).toBe(a1.asset.id);
      expect(resId.total_count).toBe(1);
    });

    it('performs case-insensitive literal substring search on name with literal %, _, \\ escaping', async () => {
      const a1 = await assetService.registerAsset(testActorId, {
        name: 'Special %_\\ Asset Item',
        asset_number: 'SPEC-01',
      });
      const a2 = await assetService.registerAsset(testActorId, {
        name: 'Ordinary Asset Item',
        asset_number: 'ORD-01',
      });

      // Substring match case-insensitive
      const resSubstring = await assetService.searchAssets({
        field: 'name',
        value: 'special',
      });
      expect(resSubstring.items).toHaveLength(1);
      expect(resSubstring.items[0].id).toBe(a1.asset.id);

      // Literal %_\ matching
      const resLiteral = await assetService.searchAssets({
        field: 'name',
        value: '%_\\',
      });
      expect(resLiteral.items).toHaveLength(1);
      expect(resLiteral.items[0].id).toBe(a1.asset.id);

      // Verify that % was not treated as a wildcard matching all items
      expect(resLiteral.total_count).toBe(1);
    });

    it('performs empty browse returning all items ordered by recorded_at DESC, id ASC', async () => {
      const a1 = await assetService.registerAsset(testActorId, { name: 'Item One' });
      const a2 = await assetService.registerAsset(testActorId, { name: 'Item Two' });

      // No field or value -> browse
      const resBrowse = await assetService.searchAssets({});
      expect(resBrowse.items.length).toBeGreaterThanOrEqual(2);
      expect(resBrowse.total_count).toBeGreaterThanOrEqual(2);
      // Items must be ordered recorded_at DESC, id ASC
      expect(resBrowse.items[0].id).toBe(a2.asset.id);
      expect(resBrowse.items[1].id).toBe(a1.asset.id);

      // Field provided with empty string value -> also browse
      const resBrowseEmptyVal = await assetService.searchAssets({ field: 'name', value: '' });
      expect(resBrowseEmptyVal.total_count).toBe(resBrowse.total_count);
    });

    it('supports pagination with limit, offset, total_count, and has_more', async () => {
      for (let i = 1; i <= 5; i++) {
        await assetService.registerAsset(testActorId, { name: `Batch Item ${i}` });
      }

      // Page 1: limit 2, offset 0
      const page1 = await assetService.searchAssets({ limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total_count).toBe(5);
      expect(page1.has_more).toBe(true);

      // Page 2: limit 2, offset 2
      const page2 = await assetService.searchAssets({ limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(2);
      expect(page2.total_count).toBe(5);
      expect(page2.has_more).toBe(true);

      // Page 3: limit 2, offset 4
      const page3 = await assetService.searchAssets({ limit: 2, offset: 4 });
      expect(page3.items).toHaveLength(1);
      expect(page3.total_count).toBe(5);
      expect(page3.has_more).toBe(false);

      // Beyond last page: offset 10
      const pageBeyond = await assetService.searchAssets({ limit: 2, offset: 10 });
      expect(pageBeyond.items).toHaveLength(0);
      expect(pageBeyond.total_count).toBe(5);
      expect(pageBeyond.has_more).toBe(false);
    });

    it('rejects invalid inputs with ValidationError', async () => {
      // Field without value
      await expect(assetService.searchAssets({ field: 'name' })).rejects.toThrow(ValidationError);

      // Value without field
      await expect(assetService.searchAssets({ value: 'some-value' })).rejects.toThrow(ValidationError);

      // Invalid UUID for stable_id
      await expect(
        assetService.searchAssets({ field: 'stable_id', value: 'not-a-uuid' })
      ).rejects.toThrow(ValidationError);

      // Non-empty whitespace-only query for name
      await expect(
        assetService.searchAssets({ field: 'name', value: '   ' })
      ).rejects.toThrow(ValidationError);

      // NUL character in value
      await expect(
        assetService.searchAssets({ field: 'name', value: 'null\0byte' })
      ).rejects.toThrow(ValidationError);

      // Oversized value > 4096 bytes
      const bigValue = 'a'.repeat(4097);
      await expect(
        assetService.searchAssets({ field: 'name', value: bigValue })
      ).rejects.toThrow(ValidationError);

      // Leading-zero limit and offset (F1)
      await expect(
        assetService.searchAssets({ limit: '01' })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ limit: '025' })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ offset: '00' })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ offset: '01' })
      ).rejects.toThrow(ValidationError);

      // IR-F1: Padded UUID with leading/trailing/surrounding whitespace must be rejected with ValidationError
      const sampleUuid = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
      await expect(
        assetService.searchAssets({ field: 'stable_id', value: ` ${sampleUuid}` })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ field: 'stable_id', value: `${sampleUuid} ` })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ field: 'stable_id', value: `  ${sampleUuid}  ` })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ field: 'stable_id', value: `\t${sampleUuid}` })
      ).rejects.toThrow(ValidationError);

      await expect(
        assetService.searchAssets({ field: 'stable_id', value: `${sampleUuid}\n` })
      ).rejects.toThrow(ValidationError);
    });

    it('IR-F1: handles valid UUID formats, empty-value browse, and non-matching valid UUID', async () => {
      const reg = await assetService.registerAsset(testActorId, { name: 'UUID Test Asset' });
      const validId = reg.asset.id;

      // Lowercase valid UUID
      const resLower = await assetService.searchAssets({
        field: 'stable_id',
        value: validId.toLowerCase(),
      });
      expect(resLower.items).toHaveLength(1);
      expect(resLower.items[0].id).toBe(validId);

      // Uppercase valid UUID
      const resUpper = await assetService.searchAssets({
        field: 'stable_id',
        value: validId.toUpperCase(),
      });
      expect(resUpper.items).toHaveLength(1);
      expect(resUpper.items[0].id).toBe(validId);

      // Non-matching valid UUID
      const resNoMatch = await assetService.searchAssets({
        field: 'stable_id',
        value: '00000000-0000-0000-0000-000000000000',
      });
      expect(resNoMatch.items).toHaveLength(0);
      expect(resNoMatch.total_count).toBe(0);

      // Empty-value stable_id -> browse mode preserved
      const resBrowse = await assetService.searchAssets({
        field: 'stable_id',
        value: '',
      });
      expect(resBrowse.total_count).toBeGreaterThan(0);
    });

    it('IR-F2: guarantees recorded_at DESC, id ASC order across page boundaries with tie-breaking and truthful counts', async () => {
      // Clean assets table before deterministic tie test
      await pool.query('DELETE FROM asset_history');
      await pool.query('DELETE FROM assets');

      // Seed 4 items: two with same recorded_at timestamp (tie), two with distinct timestamps
      const t1 = new Date('2026-01-01T10:00:00.000Z');
      const t2 = new Date('2026-01-01T12:00:00.000Z');
      const t3 = new Date('2026-01-01T14:00:00.000Z');

      const idA = '11111111-1111-1111-1111-111111111111';
      const idB = '22222222-2222-2222-2222-222222222222';
      const idC = '33333333-3333-3333-3333-333333333333';
      const idD = '44444444-4444-4444-4444-444444444444';

      // Insert: idD at t1 (oldest), idC at t3 (newest), idA and idB both at t2 (tie)
      await pool.query(
        `INSERT INTO assets (id, name, asset_number, serial_number, registered_by, recorded_at) VALUES
          ($1, 'Item D', 'AST-D', 'SN-D', $5, $6),
          ($2, 'Item C', 'AST-C', 'SN-C', $5, $7),
          ($3, 'Item A', 'AST-A', 'SN-A', $5, $8),
          ($4, 'Item B', 'AST-B', 'SN-B', $5, $8)`,
        [idD, idC, idA, idB, testActorId, t1, t3, t2]
      );

      // Expected order:
      // 1st: idC (t3, newest)
      // 2nd: idA (t2, tie broken by id ASC: idA < idB)
      // 3rd: idB (t2, tie broken by id ASC)
      // 4th: idD (t1, oldest)

      // Full browse
      const full = await assetService.searchAssets({ limit: 10, offset: 0 });
      expect(full.total_count).toBe(4);
      expect(full.items.map((i) => i.id)).toEqual([idC, idA, idB, idD]);

      // Public items must have strictly id, name, asset_number, serial_number and NO internal sort keys
      expect(Object.keys(full.items[0]).sort()).toEqual(
        ['asset_number', 'id', 'name', 'serial_number'].sort()
      );
      expect((full.items[0] as any).recorded_at).toBeUndefined();

      // Page 1: limit 2, offset 0 -> [idC, idA]
      const p1 = await assetService.searchAssets({ limit: 2, offset: 0 });
      expect(p1.items.map((i) => i.id)).toEqual([idC, idA]);
      expect(p1.total_count).toBe(4);
      expect(p1.has_more).toBe(true);

      // Page 2: limit 2, offset 2 -> [idB, idD]
      const p2 = await assetService.searchAssets({ limit: 2, offset: 2 });
      expect(p2.items.map((i) => i.id)).toEqual([idB, idD]);
      expect(p2.total_count).toBe(4);
      expect(p2.has_more).toBe(false);

      // Beyond-end page: offset 10 -> empty items, truthful total_count 4, has_more false
      const beyond = await assetService.searchAssets({ limit: 2, offset: 10 });
      expect(beyond.items).toEqual([]);
      expect(beyond.total_count).toBe(4);
      expect(beyond.has_more).toBe(false);

      // Empty table count
      await pool.query('DELETE FROM assets');
      const empty = await assetService.searchAssets({ limit: 10, offset: 0 });
      expect(empty.items).toEqual([]);
      expect(empty.total_count).toBe(0);
      expect(empty.has_more).toBe(false);
    });
  });
});
