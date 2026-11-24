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

// F010-T3 (#234): 0034_material_receipts against a populated 0033 database (Seam C): the Material Receipt
// (รายการรับวัสดุ), its Receipt Lines, its Receipt Number sequence and its history, and the Receipt Line as a Stock
// Movement's source with the รับวัสดุ kind (#231 MRC-01–MRC-03, MRC-05–MRC-09, MSL-04, Q4–Q9, P1, P2, P7, P10).
describe('Material Receipt Migration Integration (Seam C - F010-T3)', () => {
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
      client.query(`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`),
    ]).then((results) => results.map((res) => res.rows));

  // Inserts a row of `table` from `values`, returning its id.
  const insert = async (client: pg.Client, table: string, values: Record<string, unknown>): Promise<string> => {
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  const receipt = (client: pg.Client, fields: Record<string, unknown> = {}) => insert(client, 'material_receipts', { created_by: ids.user, ...fields });

  const line = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'material_receipt_lines', { material_receipt_id: ids.draft, position: 0, stock_material_id: ids.paper, ...fields });

  const movement = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'stock_movements', {
      stock_material_id: ids.paper,
      kind: 'MATERIAL_RECEIPT',
      material_receipt_line_id: ids.receivedLine,
      effective_date: '2026-11-01',
      original_quantity: '2',
      original_unit_id: ids.ream,
      base_unit_id: ids.ream,
      conversion_factor: '1',
      base_quantity: '2',
      recorded_by: ids.user,
      ...fields,
    });

  const confirm = (client: pg.Client, id: string) =>
    client.query(`UPDATE material_receipts SET receipt_number = nextval('material_receipt_numbers'), confirmed_by = $2, confirmed_at = now() WHERE id = $1 RETURNING receipt_number`, [
      id,
      ids.user,
    ]);

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

  it('adds the empty Material Receipt tables to a populated database, leaving its Opening Balance and its Stock Movement as they were', async () => {
    for (let step = 1; step <= 33; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t3_receipt_user', 'hash') RETURNING id`)).rows[0].id;
        ids.ream = (await client.query(`INSERT INTO units (name, created_by, updated_by) VALUES ('รีม', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.box = (await client.query(`INSERT INTO units (name, created_by, updated_by) VALUES ('กล่อง', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.paper = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('กระดาษ A4', $1) RETURNING id`, [ids.user])).rows[0].id;
        await client.query(`INSERT INTO stock_material_units (stock_material_id, unit_id, is_base, conversion_factor) VALUES ($1, $2, true, 1), ($1, $3, false, 5)`, [
          ids.paper,
          ids.ream,
          ids.box,
        ]);
        // An Opening Balance confirmed before 0034, with its Stock Movement.
        const opening = (
          await client.query(
            `INSERT INTO opening_balances (as_of_date, source, created_by, opening_balance_number, confirmed_by, confirmed_at)
             VALUES ('2026-09-30', 'สมุด', $1, nextval('opening_balance_numbers'), $1, now()) RETURNING id`,
            [ids.user]
          )
        ).rows[0].id;
        ids.openingLine = (
          await client.query(`INSERT INTO opening_balance_lines (opening_balance_id, position, stock_material_id, unit_id, quantity) VALUES ($1, 0, $2, $3, 3) RETURNING id`, [
            opening,
            ids.paper,
            ids.ream,
          ])
        ).rows[0].id;
        ids.openingMovement = (
          await client.query(
            `INSERT INTO stock_movements (stock_material_id, kind, opening_balance_line_id, effective_date, original_quantity, original_unit_id, base_unit_id, conversion_factor, base_quantity, recorded_by)
             VALUES ($1, 'OPENING_BALANCE', $2, '2026-09-30', 3, $3, $3, 1, 3, $4) RETURNING id`,
            [ids.paper, ids.openingLine, ids.ream, ids.user]
          )
        ).rows[0].id;
        await client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [ids.openingLine, ids.openingMovement]);
        ids.party = (await client.query(`INSERT INTO source_parties (name, created_by, updated_by) VALUES ('ร้านเครื่องเขียน', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.type = (await client.query(`INSERT INTO source_types (name, created_by, updated_by) VALUES ('ซื้อ', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0034_material_receipts');

    await withClient(async (client) => {
      for (const table of ['material_receipts', 'material_receipt_lines', 'material_receipt_history']) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      expect((await client.query('SELECT id, kind, opening_balance_line_id, material_receipt_line_id FROM stock_movements')).rows).toEqual([
        { id: ids.openingMovement, kind: 'OPENING_BALANCE', opening_balance_line_id: ids.openingLine, material_receipt_line_id: null },
      ]);
    });
  });

  it('keeps a Draft without a number, numbers a Received one from its own sequence, and needs a Received Date to be Received (P1)', async () => {
    await withClient(async (client) => {
      ids.draft = await receipt(client);
      const draft = (
        await client.query('SELECT receipt_number, received_date, source_party_id, source_type_id, receipt_reference, note, version FROM material_receipts WHERE id = $1', [ids.draft])
      ).rows[0];
      expect(draft).toEqual({ receipt_number: null, received_date: null, source_party_id: null, source_type_id: null, receipt_reference: null, note: null, version: 1 });

      // No Received Date: not Received.
      await expect(confirm(client, ids.draft)).rejects.toThrow(/material_receipts_confirmed_check/);
      // A number without its confirm, or a confirm without its actor.
      await expect(receipt(client, { received_date: '2026-11-01', receipt_number: 999 })).rejects.toThrow(/material_receipts_confirmed_check/);
      await expect(receipt(client, { received_date: '2026-11-01', receipt_number: 998, confirmed_at: new Date() })).rejects.toThrow(/material_receipts_confirmed_check/);

      ids.received = await receipt(client, { received_date: '2026-11-01', source_party_id: ids.party, source_type_id: ids.type, receipt_reference: 'ใบส่งของ 12' });
      const second = await receipt(client, { received_date: '2026-11-02' });
      const first = (await confirm(client, ids.received)).rows[0].receipt_number;
      const next = (await confirm(client, second)).rows[0].receipt_number;
      expect(BigInt(next)).toBeGreaterThan(BigInt(first));
      await expect(client.query('UPDATE material_receipts SET receipt_number = $2 WHERE id = $1', [second, first])).rejects.toThrow(/material_receipts_receipt_number_key/);
      expect((await client.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'material_receipts' AND column_name = 'receipt_number'`)).rows).toEqual([
        { data_type: 'bigint' },
      ]);

      // The lists it names (Q6, Q12), P7 lengths, and no blank text.
      await expect(receipt(client, { source_party_id: ids.type })).rejects.toThrow(/material_receipts_source_party_id_fkey/);
      await expect(receipt(client, { source_type_id: ids.party })).rejects.toThrow(/material_receipts_source_type_id_fkey/);
      await expect(receipt(client, { receipt_reference: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);
      await expect(receipt(client, { note: 'ก'.repeat(2001) })).rejects.toThrow(/character varying\(2000\)/);
      await expect(receipt(client, { receipt_reference: '  ' })).rejects.toThrow(/material_receipts_receipt_reference_check/);
      await expect(receipt(client, { note: ' ' })).rejects.toThrow(/material_receipts_note_check/);
      await expect(receipt(client, { version: 0 })).rejects.toThrow(/material_receipts_version_check/);
    });
  });

  it('holds 0 to 50 lines, a Stock Material and Unit pair once, a Draft line without its Unit or quantity, a quantity greater than 0 and a Unit Price of at least 0 (Q8, Q9)', async () => {
    await withClient(async (client) => {
      const blank = await line(client);
      expect(
        (await client.query('SELECT unit_id, quantity, unit_price, note, stock_movement_id, is_voided FROM material_receipt_lines WHERE id = $1', [blank])).rows
      ).toEqual([{ unit_id: null, quantity: null, unit_price: null, note: null, stock_movement_id: null, is_voided: false }]);
      // Two lines of one Stock Material without a Unit yet (#234 start decision 1).
      await line(client, { position: 1 });
      await line(client, { position: 2, unit_id: ids.ream });
      await expect(line(client, { position: 3, unit_id: ids.ream })).rejects.toThrow(/material_receipt_lines_stock_material_unit_once/);
      await line(client, { position: 3, unit_id: ids.box });
      await expect(line(client, { unit_id: null })).rejects.toThrow(/material_receipt_lines_material_receipt_id_position_key/);
      await expect(line(client, { position: 50 })).rejects.toThrow(/material_receipt_lines_position_check/);
      await expect(line(client, { position: -1 })).rejects.toThrow(/material_receipt_lines_position_check/);
      await expect(line(client, { position: 49, quantity: '0' })).rejects.toThrow(/material_receipt_lines_quantity_check/);
      await expect(line(client, { position: 49, unit_price: '-0.0001' })).rejects.toThrow(/material_receipt_lines_unit_price_check/);
      await expect(line(client, { position: 49, note: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);
      await expect(line(client, { position: 49, note: ' ' })).rejects.toThrow(/material_receipt_lines_note_check/);
      await line(client, { position: 49, quantity: '0.0001', unit_price: '0' });
      await client.query('DELETE FROM material_receipt_lines WHERE material_receipt_id = $1', [ids.draft]);

      ids.receivedLine = await line(client, { material_receipt_id: ids.received, unit_id: ids.ream, quantity: '2', unit_price: '120.5' });
    });
  });

  it('takes a Receipt Line as the one source of a รับวัสดุ Stock Movement, which the line points at while it is in effect (P2, MSL-04)', async () => {
    await withClient(async (client) => {
      // Both sources, or a kind that names the other source.
      await expect(movement(client, { opening_balance_line_id: ids.openingLine })).rejects.toThrow(/stock_movements_one_source_line/);
      await expect(movement(client, { kind: 'OPENING_BALANCE' })).rejects.toThrow(/stock_movements_kind_source_line/);
      await expect(movement(client, { material_receipt_line_id: null, opening_balance_line_id: ids.openingLine })).rejects.toThrow(/stock_movements_kind_source_line/);
      await expect(movement(client, { kind: 'ISSUE' })).rejects.toThrow(/stock_movements_kind_check/);

      const received = await movement(client);
      await client.query('UPDATE material_receipt_lines SET stock_movement_id = $2 WHERE id = $1', [ids.receivedLine, received]);
      // A line points only at a Stock Movement of its own, one at a time, and at none once voided.
      const other = await line(client, { material_receipt_id: ids.received, position: 1, unit_id: ids.box, quantity: '1' });
      await expect(client.query('UPDATE material_receipt_lines SET stock_movement_id = $2 WHERE id = $1', [other, received])).rejects.toThrow(/material_receipt_lines/);
      await expect(client.query('UPDATE material_receipt_lines SET stock_movement_id = $2 WHERE id = $1', [other, ids.openingMovement])).rejects.toThrow(
        /material_receipt_lines_stock_movement_fkey/
      );
      await expect(client.query('UPDATE material_receipt_lines SET is_voided = true WHERE id = $1', [ids.receivedLine])).rejects.toThrow(/material_receipt_lines_in_effect_check/);
      await client.query('DELETE FROM material_receipt_lines WHERE id = $1', [other]);
      // A Reversal of it, sourced from the same line, once.
      await movement(client, { kind: 'REVERSAL', reverses_stock_movement_id: received, base_quantity: '-2' });
      await expect(movement(client, { kind: 'REVERSAL', reverses_stock_movement_id: received, base_quantity: '-2' })).rejects.toThrow(/stock_movements_reverses_stock_movement_id_key/);
      await expect(client.query('UPDATE stock_movements SET base_quantity = 5 WHERE id = $1', [received])).rejects.toThrow('Stock Movements are append-only: UPDATE refused');
    });
  });

  it('keeps a history entry per version, a reason on every entry but the confirmed one', async () => {
    await withClient(async (client) => {
      const entry = (fields: Record<string, unknown>) => insert(client, 'material_receipt_history', { material_receipt_id: ids.received, facts: '{}', recorded_by: ids.user, ...fields });
      await expect(entry({ version: 2, kind: 'CONFIRMED', reason: 'ผิด' })).rejects.toThrow(/material_receipt_history_reason_by_kind/);
      await expect(entry({ version: 3, kind: 'CORRECTED' })).rejects.toThrow(/material_receipt_history_reason_by_kind/);
      await expect(entry({ version: 2, kind: 'MOVED' })).rejects.toThrow(/material_receipt_history_kind_check/);
      await expect(entry({ version: 2, kind: 'VOIDED', reason: ' ' })).rejects.toThrow(/material_receipt_history_reason_check/);
      await entry({ version: 2, kind: 'CONFIRMED' });
      await expect(entry({ version: 2, kind: 'VOIDED', reason: 'ซ้ำ' })).rejects.toThrow(/material_receipt_history_material_receipt_id_version_key/);
      await entry({ version: 3, kind: 'VOIDED', reason: 'ซ้ำ' });
    });
  });

  it('refuses a rollback while a Material Receipt or a retry receipt of its writes exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback: Material Receipts, their Stock Movements or their retry receipts exist');

    // Material Receipts with their Stock Movements.
    await refused();
    await withClient(async (client) => {
      await client.query('UPDATE material_receipt_lines SET stock_movement_id = NULL');
      await client.query('DELETE FROM material_receipt_history');
      // Only the test removes Stock Movements, past the trigger.
      await client.query('ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only');
      await client.query('DELETE FROM stock_movements WHERE material_receipt_line_id IS NOT NULL');
      await client.query('ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only');
    });
    // Material Receipts alone, a Draft among them.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM material_receipt_lines');
      await client.query('DELETE FROM material_receipts');
    });
    for (const operation of ['material-receipt:create', 'material-receipt:confirm']) {
      await withClient(async (client) => {
        await client.query('DELETE FROM registration_retry_tokens');
        await client.query(
          `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
           VALUES ('t3-receipt-receipt', $1, $2, 'fingerprint', 201, '{}')`,
          [ids.user, operation]
        );
      });
      // A retry receipt of its writes alone.
      await refused();
    }
    // A retry receipt of another write does not hold the rollback.
    await withClient(async (client) => {
      await client.query(`UPDATE registration_retry_tokens SET operation = 'opening-balance:create'`);
    });

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0034_material_receipts', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(JSON.stringify(await schemaOf(client))).toBe(ids.schemaBefore);
      expect((await client.query('SELECT id, kind FROM stock_movements')).rows).toEqual([{ id: ids.openingMovement, kind: 'OPENING_BALANCE' }]);
      await client.query('DELETE FROM registration_retry_tokens');
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0034_material_receipts');
  });
});
