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

// F005-T6 (#104): 0016_repair_corrections against a populated 0015 database (Seam C).
describe('Repair Correction Migration Integration (Seam C - F005-T6)', () => {
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

  // A correction record of the Repair Record, an amendment of its remark, unless `fields` says otherwise.
  const insertCorrection = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = {
      repair_record_id: ids.record,
      action: 'AMENDED',
      reason: 'บันทึกผิด',
      changes: JSON.stringify([{ field: 'remark', before: null, after: 'ส่งร้านหน้าสำนักงาน' }]),
      recorded_by: ids.user,
      ...fields,
    };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO repair_corrections (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the correction records to a populated database, and leaves its Repair Records alone', async () => {
    for (let step = 1; step <= 15; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t6_repair_user', 'hash') RETURNING id`)).rows[0].id;
        const asset = await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user]);
        ids.record = (
          await client.query(
            `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, symptom_or_work, has_outcome, recorded_by)
             VALUES ($1, 'REPAIR', '2026-11-05', 'INTERNAL', 'กระดาษติด', true, $2) RETURNING id`,
            [asset.rows[0].id, ids.user]
          )
        ).rows[0].id;
        ids.outcome = (
          await client.query(
            `INSERT INTO repair_outcomes (repair_record_id, outcome, outcome_date, recorded_by) VALUES ($1, 'USABLE', '2026-11-06', $2) RETURNING id`,
            [ids.record, ids.user]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0016_repair_corrections');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM repair_corrections')).rows[0].n).toBe(0);
      expect((await client.query('SELECT has_outcome, is_voided, version FROM repair_records WHERE id = $1', [ids.record])).rows).toEqual([
        { has_outcome: true, is_voided: false, version: 1 },
      ]);
    });
  });

  it('keeps exactly one target, a nonblank reason, and the changes an amendment made', async () => {
    await withClient(async (client) => {
      // Exactly one of the two targets.
      await expect(insertCorrection(client, { repair_record_id: null })).rejects.toThrow(/repair_corrections_one_target/);
      await expect(insertCorrection(client, { repair_outcome_id: ids.outcome })).rejects.toThrow(/repair_corrections_one_target/);
      // Real targets and recorders.
      await expect(insertCorrection(client, { repair_record_id: crypto.randomUUID() })).rejects.toThrow(/repair_record_id/);
      await expect(insertCorrection(client, { repair_record_id: null, repair_outcome_id: crypto.randomUUID() })).rejects.toThrow(/repair_outcome_id/);
      await expect(insertCorrection(client, { recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      // An action of the two, and a nonblank reason.
      await expect(insertCorrection(client, { action: 'DELETED' })).rejects.toThrow(/action/);
      await expect(insertCorrection(client, { reason: '  ' })).rejects.toThrow(/reason/);
      await expect(insertCorrection(client, { reason: null })).rejects.toThrow(/reason/);
      // An amendment lists what it changed, and a void changes no field.
      await expect(insertCorrection(client, { changes: '[]' })).rejects.toThrow(/repair_corrections_amendment_lists_changes/);
      await expect(insertCorrection(client, { changes: '{}' })).rejects.toThrow(/repair_corrections_amendment_lists_changes/);
      await expect(insertCorrection(client, { action: 'VOIDED' })).rejects.toThrow(/repair_corrections_amendment_lists_changes/);

      await insertCorrection(client);
      await insertCorrection(client, { repair_record_id: null, repair_outcome_id: ids.outcome, changes: JSON.stringify([{ field: 'outcome', before: 'USABLE', after: 'NOT_USABLE' }]) });
      for (const fields of [
        { repair_record_id: ids.record, action: 'VOIDED', changes: '[]' },
        { repair_record_id: null, repair_outcome_id: ids.outcome, action: 'VOIDED', changes: '[]' },
      ]) {
        await insertCorrection(client, fields);
        // A fact is voided at most once.
        await expect(insertCorrection(client, fields)).rejects.toThrow(/repair_corrections_one_void/);
      }
      // A correction keeps its fact: neither can be deleted under it.
      await expect(client.query('DELETE FROM repair_outcomes WHERE id = $1', [ids.outcome])).rejects.toThrow(/repair_corrections/);
    });
  });

  it('refuses a rollback while a correction record or its receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM repair_corrections')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM repair_corrections');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t6-repair-receipt', $1, $2, 'fingerprint', 201, '{}')`,
        [ids.user, `repair:correct:${ids.record}`]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't6-repair-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0016_repair_corrections', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM repair_outcomes WHERE id = $1', [ids.outcome])).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0016_repair_corrections');
  });
});
