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

// F009-T1 (#203): 0029_requestable_materials against a populated 0028 database (Seam C): the Requestable Material
// (วัสดุสำหรับขอเบิก) with its Request Unit, whole-number setting, description, status and version, and its append-only
// history, whose kinds take what T7 and T8 write too (#203 decision 2, comment 7041198954) (#202 Q5, Q6, Q17, Q26, P7).
describe('Requestable Material Migration Integration (Seam C - F009-T1)', () => {
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

  // Inserts a row of `table` from `values`, returning its id.
  const insert = async (client: pg.Client, table: string, values: Record<string, unknown>): Promise<string> => {
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  // A Requestable Material counted in the Unit รีม, named uniquely unless `fields` says otherwise.
  const requestable = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'requestable_materials', { name: `วัสดุ ${crypto.randomUUID()}`, request_unit_id: ids.unit, created_by: ids.user, ...fields });

  // A history entry of the Requestable Material `ids.requestable` at `version`: its creation, unless `fields` says otherwise.
  const historyEntry = (client: pg.Client, version: number, fields: Record<string, unknown> = {}) =>
    insert(client, 'requestable_material_history', {
      requestable_material_id: ids.requestable,
      version,
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

  it('adds the empty Requestable Materials and their history to a populated database, leaving its Units as they were', async () => {
    for (let step = 1; step <= 28; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_requestable_user', 'hash') RETURNING id`)).rows[0].id;
        ids.unit = await insert(client, 'units', { name: 'รีม', created_by: ids.user, updated_by: ids.user });
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0029_requestable_materials');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM requestable_materials')).rows[0].n).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM requestable_material_history')).rows[0].n).toBe(0);
      expect((await client.query('SELECT name, is_active, version FROM units WHERE id = $1', [ids.unit])).rows).toEqual([{ name: 'รีม', is_active: true, version: 1 }]);
    });
  });

  it('keeps a Requestable Material whole-number-only, active and at version 1 unless told otherwise, naming a Unit of the list as its Request Unit', async () => {
    await withClient(async (client) => {
      ids.requestable = await requestable(client, { name: 'กระดาษ A4' });
      expect(
        (await client.query('SELECT name, request_unit_id, whole_number_only, description, is_active, version, created_by FROM requestable_materials WHERE id = $1', [ids.requestable])).rows
      ).toEqual([{ name: 'กระดาษ A4', request_unit_id: ids.unit, whole_number_only: true, description: null, is_active: true, version: 1, created_by: ids.user }]);

      await expect(requestable(client, { request_unit_id: crypto.randomUUID() })).rejects.toThrow(/request_unit_id/);
      await expect(requestable(client, { request_unit_id: null })).rejects.toThrow(/request_unit_id/);
      await expect(requestable(client, { created_by: crypto.randomUUID() })).rejects.toThrow(/created_by/);
      await expect(requestable(client, { version: 0 })).rejects.toThrow(/requestable_materials_version_check/);
      // A Unit a Requestable Material names cannot be deleted under it.
      await expect(client.query('DELETE FROM units WHERE id = $1', [ids.unit])).rejects.toThrow(/requestable_materials/);
    });
  });

  it('keeps one Requestable Material per name, ignoring case and repeated spaces, Inactive ones included, and a nonblank name of at most 200 characters and description of at most 2000 (P7)', async () => {
    await withClient(async (client) => {
      const first = await requestable(client, { name: 'ปากกา  น้ำเงิน' });
      await expect(requestable(client, { name: 'ปากกา น้ำเงิน' })).rejects.toThrow(/requestable_materials_name_unique/);
      await client.query('UPDATE requestable_materials SET is_active = false WHERE id = $1', [first]);
      await expect(requestable(client, { name: ' ปากกา   น้ำเงิน ' })).rejects.toThrow(/requestable_materials_name_unique/);
      await expect(requestable(client, { name: 'Pen' }).then(() => requestable(client, { name: 'PEN' }))).rejects.toThrow(/requestable_materials_name_unique/);
      await requestable(client, { name: 'ปากกาน้ำเงิน' });

      await expect(requestable(client, { name: '  ' })).rejects.toThrow(/requestable_materials_name_check/);
      await expect(requestable(client, { name: 'ก'.repeat(201) })).rejects.toThrow(/too long/);
      await requestable(client, { name: 'ข'.repeat(200), description: 'ค'.repeat(2000) });
      await expect(requestable(client, { description: 'ค'.repeat(2001) })).rejects.toThrow(/too long/);
      await expect(requestable(client, { description: ' ' })).rejects.toThrow(/requestable_materials_description_check/);
    });
  });

  it('keeps an append-only history row per Requestable Material version, of the kinds T1, T7 and T8 write, naming a real entry and actor', async () => {
    await withClient(async (client) => {
      await historyEntry(client, 1);
      await expect(historyEntry(client, 1)).rejects.toThrow(/requestable_material_history_requestable_material_id_version/);
      for (const [version, kind] of [[2, 'RENAMED'], [3, 'DETAILS_CHANGED'], [4, 'INACTIVATED'], [5, 'REACTIVATED']] as const) {
        await historyEntry(client, version, { kind });
      }
      await expect(historyEntry(client, 6, { kind: 'MERGED' })).rejects.toThrow(/requestable_material_history_kind_check/);
      await expect(historyEntry(client, 6, { changes: '[]' })).rejects.toThrow(/requestable_material_history_lists_changes/);
      await expect(historyEntry(client, 6, { changes: '{}' })).rejects.toThrow(/requestable_material_history_lists_changes/);
      await expect(historyEntry(client, 6, { requestable_material_id: crypto.randomUUID() })).rejects.toThrow(/requestable_material_id/);
      await expect(historyEntry(client, 6, { recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      await expect(historyEntry(client, 0)).rejects.toThrow(/requestable_material_history_version_check/);
      // A Requestable Material with history cannot be deleted under it.
      await expect(client.query('DELETE FROM requestable_materials WHERE id = $1', [ids.requestable])).rejects.toThrow(/requestable_material_history/);
    });
  });

  it('refuses a rollback while a Requestable Material or a retry receipt of its writes exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback: Requestable Materials or their retry receipts exist');

    await withClient((client) => client.query('DELETE FROM requestable_material_history'));
    // Requestable Materials alone; history exists only with its entry.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM requestable_materials');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t1-requestable-receipt', $1, 'requestable-material:create', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });
    // A retry receipt of its writes alone.
    await refused();
    await withClient((client) => client.query('DELETE FROM registration_retry_tokens'));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0029_requestable_materials', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT name FROM units WHERE id = $1', [ids.unit])).rows).toEqual([{ name: 'รีม' }]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0029_requestable_materials');
  });
});
