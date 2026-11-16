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

// F006-T2 (#127): 0018_verification_revisions against a populated 0017 database (Seam C).
describe('Verification Revision Migration Integration (Seam C - F006-T2)', () => {
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

  // A Verification Revision of the scope entry `ids.entry`, its first and Found ปกติ, unless `fields` says otherwise.
  const insertRevision = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values: Record<string, unknown> = {
      verification_scope_entry_id: ids.entry,
      revision_number: 1,
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

  it('adds Verification Revisions to a populated database, with none for the scope entries already there', async () => {
    for (let step = 1; step <= 17; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t2_verification_user', 'hash') RETURNING id`)).rows[0].id;
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
        ids.loan = (
          await client.query(
            `INSERT INTO loans (borrower_kind, borrower_contact_name, loan_date, recorded_by) VALUES ('EXTERNAL', 'คุณผู้ยืม', '2026-11-01', $1) RETURNING id`,
            [ids.user]
          )
        ).rows[0].id;
        ids.item = (
          await client.query(`INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-11-30', 'NORMAL') RETURNING id`, [ids.loan, ids.asset])
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
    expect(upgrade.results?.[0]?.migrationName).toBe('0018_verification_revisions');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM verification_revisions')).rows[0].n).toBe(0);
      expect((await client.query('SELECT version FROM verification_scope_entries WHERE id = $1', [ids.entry])).rows).toEqual([{ version: 1 }]);
    });
  });

  it('keeps a result Found with a Condition or Not Found without one, a Verification Date, and a bounded note', async () => {
    await withClient(async (client) => {
      await expect(insertRevision(client, { result: 'LOST', condition: null })).rejects.toThrow(/result/);
      await expect(insertRevision(client, { condition: 'BROKEN' })).rejects.toThrow(/condition/);
      await expect(insertRevision(client, { condition: null })).rejects.toThrow(/verification_revisions_condition_when_found/);
      await expect(insertRevision(client, { result: 'NOT_FOUND' })).rejects.toThrow(/verification_revisions_condition_when_found/);
      await expect(insertRevision(client, { verification_date: null })).rejects.toThrow(/verification_date/);
      await expect(insertRevision(client, { note: '  ' })).rejects.toThrow(/note/);
      await expect(insertRevision(client, { revision_number: 0 })).rejects.toThrow(/revision_number/);
      await expect(insertRevision(client, { verification_scope_entry_id: crypto.randomUUID() })).rejects.toThrow(/verification_scope_entry_id/);
      await expect(insertRevision(client, { recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      await expect(insertRevision(client, { location_id: crypto.randomUUID() })).rejects.toThrow(/location_id/);

      const first = await insertRevision(client, { location_id: ids.location, legacy_organization_unit_text: 'กองคลัง (เดิม)', note: 'อยู่ใต้โต๊ะ' });
      expect((await client.query('SELECT is_voided, recorded_at IS NOT NULL AS has_recorded_at FROM verification_revisions WHERE id = $1', [first])).rows).toEqual([
        { is_voided: false, has_recorded_at: true },
      ]);
      await insertRevision(client, { revision_number: 2, result: 'NOT_FOUND', condition: null });
    });
  });

  it('numbers the revisions of a scope entry once each', async () => {
    await withClient(async (client) => {
      await expect(insertRevision(client, { revision_number: 2 })).rejects.toThrow(/verification_revisions_entry_revision_number/);
      await insertRevision(client, { revision_number: 3 });
      // A revision keeps its scope entry: the entry cannot be deleted under it.
      await expect(client.query('DELETE FROM verification_scope_entries WHERE id = $1', [ids.entry])).rejects.toThrow(/verification_revisions/);
    });
  });

  it('keeps the Loan context and the Repair context whole or not at all, each naming its fact', async () => {
    await withClient(async (client) => {
      const loan = { loan_context: 'ON_LOAN', loan_item_id: ids.item, loan_borrower_display: 'คุณผู้ยืม', loan_due_date: '2026-11-30' };
      const repair = { repair_record_id: ids.record, repair_kind: 'REPAIR' };
      let number = 10;

      await expect(insertRevision(client, { revision_number: number++, ...loan, loan_context: 'RETURNED' })).rejects.toThrow(/loan_context/);
      await expect(insertRevision(client, { revision_number: number++, ...loan, loan_item_id: null })).rejects.toThrow(/verification_revisions_loan_context_whole/);
      await expect(insertRevision(client, { revision_number: number++, ...loan, loan_due_date: null })).rejects.toThrow(/verification_revisions_loan_context_whole/);
      await expect(insertRevision(client, { revision_number: number++, ...loan, loan_borrower_display: null })).rejects.toThrow(/verification_revisions_loan_context_whole/);
      await expect(insertRevision(client, { revision_number: number++, ...loan, loan_item_id: crypto.randomUUID() })).rejects.toThrow(/loan_item_id/);
      await expect(insertRevision(client, { revision_number: number++, ...repair, repair_kind: null })).rejects.toThrow(/verification_revisions_repair_context_whole/);
      await expect(insertRevision(client, { revision_number: number++, ...repair, repair_kind: 'CLEANING' })).rejects.toThrow(/repair_kind/);
      await expect(insertRevision(client, { revision_number: number++, ...repair, repair_record_id: crypto.randomUUID() })).rejects.toThrow(/repair_record_id/);

      await insertRevision(client, { revision_number: number++, ...loan });
      await insertRevision(client, { revision_number: number++, ...loan, loan_context: 'NOT_RETURNED', ...repair });
      // A revision keeps the facts its context names: neither can be deleted under it.
      await expect(client.query('DELETE FROM loan_items WHERE id = $1', [ids.item])).rejects.toThrow(/verification_revisions/);
      await expect(client.query('DELETE FROM repair_records WHERE id = $1', [ids.record])).rejects.toThrow(/verification_revisions/);
    });
  });

  it('refuses a rollback while a Verification Revision or a retry receipt of a result exists, and rolls back cleanly once neither does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      await client.query('DELETE FROM verification_revisions');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t2-verification-receipt', $1, 'verification:record', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't2-verification-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0018_verification_revisions', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM verification_scope_entries')).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0018_verification_revisions');
  });
});
