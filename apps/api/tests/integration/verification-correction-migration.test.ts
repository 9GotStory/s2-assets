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

// F006-T4 (#129): 0020_verification_corrections against a populated 0019 database (Seam C).
describe('Verification Correction Migration Integration (Seam C - F006-T4)', () => {
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

  // The next Verification Revision of the scope entry `ids.entry`, Found ปกติ.
  const insertRevision = async (client: pg.Client): Promise<string> => {
    const res = await client.query(
      `INSERT INTO verification_revisions (verification_scope_entry_id, revision_number, result, condition, verification_date, recorded_by)
       VALUES ($1, $2, 'FOUND', 'NORMAL', '2026-11-12', $3) RETURNING id`,
      [ids.entry, revisionNumber++, ids.user]
    );
    return res.rows[0].id;
  };

  const insertCorrection = (client: pg.Client, revisionId: string, reason: unknown = 'บันทึกผิดครุภัณฑ์') =>
    client.query(`INSERT INTO verification_corrections (verification_revision_id, reason, recorded_by) VALUES ($1, $2, $3) RETURNING id, recorded_at`, [
      revisionId,
      reason,
      ids.user,
    ]);

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

  it('adds the Verification Correction record to a populated database, a revision already there left as it was', async () => {
    for (let step = 1; step <= 19; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t4_verification_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
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
        ids.earlier = await insertRevision(client);
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0020_verification_corrections');

    await withClient(async (client) => {
      expect((await client.query('SELECT is_voided FROM verification_revisions WHERE id = $1', [ids.earlier])).rows).toEqual([{ is_voided: false }]);
      expect((await client.query('SELECT count(*)::int AS n FROM verification_corrections')).rows[0].n).toBe(0);
    });
  });

  it('keeps one correction per revision with its reason, actor and Recorded At', async () => {
    await withClient(async (client) => {
      const before = Date.now();
      const kept = await insertCorrection(client, ids.earlier, 'บันทึกผิดครุภัณฑ์\nควรเป็นอีกเครื่อง');
      expect(Date.parse(kept.rows[0].recorded_at)).toBeGreaterThanOrEqual(before - 5000);

      await expect(insertCorrection(client, ids.earlier, 'ซ้ำ')).rejects.toThrow(/verification_corrections_one_per_revision/);
      const other = await insertRevision(client);
      await expect(insertCorrection(client, other, '   ')).rejects.toThrow(/reason/);
      await expect(insertCorrection(client, other, null)).rejects.toThrow(/reason/);
      await expect(insertCorrection(client, crypto.randomUUID())).rejects.toThrow(/verification_revision_id/);
      await expect(client.query(`INSERT INTO verification_corrections (verification_revision_id, reason, recorded_by) VALUES ($1, 'ผิด', $2)`, [other, crypto.randomUUID()])).rejects.toThrow(/recorded_by/);
      // A correction keeps the revision it voids: the revision cannot be deleted under it.
      await expect(client.query('DELETE FROM verification_revisions WHERE id = $1', [ids.earlier])).rejects.toThrow(/verification_corrections/);
    });
  });

  it('refuses a rollback while a Verification Correction or a retry receipt of one exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient(async (client) => {
      await client.query('DELETE FROM verification_corrections');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t4-correction-receipt', $1, 'verification:correct', 'fp', 201, '{}')`,
        [ids.user]
      );
    });
    expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient(async (client) => {
      await client.query(`DELETE FROM registration_retry_tokens WHERE token = 't4-correction-receipt'`);
    });
    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0020_verification_corrections', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM verification_revisions')).rows[0].n).toBe(2);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0020_verification_corrections');
  });
});
