import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

// F003-T5 (#55): 0008_bulk_reassignment against a populated 0007 database (Seam C).
describe('Bulk Reassignment Migration Integration (Seam C - F003-T5)', () => {
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

  const insertEvent = (client: pg.Client, assetId: string, kind: 'INITIAL' | 'REASSIGNMENT', bulkReference: string | null) =>
    client.query(
      `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance, bulk_reference)
       VALUES ($1, $2, '2026-01-02', $3, 'RECORDED', $4) RETURNING id`,
      [assetId, kind, ids.user, bulkReference]
    );

  const insertAsset = async (client: pg.Client, name: string): Promise<string> =>
    (await client.query(`INSERT INTO assets (name, registered_by) VALUES ($1, $2) RETURNING id`, [name, ids.user])).rows[0].id;

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

  it('adds the bulk reference, and the facts recorded before it have none', async () => {
    for (let step = 1; step <= 7; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t5_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = await insertAsset(client, 'โต๊ะ');
        ids.event = (
          await client.query(
            `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
             VALUES ($1, 'INITIAL', '2026-01-01', $2, 'RECORDED') RETURNING id`,
            [ids.asset, ids.user]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0008_bulk_reassignment');

    await withClient(async (client) => {
      const events = await client.query('SELECT id, bulk_reference FROM assignment_events');
      expect(events.rows).toEqual([{ id: ids.event, bulk_reference: null }]);
    });
  });

  it('gives a bulk reference only to a Reassignment, and at most one event per Asset under it', async () => {
    const reference = crypto.randomUUID();
    await withClient(async (client) => {
      const other = await insertAsset(client, 'ตู้');

      await expect(insertEvent(client, other, 'INITIAL', reference)).rejects.toThrow(/assignment_events_bulk_reference_on_reassignment/);

      await insertEvent(client, ids.asset, 'REASSIGNMENT', reference);
      await insertEvent(client, other, 'REASSIGNMENT', reference);
      await expect(insertEvent(client, ids.asset, 'REASSIGNMENT', reference)).rejects.toThrow(/assignment_events_one_per_bulk/);

      // Events outside a Bulk Reassignment are unlimited.
      await insertEvent(client, ids.asset, 'REASSIGNMENT', null);
      await insertEvent(client, ids.asset, 'REASSIGNMENT', null);
    });
  });

  it('refuses a destructive rollback while any bulk event exists, and rolls back cleanly once none does', async () => {
    const refused = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(String(refused.error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM assignment_events WHERE bulk_reference IS NOT NULL')).rows[0].n).toBe(2);
      await client.query('DELETE FROM assignment_events WHERE bulk_reference IS NOT NULL');
    });

    const rollback = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0008_bulk_reassignment', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      // The rollback removes the column and leaves every other fact.
      expect((await client.query('SELECT count(*)::int AS n FROM assignment_events')).rows[0].n).toBe(3);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0008_bulk_reassignment');
  });
});
