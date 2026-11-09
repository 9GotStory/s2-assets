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

const FEATURE_002_COLUMNS = [
  'location_id',
  'organization_unit_id',
  'responsible_person_id',
  'legacy_location_text',
  'legacy_organization_unit_text',
  'legacy_responsible_person_text',
];

// F003-T1 (#51): 0006_initial_assignment against a populated 0005 database (Seam C).
describe('Initial Assignment Migration Integration (Seam C - F003-T1)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  const ids: Record<string, string> = {};

  const connect = async <T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  };
  const withClient = <T>(run: (client: pg.Client) => Promise<T>) => connect(databaseUrl, run);

  const snapshot = (client: pg.Client, table: string, order: string) =>
    client.query(`SELECT * FROM ${table} ORDER BY ${order}`).then((res) => res.rows);

  // Tables, columns, constraints and indexes of the public schema, for comparing two databases.
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
  }, 90_000);

  afterAll(async () => {
    if (container) {
      await container.stop().catch(() => {});
    }
  }, 30_000);

  it("carries each Asset's Feature 002 values over into one Initial Assignment with an unknown Effective Date and drops the columns", async () => {
    for (let step = 1; step <= 5; step++) {
      const result = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
      expect(result.error).toBeUndefined();
    }

    const before = await withClient(async (client) => {
      const user = async (username: string) =>
        (await client.query(`INSERT INTO users (username, password_hash) VALUES ($1, 'hash') RETURNING id`, [username])).rows[0]
          .id;
      ids.registrar = await user('f002_registrar');
      ids.corrector = await user('f002_corrector');
      const add = async (table: string, name: string) =>
        (
          await client.query(`INSERT INTO ${table} (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [
            name,
            ids.registrar,
          ])
        ).rows[0].id;
      ids.room101 = await add('locations', 'ห้อง 101');
      ids.room202 = await add('locations', 'ห้อง 202');
      ids.finance = await add('organization_units', 'กองคลัง');
      ids.somchai = await add('persons', 'นายสมชาย');

      const asset = async (name: string, recordedAt: string, columns: Record<string, string | null>) => {
        const names = Object.keys(columns);
        const res = await client.query(
          `INSERT INTO assets (name, registered_by, recorded_at${names.map((c) => `, ${c}`).join('')})
           VALUES ($1, $2, $3${names.map((_, i) => `, $${i + 4}`).join('')}) RETURNING id`,
          [name, ids.registrar, recordedAt, ...Object.values(columns)]
        );
        return res.rows[0].id;
      };
      const fact = (assetId: string, action: string, actorId: string, recordedAt: string, payload: unknown) =>
        client.query(
          `INSERT INTO asset_history (asset_id, action, actor_id, recorded_at, payload) VALUES ($1, $2, $3, $4, $5)`,
          [assetId, action, actorId, recordedAt, JSON.stringify(payload)]
        );
      const registeredPayload = (name: string, context: Record<string, string | null>) => ({
        is_legacy: false,
        name,
        asset_number: null,
        serial_number: null,
        source_reference: null,
        source_notes: null,
        location_id: null,
        organization_unit_id: null,
        responsible_person_id: null,
        legacy_location_text: null,
        legacy_organization_unit_text: null,
        legacy_responsible_person_text: null,
        ...context,
      });

      // Registered in Room 101, then corrected into Room 202 and the finance unit, then renamed.
      ids.moved = await asset('เครื่องพิมพ์ย้ายห้อง', '2026-10-01T03:00:00Z', {
        location_id: ids.room202,
        organization_unit_id: ids.finance,
        legacy_responsible_person_text: 'คุณเดิม (ทะเบียนเดิม)',
      });
      await fact(ids.moved, 'REGISTERED', ids.registrar, '2026-10-01T03:00:00Z', registeredPayload('เครื่องพิมพ์ย้ายห้อง', {
        location_id: ids.room101,
        legacy_responsible_person_text: 'คุณเดิม (ทะเบียนเดิม)',
      }));
      await fact(ids.moved, 'CORRECTED', ids.corrector, '2026-10-10T03:00:00Z', {
        reason: 'ย้ายบันทึกให้ตรงห้องจริง',
        changes: {
          location_id: { before: ids.room101, after: ids.room202 },
          organization_unit_id: { before: null, after: ids.finance },
        },
      });
      await fact(ids.moved, 'CORRECTED', ids.registrar, '2026-10-20T03:00:00Z', {
        reason: 'ชื่อตามป้าย',
        changes: { name: { before: 'เครื่องพิมพ์', after: 'เครื่องพิมพ์ย้ายห้อง' } },
      });

      // An entry and Legacy text of the same dimension. A later correction cleared a value, which left
      // the values as they are carried over, so its recorder and time are the Initial Assignment's.
      ids.cleared = await asset('ตู้เก็บเอกสาร', '2026-10-05T03:00:00Z', {
        location_id: ids.room101,
        legacy_location_text: 'ห้องเก่า (ทะเบียนเดิม)',
      });
      await fact(ids.cleared, 'REGISTERED', ids.corrector, '2026-10-05T03:00:00Z', registeredPayload('ตู้เก็บเอกสาร', {
        location_id: ids.room101,
        responsible_person_id: ids.somchai,
        legacy_location_text: 'ห้องเก่า (ทะเบียนเดิม)',
      }));
      await fact(ids.cleared, 'CORRECTED', ids.registrar, '2026-10-15T03:00:00Z', {
        reason: 'ไม่มีผู้รับผิดชอบแล้ว',
        changes: { responsible_person_id: { before: ids.somchai, after: null } },
      });

      // Placeholder text written outside the API, with no fact that set it.
      ids.placeholder = await asset('โต๊ะทำงาน', '2026-09-01T03:00:00Z', {
        legacy_organization_unit_text: 'กองพัสดุ (ข้อความเดิม)',
      });
      await fact(ids.placeholder, 'REGISTERED', ids.registrar, '2026-09-01T03:00:00Z', { initial: true });

      // No value, and blank text, which is no value.
      ids.none = await asset('เก้าอี้ส่วนกลาง', '2026-09-02T03:00:00Z', {});
      ids.blank = await asset('ชั้นวางของ', '2026-09-03T03:00:00Z', { legacy_location_text: '   ' });

      return {
        asset_history: await snapshot(client, 'asset_history', 'id'),
        locations: await snapshot(client, 'locations', 'id'),
        organization_units: await snapshot(client, 'organization_units', 'id'),
        persons: await snapshot(client, 'persons', 'id'),
        reference_entry_history: await snapshot(client, 'reference_entry_history', 'id'),
      };
    });

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0006_initial_assignment');

    await withClient(async (client) => {
      const events = await client.query(
        `SELECT asset_id, kind, effective_date, recorded_by, recorded_at, provenance, document_reference, remark
         FROM assignment_events ORDER BY recorded_at`
      );
      expect(events.rows).toEqual([
        {
          asset_id: ids.placeholder,
          kind: 'INITIAL',
          effective_date: null,
          recorded_by: ids.registrar,
          recorded_at: new Date('2026-09-01T03:00:00Z'),
          provenance: 'CARRIED_OVER_F002',
          document_reference: null,
          remark: null,
        },
        {
          asset_id: ids.moved,
          kind: 'INITIAL',
          effective_date: null,
          recorded_by: ids.corrector,
          recorded_at: new Date('2026-10-10T03:00:00Z'),
          provenance: 'CARRIED_OVER_F002',
          document_reference: null,
          remark: null,
        },
        {
          asset_id: ids.cleared,
          kind: 'INITIAL',
          effective_date: null,
          recorded_by: ids.registrar,
          recorded_at: new Date('2026-10-15T03:00:00Z'),
          provenance: 'CARRIED_OVER_F002',
          document_reference: null,
          remark: null,
        },
      ]);

      const changes = await client.query(
        `SELECT e.asset_id, c.event_kind, c.dimension, c.new_location_id, c.new_organization_unit_id, c.new_person_id,
                c.new_legacy_text, num_nonnulls(c.prior_location_id, c.prior_organization_unit_id, c.prior_person_id,
                c.prior_legacy_text) AS prior_values
         FROM assignment_changes c JOIN assignment_events e ON e.id = c.event_id
         ORDER BY e.recorded_at, c.dimension`
      );
      const change = (assetId: string, dimension: string, values: Record<string, string>) => ({
        asset_id: assetId,
        event_kind: 'INITIAL',
        dimension,
        new_location_id: null,
        new_organization_unit_id: null,
        new_person_id: null,
        new_legacy_text: null,
        prior_values: 0,
        ...values,
      });
      expect(changes.rows).toEqual([
        change(ids.placeholder, 'ORGANIZATION_UNIT', { new_legacy_text: 'กองพัสดุ (ข้อความเดิม)' }),
        change(ids.moved, 'LOCATION', { new_location_id: ids.room202 }),
        change(ids.moved, 'ORGANIZATION_UNIT', { new_organization_unit_id: ids.finance }),
        change(ids.moved, 'RESPONSIBLE_PERSON', { new_legacy_text: 'คุณเดิม (ทะเบียนเดิม)' }),
        change(ids.cleared, 'LOCATION', { new_location_id: ids.room101, new_legacy_text: 'ห้องเก่า (ทะเบียนเดิม)' }),
      ]);

      const versions = await client.query(`SELECT id, assignment_version FROM assets`);
      expect(Object.fromEntries(versions.rows.map((row) => [row.id, row.assignment_version]))).toEqual({
        [ids.moved]: 1,
        [ids.cleared]: 1,
        [ids.placeholder]: 1,
        [ids.none]: 0,
        [ids.blank]: 0,
      });

      // One truth remains: the Feature 002 columns are gone.
      const columns = (
        await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assets'`)
      ).rows.map((row) => row.column_name);
      for (const column of FEATURE_002_COLUMNS) {
        expect(columns, column).not.toContain(column);
      }

      // Feature 002's facts and the Reference Lists stay as recorded.
      for (const [table, rows] of Object.entries(before)) {
        expect(await snapshot(client, table, 'id'), table).toEqual(rows);
      }
    });
  });

  it('keeps the assignment facts consistent through database constraints', async () => {
    await withClient(async (client) => {
      const initialOf = async (assetId: string) =>
        (await client.query(`SELECT id FROM assignment_events WHERE asset_id = $1`, [assetId])).rows[0].id;
      const event = (assetId: string, kind: string, effectiveDate: string | null, provenance = 'RECORDED') =>
        client.query(
          `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [assetId, kind, effectiveDate, ids.registrar, provenance]
        );

      // At most one Initial Assignment per Asset; an unknown Effective Date only on one.
      await expect(event(ids.moved, 'INITIAL', '2026-11-01')).rejects.toThrow(/assignment_events_one_initial/);
      await expect(event(ids.moved, 'REASSIGNMENT', null)).rejects.toThrow(/assignment_events_date_unknown_only_initial/);
      await expect(event(ids.moved, 'REASSIGNMENT', '2026-11-01', 'CARRIED_OVER_F002')).rejects.toThrow(
        /assignment_events_carried_over_only_initial/
      );
      await expect(event(ids.moved, 'MOVED', '2026-11-01')).rejects.toThrow(/assignment_events_kind_check/);
      const reassignment = (await event(ids.moved, 'REASSIGNMENT', '2026-11-01')).rows[0].id;

      const change = (eventId: string, kind: string, dimension: string, values: Record<string, string>) => {
        const names = Object.keys(values);
        return client.query(
          `INSERT INTO assignment_changes (event_id, event_kind, dimension${names.map((n) => `, ${n}`).join('')})
           VALUES ($1, $2, $3${names.map((_, i) => `, $${i + 4}`).join('')})`,
          [eventId, kind, dimension, ...Object.values(values)]
        );
      };
      // One change per dimension of an event, each entry in its own dimension's list.
      await expect(change(await initialOf(ids.moved), 'INITIAL', 'LOCATION', { new_location_id: ids.room101 })).rejects.toThrow(
        /assignment_changes_one_per_dimension/
      );
      await expect(change(reassignment, 'REASSIGNMENT', 'LOCATION', { new_organization_unit_id: ids.finance })).rejects.toThrow(
        /assignment_changes_own_list/
      );
      await expect(change(reassignment, 'REASSIGNMENT', 'RESPONSIBLE_PERSON', { new_person_id: ids.room101 })).rejects.toThrow(
        /assignment_changes_new_person_id_fkey/
      );
      // An Initial Assignment has no prior value, and each of its changes sets a value.
      const placeholderInitial = await initialOf(ids.placeholder);
      await expect(
        change(placeholderInitial, 'INITIAL', 'LOCATION', { prior_location_id: ids.room101, new_location_id: ids.room202 })
      ).rejects.toThrow(/assignment_changes_initial_no_prior/);
      await expect(change(placeholderInitial, 'INITIAL', 'LOCATION', {})).rejects.toThrow(
        /assignment_changes_initial_sets_value/
      );
      // New Legacy text only on an Initial Assignment; a change names its event's real kind.
      await expect(change(reassignment, 'REASSIGNMENT', 'LOCATION', { new_legacy_text: 'ห้องใหม่' })).rejects.toThrow(
        /assignment_changes_legacy_text_only_initial/
      );
      await expect(change(reassignment, 'INITIAL', 'LOCATION', { new_legacy_text: 'ห้องใหม่' })).rejects.toThrow(
        /assignment_changes_event/
      );
      await change(reassignment, 'REASSIGNMENT', 'LOCATION', {
        prior_location_id: ids.room202,
        prior_legacy_text: 'ห้องเก่า',
        new_location_id: ids.room101,
      });

      // Nothing that a fact names can be deleted.
      await expect(client.query(`DELETE FROM assets WHERE id = $1`, [ids.moved])).rejects.toThrow(/assignment_events_asset_id_fkey/);
      await expect(client.query(`DELETE FROM locations WHERE id = $1`, [ids.room202])).rejects.toThrow(/assignment_changes/);
      await expect(client.query(`DELETE FROM users WHERE id = $1`, [ids.corrector])).rejects.toThrow(/fkey/);

      await client.query(`DELETE FROM assignment_changes WHERE event_id = $1`, [reassignment]);
      await client.query(`DELETE FROM assignment_events WHERE id = $1`, [reassignment]);
    });
  });

  it('reaches the same schema from a fresh setup as from the upgrade', async () => {
    const freshUrl = await withClient(async (client) => {
      await client.query('CREATE DATABASE fresh_setup');
      const url = new URL(databaseUrl);
      url.pathname = '/fresh_setup';
      return url.toString();
    });
    let lastApplied: string | undefined;
    for (let step = 1; step <= 6; step++) {
      const fresh = await runMigrator({ command: 'up', databaseUrl: freshUrl, migrationFolder });
      expect(fresh.error).toBeUndefined();
      lastApplied = fresh.results?.[0]?.migrationName;
    }
    expect(lastApplied).toBe('0006_initial_assignment');

    const upgraded = await withClient(schemaOf);
    const freshSchema = await connect(freshUrl, schemaOf);
    expect(freshSchema).toEqual(upgraded);
  });

  it('refuses a destructive rollback while any assignment fact exists, and rolls back cleanly once none does', async () => {
    const refused = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(String(refused.error)).toContain('Refusing destructive rollback');
    await withClient(async (client) => {
      expect((await client.query(`SELECT count(*)::int AS n FROM assignment_events`)).rows[0].n).toBe(3);
    });

    await withClient(async (client) => {
      await client.query(`DELETE FROM assignment_changes`);
      await client.query(`DELETE FROM assignment_events`);
    });
    const rollback = await runMigrator({ command: 'down', databaseUrl, migrationFolder });
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0006_initial_assignment', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      const columns = (
        await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assets'`)
      ).rows.map((row) => row.column_name);
      for (const column of FEATURE_002_COLUMNS) {
        expect(columns, column).toContain(column);
      }
      expect(columns).not.toContain('assignment_version');
      const tables = (
        await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
      ).rows.map((row) => row.table_name);
      expect(tables).not.toContain('assignment_events');
      expect(tables).not.toContain('assignment_changes');
      // The restored columns reach their Reference Lists again.
      await expect(
        client.query(`UPDATE assets SET location_id = '00000000-0000-4000-8000-000000000000' WHERE id = $1`, [ids.none])
      ).rejects.toThrow(/assets_location_id_fkey/);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0006_initial_assignment');
  });
});
