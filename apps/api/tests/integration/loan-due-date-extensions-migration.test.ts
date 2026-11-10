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

// F004-T5 (#79): 0011_loan_due_date_extensions against a populated 0010 database (Seam C).
describe('Loan Due Date Extensions Migration Integration (Seam C - F004-T5)', () => {
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

  // A Due Date Extension of the one LoanItem, unless `fields` says otherwise.
  const insertExtension = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = {
      loan_item_id: ids.item,
      prior_due_date: '2026-11-30',
      new_due_date: '2026-12-15',
      action_reference: crypto.randomUUID(),
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO loan_due_date_extensions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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
  }, 30_000);

  it('adds the Due Date Extensions to a populated database, and leaves its Loans alone', async () => {
    for (let step = 1; step <= 10; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t5_user', 'hash') RETURNING id`)).rows[0].id;
        ids.person = (await client.query(`INSERT INTO persons (name, created_by, updated_by) VALUES ('สมชาย', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.loan = (
          await client.query(
            `INSERT INTO loans (borrower_kind, borrower_person_id, loan_date, recorded_by) VALUES ('INTERNAL', $1, '2026-11-01', $2) RETURNING id`,
            [ids.person, ids.user]
          )
        ).rows[0].id;
        const asset = await client.query(`INSERT INTO assets (name, registered_by) VALUES ('ของ', $1) RETURNING id`, [ids.user]);
        ids.item = (
          await client.query(`INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-11-30', 'NORMAL') RETURNING id`, [
            ids.loan,
            asset.rows[0].id,
          ])
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0011_loan_due_date_extensions');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loan_due_date_extensions')).rows[0].n).toBe(0);
      expect((await client.query(`SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date, ending_kind FROM loan_items WHERE id = $1`, [ids.item])).rows).toEqual([
        { due_date: '2026-11-30', ending_kind: 'NONE' },
      ]);
      expect((await client.query('SELECT version FROM loans WHERE id = $1', [ids.loan])).rows).toEqual([{ version: 1 }]);
    });
  });

  it('keeps only a new date later than the prior one, a nonblank reason, and real LoanItems and recorders', async () => {
    await withClient(async (client) => {
      await expect(insertExtension(client, { new_due_date: '2026-11-30' })).rejects.toThrow(/loan_due_date_extensions_later/);
      await expect(insertExtension(client, { new_due_date: '2026-11-29' })).rejects.toThrow(/loan_due_date_extensions_later/);
      await expect(insertExtension(client, { reason: '  ' })).rejects.toThrow(/reason/);
      await expect(insertExtension(client, { loan_item_id: crypto.randomUUID() })).rejects.toThrow(/loan_item_id/);
      await expect(insertExtension(client, { recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      for (const column of ['prior_due_date', 'new_due_date', 'action_reference']) {
        await expect(insertExtension(client, { [column]: null })).rejects.toThrow(new RegExp(column));
      }

      await insertExtension(client);
      await insertExtension(client, { prior_due_date: '2026-12-15', new_due_date: '2026-12-16', reason: 'ผู้ยืมขอใช้ต่อ' });
    });
  });

  it('refuses a rollback while a Due Date Extension or its receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loan_due_date_extensions')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM loan_due_date_extensions');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t5-receipt', $1, $2, 'fingerprint', 201, '{}')`,
        [ids.user, `loan:due-date-extension:${ids.loan}`]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't5-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0011_loan_due_date_extensions', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM loan_items WHERE id = $1', [ids.item])).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0011_loan_due_date_extensions');
  });
});
