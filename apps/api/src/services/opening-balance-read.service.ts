import pg from 'pg';
import { containsPattern } from './asset-lookups.ts';
import { joinUnitEntry } from './catalog-list-entries.ts';
import { openingBalanceState, type OpeningBalanceState } from './opening-balance-state.ts';
import { joinStockMaterial } from './stock-material-joins.ts';
import { stockMovementsOfOpeningBalanceLines, type StockMovementRow } from './stock-movements.ts';

// One row of the Opening Balance list (#233 start decision 4).
export interface OpeningBalanceRow {
  id: string;
  // A bigint as a string of digits, or none while Draft (P10).
  opening_balance_number: string | null;
  as_of_date: string | null;
  source: string | null;
  state: OpeningBalanceState;
  line_count: number;
  created_at: string;
}

export interface OpeningBalanceListFilters {
  // Text found in the number, the source or a line's Stock Material name.
  search?: string;
  state?: OpeningBalanceState;
  limit: number;
  offset: number;
}

export interface OpeningBalanceList {
  items: OpeningBalanceRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// A line as an Opening Balance's page shows it, each name as it is now, with the Stock Movements it made (story 58).
export interface OpeningBalanceLine {
  id: string;
  position: number;
  stock_material: { id: string; name: string; is_active: boolean };
  unit: { unit_id: string; name: string } | null;
  quantity: string | null;
  note: string | null;
  is_voided: boolean;
  // Its one Stock Movement in effect, or none.
  stock_movement_id: string | null;
  stock_movements: StockMovementRow[];
}

export interface OpeningBalanceHistoryEntry {
  version: number;
  kind: 'CONFIRMED' | 'CORRECTED' | 'VOIDED';
  // What the entry records, with names as they were then (#175 P6).
  facts: Record<string, unknown>;
  reason: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface OpeningBalanceDetail {
  id: string;
  opening_balance_number: string | null;
  as_of_date: string | null;
  source: string | null;
  note: string | null;
  state: OpeningBalanceState;
  version: number;
  created_by: string;
  created_by_username: string | null;
  created_at: string;
  confirmed_by: string | null;
  confirmed_by_username: string | null;
  confirmed_at: string | null;
  lines: OpeningBalanceLine[];
  // Oldest first; none while Draft (P1).
  history: OpeningBalanceHistoryEntry[];
}

const isoOrNull = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());

/** F010-T2 (#233): the Opening Balance reads: the list and an Opening Balance's page, Drafts included (P8). */
export class OpeningBalanceReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** The Opening Balances, newest first, a page at a time, with how many pass the filters. */
  async list(filters: OpeningBalanceListFilters): Promise<OpeningBalanceList> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (filters.state !== undefined) {
      params.push(filters.state);
      conditions.push(`${openingBalanceState('ob')} = $${params.length}`);
    }
    if (filters.search !== undefined) {
      params.push(containsPattern(filters.search));
      const pattern = `$${params.length}`;
      conditions.push(`(ob.opening_balance_number::text ILIKE ${pattern} ESCAPE '\\' OR ob.source ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM opening_balance_lines sl ${joinStockMaterial('sm', 'sl.stock_material_id')}
                   WHERE sl.opening_balance_id = ob.id AND sm.name ILIKE ${pattern} ESCAPE '\\'))`);
    }
    const values = [...params, filters.limit, filters.offset];
    // The count joins the page, so a page past the end still says how many pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT ob.id, ob.opening_balance_number::text AS opening_balance_number, ob.as_of_date::text AS as_of_date, ob.source,
                ${openingBalanceState('ob')} AS state, ob.created_at,
                (SELECT count(*)::int FROM opening_balance_lines cl WHERE cl.opening_balance_id = ob.id) AS line_count
         FROM opening_balances ob
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}
       )
       SELECT p.*, c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       ORDER BY p.created_at DESC, p.id DESC`,
      values
    );
    const totalCount: number = res.rows[0]?.total_count ?? 0;
    const items = res.rows
      .filter((row: any) => row.id !== null)
      .map(({ total_count: _count, created_at: createdAt, ...row }: any) => ({ ...row, created_at: new Date(createdAt).toISOString() }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /** An Opening Balance with its lines, their Stock Movements and its history, or null when there is none. */
  async read(id: string): Promise<OpeningBalanceDetail | null> {
    const res = await this.db.query(
      `SELECT ob.id, ob.opening_balance_number::text AS opening_balance_number, ob.as_of_date::text AS as_of_date, ob.source, ob.note,
              ${openingBalanceState('ob')} AS state, ob.version, ob.created_by, cu.username AS created_by_username, ob.created_at,
              ob.confirmed_by, fu.username AS confirmed_by_username, ob.confirmed_at
       FROM opening_balances ob
       LEFT JOIN users cu ON cu.id = ob.created_by
       LEFT JOIN users fu ON fu.id = ob.confirmed_by
       WHERE ob.id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const lines = await this.db.query(
      `SELECT l.id, l.position, l.stock_material_id, sm.name AS stock_material_name, sm.is_active AS stock_material_is_active,
              l.unit_id, u.name AS unit_name, trim_scale(l.quantity)::text AS quantity, l.note, l.is_voided, l.stock_movement_id
       FROM opening_balance_lines l
       ${joinStockMaterial('sm', 'l.stock_material_id')}
       LEFT ${joinUnitEntry('u', 'l.unit_id')}
       WHERE l.opening_balance_id = $1
       ORDER BY l.position`,
      [id]
    );
    const movements = await stockMovementsOfOpeningBalanceLines(
      this.db,
      lines.rows.map((line: any) => line.id)
    );
    const history = await this.db.query(
      `SELECT h.version, h.kind, h.facts, h.reason, h.recorded_by, u.username AS recorded_by_username, h.recorded_at
       FROM opening_balance_history h
       LEFT JOIN users u ON u.id = h.recorded_by
       WHERE h.opening_balance_id = $1
       ORDER BY h.version ASC`,
      [id]
    );
    return {
      ...row,
      created_by_username: row.created_by_username ?? null,
      confirmed_by_username: row.confirmed_by_username ?? null,
      created_at: new Date(row.created_at).toISOString(),
      confirmed_at: isoOrNull(row.confirmed_at),
      lines: lines.rows.map((line: any) => ({
        id: line.id,
        position: line.position,
        stock_material: { id: line.stock_material_id, name: line.stock_material_name, is_active: line.stock_material_is_active },
        unit: line.unit_id === null ? null : { unit_id: line.unit_id, name: line.unit_name },
        quantity: line.quantity,
        note: line.note,
        is_voided: line.is_voided,
        stock_movement_id: line.stock_movement_id,
        stock_movements: movements.get(line.id) ?? [],
      })),
      history: history.rows.map((entry: any) => ({
        ...entry,
        recorded_by_username: entry.recorded_by_username ?? null,
        recorded_at: new Date(entry.recorded_at).toISOString(),
      })),
    };
  }
}

// F010-T3 (#234): an Opening Balance holding a Stock Material's Stock Movement in effect, with its As-of Date (#231 Q21).
export interface InEffectOpeningBalance {
  opening_balance_id: string;
  opening_balance_number: string;
  as_of_date: string;
}

/**
 * F010-T3 (#234): of the Stock Materials `ids`, those with an Opening Balance in effect, each with the Opening Balance
 * whose line points at its Stock Movement in effect (MSL-04): at most one, by
 * `opening_balance_lines_one_in_effect_per_stock_material`. A write reads it under the Stock Material lock (#231 P4).
 */
export async function openingBalancesInEffectOf(runner: pg.Pool | pg.PoolClient, ids: string[]): Promise<Map<string, InEffectOpeningBalance>> {
  const res = await runner.query(
    `SELECT l.stock_material_id, ob.id AS opening_balance_id, ob.opening_balance_number::text AS opening_balance_number, ob.as_of_date::text AS as_of_date
     FROM opening_balance_lines l
     JOIN opening_balances ob ON ob.id = l.opening_balance_id
     WHERE l.stock_material_id = ANY($1::uuid[]) AND l.stock_movement_id IS NOT NULL`,
    [ids]
  );
  return new Map(res.rows.map(({ stock_material_id: id, ...openingBalance }: any) => [id, openingBalance]));
}
