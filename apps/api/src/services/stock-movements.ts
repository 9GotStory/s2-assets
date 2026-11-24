import pg from 'pg';
import type { ConversionSnapshot } from './base-quantity.ts';
import { joinUnitEntry } from './catalog-list-entries.ts';

// F010-T2 (#233): the module that owns stock_movements, the one table of Stock Movements (รายการเคลื่อนไหว) that
// Features 010 to 014 share (ADR 0003, #231 P2). Rows are only ever added: a trigger refuses every UPDATE and DELETE.
// What they add up to is read through current-stock.ts.

// The kinds 0032_opening_balances_stock_movements allows; T3 adds the Material Receipt's, and T6 and T7 write the
// Reversals.
export type StockMovementKind = 'OPENING_BALANCE' | 'REVERSAL';

// A Stock Movement made by an Opening Balance line, as Feature 008's quantity normalization gave it (#231 Numbers).
export interface NewStockMovement {
  stock_material_id: string;
  kind: 'OPENING_BALANCE';
  opening_balance_line_id: string;
  effective_date: string;
  original_quantity: string;
  original_unit_id: string;
  conversion_snapshot: ConversionSnapshot;
  // Signed, in the Base Unit.
  base_quantity: string;
  recorded_by: string;
}

/** Adds the Stock Movement `movement` through `client` inside its write's transaction, and answers its id. */
export async function recordStockMovement(client: pg.PoolClient, movement: NewStockMovement): Promise<string> {
  const res = await client.query(
    `INSERT INTO stock_movements (stock_material_id, kind, opening_balance_line_id, effective_date, original_quantity, original_unit_id,
                                  base_unit_id, conversion_factor, base_quantity, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      movement.stock_material_id,
      movement.kind,
      movement.opening_balance_line_id,
      movement.effective_date,
      movement.original_quantity,
      movement.original_unit_id,
      movement.conversion_snapshot.base_unit_id,
      movement.conversion_snapshot.conversion_factor,
      movement.base_quantity,
      movement.recorded_by,
    ]
  );
  return res.rows[0].id;
}

// A Stock Movement as a source's page shows it (#231 story 58).
export interface StockMovementRow {
  id: string;
  kind: StockMovementKind;
  effective_date: string;
  original_quantity: string;
  original_unit: { unit_id: string; name: string };
  base_unit: { unit_id: string; name: string };
  conversion_factor: string;
  base_quantity: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

/** The Stock Movements of the Opening Balance lines `lineIds`, by line id, oldest first, each Unit under its name now. */
export async function stockMovementsOfOpeningBalanceLines(runner: pg.Pool | pg.PoolClient, lineIds: string[]): Promise<Map<string, StockMovementRow[]>> {
  const res = await runner.query(
    `SELECT sm.opening_balance_line_id, sm.id, sm.kind, sm.effective_date::text AS effective_date, trim_scale(sm.original_quantity)::text AS original_quantity,
            sm.original_unit_id, ou.name AS original_unit_name, sm.base_unit_id, bu.name AS base_unit_name,
            trim_scale(sm.conversion_factor)::text AS conversion_factor, trim_scale(sm.base_quantity)::text AS base_quantity,
            sm.recorded_by, u.username AS recorded_by_username, sm.recorded_at
     FROM stock_movements sm
     ${joinUnitEntry('ou', 'sm.original_unit_id')}
     ${joinUnitEntry('bu', 'sm.base_unit_id')}
     LEFT JOIN users u ON u.id = sm.recorded_by
     WHERE sm.opening_balance_line_id = ANY($1::uuid[])
     ORDER BY sm.recorded_at ASC, sm.id ASC`,
    [lineIds]
  );
  const byLine = new Map<string, StockMovementRow[]>();
  for (const row of res.rows) {
    const movements = byLine.get(row.opening_balance_line_id) ?? [];
    movements.push({
      id: row.id,
      kind: row.kind,
      effective_date: row.effective_date,
      original_quantity: row.original_quantity,
      original_unit: { unit_id: row.original_unit_id, name: row.original_unit_name },
      base_unit: { unit_id: row.base_unit_id, name: row.base_unit_name },
      conversion_factor: row.conversion_factor,
      base_quantity: row.base_quantity,
      recorded_by: row.recorded_by,
      recorded_by_username: row.recorded_by_username ?? null,
      recorded_at: new Date(row.recorded_at).toISOString(),
    });
    byLine.set(row.opening_balance_line_id, movements);
  }
  return byLine;
}
