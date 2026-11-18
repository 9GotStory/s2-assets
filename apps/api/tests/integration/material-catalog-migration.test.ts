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

// F008-T1 (#176): 0025_material_catalog against a populated 0024 database (Seam C): the Supply Officer role,
// the Unit list, and the Stock Material with its Units and history (#175 Q28, P8).
describe('Material Catalog Migration Integration (Seam C - F008-T1)', () => {
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
      client.query('SELECT id FROM roles ORDER BY id'),
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

  const unit = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'units', { name: `หน่วย ${crypto.randomUUID()}`, created_by: ids.user, updated_by: ids.user, ...fields });

  const stockMaterial = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'stock_materials', { name: 'กระดาษ A4', created_by: ids.user, ...fields });

  // A Unit of the Stock Material: an Alternate Unit with factor 5, unless `fields` says otherwise.
  const materialUnit = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'stock_material_units', { stock_material_id: ids.material, unit_id: ids.box, is_base: false, conversion_factor: '5', ...fields });

  // A history entry of the Stock Material: its creation at version 1, unless `fields` says otherwise.
  const historyEntry = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'stock_material_history', {
      stock_material_id: ids.material,
      version: 1,
      kind: 'CREATED',
      changes: JSON.stringify([{ field: 'name', before: null, after: 'กระดาษ A4' }]),
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

  it('adds the Supply Officer role and the empty catalog to a populated database, and leaves its Assets alone', async () => {
    for (let step = 1; step <= 24; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_material_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0025_material_catalog');

    await withClient(async (client) => {
      expect((await client.query(`SELECT id, description FROM roles WHERE id = 'SUPPLY_OFFICER'`)).rows).toEqual([{ id: 'SUPPLY_OFFICER', description: 'Supply Officer' }]);
      for (const table of ['units', 'unit_history', 'stock_materials', 'stock_material_units', 'stock_material_history']) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      expect((await client.query('SELECT name FROM assets WHERE id = $1', [ids.asset])).rows).toEqual([{ name: 'เครื่องพิมพ์' }]);
    });
  });

  it('keeps one Unit per name in the list, ignoring case and repeated spaces, and a nonblank name', async () => {
    await withClient(async (client) => {
      ids.ream = (await unit(client, { name: 'Ream  Pack' }))!;
      // The same name with other case or spacing, an Inactive entry included (#175 Q20).
      await expect(unit(client, { name: 'ream pack' })).rejects.toThrow(/units_name_unique/);
      await expect(unit(client, { name: 'REAM   PACK' })).rejects.toThrow(/units_name_unique/);
      await client.query('UPDATE units SET is_active = false WHERE id = $1', [ids.ream]);
      await expect(unit(client, { name: ' Ream Pack ' })).rejects.toThrow(/units_name_unique/);
      await unit(client, { name: 'Ream Packs' });
      await expect(unit(client, { name: '  ' })).rejects.toThrow(/units_name_check/);
      expect((await client.query('SELECT version FROM units WHERE id = $1', [ids.ream])).rows).toEqual([{ version: 1 }]);
      ids.box = (await unit(client, { name: 'กล่อง' }))!;
      ids.sheet = (await unit(client, { name: 'แผ่น' }))!;
    });
  });

  it('keeps a Unit list entry history row per version, naming a real entry and actor', async () => {
    await withClient(async (client) => {
      const entry = (fields: Record<string, unknown> = {}) =>
        insert(client, 'unit_history', { unit_id: ids.box, version: 1, action: 'CREATED', changes: JSON.stringify({ name: { before: null, after: 'กล่อง' } }), actor_id: ids.user, ...fields });
      await entry();
      await expect(entry()).rejects.toThrow(/unit_history_unit_id_version/);
      await expect(entry({ version: 2, action: 'DELETED' })).rejects.toThrow(/action/);
      await expect(entry({ version: 2, unit_id: crypto.randomUUID() })).rejects.toThrow(/unit_id/);
      await expect(entry({ version: 2, actor_id: crypto.randomUUID() })).rejects.toThrow(/actor_id/);
      await entry({ version: 2, action: 'CHANGED' });
      // An entry with history cannot be deleted under it.
      await expect(client.query('DELETE FROM units WHERE id = $1', [ids.box])).rejects.toThrow(/unit_history/);
    });
  });

  it('keeps a Stock Material with a nonblank name and optional nonblank text, active at version 1', async () => {
    await withClient(async (client) => {
      ids.material = (await stockMaterial(client, { model: 'Double A', specification: '80 แกรม สีขาว', note: 'ใช้ทั่วไป' }))!;
      expect((await client.query('SELECT is_active, version FROM stock_materials WHERE id = $1', [ids.material])).rows).toEqual([{ is_active: true, version: 1 }]);
      await expect(stockMaterial(client, { name: ' ' })).rejects.toThrow(/stock_materials_name_check/);
      await expect(stockMaterial(client, { name: null })).rejects.toThrow(/name/);
      await expect(stockMaterial(client, { model: '' })).rejects.toThrow(/stock_materials_model_check/);
      await expect(stockMaterial(client, { specification: ' ' })).rejects.toThrow(/stock_materials_specification_check/);
      await expect(stockMaterial(client, { note: ' ' })).rejects.toThrow(/stock_materials_note_check/);
      await expect(stockMaterial(client, { created_by: crypto.randomUUID() })).rejects.toThrow(/created_by/);
      await expect(stockMaterial(client, { version: 0 })).rejects.toThrow(/stock_materials_version_check/);
    });
  });

  it('holds one Base Unit per Stock Material with factor 1, active, and Alternate Units with a factor above 0', async () => {
    await withClient(async (client) => {
      await materialUnit(client, { unit_id: ids.sheet, is_base: true, conversion_factor: '1' });
      // A second Base Unit, on real PostgreSQL (#175 MC-04).
      await expect(materialUnit(client, { unit_id: ids.ream, is_base: true, conversion_factor: '1' })).rejects.toThrow(/stock_material_units_one_base_unit/);
      // The Base Unit converts at 1 and is never Inactive.
      const other = (await stockMaterial(client))!;
      await expect(materialUnit(client, { stock_material_id: other, unit_id: ids.sheet, is_base: true, conversion_factor: '2' })).rejects.toThrow(/stock_material_units_base_unit/);
      await expect(materialUnit(client, { stock_material_id: other, unit_id: ids.sheet, is_base: true, conversion_factor: '1', is_active: false })).rejects.toThrow(/stock_material_units_base_unit/);
      // An Alternate Unit's factor is above 0, with at most four decimal places kept exactly.
      await expect(materialUnit(client, { conversion_factor: '0' })).rejects.toThrow(/stock_material_units_conversion_factor_check/);
      await expect(materialUnit(client, { conversion_factor: '-1' })).rejects.toThrow(/stock_material_units_conversion_factor_check/);
      await materialUnit(client, { conversion_factor: '2.5001' });
      expect((await client.query('SELECT conversion_factor, whole_number_only, is_active FROM stock_material_units WHERE stock_material_id = $1 AND unit_id = $2', [ids.material, ids.box])).rows).toEqual([
        { conversion_factor: '2.5001', whole_number_only: true, is_active: true },
      ]);
      // One row per Unit per Stock Material, naming real ones.
      await expect(materialUnit(client, { conversion_factor: '3' })).rejects.toThrow(/stock_material_units_pkey/);
      await expect(materialUnit(client, { unit_id: crypto.randomUUID() })).rejects.toThrow(/unit_id/);
      await expect(materialUnit(client, { stock_material_id: crypto.randomUUID(), unit_id: ids.ream })).rejects.toThrow(/stock_material_id/);
      // A Unit a Stock Material uses cannot be deleted under it.
      await expect(client.query('DELETE FROM units WHERE id = $1', [ids.sheet])).rejects.toThrow(/stock_material_units/);
    });
  });

  it('keeps an append-only history entry per version, a reason with a Material Correction alone, and a note with an Inactive alone', async () => {
    await withClient(async (client) => {
      await historyEntry(client);
      await expect(historyEntry(client)).rejects.toThrow(/stock_material_history_stock_material_id_version/);
      await expect(historyEntry(client, { version: 2, kind: 'MERGED' })).rejects.toThrow(/stock_material_history_kind_check/);
      // Each entry lists the values it recorded.
      await expect(historyEntry(client, { version: 2, changes: '[]' })).rejects.toThrow(/stock_material_history_lists_changes/);
      await expect(historyEntry(client, { version: 2, changes: '{}' })).rejects.toThrow(/stock_material_history_lists_changes/);
      // A Material Correction needs its reason, and nothing else has one (#175 Q11).
      await expect(historyEntry(client, { version: 2, kind: 'CORRECTED' })).rejects.toThrow(/stock_material_history_reason_with_correction/);
      await expect(historyEntry(client, { version: 2, reason: 'พิมพ์ผิด' })).rejects.toThrow(/stock_material_history_reason_with_correction/);
      await expect(historyEntry(client, { version: 2, kind: 'CORRECTED', reason: ' ' })).rejects.toThrow(/stock_material_history_reason_check/);
      await historyEntry(client, { version: 2, kind: 'CORRECTED', reason: 'พิมพ์ชื่อผิด' });
      // Only making it Inactive takes a note (#175 Q13).
      await expect(historyEntry(client, { version: 3, kind: 'REACTIVATED', note: 'กลับมาใช้' })).rejects.toThrow(/stock_material_history_note_with_inactive/);
      await historyEntry(client, { version: 3, kind: 'INACTIVATED', note: 'สร้างซ้ำผิด' });
      for (const [version, kind] of [[4, 'REACTIVATED'], [5, 'UNITS_CHANGED']] as const) {
        await historyEntry(client, { version, kind });
      }
      await expect(historyEntry(client, { version: 6, recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      // A Stock Material with history cannot be deleted under it.
      await expect(client.query('DELETE FROM stock_materials WHERE id = $1', [ids.material])).rejects.toThrow(/stock_material/);
    });
  });

  it('refuses a rollback while a Supply Officer, a Unit, a Stock Material or a catalog retry receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient((client) => client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'SUPPLY_OFFICER')`, [ids.user]));
    await withClient(async (client) => {
      await client.query('DELETE FROM stock_material_history');
      await client.query('DELETE FROM stock_material_units');
      await client.query('DELETE FROM stock_materials');
      await client.query('DELETE FROM unit_history');
      await client.query('DELETE FROM units');
    });
    // A holder of the role alone (#175 P8).
    await refused();
    await withClient(async (client) => {
      await client.query(`DELETE FROM user_roles WHERE role_id = 'SUPPLY_OFFICER'`);
      await unit(client);
    });
    // A Unit alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM units');
      await stockMaterial(client);
    });
    // A Stock Material alone.
    await refused();
    for (const operation of ['unit:create', 'stock-material:create']) {
      await withClient(async (client) => {
        await client.query('DELETE FROM stock_materials');
        await client.query('DELETE FROM registration_retry_tokens');
        await client.query(
          `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
           VALUES ('t1-material-receipt', $1, $2, 'fingerprint', 201, '{}')`,
          [ids.user, operation]
        );
      });
      // A catalog retry receipt alone.
      await refused();
    }
    await withClient((client) => client.query('DELETE FROM registration_retry_tokens'));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0025_material_catalog', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM assets WHERE id = $1', [ids.asset])).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0025_material_catalog');
  });
});
