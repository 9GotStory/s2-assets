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

// F004-T2 (#76): 0010_loan_item_endings against a populated 0009 database (Seam C).
describe('Loan Item Endings Migration Integration (Seam C - F004-T2)', () => {
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

  // A LoanItem of a new Asset on the one Loan.
  const insertItem = async (client: pg.Client): Promise<string> => {
    const asset = await client.query(`INSERT INTO assets (name, registered_by) VALUES ('ของ', $1) RETURNING id`, [ids.user]);
    const item = await client.query(
      `INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-11-30', 'NORMAL') RETURNING id`,
      [ids.loan, asset.rows[0].id]
    );
    return item.rows[0].id;
  };

  // A Loan Return of `itemId`, unless `fields` says otherwise.
  const insertEnding = async (client: pg.Client, itemId: string, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = {
      loan_item_id: itemId,
      kind: 'LOAN_RETURN',
      ending_date: '2026-11-02',
      condition: 'NORMAL',
      action_reference: crypto.randomUUID(),
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO loan_item_endings (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the ending facts to a populated database, and leaves its Loans alone', async () => {
    for (let step = 1; step <= 9; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t2_user', 'hash') RETURNING id`)).rows[0].id;
        ids.person = (await client.query(`INSERT INTO persons (name, created_by, updated_by) VALUES ('สมชาย', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.loan = (
          await client.query(
            `INSERT INTO loans (borrower_kind, borrower_person_id, loan_date, recorded_by) VALUES ('INTERNAL', $1, '2026-11-01', $2) RETURNING id`,
            [ids.person, ids.user]
          )
        ).rows[0].id;
        ids.item = await insertItem(client);
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0010_loan_item_endings');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loan_item_endings')).rows[0].n).toBe(0);
      expect((await client.query('SELECT ending_kind, is_voided FROM loan_items WHERE id = $1', [ids.item])).rows).toEqual([{ ending_kind: 'NONE', is_voided: false }]);
      expect((await client.query('SELECT version FROM loans WHERE id = $1', [ids.loan])).rows).toEqual([{ version: 1 }]);
    });
  });

  it('ties the Condition and the reason to the ending\'s kind', async () => {
    await withClient(async (client) => {
      const refused = /loan_item_endings_kind_fields/;
      const notReturned = { kind: 'NOT_RETURNED', condition: null, reason: 'ผู้ยืมทำหาย' };

      await expect(insertEnding(client, await insertItem(client), { condition: null })).rejects.toThrow(refused);
      await expect(insertEnding(client, await insertItem(client), { reason: 'ไม่ควรมี' })).rejects.toThrow(refused);
      await expect(insertEnding(client, await insertItem(client), { ...notReturned, reason: null })).rejects.toThrow(refused);
      await expect(insertEnding(client, await insertItem(client), { ...notReturned, condition: 'NORMAL' })).rejects.toThrow(refused);
      await expect(insertEnding(client, await insertItem(client), { ...notReturned, condition_note: 'ไม่ควรมี' })).rejects.toThrow(refused);
      await expect(insertEnding(client, await insertItem(client), { kind: 'LOST' })).rejects.toThrow(refused);

      await insertEnding(client, await insertItem(client), { condition: 'DAMAGED', condition_note: 'จอแตก' });
      await insertEnding(client, await insertItem(client), notReturned);
    });
  });

  it('keeps one non-voided fact of each kind per LoanItem', async () => {
    await withClient(async (client) => {
      const itemId = await insertItem(client);
      const notReturned = { kind: 'NOT_RETURNED', condition: null, reason: 'ผู้ยืมทำหาย' };
      const refused = /loan_item_endings_one_of_each_kind_per_item/;

      const first = await insertEnding(client, itemId);
      await expect(insertEnding(client, itemId)).rejects.toThrow(refused);

      // A Not Returned item that turns up has both facts (#74 Q21).
      const closure = await insertEnding(client, itemId, notReturned);
      await expect(insertEnding(client, itemId, notReturned)).rejects.toThrow(refused);

      await client.query('UPDATE loan_item_endings SET is_voided = true WHERE id = ANY($1::uuid[])', [[first, closure]]);
      await insertEnding(client, itemId);
      await insertEnding(client, itemId, notReturned);
    });
  });

  it('keeps only recorded Conditions, nonblank text, and real LoanItems and recorders', async () => {
    await withClient(async (client) => {
      await expect(insertEnding(client, await insertItem(client), { condition: 'BROKEN' })).rejects.toThrow(/condition/);
      for (const field of ['condition_note', 'document_reference', 'remark']) {
        await expect(insertEnding(client, await insertItem(client), { [field]: '   ' })).rejects.toThrow(new RegExp(field));
      }
      await expect(insertEnding(client, crypto.randomUUID())).rejects.toThrow(/loan_item_id/);
      await expect(insertEnding(client, await insertItem(client), { recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
    });
  });

  it('refuses a rollback while an ending fact or a Loan Return receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loan_item_endings')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM loan_item_endings');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t2-receipt', $1, $2, 'fingerprint', 201, '{}')`,
        [ids.user, `loan:return:${ids.loan}`]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't2-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0010_loan_item_endings', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM loan_items WHERE id = $1', [ids.item])).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0010_loan_item_endings');
  });
});
