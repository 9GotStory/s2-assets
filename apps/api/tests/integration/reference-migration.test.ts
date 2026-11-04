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

const NEW_ASSET_COLUMNS = [
  'location_id',
  'organization_unit_id',
  'responsible_person_id',
  'legacy_location_text',
  'legacy_responsible_person_text',
];

// T4 (#25): 0005_reference_context against a populated 0004 database (Seam C).
describe('Reference Context Migration Integration (Seam C - T4)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let userId: string;
  let incompleteAssetId: string;
  let legacyAssetId: string;

  const withClient = async <T>(run: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  };

  const snapshot = (client: pg.Client, table: string, order: string) =>
    client.query(`SELECT * FROM ${table} ORDER BY ${order}`).then((res) => res.rows);

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
  }, 30_000);

  it('preserves incomplete Assets and foundation records when 0005 upgrades a populated 0004 database', async () => {
    for (let step = 1; step <= 4; step++) {
      const result = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
      expect(result.error).toBeUndefined();
    }

    const before = await withClient(async (client) => {
      userId = (
        await client.query(`INSERT INTO users (username, password_hash, is_active) VALUES ('ref_mig_user', 'hash', true) RETURNING id`)
      ).rows[0].id;
      const acquisitionId = (
        await client.query(
          `INSERT INTO acquisitions (acquisition_type, acquisition_date, total_amount, currency, source_reference, created_by)
           VALUES ('PURCHASE', '2026-10-26', 12345.67, 'THB', 'ACQ-REF-T4', $1) RETURNING id`,
          [userId]
        )
      ).rows[0].id;
      // An incomplete Asset: no identifiers, no category, no context.
      incompleteAssetId = (
        await client.query(`INSERT INTO assets (name, registered_by) VALUES ('โต๊ะไม่มีเลข', $1) RETURNING id`, [userId])
      ).rows[0].id;
      // An Asset whose placeholder organization_unit holds text written outside the API.
      legacyAssetId = (
        await client.query(
          `INSERT INTO assets (asset_number, name, category, organization_unit, registered_by, acquisition_id)
           VALUES ('A-T4-1', 'เครื่องพิมพ์', 'IT', 'กองคลัง (ข้อความเดิม)', $1, $2) RETURNING id`,
          [userId, acquisitionId]
        )
      ).rows[0].id;
      for (const assetId of [incompleteAssetId, legacyAssetId]) {
        await client.query(
          `INSERT INTO asset_history (asset_id, action, actor_id, payload) VALUES ($1, 'REGISTERED', $2, '{"initial": true}'::jsonb)`,
          [assetId, userId]
        );
      }
      const evidenceId = (
        await client.query(
          `INSERT INTO evidence_records (reference_text, description, created_by) VALUES ('EV-T4', 'ใบส่งของ', $1) RETURNING id`,
          [userId]
        )
      ).rows[0].id;
      await client.query(`INSERT INTO evidence_asset_links (evidence_id, asset_id) VALUES ($1, $2)`, [evidenceId, incompleteAssetId]);
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('tok_t4', $1, 'asset:create', 'fp_t4', 201, '{"id": "a-t4"}')`,
        [userId]
      );

      return {
        assets: await snapshot(client, 'assets', 'id'),
        unchanged: {
          users: await snapshot(client, 'users', 'id'),
          acquisitions: await snapshot(client, 'acquisitions', 'id'),
          asset_history: await snapshot(client, 'asset_history', 'id'),
          evidence_records: await snapshot(client, 'evidence_records', 'id'),
          evidence_asset_links: await snapshot(client, 'evidence_asset_links', 'evidence_id, asset_id'),
          registration_retry_tokens: await snapshot(client, 'registration_retry_tokens', 'token'),
        },
      };
    });

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0005_reference_context');

    await withClient(async (client) => {
      const assets = await snapshot(client, 'assets', 'id');
      expect(assets).toHaveLength(before.assets.length);
      assets.forEach((asset, index) => {
        const { organization_unit, ...kept } = before.assets[index];
        expect(asset).toMatchObject(kept);
        expect(asset.legacy_organization_unit_text).toBe(organization_unit);
        for (const column of NEW_ASSET_COLUMNS) {
          expect(asset[column], column).toBeNull();
        }
        expect(asset).not.toHaveProperty('organization_unit');
      });
      expect(assets.find((asset) => asset.id === legacyAssetId)?.legacy_organization_unit_text).toBe('กองคลัง (ข้อความเดิม)');

      for (const [table, rows] of Object.entries(before.unchanged)) {
        const order = table === 'evidence_asset_links' ? 'evidence_id, asset_id' : table === 'registration_retry_tokens' ? 'token' : 'id';
        expect(await snapshot(client, table, order), table).toEqual(rows);
      }

      // Every list starts empty: no entry is invented from legacy text (D7).
      for (const table of ['locations', 'organization_units', 'persons']) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      }
    });
  });

  it('keeps the three lists distinct, unique by name ignoring case and spaces, and never blank', async () => {
    await withClient(async (client) => {
      const add = (table: string, name: string, version = 1) =>
        client.query(`INSERT INTO ${table} (name, version, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`, [
          name,
          version,
          userId,
        ]);

      await add('locations', 'Main Office');
      await expect(add('locations', '  main office ')).rejects.toMatchObject({ code: '23505' });
      await add('organization_units', 'Main Office');
      await add('persons', 'Main Office');
      await expect(add('persons', '   ')).rejects.toMatchObject({ code: '23514' });
      await expect(add('persons', 'Version Zero', 0)).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('restricts removing an entry an Asset names, and refuses an Asset naming a missing entry', async () => {
    await withClient(async (client) => {
      const personId = (await client.query(`SELECT id FROM persons WHERE name = 'Main Office'`)).rows[0].id;
      await client.query(`UPDATE assets SET responsible_person_id = $1 WHERE id = $2`, [personId, incompleteAssetId]);
      await expect(client.query(`DELETE FROM persons WHERE id = $1`, [personId])).rejects.toThrow(
        /assets_responsible_person_id_fkey/
      );
      await expect(
        client.query(`UPDATE assets SET location_id = '00000000-0000-4000-8000-000000000000' WHERE id = $1`, [incompleteAssetId])
      ).rejects.toThrow(/assets_location_id_fkey/);
    });
  });

  it('refuses rollback once an entry or Asset context exists, and rolls back cleanly when none does', async () => {
    const refused = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(String(refused.error)).toContain('Refusing destructive rollback');

    // Asset context alone, here legacy text, still refuses.
    await withClient(async (client) => {
      await client.query(`UPDATE assets SET responsible_person_id = NULL`);
      await client.query(`DELETE FROM locations`);
      await client.query(`DELETE FROM organization_units`);
      await client.query(`DELETE FROM persons`);
    });
    const refusedForText = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(String(refusedForText.error)).toContain('Refusing destructive rollback');

    await withClient((client) => client.query(`UPDATE assets SET legacy_organization_unit_text = NULL`));
    const rollback = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0005_reference_context', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      const columns = (
        await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assets'`)
      ).rows.map((row) => row.column_name);
      expect(columns).toContain('organization_unit');
      expect(columns).not.toContain('legacy_organization_unit_text');
      for (const column of NEW_ASSET_COLUMNS) {
        expect(columns).not.toContain(column);
      }
      const tables = (
        await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
      ).rows.map((row) => row.table_name);
      expect(tables).not.toContain('locations');
      expect(tables).not.toContain('organization_units');
      expect(tables).not.toContain('persons');
      expect((await client.query(`SELECT count(*)::int AS n FROM assets`)).rows[0].n).toBe(2);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0005_reference_context');
  });
});
