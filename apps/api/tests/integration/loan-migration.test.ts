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

// F004-T1 (#75): 0009_loans against a populated 0008 database (Seam C).
describe('Loan Migration Integration (Seam C - F004-T1)', () => {
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

  const insertAsset = async (client: pg.Client, name: string): Promise<string> =>
    (await client.query(`INSERT INTO assets (name, registered_by) VALUES ($1, $2) RETURNING id`, [name, ids.user])).rows[0].id;

  // A Loan of an Internal Borrower, unless `fields` says otherwise.
  const insertLoan = async (client: pg.Client, fields: Record<string, unknown> = { borrower_kind: 'INTERNAL', borrower_person_id: ids.person }): Promise<string> => {
    const values = { loan_date: '2026-11-01', recorded_by: ids.user, ...fields };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO loans (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  const insertItem = async (client: pg.Client, loanId: string, assetId: string, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = { loan_id: loanId, asset_id: assetId, due_date: '2026-11-30', lending_condition: 'NORMAL', ...fields };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO loan_items (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the Loan tables to a populated database, and leaves its facts alone', async () => {
    for (let step = 1; step <= 8; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_user', 'hash') RETURNING id`)).rows[0].id;
        ids.person = (await client.query(`INSERT INTO persons (name, created_by, updated_by) VALUES ('สมชาย', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.asset = await insertAsset(client, 'โน้ตบุ๊ก');
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0009_loans');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loans')).rows[0].n).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM loan_items')).rows[0].n).toBe(0);
      expect((await client.query('SELECT name FROM assets WHERE id = $1', [ids.asset])).rows).toEqual([{ name: 'โน้ตบุ๊ก' }]);
    });
  });

  it('ties the Borrower fields to the Borrower kind', async () => {
    await withClient(async (client) => {
      const refused = /loans_borrower_fields/;
      await expect(insertLoan(client, { borrower_kind: 'INTERNAL' })).rejects.toThrow(refused);
      await expect(
        insertLoan(client, { borrower_kind: 'INTERNAL', borrower_person_id: ids.person, borrower_contact_name: 'สมหญิง' })
      ).rejects.toThrow(refused);
      await expect(
        insertLoan(client, { borrower_kind: 'INTERNAL', borrower_person_id: ids.person, borrower_phone: '0812345678' })
      ).rejects.toThrow(refused);
      await expect(insertLoan(client, { borrower_kind: 'EXTERNAL' })).rejects.toThrow(refused);
      await expect(insertLoan(client, { borrower_kind: 'EXTERNAL', borrower_organization_name: 'บริษัท ก' })).rejects.toThrow(refused);
      await expect(
        insertLoan(client, { borrower_kind: 'EXTERNAL', borrower_contact_name: 'สมหญิง', borrower_person_id: ids.person })
      ).rejects.toThrow(refused);
      await expect(insertLoan(client, { borrower_kind: 'OTHER', borrower_contact_name: 'สมหญิง' })).rejects.toThrow(refused);

      await insertLoan(client, { borrower_kind: 'EXTERNAL', borrower_contact_name: 'สมหญิง' });
      await insertLoan(client, {
        borrower_kind: 'EXTERNAL',
        borrower_contact_name: 'สมหญิง',
        borrower_organization_name: 'บริษัท ก',
        borrower_phone: '081-234-5678',
      });
      await insertLoan(client);
    });
  });

  it('holds an Asset on at most one LoanItem until that item ends with a Loan Return or is voided', async () => {
    await withClient(async (client) => {
      const assetId = await insertAsset(client, 'เครื่องฉาย');
      const firstLoan = await insertLoan(client);
      const secondLoan = await insertLoan(client);
      const refused = /loan_items_one_outstanding_or_not_returned_per_asset/;

      const first = await insertItem(client, firstLoan, assetId);
      await expect(insertItem(client, secondLoan, assetId)).rejects.toThrow(refused);

      // Not Returned keeps the Asset from a new Loan (#74 Q21); a Loan Return frees it.
      await client.query(`UPDATE loan_items SET ending_kind = 'NOT_RETURNED' WHERE id = $1`, [first]);
      await expect(insertItem(client, secondLoan, assetId)).rejects.toThrow(refused);

      await client.query(`UPDATE loan_items SET ending_kind = 'LOAN_RETURN' WHERE id = $1`, [first]);
      const second = await insertItem(client, secondLoan, assetId);

      await client.query(`UPDATE loan_items SET is_voided = true WHERE id = $1`, [second]);
      await insertItem(client, await insertLoan(client), assetId);
    });
  });

  it('keeps one LoanItem per Asset of a Loan, and only the recorded Conditions and ending kinds', async () => {
    await withClient(async (client) => {
      const assetId = await insertAsset(client, 'กล้อง');
      const loanId = await insertLoan(client);
      const item = await insertItem(client, loanId, assetId, { ending_kind: 'LOAN_RETURN' });

      await expect(insertItem(client, loanId, assetId)).rejects.toThrow(/loan_items_one_per_loan_and_asset/);
      await expect(insertItem(client, loanId, await insertAsset(client, 'ไมค์'), { lending_condition: 'BROKEN' })).rejects.toThrow(/lending_condition/);
      await expect(client.query(`UPDATE loan_items SET ending_kind = 'LOST' WHERE id = $1`, [item])).rejects.toThrow(/ending_kind/);
    });
  });

  it('refuses a rollback while a Loan fact or a Loan retry receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loans')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM loan_items');
      await client.query('DELETE FROM loans');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t1-receipt', $1, 'loan:start', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE operation = 'loan:start'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0009_loans', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM assets WHERE id = $1', [ids.asset])).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0009_loans');
  });
});
