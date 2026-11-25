import pg from 'pg';
import type { ConversionSnapshot } from './base-quantity.ts';
import { joinUnitEntry } from './catalog-list-entries.ts';
import { fiscalYearsOf, inFiscalYear, stockLedgerOf } from './current-stock.ts';
import { joinMaterialReceiptOfLine } from './material-receipt-line-joins.ts';
import { joinOpeningBalanceOfLine } from './opening-balance-line-joins.ts';
import { joinStockMaterial } from './stock-material-joins.ts';

// F010-T2 (#233), T3 (#234): the module that owns stock_movements, the one table of Stock Movements (รายการเคลื่อนไหว) that
// Features 010 to 014 share (ADR 0003, #231 P2). Rows are only ever added: a trigger refuses every UPDATE and DELETE.
// What they add up to is read through current-stock.ts.

// The kinds 0032_opening_balances_stock_movements and 0034_material_receipts allow; T6 and T7 write the Reversals
// through `reverseStockMovement`.
export type StockMovementKind = 'OPENING_BALANCE' | 'MATERIAL_RECEIPT' | 'REVERSAL';

// A Stock Movement made by an Opening Balance line (T2) or a Receipt Line (T3), each kind naming its own source line,
// as Feature 008's quantity normalization gave it (#231 Numbers).
export type NewStockMovement = NewStockMovementFacts &
  ({ kind: 'OPENING_BALANCE'; opening_balance_line_id: string } | { kind: 'MATERIAL_RECEIPT'; material_receipt_line_id: string });

interface NewStockMovementFacts {
  stock_material_id: string;
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
    `INSERT INTO stock_movements (stock_material_id, kind, opening_balance_line_id, material_receipt_line_id, effective_date, original_quantity,
                                  original_unit_id, base_unit_id, conversion_factor, base_quantity, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      movement.stock_material_id,
      movement.kind,
      movement.kind === 'OPENING_BALANCE' ? movement.opening_balance_line_id : null,
      movement.kind === 'MATERIAL_RECEIPT' ? movement.material_receipt_line_id : null,
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

/**
 * F010-T6 (#237): adds, through `client` inside its write's transaction, the Reversal (กลับรายการ) of the Stock Movement
 * `stockMovementId`, recorded by `recordedBy`, and answers its id. It takes the movement back in full on its Effective
 * Date, with its source line, Original Quantity and Conversion Snapshot (ADR 0003; #231 P2, P9). The unique reference
 * refuses a second Reversal of one Stock Movement, and the reversal check refuses a Reversal of a Reversal.
 */
export async function reverseStockMovement(client: pg.PoolClient, stockMovementId: string, recordedBy: string): Promise<string> {
  const res = await client.query(
    `INSERT INTO stock_movements (stock_material_id, kind, opening_balance_line_id, material_receipt_line_id, reverses_stock_movement_id, effective_date,
                                  original_quantity, original_unit_id, base_unit_id, conversion_factor, base_quantity, recorded_by)
     SELECT stock_material_id, 'REVERSAL', opening_balance_line_id, material_receipt_line_id, id, effective_date,
            original_quantity, original_unit_id, base_unit_id, conversion_factor, -base_quantity, $2
     FROM stock_movements WHERE id = $1
     RETURNING id`,
    [stockMovementId, recordedBy]
  );
  return res.rows[0].id;
}

// F010-T6 (#237): what a correction reads of a line's Stock Movement in effect: its Conversion Snapshot and Base Quantity.
export interface StockMovementInEffect {
  conversion_snapshot: ConversionSnapshot;
  base_quantity: string;
}

/** F010-T6 (#237): the Stock Movements `ids`, by id, as a correction of their source lines reads them (#231 Q29). */
export async function stockMovementsInEffectOf(runner: pg.Pool | pg.PoolClient, ids: string[]): Promise<Map<string, StockMovementInEffect>> {
  const res = await runner.query(
    `SELECT id, original_unit_id, base_unit_id, trim_scale(conversion_factor)::text AS conversion_factor, trim_scale(base_quantity)::text AS base_quantity
     FROM stock_movements WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(
    res.rows.map((row: any) => [
      row.id,
      { conversion_snapshot: { unit_id: row.original_unit_id, base_unit_id: row.base_unit_id, conversion_factor: row.conversion_factor }, base_quantity: row.base_quantity },
    ])
  );
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
export const stockMovementsOfOpeningBalanceLines = (runner: pg.Pool | pg.PoolClient, lineIds: string[]): Promise<Map<string, StockMovementRow[]>> =>
  stockMovementsOfLines(runner, 'opening_balance_line_id', lineIds);

/** F010-T3 (#234): the Stock Movements of the Receipt Lines `lineIds`, by line id, oldest first, as above (story 58). */
export const stockMovementsOfMaterialReceiptLines = (runner: pg.Pool | pg.PoolClient, lineIds: string[]): Promise<Map<string, StockMovementRow[]>> =>
  stockMovementsOfLines(runner, 'material_receipt_line_id', lineIds);

// The columns of the Stock Movement `alias` that `stockMovementOf` reads, its Units' names and who recorded it among
// them, from the joins of `joinStockMovementNames`.
const stockMovementColumns = (alias: string): string =>
  `${alias}.id, ${alias}.kind, ${alias}.effective_date::text AS effective_date, trim_scale(${alias}.original_quantity)::text AS original_quantity,
   ${alias}.original_unit_id, ou.name AS original_unit_name, ${alias}.base_unit_id, bu.name AS base_unit_name,
   trim_scale(${alias}.conversion_factor)::text AS conversion_factor, trim_scale(${alias}.base_quantity)::text AS base_quantity,
   ${alias}.recorded_by, u.username AS recorded_by_username, ${alias}.recorded_at`;

const joinStockMovementNames = (alias: string): string =>
  `LEFT ${joinUnitEntry('ou', `${alias}.original_unit_id`)}
   LEFT ${joinUnitEntry('bu', `${alias}.base_unit_id`)}
   LEFT JOIN users u ON u.id = ${alias}.recorded_by`;

const stockMovementOf = (row: any): StockMovementRow => ({
  id: row.id,
  kind: row.kind,
  effective_date: row.effective_date,
  original_quantity: row.original_quantity,
  original_unit: { unit_id: row.original_unit_id, name: row.original_unit_name },
  base_unit: { unit_id: row.base_unit_id, name: row.base_unit_name },
  conversion_factor: row.conversion_factor,
  base_quantity: row.base_quantity,
  recorded_by: row.recorded_by,
  recorded_by_username: row.recorded_by_username,
  recorded_at: new Date(row.recorded_at).toISOString(),
});

// The Stock Movements whose source line, in the column `column`, is one of `lineIds`, by line id, in the order they
// were recorded, a Reversal before the new Stock Movement of the same correction (#237 build decision 5).
async function stockMovementsOfLines(
  runner: pg.Pool | pg.PoolClient,
  column: 'opening_balance_line_id' | 'material_receipt_line_id',
  lineIds: string[]
): Promise<Map<string, StockMovementRow[]>> {
  const res = await runner.query(
    `SELECT sm.${column} AS line_id, ${stockMovementColumns('sm')}
     FROM stock_movements sm
     ${joinStockMovementNames('sm')}
     WHERE sm.${column} = ANY($1::uuid[])
     ORDER BY sm.recorded_at ASC, sm.kind <> 'REVERSAL', sm.id ASC`,
    [lineIds]
  );
  const byLine = new Map<string, StockMovementRow[]>();
  for (const row of res.rows) {
    const movements = byLine.get(row.line_id) ?? [];
    movements.push(stockMovementOf(row));
    byLine.set(row.line_id, movements);
  }
  return byLine;
}

// F010-T4 (#235): the record a Stock Movement's source line belongs to, by the line it names, so a Reversal (T6, T7)
// shows the record whose Stock Movement it reverses.
export interface StockMovementSource {
  kind: 'OPENING_BALANCE' | 'MATERIAL_RECEIPT';
  id: string;
  // Its running number, a bigint as digits.
  number: string;
}

// A row of a Stock Material's รายการเคลื่อนไหว table (#231 Q23, P6).
export interface StockLedgerRow extends StockMovementRow {
  source: StockMovementSource;
  // The stock right after it, in the Base Unit (P3).
  balance: string;
}

export interface StockLedgerFilters {
  // Only the Stock Movements whose Effective Date falls in this Fiscal Year (ปีงบประมาณ).
  fiscalYear?: number;
  limit: number;
  offset: number;
}

export interface StockLedger {
  items: StockLedgerRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  // Each Fiscal Year that holds one of its Stock Movements, newest first, whatever the filter (#235 start decision 2).
  fiscal_years: number[];
}

/** F010-T4 (#235): a Stock Material's Stock Movements (รายการเคลื่อนไหว), Inactive or not. */
export class StockMovementReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /**
   * The Stock Movements of the Stock Material `stockMaterialId`, oldest first in the business timeline, a page at a
   * time, each with the balance after it (#235 start decision 3), or null when there is no such Stock Material. A
   * Fiscal Year filter keeps each balance the whole ledger's (start decision 4).
   */
  async ledgerOf(stockMaterialId: string, filters: StockLedgerFilters): Promise<StockLedger | null> {
    const params: unknown[] = [stockMaterialId];
    const conditions: string[] = [];
    if (filters.fiscalYear !== undefined) {
      params.push(filters.fiscalYear);
      conditions.push(inFiscalYear('effective_date', `$${params.length}::int`));
    }
    const values = [...params, filters.limit, filters.offset];
    // The count and the Fiscal Years join the page, so a page past the end still says how many pass; the Stock Material
    // joins all three, so a Stock Material that does not exist gives no row. The filter runs over the ledger, after its
    // window.
    const res = await this.db.query(
      `WITH asked AS (SELECT m.id FROM (VALUES ($1::uuid)) AS ask (id) ${joinStockMaterial('m', 'ask.id')}),
            ledger AS (SELECT * FROM ${stockLedgerOf('$1::uuid')} timeline),
            filtered AS (SELECT * FROM ledger ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}),
            counted AS (SELECT count(*)::int AS total_count FROM filtered),
            years AS (SELECT ${fiscalYearsOf('effective_date')} AS fiscal_years FROM ledger),
            paged AS (SELECT * FROM filtered ORDER BY position LIMIT $${values.length - 1} OFFSET $${values.length})
       SELECT c.total_count, y.fiscal_years, ${stockMovementColumns('p')}, trim_scale(p.balance)::text AS balance,
              ob.id AS opening_balance_id, ob.opening_balance_number::text AS opening_balance_number,
              mr.id AS material_receipt_id, mr.receipt_number::text AS receipt_number
       FROM asked
       CROSS JOIN counted c
       CROSS JOIN years y
       LEFT JOIN paged p ON true
       ${joinStockMovementNames('p')}
       ${joinOpeningBalanceOfLine('ob', 'p.opening_balance_line_id')}
       ${joinMaterialReceiptOfLine('mr', 'p.material_receipt_line_id')}
       ORDER BY p.position`,
      values
    );
    if (res.rows.length === 0) {
      return null;
    }
    const totalCount: number = res.rows[0].total_count;
    const items: StockLedgerRow[] = res.rows
      .filter((row: any) => row.id !== null)
      .map((row: any) => ({
        ...stockMovementOf(row),
        source:
          row.opening_balance_id !== null
            ? { kind: 'OPENING_BALANCE', id: row.opening_balance_id, number: row.opening_balance_number }
            : { kind: 'MATERIAL_RECEIPT', id: row.material_receipt_id, number: row.receipt_number },
        balance: row.balance,
      }));
    return {
      items,
      limit: filters.limit,
      offset: filters.offset,
      total_count: totalCount,
      has_more: filters.offset + items.length < totalCount,
      fiscal_years: res.rows[0].fiscal_years,
    };
  }
}
