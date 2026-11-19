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

// F008-T6 (#182): 0028_minimum_stock against a populated 0027 database (Seam C). A Stock Material's optional Minimum
// Stock (จำนวนขั้นต่ำ) in its Base Unit, kept exactly to four decimal places (#175 MC-20, Q14, Q28, P1).
describe('Minimum Stock Migration Integration (Seam C - F008-T6)', () => {
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
      client.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns WHERE table_schema = 'public'
                    ORDER BY table_name, column_name`),
      client.query(`SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
                    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                    ORDER BY 1, 2`),
      client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
                    ORDER BY tablename, indexname`),
    ]).then((results) => results.map((res) => res.rows));

  // Sets the Minimum Stock of the Stock Material where it is stored.
  const setMinimumStock = (client: pg.Client, value: string | null) => client.query('UPDATE stock_materials SET minimum_stock = $2 WHERE id = $1', [ids.material, value]);

  // The Minimum Stock as stored, without trailing zeros.
  const minimumStockOf = async (client: pg.Client) =>
    (await client.query('SELECT trim_scale(minimum_stock)::text AS minimum_stock FROM stock_materials WHERE id = $1', [ids.material])).rows[0].minimum_stock;

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

  it('adds a Minimum Stock to a populated database, leaving its Stock Materials with none (MC-20: nothing guessed)', async () => {
    for (let step = 1; step <= 27; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t6_material_user', 'hash') RETURNING id`)).rows[0].id;
        ids.material = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('น้ำยาล้างจาน', $1) RETURNING id`, [ids.user])).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0028_minimum_stock');

    await withClient(async (client) => {
      expect((await client.query('SELECT name, minimum_stock, version FROM stock_materials WHERE id = $1', [ids.material])).rows).toEqual([
        { name: 'น้ำยาล้างจาน', minimum_stock: null, version: 1 },
      ]);
    });
  });

  it('keeps a Minimum Stock above 0 exactly to four decimal places, and lets it be none', async () => {
    await withClient(async (client) => {
      await setMinimumStock(client, '2.5');
      expect(await minimumStockOf(client)).toBe('2.5');
      await setMinimumStock(client, '0.0001');
      expect(await minimumStockOf(client)).toBe('0.0001');
      await setMinimumStock(client, '99999999999999.9999');
      expect(await minimumStockOf(client)).toBe('99999999999999.9999');
      await expect(setMinimumStock(client, '0')).rejects.toThrow(/stock_materials_minimum_stock_check/);
      await expect(setMinimumStock(client, '-1')).rejects.toThrow(/stock_materials_minimum_stock_check/);
      await expect(setMinimumStock(client, '100000000000000')).rejects.toThrow(/numeric field overflow/);
      await setMinimumStock(client, null);
      expect(await minimumStockOf(client)).toBeNull();
    });
  });

  it('refuses a rollback while a Stock Material has a Minimum Stock, and rolls back cleanly once none has', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    await withClient((client) => setMinimumStock(client, '3'));
    // One Minimum Stock alone.
    expect(String((await down()).error)).toContain('Refusing destructive rollback: a Stock Material has a Minimum Stock');
    await withClient((client) => setMinimumStock(client, null));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0028_minimum_stock', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM stock_materials')).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0028_minimum_stock');
  });
});
