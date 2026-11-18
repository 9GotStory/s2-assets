import pg from 'pg';
import { containsPattern } from './asset-lookups.ts';

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
  // A decimal string, without trailing zeros (#175 P1).
  conversion_factor: string;
  whole_number_only: boolean;
  is_active: boolean;
}

// One entry of a Stock Material's history, with the values it recorded as they were then (#175 Q18, P6).
export interface StockMaterialHistoryEntry {
  version: number;
  kind: string;
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
         JOIN units u ON u.id = b.unit_id
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
    const units = await this.db.query(
      `SELECT su.unit_id, u.name, u.is_active AS unit_is_active, su.is_base, trim_scale(su.conversion_factor)::text AS conversion_factor,
              su.whole_number_only, su.is_active
       FROM stock_material_units su
       JOIN units u ON u.id = su.unit_id
       WHERE su.stock_material_id = $1
       ORDER BY su.is_base DESC, lower(u.name) ASC, u.id ASC`,
      [id]
    );
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
      units: units.rows,
      history: history.rows.map((row: any) => ({ ...row, recorded_by_username: row.recorded_by_username ?? null, recorded_at: new Date(row.recorded_at).toISOString() })),
    };
  }
}
