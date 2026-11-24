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

// F010-T2 (#233): 0032_opening_balances_stock_movements against a populated 0031 database (Seam C): the Opening
// Balance with its number sequence, lines and history, and the shared Stock Movement table with its one-source CHECK,
// its Reversal reference and its append-only trigger (#231 Q13, Q20, Q26, P1, P2, P10; ADR 0003).
describe('Opening Balance and Stock Movement Migration Integration (Seam C - F010-T2)', () => {
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
      client.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname`),
      client.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`),
    ]).then((results) => results.map((res) => res.rows));

  // Inserts `values` into `table` and answers the new row's id.
  const insert = async (client: pg.Client, table: string, values: Record<string, unknown>): Promise<string> => {
    const columns = Object.keys(values);
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values)
    );
    return res.rows[0].id;
  };

  const openingBalance = (client: pg.Client, fields: Record<string, unknown> = {}) => insert(client, 'opening_balances', { created_by: ids.user, ...fields });

  const line = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'opening_balance_lines', { opening_balance_id: ids.draft, position: 0, stock_material_id: ids.paper, ...fields });

  const movement = (client: pg.Client, fields: Record<string, unknown> = {}) =>
    insert(client, 'stock_movements', {
      stock_material_id: ids.paper,
      kind: 'OPENING_BALANCE',
      opening_balance_line_id: ids.confirmedLine,
      effective_date: '2026-10-01',
      original_quantity: '2',
      original_unit_id: ids.ream,
      base_unit_id: ids.ream,
      conversion_factor: '1',
      base_quantity: '2',
      recorded_by: ids.user,
      ...fields,
    });

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

  it('adds the empty Opening Balance and Stock Movement tables to a populated database, leaving its Stock Materials as they were', async () => {
    for (let step = 1; step <= 31; step++) {
      expect((await runMigrator({ command: 'up', databaseUrl, migrationFolder })).error).toBeUndefined();
    }

    ids.schemaBefore = JSON.stringify(
      await withClient(async (client) => {
        const schema = await schemaOf(client);
        ids.user = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('t2_opening_user', 'hash') RETURNING id`)).rows[0].id;
        ids.ream = (await client.query(`INSERT INTO units (name, created_by, updated_by) VALUES ('รีม', $1, $1) RETURNING id`, [ids.user])).rows[0].id;
        ids.paper = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('กระดาษ A4', $1) RETURNING id`, [ids.user])).rows[0].id;
        await client.query(`INSERT INTO stock_material_units (stock_material_id, unit_id, is_base, conversion_factor) VALUES ($1, $2, true, 1)`, [ids.paper, ids.ream]);
        return schema;
      })
    );

    const upgrade = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.[0]?.migrationName).toBe('0032_opening_balances_stock_movements');

    await withClient(async (client) => {
      for (const table of ['opening_balances', 'opening_balance_lines', 'opening_balance_history', 'stock_movements']) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      expect((await client.query('SELECT name, version FROM stock_materials')).rows).toEqual([{ name: 'กระดาษ A4', version: 1 }]);
    });
  });

  it('keeps a Draft without a number, numbers a confirmed one from its own sequence, and needs an As-of Date and a source to be confirmed', async () => {
    await withClient(async (client) => {
      ids.draft = await openingBalance(client);
      const draft = (await client.query('SELECT opening_balance_number, as_of_date, source, version FROM opening_balances WHERE id = $1', [ids.draft])).rows[0];
      expect(draft).toEqual({ opening_balance_number: null, as_of_date: null, source: null, version: 1 });

      const confirm = (id: string) =>
        client.query(`UPDATE opening_balances SET opening_balance_number = nextval('opening_balance_numbers'), confirmed_by = $2, confirmed_at = now() WHERE id = $1 RETURNING opening_balance_number`, [
          id,
          ids.user,
        ]);
      // Neither the As-of Date nor the source: not confirmable.
      await expect(confirm(ids.draft)).rejects.toThrow(/opening_balances_confirmed_check/);
      const sourceOnly = await openingBalance(client, { source: 'สมุดคุมวัสดุ' });
      await expect(confirm(sourceOnly)).rejects.toThrow(/opening_balances_confirmed_check/);
      const dateOnly = await openingBalance(client, { as_of_date: '2026-09-30' });
      await expect(confirm(dateOnly)).rejects.toThrow(/opening_balances_confirmed_check/);
      // A number without its confirm, or a confirm without its actor.
      await expect(openingBalance(client, { as_of_date: '2026-09-30', source: 'สมุด', opening_balance_number: 999 })).rejects.toThrow(/opening_balances_confirmed_check/);
      await expect(openingBalance(client, { as_of_date: '2026-09-30', source: 'สมุด', opening_balance_number: 998, confirmed_at: new Date() })).rejects.toThrow(/opening_balances_confirmed_check/);

      ids.confirmed = await openingBalance(client, { as_of_date: '2026-09-30', source: 'สมุดคุมวัสดุ' });
      const second = await openingBalance(client, { as_of_date: '2026-09-30', source: 'แฟ้มนับวัสดุ' });
      const first = (await confirm(ids.confirmed)).rows[0].opening_balance_number;
      const next = (await confirm(second)).rows[0].opening_balance_number;
      expect(BigInt(next)).toBeGreaterThan(BigInt(first));
      await expect(client.query('UPDATE opening_balances SET opening_balance_number = $2 WHERE id = $1', [second, first])).rejects.toThrow(/opening_balances_opening_balance_number_key/);
      expect((await client.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'opening_balances' AND column_name = 'opening_balance_number'`)).rows).toEqual([{ data_type: 'bigint' }]);

      // P7 lengths, and no blank text.
      await expect(openingBalance(client, { source: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);
      await expect(openingBalance(client, { note: 'ก'.repeat(2001) })).rejects.toThrow(/character varying\(2000\)/);
      await expect(openingBalance(client, { source: '  ' })).rejects.toThrow(/opening_balances_source_check/);
      await expect(openingBalance(client, { note: ' ' })).rejects.toThrow(/opening_balances_note_check/);
      await expect(openingBalance(client, { version: 0 })).rejects.toThrow(/opening_balances_version_check/);
    });
  });

  it('holds 0 to 50 lines, each Stock Material once, a Draft line without its Unit or quantity, and a quantity greater than 0', async () => {
    await withClient(async (client) => {
      const blank = await line(client);
      expect((await client.query('SELECT unit_id, quantity, note, stock_movement_id, is_voided FROM opening_balance_lines WHERE id = $1', [blank])).rows).toEqual([
        { unit_id: null, quantity: null, note: null, stock_movement_id: null, is_voided: false },
      ]);
      await expect(line(client, { position: 1 })).rejects.toThrow(/opening_balance_lines_stock_material_once/);
      const pens = (await client.query(`INSERT INTO stock_materials (name, created_by) VALUES ('ปากกา', $1) RETURNING id`, [ids.user])).rows[0].id;
      await expect(line(client, { stock_material_id: pens })).rejects.toThrow(/opening_balance_lines_opening_balance_id_position_key/);
      await expect(line(client, { stock_material_id: pens, position: 50 })).rejects.toThrow(/opening_balance_lines_position_check/);
      await expect(line(client, { stock_material_id: pens, position: -1 })).rejects.toThrow(/opening_balance_lines_position_check/);
      await expect(line(client, { stock_material_id: pens, position: 49, quantity: '0' })).rejects.toThrow(/opening_balance_lines_quantity_check/);
      await expect(line(client, { stock_material_id: pens, position: 49, note: 'ก'.repeat(501) })).rejects.toThrow(/character varying\(500\)/);
      await line(client, { stock_material_id: pens, position: 49, quantity: '0.0001' });
      await client.query('DELETE FROM opening_balance_lines WHERE opening_balance_id = $1', [ids.draft]);

      ids.confirmedLine = await line(client, { opening_balance_id: ids.confirmed, unit_id: ids.ream, quantity: '2' });
    });
  });

  it('gives a Stock Movement exactly one source line, its snapshot and a signed Base Quantity, and a Reversal that takes back one Stock Movement once', async () => {
    await withClient(async (client) => {
      await expect(movement(client, { opening_balance_line_id: null })).rejects.toThrow(/stock_movements_one_source_line/);
      await expect(movement(client, { base_quantity: '0' })).rejects.toThrow(/stock_movements_reversal_check/);
      await expect(movement(client, { base_quantity: '-2' })).rejects.toThrow(/stock_movements_reversal_check/);
      await expect(movement(client, { original_quantity: '0' })).rejects.toThrow(/stock_movements_original_quantity_check/);
      await expect(movement(client, { conversion_factor: '0' })).rejects.toThrow(/stock_movements_conversion_factor_check/);
      await expect(movement(client, { kind: 'RECEIPT' })).rejects.toThrow(/stock_movements_kind_check/);

      ids.movement = await movement(client);
      await expect(movement(client, { kind: 'REVERSAL', base_quantity: '-2' })).rejects.toThrow(/stock_movements_reversal_check/);
      await expect(movement(client, { reverses_stock_movement_id: ids.movement, base_quantity: '-2' })).rejects.toThrow(/stock_movements_reversal_check/);
      await expect(movement(client, { kind: 'REVERSAL', reverses_stock_movement_id: ids.movement, base_quantity: '2' })).rejects.toThrow(/stock_movements_reversal_check/);
      ids.reversal = await movement(client, { kind: 'REVERSAL', reverses_stock_movement_id: ids.movement, base_quantity: '-2' });
      await expect(movement(client, { kind: 'REVERSAL', reverses_stock_movement_id: ids.movement, base_quantity: '-2' })).rejects.toThrow(
        /stock_movements_reverses_stock_movement_id_key/
      );
    });
  });

  it('refuses every UPDATE and DELETE of a Stock Movement', async () => {
    await withClient(async (client) => {
      await expect(client.query(`UPDATE stock_movements SET base_quantity = 3 WHERE id = $1`, [ids.movement])).rejects.toThrow(/Stock Movements are append-only: UPDATE refused/);
      await expect(client.query(`DELETE FROM stock_movements WHERE id = $1`, [ids.reversal])).rejects.toThrow(/Stock Movements are append-only: DELETE refused/);
      expect((await client.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n).toBe(2);
    });
  });

  it('points a line at one Stock Movement of its own, unique, and a Stock Material at one line in effect', async () => {
    await withClient(async (client) => {
      await client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [ids.confirmedLine, ids.movement]);
      // Another line cannot point at it, nor this line at a movement of another line.
      const other = (await client.query(`SELECT id FROM opening_balances WHERE source = 'แฟ้มนับวัสดุ'`)).rows[0].id;
      const pens = (await client.query(`SELECT id FROM stock_materials WHERE name = 'ปากกา'`)).rows[0].id;
      const otherLine = await line(client, { opening_balance_id: other, stock_material_id: pens, unit_id: ids.ream, quantity: '1' });
      await expect(client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [otherLine, ids.movement])).rejects.toThrow(
        /opening_balance_lines_stock_movement_id_key|opening_balance_lines_stock_movement_fkey/
      );
      const pensMovement = await movement(client, { stock_material_id: pens, opening_balance_line_id: otherLine });
      const draftLine = await line(client, { stock_material_id: pens, unit_id: ids.ream, quantity: '1' });
      await expect(client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [draftLine, pensMovement])).rejects.toThrow(/opening_balance_lines_stock_movement_fkey/);

      // A line in effect has its Unit and quantity and is not voided.
      await expect(client.query('UPDATE opening_balance_lines SET is_voided = true WHERE id = $1', [ids.confirmedLine])).rejects.toThrow(/opening_balance_lines_in_effect_check/);

      // A second line of paper in effect, in another Opening Balance: refused.
      const paperAgain = await line(client, { opening_balance_id: other, position: 1, unit_id: ids.ream, quantity: '5' });
      const paperAgainMovement = await movement(client, { opening_balance_line_id: paperAgain });
      await expect(client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [paperAgain, paperAgainMovement])).rejects.toThrow(
        /opening_balance_lines_one_in_effect_per_stock_material/
      );
    });
  });

  it('keeps a history entry per version, a reason on every entry but the confirmed one', async () => {
    await withClient(async (client) => {
      const entry = (fields: Record<string, unknown>) => insert(client, 'opening_balance_history', { opening_balance_id: ids.confirmed, facts: '{}', recorded_by: ids.user, ...fields });
      await expect(entry({ version: 2, kind: 'CONFIRMED', reason: 'ผิด' })).rejects.toThrow(/opening_balance_history_reason_by_kind/);
      await expect(entry({ version: 3, kind: 'CORRECTED' })).rejects.toThrow(/opening_balance_history_reason_by_kind/);
      await expect(entry({ version: 2, kind: 'MOVED' })).rejects.toThrow(/opening_balance_history_kind_check/);
      await entry({ version: 2, kind: 'CONFIRMED' });
      await expect(entry({ version: 2, kind: 'VOIDED', reason: 'ซ้ำ' })).rejects.toThrow(/opening_balance_history_opening_balance_id_version_key/);
      await entry({ version: 3, kind: 'VOIDED', reason: 'ซ้ำ' });
    });
  });

  it('refuses a rollback while an Opening Balance, a Stock Movement or a retry receipt of their writes exists, and rolls back cleanly once none does', async () => {
    const down = () => runMigrator({ command: 'down', databaseUrl, migrationFolder });
    const refused = async () => expect(String((await down()).error)).toContain('Refusing destructive rollback: Opening Balances, Stock Movements or their retry receipts exist');

    // Both Opening Balances and Stock Movements.
    await refused();
    await withClient(async (client) => {
      await client.query('UPDATE opening_balance_lines SET stock_movement_id = NULL');
      await client.query('DELETE FROM opening_balance_history');
      // Only the test removes Stock Movements, past the trigger.
      await client.query('ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only');
      await client.query('DELETE FROM stock_movements');
      await client.query('ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only');
    });
    // Opening Balances alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM opening_balance_lines');
      await client.query('DELETE FROM opening_balances');
      await client.query(
        `INSERT INTO registration_retry_tokens (token, actor_id, operation, payload_fingerprint, response_status, response_body)
         VALUES ('t2-opening-receipt', $1, 'opening-balance:create', 'fingerprint', 201, '{}')`,
        [ids.user]
      );
    });
    // A retry receipt alone.
    await refused();
    await withClient(async (client) => {
      await client.query('DELETE FROM registration_retry_tokens');
      await client.query(`DELETE FROM stock_materials WHERE name = 'ปากกา'`);
    });

    const rollback = await down();
    expect(rollback.error).toBeUndefined();
    expect(rollback.results?.[0]).toMatchObject({ migrationName: '0032_opening_balances_stock_movements', direction: 'Down', status: 'Success' });

    await withClient(async (client) => {
      expect(await schemaOf(client)).toEqual(JSON.parse(ids.schemaBefore));
      expect((await client.query('SELECT name FROM stock_materials')).rows).toEqual([{ name: 'กระดาษ A4' }]);
    });

    const reapply = await runMigrator({ command: 'up', databaseUrl, migrationFolder });
    expect(reapply.error).toBeUndefined();
    expect(reapply.results?.[0]?.migrationName).toBe('0032_opening_balances_stock_movements');
  });
});
