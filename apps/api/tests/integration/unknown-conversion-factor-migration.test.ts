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

// F008-T3 (#178): 0026_unknown_conversion_factor against a populated 0025 database (Seam C). When the Base Unit
// changes, an Inactive Alternate Unit given no new Conversion Factor keeps none, rather than one that converts to the
// old Base Unit (#178 PO decision 1, comment 6998878850).
describe('Unknown Conversion Factor Migration Integration (Seam C - F008-T3)', () => {
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

  // A Unit of the Stock Material, written as `fields` say over an Alternate Unit กล่อง.
  const materialUnit = (client: pg.Client, fields: Record<string, unknown>) => {
    const values: Record<string, unknown> = { stock_material_id: ids.material, unit_id: ids.box, is_base: false, ...fields };
    const columns = Object.keys(values);
    return client.query(
      `INSERT INTO stock_material_units (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values)
    );
  };

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

  it('lets a Conversion Factor be unknown on a populated database, and leaves its Units alone', async () => {
    for (let step = 1; step <= 25; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t3_material_user', 'hash') RETURNING id`)).rows[0].id;
        const unit = async (name: string) => (await client.query('INSERT INTO units (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id', [name, ids.user])).rows[0].id;
        ids.sheet = await unit('แผ่น');
        ids.box = await unit('กล่อง');
        ids.ream = await unit('รีม');
        ids.material = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('กระดาษ A4', $1) RETURNING id`, [ids.user])).rows[0].id;
        await materialUnit(client, { unit_id: ids.sheet, is_base: true, conversion_factor: '1' });
        await materialUnit(client, { unit_id: ids.ream, conversion_factor: '500', is_active: false });
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0026_unknown_conversion_factor');

    await withClient(async (client) => {
      expect((await client.query('SELECT unit_id, trim_scale(conversion_factor)::text AS factor, is_active FROM stock_material_units ORDER BY is_base DESC')).rows).toEqual([
        { unit_id: ids.sheet, factor: '1', is_active: true },
        { unit_id: ids.ream, factor: '500', is_active: false },
      ]);
    });
  });

  it('leaves a Conversion Factor unknown only on an Inactive Alternate Unit, and keeps every known one above 0', async () => {
    await withClient(async (client) => {
      await client.query('UPDATE stock_material_units SET conversion_factor = NULL WHERE unit_id = $1', [ids.ream]);
      // An active Alternate Unit converts at a known factor.
      await expect(materialUnit(client, { conversion_factor: null })).rejects.toThrow(/stock_material_units_factor_known_unless_inactive/);
      // So does the Base Unit, Inactive or not.
      await expect(client.query('UPDATE stock_material_units SET conversion_factor = NULL WHERE unit_id = $1', [ids.sheet])).rejects.toThrow(/stock_material_units_factor_known_unless_inactive/);
      await client.query('UPDATE stock_material_units SET conversion_factor = 1 WHERE unit_id = $1', [ids.sheet]);
      // A known factor stays above 0.
      await expect(materialUnit(client, { conversion_factor: '0', is_active: false })).rejects.toThrow(/stock_material_units_conversion_factor_check/);
      await materialUnit(client, { conversion_factor: null, is_active: false });
      // Reactivating it needs a factor.
      await expect(client.query('UPDATE stock_material_units SET is_active = true WHERE unit_id = $1', [ids.box])).rejects.toThrow(/stock_material_units_factor_known_unless_inactive/);
    });
  });

  it('refuses a rollback while a Conversion Factor is unknown, and rolls back cleanly once none is', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    await withClient((client) => client.query('UPDATE stock_material_units SET conversion_factor = 500 WHERE unit_id = $1', [ids.ream]));
    // One unknown factor alone.
    expect(String((await down()).error)).toContain('Refusing rollback: a Conversion Factor is unknown');
    await withClient((client) => client.query('DELETE FROM stock_material_units WHERE unit_id = $1', [ids.box]));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0026_unknown_conversion_factor', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM stock_material_units')).rows[0].n).toBe(2);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0026_unknown_conversion_factor');
  });
});
