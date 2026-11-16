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

// F006-T3 (#128): 0019_verification_discrepancies against a populated 0018 database (Seam C).
describe('Verification Discrepancy Migration Integration (Seam C - F006-T3)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  const ids: Record<string, string> = {};
  let revisionNumber = 1;

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

  // The next Verification Revision of the scope entry `ids.entry`, Found ปกติ, unless `fields` says otherwise.
  const insertRevision = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values: Record<string, unknown> = {
      verification_scope_entry_id: ids.entry,
      revision_number: revisionNumber++,
      result: 'FOUND',
      condition: 'NORMAL',
      verification_date: '2026-11-12',
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO verification_revisions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the Observed Location and the two flags to a populated database, a revision already there holding none', async () => {
    for (let step = 1; step <= 18; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t3_verification_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.location = (await client.query(`INSERT INTO locations (name, created_by, updated_by) VALUES ('ห้องประชุม', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.round = (
          await client.query(`INSERT INTO verification_rounds (name, fiscal_year, start_date, opened_by) VALUES ('ตรวจประจำปี 2569', 2569, '2026-11-12', $1) RETURNING id`, [
            ids.user,
          ])
        ).rows[0].id;
        ids.entry = (
          await client.query(
            `INSERT INTO verification_scope_entries (verification_round_id, asset_id, joined_as, recorded_by, name) VALUES ($1, $2, 'OPENING', $3, 'เครื่องพิมพ์') RETURNING id`,
            [ids.round, ids.asset, ids.user]
          )
        ).rows[0].id;
        ids.earlier = await insertRevision(client, { result: 'NOT_FOUND', condition: null });
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0019_verification_discrepancies');

    await withClient(async (client) => {
      expect(
        (await client.query('SELECT observed_location_id, label_missing_or_damaged, data_mismatch, data_mismatch_note FROM verification_revisions WHERE id = $1', [ids.earlier])).rows
      ).toEqual([{ observed_location_id: null, label_missing_or_damaged: false, data_mismatch: false, data_mismatch_note: null }]);
    });
  });

  it('keeps an Observed Location and the flags on a Found result, each alone or together, the data-mismatch flag with its note', async () => {
    await withClient(async (client) => {
      await insertRevision(client, { observed_location_id: ids.location });
      await insertRevision(client, { label_missing_or_damaged: true });
      await insertRevision(client, { data_mismatch: true, data_mismatch_note: 'Serial Number บนตัวเครื่องไม่ตรง' });
      await insertRevision(client, {
        condition: 'DAMAGED',
        observed_location_id: ids.location,
        label_missing_or_damaged: true,
        data_mismatch: true,
        data_mismatch_note: 'ยี่ห้อไม่ตรง',
      });

      await expect(insertRevision(client, { observed_location_id: crypto.randomUUID() })).rejects.toThrow(/observed_location_id/);
      await expect(insertRevision(client, { data_mismatch: true })).rejects.toThrow(/verification_revisions_data_mismatch_note/);
      await expect(insertRevision(client, { data_mismatch_note: 'ไม่ได้ติ๊ก' })).rejects.toThrow(/verification_revisions_data_mismatch_note/);
      await expect(insertRevision(client, { data_mismatch: true, data_mismatch_note: '  ' })).rejects.toThrow(/data_mismatch_note/);
      await expect(insertRevision(client, { label_missing_or_damaged: null })).rejects.toThrow(/label_missing_or_damaged/);
      await expect(insertRevision(client, { data_mismatch: null })).rejects.toThrow(/data_mismatch/);
      // A revision keeps the Location it names: the entry cannot be deleted under it.
      await expect(client.query('DELETE FROM locations WHERE id = $1', [ids.location])).rejects.toThrow(/verification_revisions/);
    });
  });

  it('refuses an Observed Location and either flag on a Not Found result', async () => {
    await withClient(async (client) => {
      const notFound = { result: 'NOT_FOUND', condition: null };
      await expect(insertRevision(client, { ...notFound, observed_location_id: ids.location })).rejects.toThrow(/verification_revisions_found_discrepancies/);
      await expect(insertRevision(client, { ...notFound, label_missing_or_damaged: true })).rejects.toThrow(/verification_revisions_found_discrepancies/);
      await expect(insertRevision(client, { ...notFound, data_mismatch: true, data_mismatch_note: 'ไม่ตรง' })).rejects.toThrow(/verification_revisions_found_discrepancies/);
      await insertRevision(client, notFound);
    });
  });

  it('refuses a rollback while a revision holds an Observed Location or a flag, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const holding = [
      { observed_location_id: ids.location },
      { label_missing_or_damaged: true },
      { data_mismatch: true, data_mismatch_note: 'ไม่ตรง' },
    ];

    for (const fields of holding) {
      await withClient(async (client) => {
        await client.query('DELETE FROM verification_revisions WHERE id <> $1', [ids.earlier]);
        await insertRevision(client, fields);
      });
      expect(String((await down()).error)).toContain('Refusing destructive rollback');
    }
    await withClient(async (client) => {
      await client.query('DELETE FROM verification_revisions WHERE id <> $1', [ids.earlier]);
      await insertRevision(client, { condition: 'DAMAGED' });
    });

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0019_verification_discrepancies', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      // Revisions with no Observed Location and no flag keep everything else they hold.
      expect((await client.query('SELECT result, condition FROM verification_revisions ORDER BY revision_number')).rows).toEqual([
        { result: 'NOT_FOUND', condition: null },
        { result: 'FOUND', condition: 'DAMAGED' },
      ]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0019_verification_discrepancies');
  });
});
