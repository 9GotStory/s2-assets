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

// F005-T5 (#103): 0015_repair_sources against a populated 0014 database (Seam C).
describe('Repair Source Migration Integration (Seam C - F005-T5)', () => {
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

  it('adds a Repair Source to a populated database, with none on the Repair Records already there', async () => {
    for (let step = 1; step <= 14; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t5_repair_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องฉาย', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.loan = (
          await client.query(
            `INSERT INTO loans (borrower_kind, borrower_contact_name, loan_date, recorded_by) VALUES ('EXTERNAL', 'คุณผู้ยืม', '2026-11-01', $1) RETURNING id`,
            [ids.user]
          )
        ).rows[0].id;
        ids.item = (
          await client.query(
            `INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-11-10', 'NORMAL') RETURNING id`,
            [ids.loan, ids.asset]
          )
        ).rows[0].id;
        ids.loanReturn = (
          await client.query(
            `INSERT INTO loan_item_endings (loan_item_id, kind, ending_date, condition, action_reference, recorded_by)
             VALUES ($1, 'LOAN_RETURN', '2026-11-04', 'DAMAGED', gen_random_uuid(), $2) RETURNING id`,
            [ids.item, ids.user]
          )
        ).rows[0].id;
        ids.record = (
          await client.query(
            `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, symptom_or_work, recorded_by)
             VALUES ($1, 'REPAIR', '2026-11-05', 'INTERNAL', 'จอไม่ติด', $2) RETURNING id`,
            [ids.asset, ids.user]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0015_repair_sources');

    await withClient(async (client) => {
      expect((await client.query('SELECT repair_source_loan_return_id, version FROM repair_records WHERE id = $1', [ids.record])).rows).toEqual([
        { repair_source_loan_return_id: null, version: 1 },
      ]);
    });
  });

  it('keeps a Repair Source to an existing Loan ending fact, which it never lets be deleted', async () => {
    await withClient(async (client) => {
      const cite = (source: string) => client.query('UPDATE repair_records SET repair_source_loan_return_id = $2 WHERE id = $1', [ids.record, source]);

      await expect(cite(ids.asset)).rejects.toThrow(/repair_source_loan_return_id/);
      await cite(ids.loanReturn);
      await expect(client.query('DELETE FROM loan_item_endings WHERE id = $1', [ids.loanReturn])).rejects.toThrow(/repair_records/);
      // Voiding the Loan Return leaves the record citing it (#98 Q5).
      await client.query('UPDATE loan_item_endings SET is_voided = true WHERE id = $1', [ids.loanReturn]);
      expect((await client.query('SELECT repair_source_loan_return_id FROM repair_records WHERE id = $1', [ids.record])).rows[0]).toEqual({
        repair_source_loan_return_id: ids.loanReturn,
      });
    });
  });

  it('refuses a rollback while a Repair Record has a Repair Source, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query('UPDATE repair_records SET repair_source_loan_return_id = NULL'));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0015_repair_sources', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM repair_records')).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0015_repair_sources');
  });
});
