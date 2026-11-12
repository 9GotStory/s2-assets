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

// F006-T1 (#126): 0017_verification_rounds against a populated 0016 database (Seam C).
describe('Verification Round Migration Integration (Seam C - F006-T1)', () => {
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
      client.query('SELECT id, description FROM roles ORDER BY id'),
    ]).then((results) => results.map((res) => res.rows));

  // Inserts one row of `table` from `values` and returns its id.
  const insert = async (client: pg.Client, table: string, values: Record<string, unknown>): Promise<string> => {
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  // A Verification Round, open unless `fields` says otherwise.
  const insertRound = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'verification_rounds', {
      name: 'ตรวจประจำปี 2569',
      fiscal_year: 2569,
      start_date: '2026-11-12',
      opened_by: ids.user,
      ...fields,
    });

  // A scope entry of the Round `ids.round` for the Asset `ids.asset`, joined at opening, unless `fields` says otherwise.
  const insertEntry = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'verification_scope_entries', {
      verification_round_id: ids.round,
      asset_id: ids.asset,
      joined_as: 'OPENING',
      recorded_by: ids.user,
      name: 'เครื่องพิมพ์',
      ...fields,
    });

  // A history event of the Round `ids.round`, its opening, unless `fields` says otherwise.
  const insertEvent = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'verification_round_events', { verification_round_id: ids.round, kind: 'OPENED', recorded_by: ids.user, ...fields });

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

  it('adds the Verification tables and the VERIFICATION_STAFF role to a populated database, and leaves its Assets alone', async () => {
    for (let step = 1; step <= 16; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t1_verification_user', 'hash') RETURNING id`)).rows[0].id;
        ids.asset = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('เครื่องพิมพ์', $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.location = (await client.query(`INSERT INTO locations (name, created_by, updated_by) VALUES ('ห้องประชุม', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.unit = (await client.query(`INSERT INTO organization_units (name, created_by, updated_by) VALUES ('งานพัสดุ', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0017_verification_rounds');

    await withClient(async (client) => {
      expect((await client.query(`SELECT id, description FROM roles WHERE id = 'VERIFICATION_STAFF'`)).rows).toEqual([
        { id: 'VERIFICATION_STAFF', description: 'Verification Staff' },
      ]);
      expect((await client.query('SELECT count(*)::int AS n FROM verification_rounds')).rows[0].n).toBe(0);
      expect((await client.query('SELECT name FROM assets WHERE id = $1', [ids.asset])).rows).toEqual([{ name: 'เครื่องพิมพ์' }]);
    });
  });

  it('keeps a Round named, labelled with a four-digit fiscal year, in one of its three states, and at most one open', async () => {
    await withClient(async (client) => {
      await expect(insertRound(client, { name: '  ' })).rejects.toThrow(/name/);
      await expect(insertRound(client, { name: null })).rejects.toThrow(/name/);
      await expect(insertRound(client, { fiscal_year: 999 })).rejects.toThrow(/fiscal_year/);
      await expect(insertRound(client, { fiscal_year: 10000 })).rejects.toThrow(/fiscal_year/);
      await expect(insertRound(client, { notes: ' ' })).rejects.toThrow(/notes/);
      await expect(insertRound(client, { state: 'PAUSED' })).rejects.toThrow(/state/);
      await expect(insertRound(client, { start_date: null })).rejects.toThrow(/start_date/);
      await expect(insertRound(client, { opened_by: crypto.randomUUID() })).rejects.toThrow(/opened_by/);

      ids.round = await insertRound(client);
      expect((await client.query('SELECT state, version FROM verification_rounds WHERE id = $1', [ids.round])).rows).toEqual([{ state: 'OPEN', version: 1 }]);
      // At most one Round is open; closed and voided ones are many.
      await expect(insertRound(client)).rejects.toThrow(/verification_rounds_one_open/);
      await insertRound(client, { state: 'CLOSED' });
      await insertRound(client, { state: 'CLOSED' });
      await insertRound(client, { state: 'VOIDED' });
    });
  });

  it('keeps each filter as one entry of its list, once per Round', async () => {
    await withClient(async (client) => {
      const filter = (fields: Record<string, unknown>) => insert(client, 'verification_round_filters', { verification_round_id: ids.round, ...fields });

      await expect(filter({})).rejects.toThrow(/verification_round_filters_one_entry/);
      await expect(filter({ location_id: ids.location, organization_unit_id: ids.unit })).rejects.toThrow(/verification_round_filters_one_entry/);
      await expect(filter({ location_id: crypto.randomUUID() })).rejects.toThrow(/location_id/);
      await expect(filter({ organization_unit_id: crypto.randomUUID() })).rejects.toThrow(/organization_unit_id/);

      await filter({ location_id: ids.location });
      await filter({ organization_unit_id: ids.unit });
      await expect(filter({ location_id: ids.location })).rejects.toThrow(/verification_round_filters/);
      await expect(filter({ organization_unit_id: ids.unit })).rejects.toThrow(/verification_round_filters/);
    });
  });

  it('keeps one scope entry per Round and Asset, and how it joined: a Late Addition with its reason, an opening entry with none', async () => {
    await withClient(async (client) => {
      await expect(insertEntry(client, { joined_as: 'IMPORTED' })).rejects.toThrow(/joined_as/);
      await expect(insertEntry(client, { reason: 'พบภายหลัง' })).rejects.toThrow(/verification_scope_entries_late_addition_reason/);
      await expect(insertEntry(client, { joined_as: 'LATE_ADDITION' })).rejects.toThrow(/verification_scope_entries_late_addition_reason/);
      await expect(insertEntry(client, { joined_as: 'LATE_ADDITION', reason: ' ' })).rejects.toThrow(/reason/);
      await expect(insertEntry(client, { asset_id: crypto.randomUUID() })).rejects.toThrow(/asset_id/);
      await expect(insertEntry(client, { location_id: crypto.randomUUID() })).rejects.toThrow(/location_id/);

      await insertEntry(client, { location_id: ids.location, legacy_organization_unit_text: 'กองคลัง (เดิม)' });
      await expect(insertEntry(client)).rejects.toThrow(/verification_scope_entries_verification_round_id_asset_id/);
      await expect(insertEntry(client, { joined_as: 'LATE_ADDITION', reason: 'พบภายหลัง' })).rejects.toThrow(/verification_scope_entries_verification_round_id_asset_id/);

      const other = (await client.query(`INSERT INTO assets (name, registered_by) VALUES ('จอภาพ', $1) RETURNING id`, [ids.user])).rows[0].id;
      await insertEntry(client, { asset_id: other, joined_as: 'LATE_ADDITION', reason: 'ลงทะเบียนหลังเปิดรอบ' });
      // A snapshot keeps its Asset and its Round: neither can be deleted under it.
      await expect(client.query('DELETE FROM assets WHERE id = $1', [other])).rejects.toThrow(/verification_scope_entries/);
    });
  });

  it('keeps every kind of Round event: a reopen and a void with a reason, an edit with its changes, and a close with its counts', async () => {
    await withClient(async (client) => {
      const counts = { found_count: 3, not_found_count: 1, not_yet_verified_count: 2, discrepancy_count: 1 };

      await expect(insertEvent(client, { kind: 'PAUSED' })).rejects.toThrow(/kind/);
      await expect(insertEvent(client, { kind: 'REOPENED' })).rejects.toThrow(/verification_round_events_reason_required/);
      await expect(insertEvent(client, { kind: 'VOIDED' })).rejects.toThrow(/verification_round_events_reason_required/);
      await expect(insertEvent(client, { kind: 'VOIDED', reason: '  ' })).rejects.toThrow(/reason/);
      await expect(insertEvent(client, { kind: 'EDITED' })).rejects.toThrow(/verification_round_events_edit_lists_changes/);
      await expect(insertEvent(client, { kind: 'EDITED', changes: '{}' })).rejects.toThrow(/verification_round_events_edit_lists_changes/);
      await expect(insertEvent(client, { changes: JSON.stringify([{ field: 'name', before: 'ก', after: 'ข' }]) })).rejects.toThrow(
        /verification_round_events_edit_lists_changes/
      );
      await expect(insertEvent(client, { kind: 'CLOSED' })).rejects.toThrow(/verification_round_events_close_counts/);
      await expect(insertEvent(client, { kind: 'CLOSED', ...counts, discrepancy_count: null })).rejects.toThrow(/verification_round_events_close_counts/);
      await expect(insertEvent(client, counts)).rejects.toThrow(/verification_round_events_close_counts/);
      await expect(insertEvent(client, { kind: 'CLOSED', ...counts, found_count: -1 })).rejects.toThrow(/found_count/);

      await insertEvent(client);
      await insertEvent(client, { kind: 'EDITED', changes: JSON.stringify([{ field: 'name', before: 'ตรวจปี 69', after: 'ตรวจประจำปี 2569' }]) });
      await insertEvent(client, { kind: 'CLOSED', ...counts });
      await insertEvent(client, { kind: 'REOPENED', reason: 'บันทึกผลผิด' });
      await insertEvent(client, { kind: 'VOIDED', reason: 'เปิดรอบผิดตัวกรอง' });
      expect((await client.query('SELECT changes FROM verification_round_events WHERE kind = $1', ['OPENED'])).rows).toEqual([{ changes: [] }]);
    });
  });

  it('refuses a rollback while a Round, a Verification retry receipt or a user holding VERIFICATION_STAFF exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM verification_rounds')).rows[0].n).toBeGreaterThan(0);
      await client.query('DELETE FROM verification_round_events');
      await client.query('DELETE FROM verification_scope_entries');
      await client.query('DELETE FROM verification_round_filters');
      await client.query('DELETE FROM verification_rounds');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t1-verification-receipt', $1, 'verification:open', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      await client.query(`DELETE FROM registration_retry_tokens WHERE token = 't1-verification-receipt'`);
      await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'VERIFICATION_STAFF')`, [ids.user]);
    });

    expect(String((await down()).error)).toContain('Refusing destructive rollback');
    await withClient((client) => client.query(`DELETE FROM user_roles WHERE role_id = 'VERIFICATION_STAFF'`));

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0017_verification_rounds', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT count(*)::int AS n FROM assets')).rows[0].n).toBe(2);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0017_verification_rounds');
  });
});
