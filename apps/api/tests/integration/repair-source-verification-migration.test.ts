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

// F006-T7 (#132): 0021_repair_source_verification_revisions against a populated 0020 database (Seam C).
describe('Repair Source Verification Revision Migration Integration (Seam C - F006-T7)', () => {
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

  // A Repair Record of `ids.asset`, citing what `sources` names.
  const insertRepairRecord = (client: pg.Client, sources: { loanReturnId?: string; revisionId?: string } = {}) =>
    client.query(
      `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, symptom_or_work, recorded_by,
                                   repair_source_loan_return_id, repair_source_verification_revision_id)
       VALUES ($1, 'REPAIR', '2026-11-13', 'INTERNAL', 'จอแตก', $2, $3, $4) RETURNING id`,
      [ids.asset, ids.user, sources.loanReturnId ?? null, sources.revisionId ?? null]
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

  it('lets a Repair Record cite a Verification Revision, with none cited on the Repair Records already there', async () => {
    for (let step = 1; step <= 20; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t7_verification_user', 'hash') RETURNING id`)).rows[0].id;
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
        ids.revision = (
          await client.query(
            `INSERT INTO verification_revisions (verification_scope_entry_id, revision_number, result, condition, verification_date, recorded_by)
             VALUES ($1, 1, 'FOUND', 'DAMAGED', '2026-11-12', $2) RETURNING id`,
            [ids.entry, ids.user]
          )
        ).rows[0].id;
        ids.loan = (
          await client.query(
            `INSERT INTO loans (borrower_kind, borrower_contact_name, loan_date, recorded_by) VALUES ('EXTERNAL', 'คุณผู้ยืม', '2026-11-01', $1) RETURNING id`,
            [ids.user]
          )
        ).rows[0].id;
        ids.item = (await client.query(`INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition) VALUES ($1, $2, '2026-11-10', 'NORMAL') RETURNING id`, [ids.loan, ids.asset])).rows[0].id;
        ids.loanReturn = (
          await client.query(
            `INSERT INTO loan_item_endings (loan_item_id, kind, ending_date, condition, action_reference, recorded_by)
             VALUES ($1, 'LOAN_RETURN', '2026-11-04', 'DAMAGED', gen_random_uuid(), $2) RETURNING id`,
            [ids.item, ids.user]
          )
        ).rows[0].id;
        ids.existing = (
          await client.query(
            `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, symptom_or_work, recorded_by, repair_source_loan_return_id, has_outcome)
             VALUES ($1, 'REPAIR', '2026-11-05', 'INTERNAL', 'จอไม่ติด', $2, $3, true) RETURNING id`,
            [ids.asset, ids.user, ids.loanReturn]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0021_repair_source_verification_revisions');

    await withClient(async (client) => {
      expect((await client.query('SELECT repair_source_loan_return_id, repair_source_verification_revision_id FROM repair_records WHERE id = $1', [ids.existing])).rows).toEqual([
        { repair_source_loan_return_id: ids.loanReturn, repair_source_verification_revision_id: null },
      ]);
    });
  });

  it('keeps at most one Repair Source per record, and a cited revision that exists', async () => {
    await withClient(async (client) => {
      await client.query('UPDATE repair_records SET is_voided = true WHERE id = $1', [ids.existing]);
      ids.cited = (await insertRepairRecord(client, { revisionId: ids.revision })).rows[0].id;
      await client.query('UPDATE repair_records SET has_outcome = true WHERE id = $1', [ids.cited]);

      await expect(insertRepairRecord(client, { loanReturnId: ids.loanReturn, revisionId: ids.revision })).rejects.toThrow(/repair_records_one_repair_source/);
      await expect(insertRepairRecord(client, { revisionId: crypto.randomUUID() })).rejects.toThrow(/repair_source_verification_revision_id/);
      // A Repair Record keeps the revision it cites: the revision cannot be deleted under it.
      await expect(client.query('DELETE FROM verification_revisions WHERE id = $1', [ids.revision])).rejects.toThrow(/repair_records/);
    });
  });

  it('refuses a rollback while a Repair Record cites a Verification Revision, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');

    await withClient(async (client) => {
      await client.query('DELETE FROM repair_records WHERE id = $1', [ids.cited]);
    });
    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0021_repair_source_verification_revisions', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT repair_source_loan_return_id FROM repair_records WHERE id = $1', [ids.existing])).rows).toEqual([
        { repair_source_loan_return_id: ids.loanReturn },
      ]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0021_repair_source_verification_revisions');
  });
});
