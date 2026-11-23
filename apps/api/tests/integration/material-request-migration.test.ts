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

// F009-T4 (#206): 0031_material_requests against a populated 0030 database (Seam C): the Requester role, the Request
// Number sequence, the Material Request with its version, its Requested Items with the Cancel columns T5 uses, and its
// history (#202 Q1, Q10, Q13, Q14, Q26, P3, P4, P7, P8).
describe('Material Request Migration Integration (Seam C - F009-T4)', () => {
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
      client.query(`SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
                    FROM information_schema.columns WHERE table_schema = 'public'
                    ORDER BY table_name, column_name`),
      client.query(`SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
                    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                    ORDER BY 1, 2`),
      client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
                    ORDER BY tablename, indexname`),
      client.query(`SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' ORDER BY sequence_name`),
      client.query('SELECT id, description FROM roles ORDER BY id'),
    ]).then((results) => results.map((res) => res.rows));

  // A Material Request of the user `ids`, with `fields` over the defaults; its id and Request Number.
  const materialRequest = async (client: pg.Client, fields: Record<string, unknown> = {}) => {
    const values = { requested_by: ids.user, ...fields };
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO material_requests (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, request_number`,
      Object.values(values)
    );
    return res.rows[0] as { id: string; request_number: string };
  };

  // A Requested Item of the Material Request `ids.request` asking for the Requestable Material `ids.requestable`, with
  // `fields` over the defaults.
  const requestedItem = (client: pg.Client, fields: Record<string, unknown> = {}) => {
    const values = {
      material_request_id: ids.request,
      position: 0,
      requestable_material_id: ids.requestable,
      requested_quantity: '2',
      request_unit_id: ids.unit,
      ...fields,
    };
    const columns = Object.keys(values);
    return client.query(
      `INSERT INTO requested_items (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values)
    );
  };

  // A history entry of the Material Request `ids.request`, with `fields` over the defaults.
  const historyEntry = (client: pg.Client, fields: Record<string, unknown> = {}) => {
    const values = { material_request_id: ids.request, version: 1, kind: 'CREATED', recorded_by: ids.user, ...fields };
    const columns = Object.keys(values);
    return client.query(`INSERT INTO material_request_history (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values));
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

  it('adds the Requester role and the empty Material Requests to a populated database, leaving its Requestable Materials as they were', async () => {
    for (let step = 1; step <= 30; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t4_request_user', 'hash') RETURNING id`)).rows[0].id;
        ids.unit = (await client.query(`INSERT INTO units (name, created_by, updated_by) VALUES ('รีม', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.requestable = (
          await client.query(`INSERT INTO requestable_materials (name, request_unit_id, created_by) VALUES ('กระดาษ A4', $1, $2) RETURNING id`, [ids.unit, ids.user])
        ).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0031_material_requests');

    await withClient(async (client) => {
      expect((await client.query(`SELECT id, description FROM roles WHERE id = 'REQUESTER'`)).rows).toEqual([{ id: 'REQUESTER', description: 'Requester' }]);
      for (const table of ['material_requests', 'requested_items', 'material_request_history']) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      expect((await client.query('SELECT name, version FROM requestable_materials')).rows).toEqual([{ name: 'กระดาษ A4', version: 1 }]);
    });
  });

  it('numbers each Material Request from a sequence, unique, at version 1 and Recorded At now, with a note of at most 2000 characters that is not blank', async () => {
    await withClient(async (client) => {
      const first = await materialRequest(client);
      const second = await materialRequest(client);
      expect(BigInt(second.request_number)).toBeGreaterThan(BigInt(first.request_number));
      expect((await client.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'material_requests' AND column_name = 'request_number'`)).rows).toEqual([
        { data_type: 'bigint' },
      ]);
      expect((await client.query('SELECT version, recorded_at <= now() AS recorded_now, note FROM material_requests WHERE id = $1', [first.id])).rows).toEqual([
        { version: 1, recorded_now: true, note: null },
      ]);
      ids.request = first.id;
      ids.secondRequest = second.id;

      await expect(materialRequest(client, { request_number: first.request_number })).rejects.toThrow(/material_requests_request_number_key/);
      await expect(materialRequest(client, { requested_by: crypto.randomUUID() })).rejects.toThrow(/requested_by/);
      await expect(materialRequest(client, { note: '   ' })).rejects.toThrow(/material_requests_note_check/);
      await expect(materialRequest(client, { note: 'ก'.repeat(2001) })).rejects.toThrow(/character varying\(2000\)/);
      await expect(materialRequest(client, { version: 0 })).rejects.toThrow(/material_requests_version_check/);
      expect((await materialRequest(client, { note: 'ก'.repeat(2000) })).id).toBeTruthy();
      await client.query('DELETE FROM material_requests WHERE note IS NOT NULL');
    });
  });

  it('keeps each Requested Item with its Requestable Material at most once per Material Request, a Requested Quantity above 0 in NUMERIC(18,4), the Request Unit as recorded and a note of at most 500 characters', async () => {
    await withClient(async (client) => {
      ids.item = (await requestedItem(client)).rows[0].id;
      expect((await client.query('SELECT requested_quantity, cancelled_by, cancelled_at, cancel_note FROM requested_items WHERE id = $1', [ids.item])).rows).toEqual([
        { requested_quantity: '2.0000', cancelled_by: null, cancelled_at: null, cancel_note: null },
      ]);
      const other = (await client.query(`INSERT INTO requestable_materials (name, request_unit_id, created_by) VALUES ('ปากกา', $1, $2) RETURNING id`, [ids.unit, ids.user])).rows[0].id;

      await expect(requestedItem(client, { position: 1 })).rejects.toThrow(/requested_items_requestable_material_once/);
      await expect(requestedItem(client, { requestable_material_id: other })).rejects.toThrow(/requested_items_material_request_id_position_key/);
      await expect(requestedItem(client, { requestable_material_id: other, position: -1 })).rejects.toThrow(/requested_items_position_check/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 50 })).rejects.toThrow(/requested_items_position_check/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, requested_quantity: '0' })).rejects.toThrow(/requested_items_requested_quantity_check/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, requested_quantity: '-1' })).rejects.toThrow(/requested_items_requested_quantity_check/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, requested_quantity: '100000000000000' })).rejects.toThrow(/numeric field overflow/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, request_unit_id: crypto.randomUUID() })).rejects.toThrow(/request_unit_id/);
      await expect(requestedItem(client, { requestable_material_id: crypto.randomUUID(), position: 1 })).rejects.toThrow(/requestable_material_id/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, material_request_id: crypto.randomUUID() })).rejects.toThrow(/material_request_id/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, note: ' ' })).rejects.toThrow(/requested_items_note_check/);
      await expect(requestedItem(client, { requestable_material_id: other, position: 1, note: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);

      // The same Requestable Material in another Material Request.
      expect((await requestedItem(client, { material_request_id: ids.secondRequest })).rows).toHaveLength(1);
      await expect(client.query('DELETE FROM requestable_materials WHERE id = $1', [ids.requestable])).rejects.toThrow(/requested_items/);
      await expect(client.query('DELETE FROM material_requests WHERE id = $1', [ids.request])).rejects.toThrow(/requested_items/);
      // The Requested Items using a Requestable Material are found by an index, for F009-T7's Pending count and T8's
      // Request Unit change (#202 P2, P6).
      expect((await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_requested_items_requestable_material'`)).rows).toEqual([
        { indexdef: 'CREATE INDEX idx_requested_items_requestable_material ON public.requested_items USING btree (requestable_material_id)' },
      ]);
    });
  });

  it('keeps a Requested Item Pending with no Cancel facts, or Cancelled with who and when, its note only beside them (P4)', async () => {
    await withClient(async (client) => {
      const cancel = (fields: Record<string, unknown>) => {
        const columns = Object.keys(fields);
        return client.query(`UPDATE requested_items SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')} WHERE id = $1`, [ids.item, ...Object.values(fields)]);
      };
      await expect(cancel({ cancelled_by: ids.user })).rejects.toThrow(/requested_items_cancelled_check/);
      await expect(cancel({ cancelled_at: new Date() })).rejects.toThrow(/requested_items_cancelled_check/);
      await expect(cancel({ cancel_note: 'ไม่ใช้แล้ว' })).rejects.toThrow(/requested_items_cancelled_check/);
      await expect(cancel({ cancelled_by: ids.user, cancelled_at: new Date(), cancel_note: ' ' })).rejects.toThrow(/requested_items_cancel_note_check/);
      await expect(cancel({ cancelled_by: ids.user, cancelled_at: new Date(), cancel_note: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);
      await expect(cancel({ cancelled_by: crypto.randomUUID(), cancelled_at: new Date() })).rejects.toThrow(/cancelled_by/);
      await cancel({ cancelled_by: ids.user, cancelled_at: new Date(), cancel_note: 'ไม่ใช้แล้ว' });
      await cancel({ cancelled_by: null, cancelled_at: null, cancel_note: null });
    });
  });

  it('keeps an append-only history: one entry per version, created with nothing listed, a Cancel listing the Requested Items it cancelled with an optional note', async () => {
    await withClient(async (client) => {
      await historyEntry(client);
      await expect(historyEntry(client)).rejects.toThrow(/material_request_history_material_request_id_version_key/);
      await expect(historyEntry(client, { version: 0 })).rejects.toThrow(/material_request_history_version_check/);
      await expect(historyEntry(client, { version: 2, kind: 'EDITED' })).rejects.toThrow(/material_request_history_kind_check/);
      await expect(historyEntry(client, { version: 2, requested_item_ids: [ids.item] })).rejects.toThrow(/material_request_history_lists_cancelled_items/);
      await expect(historyEntry(client, { version: 2, note: 'สร้าง' })).rejects.toThrow(/material_request_history_lists_cancelled_items/);
      await expect(historyEntry(client, { version: 2, kind: 'REQUESTED_ITEM_CANCELLED' })).rejects.toThrow(/material_request_history_lists_cancelled_items/);
      await expect(historyEntry(client, { version: 2, kind: 'MATERIAL_REQUEST_CANCELLED', requested_item_ids: [] })).rejects.toThrow(/material_request_history_lists_cancelled_items/);
      await expect(historyEntry(client, { version: 2, kind: 'REQUESTED_ITEM_CANCELLED', requested_item_ids: [ids.item], note: ' ' })).rejects.toThrow(/material_request_history_note_check/);
      await expect(historyEntry(client, { version: 2, kind: 'REQUESTED_ITEM_CANCELLED', requested_item_ids: [ids.item], note: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);
      await expect(historyEntry(client, { version: 2, recorded_by: crypto.randomUUID() })).rejects.toThrow(/recorded_by/);
      await historyEntry(client, { version: 2, kind: 'REQUESTED_ITEM_CANCELLED', requested_item_ids: [ids.item], note: 'ไม่ใช้แล้ว' });
      await historyEntry(client, { version: 3, kind: 'MATERIAL_REQUEST_CANCELLED', requested_item_ids: [ids.item] });
      expect((await client.query('SELECT version, kind FROM material_request_history ORDER BY version')).rows).toEqual([
        { version: 1, kind: 'CREATED' },
        { version: 2, kind: 'REQUESTED_ITEM_CANCELLED' },
        { version: 3, kind: 'MATERIAL_REQUEST_CANCELLED' },
      ]);
      await expect(client.query('DELETE FROM material_requests WHERE id = $1', [ids.secondRequest])).rejects.toThrow(/requested_items/);
    });
  });

  it('refuses a rollback while a Requester, a Material Request or a retry receipt of its writes exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback: Requesters, Material Requests or their retry receipts exist');

    // Material Requests alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM material_request_history');
      await client.query('DELETE FROM requested_items');
      await client.query('DELETE FROM material_requests');
      await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'REQUESTER')`, [ids.user]);
    });
    // A Requester alone.
    await refused();
    await withClient(async (client) => {
      await client.query(`DELETE FROM user_roles WHERE role_id = 'REQUESTER'`);
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t4-request-receipt', $1, 'material-request:create', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });
    // A retry receipt alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM registration_retry_tokens');
      await client.query(`DELETE FROM requestable_materials WHERE name = 'ปากกา'`);
    });

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0031_material_requests', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(await schemaOf(client)).toEqual(JSON.parse(ids.schemaBefore));
      expect((await client.query('SELECT name FROM requestable_materials')).rows).toEqual([{ name: 'กระดาษ A4' }]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0031_material_requests');
  });
});
