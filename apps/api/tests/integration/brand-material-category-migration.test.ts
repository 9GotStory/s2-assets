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

// The two lists of F008-T4, each with its history table and the Stock Material column that names one of its entries.
const LISTS = [
  { table: 'brands', history: 'brand_history', column: 'brand_id' },
  { table: 'material_categories', history: 'material_category_history', column: 'material_category_id' },
] as const;

// F008-T4 (#179): 0027_brands_material_categories against a populated 0026 database (Seam C): the Brand and Material
// Category lists with their histories, a Stock Material's references to them, and the history kind of a change of
// other details (#175 MC-12, MC-26, Q3, Q4, Q11, Q20, Q28).
describe('Brand and Material Category Migration Integration (Seam C - F008-T4)', () => {
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

  // Inserts a row of `table` from `values`, returning its id when it has one.
  const insert = async (client: pg.Client, table: string, values: Record<string, unknown>): Promise<string | undefined> => {
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  // An entry of the list `table`, named uniquely unless `fields` says otherwise.
  const entry = (client: pg.Client, table: string, fields: Record<string, unknown> = {}) =>
    insert(client, table, { name: `รายการ ${crypto.randomUUID()}`, created_by: ids.user, updated_by: ids.user, ...fields });

  // A history entry of the Stock Material at `version`: a change of other details, unless `fields` says otherwise.
  const historyEntry = (client: pg.Client, version: number, fields: Record<string, unknown> = {}) =>
    insert(client, 'stock_material_history', {
      stock_material_id: ids.material,
      version,
      kind: 'DETAILS_CHANGED',
      changes: JSON.stringify([{ field: 'note', before: null, after: 'ใช้ในงานธุรการ' }]),
      recorded_by: ids.user,
      ...fields,
    });

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

  it('adds the empty Brand and Material Category lists to a populated database, and leaves its Stock Materials with neither', async () => {
    for (let step = 1; step <= 26; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t4_material_user', 'hash') RETURNING id`)).rows[0].id;
        ids.material = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('กระดาษ A4', $1) RETURNING id`, [ids.user])).rows[0].id;
        await client.query(
          `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, 1, 'CREATED', $2, $3)`,
          [ids.material, JSON.stringify([{ field: 'name', before: null, after: 'กระดาษ A4' }]), ids.user]
        );
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0027_brands_material_categories');

    await withClient(async (client) => {
      // Nothing is seeded (#175 Q3).
      for (const { table, history } of LISTS) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
        expect((await client.query(`SELECT count(*)::int AS n FROM ${history}`)).rows[0].n).toBe(0);
      }
      expect((await client.query('SELECT name, brand_id, material_category_id, version FROM stock_materials WHERE id = $1', [ids.material])).rows).toEqual([
        { name: 'กระดาษ A4', brand_id: null, material_category_id: null, version: 1 },
      ]);
    });
  });

  it('keeps one entry per name in each list, ignoring case and repeated spaces, Inactive ones included, and a nonblank name of at most 200 characters', async () => {
    await withClient(async (client) => {
      for (const { table } of LISTS) {
        const first = (await entry(client, table, { name: 'Double  A' }))!;
        expect((await client.query(`SELECT is_active, version FROM ${table} WHERE id = $1`, [first])).rows).toEqual([{ is_active: true, version: 1 }]);
        await expect(entry(client, table, { name: 'double a' })).rejects.toThrow(new RegExp(`${table}_name_unique`));
        await client.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [first]);
        await expect(entry(client, table, { name: ' DOUBLE   A ' })).rejects.toThrow(new RegExp(`${table}_name_unique`));
        await entry(client, table, { name: 'Double AA' });
        await expect(entry(client, table, { name: '  ' })).rejects.toThrow(new RegExp(`${table}_name_check`));
        await expect(entry(client, table, { name: 'ก'.repeat(201) })).rejects.toThrow(/too long/);
        await expect(entry(client, table, { created_by: crypto.randomUUID() })).rejects.toThrow(/created_by/);
        await expect(entry(client, table, { version: 0 })).rejects.toThrow(new RegExp(`${table}_version_check`));
      }
      // The two lists are apart: one name may be in both.
      ids.brand = (await entry(client, 'brands', { name: 'สำนักงาน' }))!;
      ids.category = (await entry(client, 'material_categories', { name: 'สำนักงาน' }))!;
    });
  });

  it('keeps a history row per entry version, naming a real entry and actor', async () => {
    await withClient(async (client) => {
      for (const { history, column } of LISTS) {
        const listEntry = column === 'brand_id' ? ids.brand : ids.category;
        const row = (fields: Record<string, unknown> = {}) =>
          insert(client, history, { [column]: listEntry, version: 1, action: 'CREATED', changes: JSON.stringify({ name: { before: null, after: 'สำนักงาน' } }), actor_id: ids.user, ...fields });
        await row();
        await expect(row()).rejects.toThrow(new RegExp(`${history}_${column}_version`));
        await expect(row({ version: 2, action: 'DELETED' })).rejects.toThrow(/action/);
        await expect(row({ version: 2, [column]: crypto.randomUUID() })).rejects.toThrow(new RegExp(column));
        await expect(row({ version: 2, actor_id: crypto.randomUUID() })).rejects.toThrow(/actor_id/);
        await row({ version: 2, action: 'CHANGED' });
      }
      // An entry with history cannot be deleted under it.
      await expect(client.query('DELETE FROM brands WHERE id = $1', [ids.brand])).rejects.toThrow(/brand_history/);
      await expect(client.query('DELETE FROM material_categories WHERE id = $1', [ids.category])).rejects.toThrow(/material_category_history/);
    });
  });

  it('lets a Stock Material name one Brand and one Material Category of their own lists, and keeps an entry it names', async () => {
    await withClient(async (client) => {
      await client.query('UPDATE stock_materials SET brand_id = $2, material_category_id = $3 WHERE id = $1', [ids.material, ids.brand, ids.category]);
      expect((await client.query('SELECT brand_id, material_category_id FROM stock_materials WHERE id = $1', [ids.material])).rows).toEqual([
        { brand_id: ids.brand, material_category_id: ids.category },
      ]);
      // Each names an entry of its own list.
      await expect(client.query('UPDATE stock_materials SET brand_id = $2 WHERE id = $1', [ids.material, ids.category])).rejects.toThrow(/brand_id/);
      await expect(client.query('UPDATE stock_materials SET material_category_id = $2 WHERE id = $1', [ids.material, ids.brand])).rejects.toThrow(/material_category_id/);
      // An entry a Stock Material names cannot be deleted under it.
      await client.query('DELETE FROM brand_history');
      await client.query('DELETE FROM material_category_history');
      await expect(client.query('DELETE FROM brands WHERE id = $1', [ids.brand])).rejects.toThrow(/stock_materials/);
      await expect(client.query('DELETE FROM material_categories WHERE id = $1', [ids.category])).rejects.toThrow(/stock_materials/);
    });
  });

  it('records a change of other details in the Stock Material history, with no reason and no note', async () => {
    await withClient(async (client) => {
      await historyEntry(client, 2);
      expect((await client.query('SELECT kind FROM stock_material_history WHERE stock_material_id = $1 ORDER BY version', [ids.material])).rows).toEqual([
        { kind: 'CREATED' },
        { kind: 'DETAILS_CHANGED' },
      ]);
      // The constraints of 0025 still hold for it (#175 Q11).
      await expect(historyEntry(client, 3, { reason: 'ไม่ต้องมีเหตุผล' })).rejects.toThrow(/stock_material_history_reason_with_correction/);
      await expect(historyEntry(client, 3, { note: 'ไม่มีหมายเหตุ' })).rejects.toThrow(/stock_material_history_note_with_inactive/);
      await expect(historyEntry(client, 3, { kind: 'MERGED' })).rejects.toThrow(/stock_material_history_kind_check/);
    });
  });

  it('refuses a rollback while a Brand, a Material Category, a change of other details or a retry receipt of theirs exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient(async (client) => {
      await client.query('UPDATE stock_materials SET brand_id = NULL, material_category_id = NULL');
      await client.query('DELETE FROM material_categories');
      await client.query(`DELETE FROM stock_material_history WHERE kind = 'DETAILS_CHANGED'`);
    });
    // A Brand alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM brands');
      await entry(client, 'material_categories');
    });
    // A Material Category alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM material_categories');
      await historyEntry(client, 2);
    });
    // A change of other details alone.
    await refused();
    for (const operation of ['brand:create', 'material-category:create', 'stock-material:details']) {
      await withClient(async (client) => {
        await client.query(`DELETE FROM stock_material_history WHERE kind = 'DETAILS_CHANGED'`);
        await client.query('DELETE FROM registration_retry_tokens');
        await client.query(
          `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
           VALUES ('t4-material-receipt', $1, $2, 'fingerprint', 201, '{}')`,
          [ids.user, operation]
        );
      });
      // A retry receipt of theirs alone.
      await refused();
    }
    await withClient((client) => client.query('DELETE FROM registration_retry_tokens'));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0027_brands_material_categories', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT kind FROM stock_material_history WHERE stock_material_id = $1', [ids.material])).rows).toEqual([{ kind: 'CREATED' }]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0027_brands_material_categories');
  });
});
