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

// F006-T8 (#133): 0022_reassignment_verification_revisions against a populated 0021 database (Seam C).
describe('Reassignment Verification Revision Migration Integration (Seam C - F006-T8)', () => {
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

  // An assignment fact of `ids.asset` of `kind`, part of a Bulk Reassignment when `bulk`, citing `revisionId`.
  const insertEvent = (client: pg.Client, { kind = 'REASSIGNMENT', bulk = false, revisionId }: { kind?: string; bulk?: boolean; revisionId?: string } = {}) =>
    client.query(
      `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance, bulk_reference, verification_revision_id)
       VALUES ($1, $2, '2026-11-12', $3, 'RECORDED', $4, $5) RETURNING id`,
      [ids.asset, kind, ids.user, bulk ? crypto.randomUUID() : null, revisionId ?? null]
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

  it('lets a Reassignment cite a Verification Revision, with none cited on the facts already there', async () => {
    for (let step = 1; step <= 21; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t8_verification_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('โต๊ะทำงาน', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.round = (
          await client.query(`INSERT INTO verification_rounds (name, fiscal_year, start_date, opened_by) VALUES ('ตรวจประจำปี 2569', 2569, '2026-11-12', $1) RETURNING id`, [
            ids.user,
          ])
        ).rows[0].id;
        ids.entry = (
          await client.query(
            `INSERT INTO verification_scope_entries (verification_round_id, asset_id, joined_as, recorded_by, name) VALUES ($1, $2, 'OPENING', $3, 'โต๊ะทำงาน') RETURNING id`,
            [ids.round, ids.asset, ids.user]
          )
        ).rows[0].id;
        ids.revision = (
          await client.query(
            `INSERT INTO verification_revisions (verification_scope_entry_id, revision_number, result, condition, verification_date, recorded_by)
             VALUES ($1, 1, 'FOUND', 'NORMAL', '2026-11-12', $2) RETURNING id`,
            [ids.entry, ids.user]
          )
        ).rows[0].id;
        ids.initial = (
          await client.query(
            `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance) VALUES ($1, 'INITIAL', '2026-10-01', $2, 'RECORDED') RETURNING id`,
            [ids.asset, ids.user]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0022_reassignment_verification_revisions');

    await withClient(async (client) => {
      expect((await client.query('SELECT verification_revision_id FROM assignment_events WHERE id = $1', [ids.initial])).rows).toEqual([{ verification_revision_id: null }]);
    });
  });

  it('lets only a single Reassignment cite, and only a revision that exists', async () => {
    await withClient(async (client) => {
      ids.cited = (await insertEvent(client, { revisionId: ids.revision })).rows[0].id;

      await expect(insertEvent(client, { kind: 'INITIAL', revisionId: ids.revision })).rejects.toThrow(/assignment_events_verification_revision_on_single_reassignment/);
      await expect(insertEvent(client, { bulk: true, revisionId: ids.revision })).rejects.toThrow(/assignment_events_verification_revision_on_single_reassignment/);
      await expect(insertEvent(client, { revisionId: crypto.randomUUID() })).rejects.toThrow(/verification_revision_id/);
      // A Reassignment keeps the revision it cites: the revision cannot be deleted under it.
      await expect(client.query('DELETE FROM verification_revisions WHERE id = $1', [ids.revision])).rejects.toThrow(/assignment_events/);
    });
  });

  it('refuses a rollback while a Reassignment cites a Verification Revision, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient(async (client) => {
      await client.query('DELETE FROM assignment_events WHERE id = $1', [ids.cited]);
    });
    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0022_reassignment_verification_revisions', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT kind FROM assignment_events WHERE id = $1', [ids.initial])).rows).toEqual([{ kind: 'INITIAL' }]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0022_reassignment_verification_revisions');
  });
});
