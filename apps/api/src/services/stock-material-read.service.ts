import pg from 'pg';
import { containsPattern } from './asset-lookups.ts';
import { joinUnitEntry } from './unit-entries.ts';

// One row of the Stock Material list (#175 Q15).
export interface StockMaterialRow {
  id: string;
  name: string;
  model: string | null;
  specification: string | null;
  is_active: boolean;
  base_unit: { unit_id: string; name: string };
}

export interface StockMaterialListFilters {
  // Text found in the name, the Model or the Specification (#175 Q15, MC-10).
  search?: string;
  limit: number;
  offset: number;
}

export interface StockMaterialList {
  items: StockMaterialRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// One Unit of a Stock Material, under the name its list entry has now (#175 Q19).
export interface StockMaterialUnit {
  unit_id: string;
  name: string;
  // Whether the list entry is Inactive; a Stock Material keeps an Inactive Unit it already uses (Q21).
  unit_is_active: boolean;
  is_base: boolean;
  // A decimal string, without trailing zeros (#175 P1); null when unknown, which only an Inactive Alternate Unit can
  // be, as when the Base Unit changed and it got no new factor (F008-T3, #178).
  conversion_factor: string | null;
  whole_number_only: boolean;
  is_active: boolean;
}

// The kinds of change a history entry records: F008-T1 writes CREATED, T3 UNITS_CHANGED; T5 and T7 the others, which
// 0025_material_catalog already takes. T4 and T6 add theirs with their own migrations.
export type StockMaterialHistoryKind = 'CREATED' | 'CORRECTED' | 'UNITS_CHANGED' | 'INACTIVATED' | 'REACTIVATED';

// One entry of a Stock Material's history, with the values it recorded as they were then (#175 Q18, P6).
export interface StockMaterialHistoryEntry {
  version: number;
  kind: StockMaterialHistoryKind;
  changes: { field: string; before: unknown; after: unknown }[];
  reason: string | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface StockMaterialDetail {
  id: string;
  name: string;
  model: string | null;
  specification: string | null;
  note: string | null;
  is_active: boolean;
  version: number;
  created_by: string;
  created_by_username: string | null;
  recorded_at: string;
  // The Base Unit first, then the Alternate Units by name.
  units: StockMaterialUnit[];
  // Oldest first.
  history: StockMaterialHistoryEntry[];
}

/**
 * A Stock Material's Units, the Base Unit first and then the Alternate Units by name, each under the name its list
 * entry has now. A write reads them through `client` inside its transaction, for the history it records (#175 P6).
 */
export async function stockMaterialUnitsOf(client: pg.Pool | pg.PoolClient, stockMaterialId: string): Promise<StockMaterialUnit[]> {
  const res = await client.query(
    `SELECT su.unit_id, u.name, u.is_active AS unit_is_active, su.is_base, trim_scale(su.conversion_factor)::text AS conversion_factor,
            su.whole_number_only, su.is_active
     FROM stock_material_units su
     ${joinUnitEntry('u', 'su.unit_id')}
     WHERE su.stock_material_id = $1
     ORDER BY su.is_base DESC, lower(u.name) ASC, u.id ASC`,
    [stockMaterialId]
  );
  return res.rows;
}

const toRow = (row: any): StockMaterialRow => ({
  id: row.id,
  name: row.name,
  model: row.model,
  specification: row.specification,
  is_active: row.is_active,
  base_unit: { unit_id: row.base_unit_id, name: row.base_unit_name },
});

/** F008-T1 (#176): the Stock Material catalog's reads: the list and a Stock Material's page. */
export class StockMaterialReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  async list(filters: StockMaterialListFilters): Promise<StockMaterialList> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (filters.search !== undefined) {
      params.push(containsPattern(filters.search));
      conditions.push(`(m.name ILIKE $1 ESCAPE '\\' OR m.model ILIKE $1 ESCAPE '\\' OR m.specification ILIKE $1 ESCAPE '\\')`);
    }
    params.push(filters.limit, filters.offset);

    // The count joins the page, so a page past the end still says how many Stock Materials pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT m.id, m.name, m.model, m.specification, m.is_active, u.id AS base_unit_id, u.name AS base_unit_name
         FROM stock_materials m
         JOIN stock_material_units b ON b.stock_material_id = m.id AND b.is_base
         ${joinUnitEntry('u', 'b.unit_id')}
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY lower(name) ASC, id ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}
       )
       SELECT p.*, c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       ORDER BY lower(p.name) ASC, p.id ASC`,
      params
    );
    const totalCount: number = res.rows[0]?.total_count ?? 0;
    const items = res.rows.filter((row: any) => row.id !== null).map(toRow);
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /** A Stock Material with its Units and its history, or null when there is none. */
  async read(id: string): Promise<StockMaterialDetail | null> {
    const res = await this.db.query(
      `SELECT m.id, m.name, m.model, m.specification, m.note, m.is_active, m.version, m.created_by, u.username AS created_by_username, m.recorded_at
       FROM stock_materials m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.id = $1`,
      [id]
    );
    const material = res.rows[0];
    if (!material) {
      return null;
    }
    const units = await stockMaterialUnitsOf(this.db, id);
    const history = await this.db.query(
      `SELECT h.version, h.kind, h.changes, h.reason, h.note, h.recorded_by, u.username AS recorded_by_username, h.recorded_at
       FROM stock_material_history h
       LEFT JOIN users u ON u.id = h.recorded_by
       WHERE h.stock_material_id = $1
       ORDER BY h.version ASC`,
      [id]
    );
    return {
      ...material,
      created_by_username: material.created_by_username ?? null,
      recorded_at: new Date(material.recorded_at).toISOString(),
      units,
      history: history.rows.map((row: any) => ({ ...row, recorded_by_username: row.recorded_by_username ?? null, recorded_at: new Date(row.recorded_at).toISOString() })),
    };
  }
}
