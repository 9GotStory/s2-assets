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

// F007-T1 (#155): 0023_retirements against a populated 0022 database (Seam C).
describe('Retirement Migration Integration (Seam C - F007-T1)', () => {
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

  // A Retirement of the Asset, sold, unless `fields` says otherwise.
  const insertRetirement = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = {
      asset_id: ids.asset,
      retirement_date: '2026-11-05',
      retirement_method: 'SALE',
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO retirements (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values)
    );
    return res.rows[0].id;
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

  it('adds the Retirements to a populated database, and leaves its Assets alone with no status column', async () => {
    for (let step = 1; step <= 22; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_retirement_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.otherAsset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('จอภาพ', $1) RETURNING id`, [ids.user])).rows[0].id;
        return schema;
      })
    );
    const assetColumnsBefore = await withClient(async (client) =>
      (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assets' ORDER BY column_name`)).rows
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0023_retirements');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM retirements')).rows[0].n).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(2);
      // Retired is derived on read from a Retirement not voided: the Asset gains no column.
      expect((await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assets' ORDER BY column_name`)).rows).toEqual(
        assetColumnsBefore
      );
    });
  });

  it('keeps a Retirement to its five Retirement Methods, a Retirement Date, and nonblank optional text', async () => {
    await withClient(async (client) => {
      const id = await insertRetirement(client);
      expect((await client.query('SELECT retirement_reference, note, is_voided, version FROM retirements WHERE id = $1', [id])).rows).toEqual([
        { retirement_reference: null, note: null, is_voided: false, version: 1 },
      ]);
      await client.query('UPDATE retirements SET is_voided = true WHERE id = $1', [id]);

      for (const method of ['SALE', 'EXCHANGE', 'HANDOVER_TO_OTHER_AGENCY', 'CONVERSION_OR_DESTRUCTION', 'DECLARED_LOSS']) {
        const kept = await insertRetirement(client, { retirement_method: method, retirement_reference: 'คำสั่ง 1/2569', note: 'ชำรุดเกินซ่อม' });
        await client.query('UPDATE retirements SET is_voided = true WHERE id = $1', [kept]);
      }

      await expect(insertRetirement(client, { retirement_method: 'DONATION' })).rejects.toThrow(/retirement_method/);
      await expect(insertRetirement(client, { retirement_method: null })).rejects.toThrow(/retirement_method/);
      await expect(insertRetirement(client, { retirement_date: null })).rejects.toThrow(/retirement_date/);
      await expect(insertRetirement(client, { retirement_reference: '  ' })).rejects.toThrow(/retirement_reference/);
      await expect(insertRetirement(client, { note: ' ' })).rejects.toThrow(/note/);
      await expect(insertRetirement(client, { version: 0 })).rejects.toThrow(/version/);
      await expect(insertRetirement(client, { asset_id: ids.user })).rejects.toThrow(/asset_id/);
      await expect(insertRetirement(client, { recorded_by: ids.asset })).rejects.toThrow(/recorded_by/);
    });
  });

  it('allows at most one Retirement not voided per Asset', async () => {
    await withClient(async (client) => {
      const current = await insertRetirement(client);

      await expect(insertRetirement(client, { retirement_method: 'EXCHANGE' })).rejects.toThrow(/retirements_one_not_voided_per_asset/);
      // Another Asset has its own, and a voided one does not count.
      await insertRetirement(client, { asset_id: ids.otherAsset });
      await insertRetirement(client, { is_voided: true });

      await client.query('UPDATE retirements SET is_voided = true WHERE id = $1', [current]);
      await insertRetirement(client);
    });
  });

  it('keeps an Asset with a Retirement from being deleted', async () => {
    await withClient(async (client) => {
      await expect(client.query('DELETE FROM assets WHERE id = $1', [ids.asset])).rejects.toThrow(/retirements/);
    });
  });

  it('refuses a rollback while a Retirement or a Retirement retry receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM retirements')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM retirements');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t1-retirement-receipt', $1, $2, 'fingerprint', 201, '{}')`,
        [ids.user, `retirement:record:${ids.asset}`]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't1-retirement-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0023_retirements', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(2);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0023_retirements');
  });
});
