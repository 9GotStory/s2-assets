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

// F004-T6 (#80): 0012_loan_corrections against a populated 0011 database (Seam C).
describe('Loan Correction Migration Integration (Seam C - F004-T6)', () => {
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

  // A correction record of the Loan, an amendment of its remark, unless `fields` says otherwise.
  const insertCorrection = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = {
      loan_id: ids.loan,
      action: 'AMENDED',
      reason: 'บันทึกผิด',
      changes: JSON.stringify([{ field: 'remark', before: null, after: 'ยืมไปใช้ประชุม' }]),
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO loan_corrections (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the correction records to a populated database, and leaves its Loans alone', async () => {
    for (let step = 1; step <= 11; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t6_user', 'hash') RETURNING id`)).rows[0].id;
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
        ids.ending = (
          await client.query(
            `INSERT INTO loan_item_endings (loan_item_id, kind, ending_date, condition, action_reference, recorded_by)
             VALUES ($1, 'LOAN_RETURN', '2026-11-05', 'NORMAL', $2, $3) RETURNING id`,
            [ids.item, crypto.randomUUID(), ids.user]
          )
        ).rows[0].id;
        await client.query(`UPDATE loan_items SET ending_kind = 'LOAN_RETURN' WHERE id = $1`, [ids.item]);
        ids.extension = (
          await client.query(
            `INSERT INTO loan_due_date_extensions (loan_item_id, prior_due_date, new_due_date, action_reference, recorded_by)
             VALUES ($1, '2026-11-30', '2026-12-15', $2, $3) RETURNING id`,
            [ids.item, crypto.randomUUID(), ids.user]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0012_loan_corrections');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loan_corrections')).rows[0].n).toBe(0);
      expect((await client.query('SELECT ending_kind, is_voided FROM loan_items WHERE id = $1', [ids.item])).rows).toEqual([
        { ending_kind: 'LOAN_RETURN', is_voided: false },
      ]);
      expect((await client.query('SELECT version, is_voided FROM loans WHERE id = $1', [ids.loan])).rows).toEqual([{ version: 1, is_voided: false }]);
    });
  });

  it('keeps exactly one target, a nonblank reason, and the changes an amendment made', async () => {
    await withClient(async (client) => {
      // Exactly one of the four targets.
      await expect(insertCorrection(client, { loan_id: null })).rejects.toThrow(/loan_corrections_one_target/);
      await expect(insertCorrection(client, { loan_item_id: ids.item })).rejects.toThrow(/loan_corrections_one_target/);
      await expect(insertCorrection(client, { loan_item_ending_id: ids.ending, due_date_extension_id: ids.extension, loan_id: null })).rejects.toThrow(
        /loan_corrections_one_target/
      );
      // Real targets and recorders.
      await expect(insertCorrection(client, { loan_id: crypto.randomUUID() })).rejects.toThrow(/loan_id/);
      await expect(insertCorrection(client, { loan_id: null, loan_item_id: crypto.randomUUID() })).rejects.toThrow(/loan_item_id/);
      await expect(insertCorrection(client, { recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      // An action of the two, and a nonblank reason.
      await expect(insertCorrection(client, { action: 'DELETED' })).rejects.toThrow(/action/);
      await expect(insertCorrection(client, { reason: '  ' })).rejects.toThrow(/reason/);
      await expect(insertCorrection(client, { reason: null })).rejects.toThrow(/reason/);
      // An amendment lists what it changed, and a void changes no field.
      await expect(insertCorrection(client, { changes: '[]' })).rejects.toThrow(/loan_corrections_amendment_lists_changes/);
      await expect(insertCorrection(client, { changes: '{}' })).rejects.toThrow(/loan_corrections_amendment_lists_changes/);
      await expect(insertCorrection(client, { action: 'VOIDED' })).rejects.toThrow(/loan_corrections_amendment_lists_changes/);

      await insertCorrection(client);
      await insertCorrection(client, { loan_id: null, loan_item_id: ids.item, changes: JSON.stringify([{ field: 'condition', before: 'NORMAL', after: 'DAMAGED' }]) });
      for (const target of ['loan_id', 'loan_item_id', 'loan_item_ending_id', 'due_date_extension_id']) {
        const fields = { loan_id: null, [target]: ids[{ loan_id: 'loan', loan_item_id: 'item', loan_item_ending_id: 'ending', due_date_extension_id: 'extension' }[target]!], action: 'VOIDED', changes: '[]' };
        await insertCorrection(client, fields);
        // A fact is voided at most once.
        await expect(insertCorrection(client, fields)).rejects.toThrow(/loan_corrections_one_void/);
      }
    });
  });

  it('refuses a rollback while a correction record or its receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM loan_corrections')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM loan_corrections');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t6-receipt', $1, $2, 'fingerprint', 201, '{}')`,
        [ids.user, `loan:correct:${ids.loan}`]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't6-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0012_loan_corrections', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM loan_item_endings WHERE id = $1', [ids.ending])).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0012_loan_corrections');
  });
});
