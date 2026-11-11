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

// F005-T2 (#100): 0014_repair_outcomes against a populated 0013 database (Seam C).
describe('Repair Outcome Migration Integration (Seam C - F005-T2)', () => {
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

  // A Repair Outcome of the Repair Record, ใช้งานได้ on its Start Date, unless `fields` says otherwise.
  const insertOutcome = async (client: pg.Client, fields: Record<string, unknown> = {}): Promise<string> => {
    const values = { repair_record_id: ids.record, outcome: 'USABLE', outcome_date: '2026-11-05', recorded_by: ids.user, ...fields };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO repair_outcomes (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
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

  it('adds the Repair Outcomes to a populated database, and leaves its Repair Records alone', async () => {
    for (let step = 1; step <= 13; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t2_repair_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.record = (
          await client.query(
            `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, symptom_or_work, cost, recorded_by)
             VALUES ($1, 'REPAIR', '2026-11-05', 'INTERNAL', 'เปิดไม่ติด', 1200.00, $2) RETURNING id`,
            [ids.asset, ids.user]
          )
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0014_repair_outcomes');

    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM repair_outcomes')).rows[0].n).toBe(0);
      expect((await client.query('SELECT cost::text, has_outcome, version FROM repair_records WHERE id = $1', [ids.record])).rows).toEqual([
        { cost: '1200.00', has_outcome: false, version: 1 },
      ]);
    });
  });

  it('keeps an outcome to usable or not usable, its text nonblank, and a Next Recommended Maintenance Date after its Outcome Date', async () => {
    await withClient(async (client) => {
      const id = await insertOutcome(client, { cost_before: '1200.00' });
      expect((await client.query('SELECT cost_before::text, is_voided FROM repair_outcomes WHERE id = $1', [id])).rows).toEqual([
        { cost_before: '1200.00', is_voided: false },
      ]);
      await client.query('UPDATE repair_outcomes SET is_voided = true WHERE id = $1', [id]);

      await expect(insertOutcome(client, { outcome: 'RETIRED' })).rejects.toThrow(/outcome/);
      await expect(insertOutcome(client, { outcome: null })).rejects.toThrow(/outcome/);
      await expect(insertOutcome(client, { outcome_date: null })).rejects.toThrow(/outcome_date/);
      await expect(insertOutcome(client, { note: ' ' })).rejects.toThrow(/note/);
      await expect(insertOutcome(client, { document_reference: '' })).rejects.toThrow(/document_reference/);
      await expect(insertOutcome(client, { cost_before: '-0.01' })).rejects.toThrow(/cost_before/);
      await expect(insertOutcome(client, { next_recommended_maintenance_date: '2026-11-05' })).rejects.toThrow(/next_recommended_maintenance_date/);
      await expect(insertOutcome(client, { repair_record_id: ids.asset })).rejects.toThrow(/repair_record_id/);
      await expect(insertOutcome(client, { recorded_by: ids.asset })).rejects.toThrow(/recorded_by/);
      await insertOutcome(client, { outcome: 'NOT_USABLE', next_recommended_maintenance_date: '2026-11-06', is_voided: true });
    });
  });

  it('allows at most one non-voided Repair Outcome per Repair Record', async () => {
    await withClient(async (client) => {
      const kept = await insertOutcome(client);

      await expect(insertOutcome(client, { outcome: 'NOT_USABLE' })).rejects.toThrow(/repair_outcomes_one_per_record/);
      // A voided one does not count.
      await insertOutcome(client, { is_voided: true });

      await client.query('UPDATE repair_outcomes SET is_voided = true WHERE id = $1', [kept]);
      await insertOutcome(client);
    });
  });

  it('refuses a rollback while a Repair Outcome or its retry receipt exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM repair_outcomes')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM repair_outcomes');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t2-repair-receipt', $1, $2, 'fingerprint', 201, '{}')`,
        [ids.user, `repair:outcome:${ids.record}`]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM registration_retry_tokens WHERE token = 't2-repair-receipt'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0014_repair_outcomes', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM repair_records')).rows[0].n).toBe(1);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0014_repair_outcomes');
  });
});
