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

// F005-T1 (#99): 0013_repair_records against a populated 0012 database (Seam C).
describe('Repair Record Migration Integration (Seam C - F005-T1)', () => {
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

  // A Repair Record of the Asset, of kind ซ่อม by an internal Repairer, unless `fields` says otherwise.
  const insertRecord = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = {
      asset_id: ids.asset,
      repair_kind: 'REPAIR',
      start_date: '2026-11-05',
      repairer_kind: 'INTERNAL',
      symptom_or_work: 'เปิดไม่ติด',
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO repair_records (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the Repair Records to a populated database, and leaves its Assets and Loans alone', async () => {
    for (let step = 1; step <= 12; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_repair_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.otherAsset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('จอภาพ', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.loan = (
          await client.query(`INSERT INTO loans (borrower_kind, borrower_contact_name, loan_date, recorded_by) VALUES ('EXTERNAL', 'คุณผู้ยืม', '2026-11-01', $1) RETURNING id`, [
            ids.user,
          ])
        ).rows[0].id;
        await client.query(`INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-11-30', 'NORMAL')`, [ids.loan, ids.otherAsset]);
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0013_repair_records');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM repair_records')).rows[0].n).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(2);
      expect((await client.query('SELECT ending_kind, is_voided FROM loan_items WHERE loan_id = $1', [ids.loan])).rows).toEqual([{ ending_kind: 'NONE', is_voided: false }]);
    });
  });

  it('keeps a record to its kinds, a symptom or work, a cost not negative, and no outcome until one is recorded', async () => {
    await withClient(async (client) => {
      const id = await insertRecord(client);
      expect((await client.query('SELECT under_warranty, has_outcome, is_voided, version FROM repair_records WHERE id = $1', [id])).rows).toEqual([
        { under_warranty: 'UNSPECIFIED', has_outcome: false, is_voided: false, version: 1 },
      ]);
      await client.query('UPDATE repair_records SET has_outcome = true WHERE id = $1', [id]);

      await expect(insertRecord(client, { repair_kind: 'CLEANING' })).rejects.toThrow(/repair_kind/);
      await expect(insertRecord(client, { repairer_kind: 'VENDOR' })).rejects.toThrow(/repairer_kind/);
      await expect(insertRecord(client, { under_warranty: 'MAYBE' })).rejects.toThrow(/under_warranty/);
      await expect(insertRecord(client, { symptom_or_work: '  ' })).rejects.toThrow(/symptom_or_work/);
      await expect(insertRecord(client, { symptom_or_work: null })).rejects.toThrow(/symptom_or_work/);
      await expect(insertRecord(client, { repairer_name: ' ' })).rejects.toThrow(/repairer_name/);
      await expect(insertRecord(client, { cost: '-0.01' })).rejects.toThrow(/cost/);
      await expect(insertRecord(client, { cost: '10000000000.00' })).rejects.toThrow(/numeric field overflow/);
      await expect(insertRecord(client, { asset_id: ids.user })).rejects.toThrow(/asset_id/);
      await expect(insertRecord(client, { recorded_by: ids.asset })).rejects.toThrow(/recorded_by/);
      await expect(insertRecord(client, { start_date: null })).rejects.toThrow(/start_date/);
    });
  });

  it('allows at most one non-voided Repair Record without an outcome per Asset (#98 Q3)', async () => {
    await withClient(async (client) => {
      const open = await insertRecord(client, { repair_kind: 'MAINTENANCE' });

      // Either kind counts.
      await expect(insertRecord(client)).rejects.toThrow(/repair_records_one_under_repair_per_asset/);
      await expect(insertRecord(client, { repair_kind: 'MAINTENANCE' })).rejects.toThrow(/repair_records_one_under_repair_per_asset/);
      // Another Asset has its own.
      await insertRecord(client, { asset_id: ids.otherAsset });
      // A voided record, or one with an outcome, does not count.
      await insertRecord(client, { is_voided: true });
      await insertRecord(client, { has_outcome: true });

      await client.query('UPDATE repair_records SET is_voided = true WHERE id = $1', [open]);
      await insertRecord(client);
    });
  });

  it('refuses a rollback while a Repair Record or a Repair retry receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM repair_records')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM repair_records');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t1-repair-receipt', $1, 'repair:start', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't1-repair-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0013_repair_records', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(2);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0013_repair_records');
  });
});
