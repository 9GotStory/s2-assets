import * as crypto from 'node:crypto';
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

// F009-T2 (#204): 0030_compatible_stock_materials against a populated 0029 database (Seam C): one row per pair of
// Requestable Material and Stock Material with whether it is current (P1), and the history kinds of an add and an end
// (#202 Q8, Q17, Q26).
describe('Compatible Stock Material Migration Integration (Seam C - F009-T2)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  const ids: Record<string, string> = {};

  const withClient = async <T>(run: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  };

  const schemaOf = (client: pg.Client) =>
    Promise.all([
      client.query(`SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
                    FROM information_schema.columns WHERE table_schema = 'public'
                    ORDER BY table_name, column_name`),
      client.query(`SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
                    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                    ORDER BY 1, 2`),
      client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
                    ORDER BY tablename, indexname`),
    ]).then((results) => results.map((res) => res.rows));

  // A pair of the Requestable Material and the Stock Material `ids`, unless `fields` says otherwise.
  const pair = (client: pg.Client, fields: Record<string, unknown> = {}) => {
    const values = { requestable_material_id: ids.requestable, stock_material_id: ids.material, ...fields };
    const columns = Object.keys(values);
    return client.query(`INSERT INTO compatible_stock_materials (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values));
  };

  // A history entry of the Requestable Material at `version` of `kind`, naming the Stock Material after or before.
  const historyEntry = (client: pg.Client, version: number, kind: string) =>
    client.query(
      `INSERT INTO requestable_material_history (requestable_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        ids.requestable,
        version,
        kind,
        JSON.stringify([
          kind === 'COMPATIBLE_STOCK_MATERIAL_ADDED'
            ? { field: 'compatible_stock_material', before: null, after: { id: ids.material, name: 'กระดาษ A4 80 แกรม' } }
            : { field: 'compatible_stock_material', before: { id: ids.material, name: 'กระดาษ A4 80 แกรม' }, after: null },
        ]),
        ids.user,
      ]
    );

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
      await container.stop().catch(() => {});
    }
  });

  it('adds the empty Compatible Stock Materials to a populated database, leaving its Requestable Materials and their history as they were', async () => {
    for (let step = 1; step <= 29; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t2_compatible_user', 'hash') RETURNING id`)).rows[0].id;
        ids.unit = (await client.query(`INSERT INTO units (name, created_by, updated_by) VALUES ('รีม', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.material = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('กระดาษ A4 80 แกรม', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.requestable = (
          await client.query(`INSERT INTO requestable_materials (name, request_unit_id, created_by) VALUES ('กระดาษ A4', $1, $2) RETURNING id`, [ids.unit, ids.user])
        ).rows[0].id;
        await client.query(
          `INSERT INTO requestable_material_history (requestable_material_id, version, kind, changes, recorded_by)
           VALUES ($1, 1, 'CREATED', '[{"field":"name","before":null,"after":"กระดาษ A4"}]'::jsonb, $2)`,
          [ids.requestable, ids.user]
        );
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0030_compatible_stock_materials');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM compatible_stock_materials')).rows[0].n).toBe(0);
      expect((await client.query('SELECT name, version FROM requestable_materials')).rows).toEqual([{ name: 'กระดาษ A4', version: 1 }]);
      expect((await client.query('SELECT version, kind FROM requestable_material_history')).rows).toEqual([{ version: 1, kind: 'CREATED' }]);
    });
  });

  it('keeps one row per pair, current unless told otherwise, naming a real Requestable Material and Stock Material that cannot be deleted under it', async () => {
    await withClient(async (client) => {
      await pair(client);
      expect((await client.query('SELECT is_current FROM compatible_stock_materials')).rows).toEqual([{ is_current: true }]);
      await expect(pair(client, { is_current: false })).rejects.toThrow(/compatible_stock_materials_pkey/);
      await expect(pair(client, { requestable_material_id: crypto.randomUUID() })).rejects.toThrow(/requestable_material_id/);
      await expect(pair(client, { stock_material_id: crypto.randomUUID() })).rejects.toThrow(/stock_material_id/);
      await expect(pair(client, { is_current: null })).rejects.toThrow(/is_current/);
      await expect(client.query('DELETE FROM stock_materials WHERE id = $1', [ids.material])).rejects.toThrow(/compatible_stock_materials/);
      await expect(client.query('DELETE FROM requestable_materials WHERE id = $1', [ids.requestable])).rejects.toThrow(/compatible_stock_materials|requestable_material_history/);

      // One Stock Material for several Requestable Materials (MRQ-27).
      const other = (await client.query(`INSERT INTO requestable_materials (name, request_unit_id, created_by) VALUES ('กระดาษถ่ายเอกสาร', $1, $2) RETURNING id`, [ids.unit, ids.user])).rows[0].id;
      await pair(client, { requestable_material_id: other });
      expect((await client.query('SELECT count(*)::int AS n FROM compatible_stock_materials WHERE stock_material_id = $1', [ids.material])).rows[0].n).toBe(2);
    });
  });

  it('takes the history kinds of an add and an end, and still refuses one it does not know', async () => {
    await withClient(async (client) => {
      await historyEntry(client, 2, 'COMPATIBLE_STOCK_MATERIAL_ADDED');
      await historyEntry(client, 3, 'COMPATIBLE_STOCK_MATERIAL_ENDED');
      // The kinds of 0029 still go in.
      for (const [version, kind] of [[4, 'RENAMED'], [5, 'DETAILS_CHANGED'], [6, 'INACTIVATED'], [7, 'REACTIVATED']] as const) {
        await historyEntry(client, version, kind);
      }
      await expect(historyEntry(client, 8, 'COMPATIBLE_STOCK_MATERIAL_MERGED')).rejects.toThrow(/requestable_material_history_kind_check/);
    });
  });

  it('refuses a rollback while a Compatible Stock Material, a history entry of an add or an end, or a retry receipt of either exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback: Compatible Stock Materials, their history or their retry receipts exist');

    // Pairs alone.
    await withClient((client) => client.query(`DELETE FROM requestable_material_history WHERE kind <> 'CREATED'`));
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM compatible_stock_materials');
      await historyEntry(client, 2, 'COMPATIBLE_STOCK_MATERIAL_ADDED');
    });
    // A history entry of an add alone.
    await refused();
    await withClient(async (client) => {
      await client.query(`DELETE FROM requestable_material_history WHERE kind <> 'CREATED'`);
      await historyEntry(client, 2, 'COMPATIBLE_STOCK_MATERIAL_ENDED');
    });
    // A history entry of an end alone.
    await refused();
    for (const operation of ['compatible-stock-material:add', 'compatible-stock-material:end']) {
      await withClient(async (client) => {
        await client.query(`DELETE FROM requestable_material_history WHERE kind <> 'CREATED'`);
        await client.query('DELETE FROM registration_retry_tokens');
        await client.query(
          `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
           VALUES ('t2-compatible-receipt', $1, $2, 'fingerprint', 200, '{}')`,
          [ids.user, operation]
        );
      });
      // A retry receipt of an add or an end alone.
      await refused();
    }
    await withClient(async (client) => {
      await client.query('DELETE FROM registration_retry_tokens');
      await client.query(`DELETE FROM requestable_materials WHERE name = 'กระดาษถ่ายเอกสาร'`);
    });

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0030_compatible_stock_materials', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(await schemaOf(client)).toEqual(JSON.parse(ids.schemaBefore));
      expect((await client.query('SELECT name FROM requestable_materials')).rows).toEqual([{ name: 'กระดาษ A4' }]);
      expect((await client.query('SELECT name FROM stock_materials')).rows).toEqual([{ name: 'กระดาษ A4 80 แกรม' }]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0030_compatible_stock_materials');
  });
});
