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

// The two lists of F010-T1, each with its history table and the column of the history that names one of its entries.
const LISTS = [
  { table: 'source_parties', history: 'source_party_history', column: 'source_party_id' },
  { table: 'source_types', history: 'source_type_history', column: 'source_type_id' },
] as const;

// F010-T1 (#232): 0033_source_parties_source_types against a populated 0032 database (Seam C): the Source Party
// (แหล่งที่มา) and Source Type (วิธีได้มา) lists with their histories, both empty, a Source Party with an optional note
// (#231 MRC-06, MRC-09, MRC-10, MRC-11, Q6, Q12, P7, P10).
describe('Source Party and Source Type Migration Integration (Seam C - F010-T1)', () => {
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
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  // An entry of the list `table`, named uniquely unless `fields` says otherwise.
  const entry = (client: pg.Client, table: string, fields: Record<string, unknown> = {}) =>
    insert(client, table, { name: `รายการ ${crypto.randomUUID()}`, created_by: ids.user, updated_by: ids.user, ...fields });

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

  it('adds the two lists empty to a populated database (Q6)', async () => {
    for (let step = 1; step <= 32; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_source_user', 'hash') RETURNING id`)).rows[0].id;
        ids.brand = (await client.query(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Double A', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0033_source_parties_source_types');

    await withClient(async (client) => {
      for (const { table, history } of LISTS) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
        expect((await client.query(`SELECT count(*)::int AS n FROM ${history}`)).rows[0].n).toBe(0);
      }
      expect((await client.query('SELECT name FROM brands WHERE id = $1', [ids.brand])).rows).toEqual([{ name: 'Double A' }]);
    });
  });

  it('keeps one entry per name in each list, ignoring case and repeated spaces, Inactive ones included, and a nonblank name of at most 200 characters (MRC-09, P7)', async () => {
    await withClient(async (client) => {
      for (const { table } of LISTS) {
        const first = await entry(client, table, { name: 'บริษัท  ก' });
        expect((await client.query(`SELECT is_active, version FROM ${table} WHERE id = $1`, [first])).rows).toEqual([{ is_active: true, version: 1 }]);
        await expect(entry(client, table, { name: 'บริษัท ก' })).rejects.toThrow(new RegExp(`${table}_name_unique`));
        await client.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [first]);
        await expect(entry(client, table, { name: ' บริษัท   ก ' })).rejects.toThrow(new RegExp(`${table}_name_unique`));
        await entry(client, table, { name: 'บริษัท กข' });
        await expect(entry(client, table, { name: '  ' })).rejects.toThrow(new RegExp(`${table}_name_check`));
        await entry(client, table, { name: 'ก'.repeat(200) });
        await expect(entry(client, table, { name: 'ข'.repeat(201) })).rejects.toThrow(/too long/);
        await expect(entry(client, table, { created_by: crypto.randomUUID() })).rejects.toThrow(/created_by/);
        await expect(entry(client, table, { updated_by: crypto.randomUUID() })).rejects.toThrow(/updated_by/);
        await expect(entry(client, table, { version: 0 })).rejects.toThrow(new RegExp(`${table}_version_check`));
      }
      // The lists are apart from each other and from the Brand list: one name may be in each.
      ids.party = await entry(client, 'source_parties', { name: 'Double A' });
      ids.type = await entry(client, 'source_types', { name: 'Double A' });
    });
  });

  it('holds an optional note of at most 2000 characters on a Source Party only (MRC-10, P7)', async () => {
    await withClient(async (client) => {
      expect((await client.query('SELECT note FROM source_parties WHERE id = $1', [ids.party])).rows).toEqual([{ note: null }]);
      const noted = await entry(client, 'source_parties', { note: 'ห'.repeat(2000) });
      expect((await client.query('SELECT length(note)::int AS n FROM source_parties WHERE id = $1', [noted])).rows).toEqual([{ n: 2000 }]);
      await expect(entry(client, 'source_parties', { note: 'ห'.repeat(2001) })).rejects.toThrow(/too long/);
      // A blank note is none, as in 0031 and 0032.
      await expect(entry(client, 'source_parties', { note: '   ' })).rejects.toThrow(/source_parties_note_check/);
      await expect(entry(client, 'source_types', { note: 'ไม่มีหมายเหตุ' })).rejects.toThrow(/note/);
    });
  });

  it('keeps a history row per entry version, naming a real entry and actor, and an entry with history is never deleted under it', async () => {
    await withClient(async (client) => {
      for (const { history, column } of LISTS) {
        const listEntry = column === 'source_party_id' ? ids.party : ids.type;
        const row = (fields: Record<string, unknown> = {}) =>
          insert(client, history, { [column]: listEntry, version: 1, action: 'CREATED', changes: JSON.stringify({ name: { before: null, after: 'Double A' } }), actor_id: ids.user, ...fields });
        await row();
        await expect(row()).rejects.toThrow(new RegExp(`${history}_${column}_version`));
        await expect(row({ version: 2, action: 'DELETED' })).rejects.toThrow(/action/);
        await expect(row({ version: 0 })).rejects.toThrow(/version/);
        await expect(row({ version: 2, [column]: crypto.randomUUID() })).rejects.toThrow(new RegExp(column));
        await expect(row({ version: 2, actor_id: crypto.randomUUID() })).rejects.toThrow(/actor_id/);
        await row({ version: 2, action: 'CHANGED' });
      }
      await expect(client.query('DELETE FROM source_parties WHERE id = $1', [ids.party])).rejects.toThrow(/source_party_history/);
      await expect(client.query('DELETE FROM source_types WHERE id = $1', [ids.type])).rejects.toThrow(/source_type_history/);
    });
  });

  it('refuses a rollback while a Source Party, a Source Type or a retry receipt of theirs exists, and rolls back cleanly once none does (P10)', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient(async (client) => {
      await client.query('DELETE FROM source_type_history');
      await client.query('DELETE FROM source_types');
    });
    // A Source Party alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM source_party_history');
      await client.query('DELETE FROM source_parties');
      await entry(client, 'source_types');
    });
    // A Source Type alone.
    await refused();
    await withClient((client) => client.query('DELETE FROM source_types'));
    for (const operation of ['source-party:create', 'source-party:note', 'source-type:rename']) {
      await withClient(async (client) => {
        await client.query('DELETE FROM registration_retry_tokens');
        await client.query(
          `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
           VALUES ('t1-source-receipt', $1, $2, 'fingerprint', 201, '{}')`,
          [ids.user, operation]
        );
      });
      // A retry receipt of theirs alone.
      await refused();
    }
    // A retry receipt of another list does not hold the rollback.
    await withClient(async (client) => {
      await client.query(`UPDATE registration_retry_tokens SET operation = 'brand:create'`);
    });

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0033_source_parties_source_types', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT name FROM brands WHERE id = $1', [ids.brand])).rows).toEqual([{ name: 'Double A' }]);
      await client.query('DELETE FROM registration_retry_tokens');
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0033_source_parties_source_types');
  });
});
