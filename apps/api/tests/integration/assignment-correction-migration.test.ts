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

// F003-T3 (#53): 0007_assignment_correction against a populated 0006 database (Seam C).
describe('Assignment Correction Migration Integration (Seam C - F003-T3)', () => {
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

  const insertInitial = (client: pg.Client) =>
    client.query(
      `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
       VALUES ($1, 'INITIAL', NULL, $2, 'RECORDED')`,
      [ids.asset, ids.user]
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
  }, 30_000);

  it('adds the correction records and the voided state, and keeps the facts recorded before it', async () => {
    for (let step = 1; step <= 6; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t3_user', 'hash') RETURNING id`)).rows[0].id;
        ids.room = (
          await client.query(`INSERT INTO locations (name, created_by, updated_by) VALUES ('ห้อง 101', $1, $1) RETURNING id`, [ids.user])
        ).rows[0].id;
        ids.asset = (
          await client.query(
            `INSERT INTO assets (name, registered_by, assignment_version) VALUES ('โต๊ะ', $1, 1) RETURNING id`,
            [ids.user]
          )
        ).rows[0].id;
        ids.event = (
          await client.query(
            `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
             VALUES ($1, 'INITIAL', '2026-01-01', $2, 'RECORDED') RETURNING id`,
            [ids.asset, ids.user]
          )
        ).rows[0].id;
        await client.query(
          `INSERT INTO assignment_changes (event_id, event_kind, dimension, new_location_id) VALUES ($1, 'INITIAL', 'LOCATION', $2)`,
          [ids.event, ids.room]
        );
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0007_assignment_correction');

    await withClient(async (client) => {
      const events = await client.query('SELECT id, is_voided FROM assignment_events');
      expect(events.rows).toEqual([{ id: ids.event, is_voided: false }]);
      const changes = await client.query('SELECT new_location_id FROM assignment_changes');
      expect(changes.rows).toEqual([{ new_location_id: ids.room }]);
      const corrections = await client.query('SELECT count(*)::int AS n FROM assignment_corrections');
      expect(corrections.rows[0].n).toBe(0);
    });
  });

  it('allows one non-voided Initial Assignment per Asset, and any number of voided ones', async () => {
    await withClient(async (client) => {
      await expect(insertInitial(client)).rejects.toThrow(/assignment_events_one_initial/);
      await client.query('UPDATE assignment_events SET is_voided = true WHERE id = $1', [ids.event]);
      await insertInitial(client);
      await expect(insertInitial(client)).rejects.toThrow(/assignment_events_one_initial/);
      await client.query(`DELETE FROM assignment_events WHERE id <> $1`, [ids.event]);
      await client.query('UPDATE assignment_events SET is_voided = false WHERE id = $1', [ids.event]);
    });
  });

  it('holds a correction record to its action, reason and changes', async () => {
    await withClient(async (client) => {
      const insert = (action: string, reason: string, changes: string) =>
        client.query(`INSERT INTO assignment_corrections (event_id, action, reason, changes, recorded_by) VALUES ($1, $2, $3, $4::jsonb, $5)`, [
          ids.event,
          action,
          reason,
          changes,
          ids.user,
        ]);
      const anAmendment = JSON.stringify([{ field: 'remark', before: null, after: 'x' }]);

      await expect(insert('DELETED', 'เหตุผล', '[]')).rejects.toThrow(/action/);
      await expect(insert('VOIDED', '   ', '[]')).rejects.toThrow(/reason/);
      await expect(insert('AMENDED', 'เหตุผล', '[]')).rejects.toThrow(/assignment_corrections_amendment_lists_changes/);
      await expect(insert('AMENDED', 'เหตุผล', '{}')).rejects.toThrow(/assignment_corrections_amendment_lists_changes/);
      await expect(insert('VOIDED', 'เหตุผล', anAmendment)).rejects.toThrow(/assignment_corrections_amendment_lists_changes/);
    });
  });

  it('refuses a destructive rollback while any correction record exists, and rolls back cleanly once none does', async () => {
    await withClient((client) =>
      client.query(
        `INSERT INTO assignment_corrections (event_id, action, reason, changes, recorded_by)
         VALUES ($1, 'AMENDED', 'เหตุผล', '[{"field":"remark","before":null,"after":"x"}]'::jsonb, $2)`,
        [ids.event, ids.user]
      )
    );

    const refused = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(String(refused.error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM assignment_corrections')).rows[0].n).toBe(1);
      expect((await client.query('SELECT count(*)::int AS n FROM assignment_events WHERE NOT is_voided')).rows[0].n).toBe(1);
      await client.query('DELETE FROM assignment_corrections');
    });

    const rollback = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0007_assignment_correction', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM assignment_events')).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0007_assignment_correction');
  });
});
