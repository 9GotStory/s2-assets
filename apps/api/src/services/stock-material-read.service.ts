import pg from 'pg';
import { containsPattern } from './asset-lookups.ts';
import { joinCatalogListEntry, joinUnitEntry, type NamedListEntry, type StockMaterialListKind } from './catalog-list-entries.ts';
import { comparedName } from './compared-name.ts';
import { lowStock, stockFiguresOf } from './current-stock.ts';
import { handlesUnit } from './stock-material-handles-unit.ts';

// One row of the Stock Material list (#175 Q15).
export interface StockMaterialRow {
  id: string;
  name: string;
  model: string | null;
  specification: string | null;
  is_active: boolean;
  base_unit: { unit_id: string; name: string };
  // F008-T4 (#179): each under the name its list entry has now, or none.
  brand: NamedListEntry | null;
  material_category: NamedListEntry | null;
  // F008-T6 (#182): in the Base Unit, a decimal string without trailing zeros (#175 P1), or none (MC-20).
  minimum_stock: string | null;
}

// F010-T2 (#233): what a Stock Material's Stock Movements give it, from the one SQL source (current-stock.ts, #231 P3).
export interface StockFigures {
  // Current Stock (คงเหลือ) in the Base Unit, a decimal string without trailing zeros, or none while it has no Stock
  // Movement (ยังไม่มีรายการเคลื่อนไหว, Q22).
  current_stock: string | null;
  has_stock_movement: boolean;
  // ต่ำกว่าขั้นต่ำ (MC-20).
  low_stock: boolean;
}

// One row of the Stock Material list, with its stock (F010-T2, #231 Q14).
export interface StockMaterialListRow extends StockMaterialRow, StockFigures {}

export interface StockMaterialListFilters {
  // Text found in the name, the Brand's name, the Model or the Specification (#175 Q15, MC-10).
  search?: string;
  // F008-T4 (#179): the Material Category's id, or 'none' for the Stock Materials with none (#175 Q3).
  material_category_id?: string;
  // F008-T6 (#182): whether the Stock Material has a Minimum Stock (#175 MC-20).
  minimum_stock?: 'set' | 'not_set';
  // F008-T7 (#180): the Stock Materials in use (ใช้งานอยู่), the Inactive ones (หยุดใช้), or all (#175 MC-14, Q13).
  status: 'active' | 'inactive' | 'all';
  // F010-T2 (#233): only the Low Stock ones (ต่ำกว่าขั้นต่ำ, #231 Q14).
  low_stock?: boolean;
  limit: number;
  offset: number;
}

export interface StockMaterialList {
  items: StockMaterialListRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// F008-T5 (#181, #175 P4): the most Duplicate Candidates a lookup or a warning lists.
export const DUPLICATE_CANDIDATES_LIMIT = 50;

// The Duplicate Candidates of a name, in Feature 002's shape: at most DUPLICATE_CANDIDATES_LIMIT, with how many there are.
export interface DuplicateCandidates {
  candidates: StockMaterialRow[];
  total_count: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

// One Unit of a Stock Material, under the name its list entry has now (#175 Q19).
export interface StockMaterialUnit {
  unit_id: string;
  name: string;
  // Whether the list entry is Inactive; a Stock Material keeps an Inactive Unit it already uses (Q21).
  unit_is_active: boolean;
  is_base: boolean;
  // A decimal string, without trailing zeros (#175 P1); null on an Inactive Alternate Unit given no new factor when
  // the Base Unit changed (F008-T3, #178).
  conversion_factor: string | null;
  whole_number_only: boolean;
  is_active: boolean;
}

// The kinds of change a history entry records: F008-T1 writes CREATED, T3 UNITS_CHANGED, T4 DETAILS_CHANGED
// (0027_brands_material_categories); T5 and T7 the others, which 0025_material_catalog already takes. T6 records the
// Minimum Stock in CREATED, DETAILS_CHANGED and UNITS_CHANGED (#182 decision 3).
export type StockMaterialHistoryKind = 'CREATED' | 'CORRECTED' | 'UNITS_CHANGED' | 'DETAILS_CHANGED' | 'INACTIVATED' | 'REACTIVATED';

// One value a history entry recorded, as it was before and after; a value created has none before.
export interface StockMaterialHistoryChange {
  field: string;
  before: unknown;
  after: unknown;
}

// One entry of a Stock Material's history, with the values it recorded as they were then (#175 Q18, P6).
export interface StockMaterialHistoryEntry {
  version: number;
  kind: StockMaterialHistoryKind;
  changes: StockMaterialHistoryChange[];
  reason: string | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

// F010-T2 (#233): with its Current Stock and Low Stock (#231 Q14).
export interface StockMaterialDetail extends StockFigures {
  id: string;
  name: string;
  // F008-T4 (#179): under the name its list entry has now (#175 Q19), or none (Q2).
  brand: NamedListEntry | null;
  model: string | null;
  specification: string | null;
  note: string | null;
  material_category: NamedListEntry | null;
  // F008-T6 (#182): in the Base Unit, a decimal string without trailing zeros (#175 P1), or none (MC-20).
  minimum_stock: string | null;
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
 * entry has now. A write reads them through `client` inside its transaction, for the history it records (#175 P6),
 * `locked`: each Unit's list entry is then locked FOR SHARE before its name is read, so that a rename waits for the
 * write or is seen by it (F008-T8, CODING_STANDARDS).
 */
export async function stockMaterialUnitsOf(client: pg.Pool | pg.PoolClient, stockMaterialId: string, { locked = false }: { locked?: boolean } = {}): Promise<StockMaterialUnit[]> {
  const res = await client.query(
    `SELECT su.unit_id, u.name, u.is_active AS unit_is_active, su.is_base, trim_scale(su.conversion_factor)::text AS conversion_factor,
            su.whole_number_only, su.is_active
     FROM stock_material_units su
     ${joinUnitEntry('u', 'su.unit_id')}
     WHERE su.stock_material_id = $1
     ORDER BY su.is_base DESC, lower(u.name) ASC, u.id ASC
     ${locked ? 'FOR SHARE OF u' : ''}`,
    [stockMaterialId]
  );
  return res.rows;
}

// F009-T2 (#204): what a Compatible Stock Material write needs of the Stock Material it names.
export interface StockMaterialForCompatibility {
  // Its name now, which the Requestable Material's history records (#175 P6).
  name: string;
  is_active: boolean;
  // Whether its active Units include the Request Unit (ADR 0002).
  handles_request_unit: boolean;
}

/**
 * F009-T2 (#204): the Stock Material `stockMaterialId` as a write adding or ending a Compatible Stock Material reads it,
 * through `client` inside its transaction, or null when there is none. It locks the Stock Material FOR SHARE: making it
 * Inactive or reactivating it, a Units write and a Material Correction each lock it FOR UPDATE first, so each waits for
 * the write or is seen by it (#204 start decision 3, comment 7075904252).
 */
export async function stockMaterialForCompatibility(client: pg.PoolClient, stockMaterialId: string, requestUnitId: string): Promise<StockMaterialForCompatibility | null> {
  const locked = await lockedStockMaterial(client, stockMaterialId);
  if (locked === null) {
    return null;
  }
  // A statement of its own, whose snapshot follows the lock: one in the locking statement would miss a Units write
  // committed while it waited (PostgreSQL 18, §13.2.1).
  const handled = await client.query(`SELECT ${handlesUnit('$1::uuid', '$2::uuid')} AS handles_request_unit`, [stockMaterialId, requestUnitId]);
  return { ...locked, handles_request_unit: handled.rows[0].handles_request_unit };
}

/**
 * F009-T2 (#204): the name and status of the Stock Material `stockMaterialId`, locked FOR SHARE as
 * `stockMaterialForCompatibility` locks it, or null when there is none: what an end records (#175 P6).
 */
export async function lockedStockMaterial(client: pg.PoolClient, stockMaterialId: string): Promise<{ name: string; is_active: boolean } | null> {
  const res = await client.query('SELECT name, is_active FROM stock_materials WHERE id = $1 FOR SHARE', [stockMaterialId]);
  return res.rows[0] ?? null;
}

/**
 * F010-T2 (#233): the names of the Stock Materials `ids`, by id, each locked FOR UPDATE in id order, as a write that
 * adds Stock Movements locks them (#231 P4). A Units write and a Material Correction lock a Stock Material FOR UPDATE
 * too, so each waits for the write or is seen by it. An id with no Stock Material is left out.
 */
export async function lockedStockMaterialsForStock(client: pg.PoolClient, ids: string[]): Promise<Map<string, string>> {
  const res = await client.query('SELECT id, name FROM stock_materials WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  return new Map(res.rows.map((row: any) => [row.id, row.name]));
}

// F009-T2 (#204): a Stock Material as a Requestable Material's page lists it among its Compatible Stock Materials.
export interface StockMaterialSummary {
  stock_material_id: string;
  name: string;
  is_active: boolean;
  units: StockMaterialUnit[];
}

/** F009-T2 (#204): the Stock Materials `ids`, by name, each with its status and its Units (#202 Q19). */
export async function stockMaterialSummariesOf(runner: pg.Pool | pg.PoolClient, ids: string[]): Promise<StockMaterialSummary[]> {
  const res = await runner.query('SELECT id, name, is_active FROM stock_materials WHERE id = ANY($1::uuid[]) ORDER BY lower(name) ASC, id ASC', [ids]);
  return Promise.all(
    res.rows.map(async (row: any) => ({ stock_material_id: row.id, name: row.name, is_active: row.is_active, units: await stockMaterialUnitsOf(runner, row.id) }))
  );
}

// How many Stock Materials name each entry of a list: a Unit as the Base Unit or an Alternate Unit, a Brand or a
// Material Category as its own; those naming none count under no entry's id.
const USAGE_QUERIES: Record<StockMaterialListKind, string> = {
  unit: 'SELECT unit_id AS id, count(*)::int AS usage_count FROM stock_material_units GROUP BY unit_id',
  brand: 'SELECT brand_id AS id, count(*)::int AS usage_count FROM stock_materials GROUP BY brand_id',
  'material-category': 'SELECT material_category_id AS id, count(*)::int AS usage_count FROM stock_materials GROUP BY material_category_id',
};

/**
 * F008-T8 (#183): how many Stock Materials name each entry of the list `kind`, by its id, which a rename shows before
 * saving (#175 Q19). It counts every one the new name would show on: Inactive Stock Materials and Inactive Alternate
 * Units included (#183 decision 3). An entry that none names is left out.
 */
export async function stockMaterialUsageOf(runner: pg.Pool | pg.PoolClient, kind: StockMaterialListKind): Promise<Map<string, number>> {
  const res = await runner.query(USAGE_QUERIES[kind]);
  return new Map(res.rows.map((row: { id: string; usage_count: number }) => [row.id, row.usage_count]));
}

// The entry a row joined as `<prefix>_id` and `<prefix>_name`, or null when it names none.
const namedEntryOf = (row: any, prefix: string): NamedListEntry | null =>
  row[`${prefix}_id`] === null ? null : { id: row[`${prefix}_id`], name: row[`${prefix}_name`] };

const toRow = (row: any): StockMaterialRow => ({
  id: row.id,
  name: row.name,
  model: row.model,
  specification: row.specification,
  is_active: row.is_active,
  base_unit: { unit_id: row.base_unit_id, name: row.base_unit_name },
  brand: namedEntryOf(row, 'brand'),
  material_category: namedEntryOf(row, 'material_category'),
  minimum_stock: row.minimum_stock,
});

const toListRow = (row: any): StockMaterialListRow => ({
  ...toRow(row),
  current_stock: row.current_stock,
  has_stock_movement: row.has_stock_movement,
  low_stock: row.low_stock,
});

// The Stock Materials that every one of `conditions` passes, over `params`, a page of them by name with their count.
async function pageOf<Item>(
  runner: pg.Pool | pg.PoolClient,
  conditions: string[],
  params: unknown[],
  limit: number,
  offset: number,
  toItem: (row: any) => Item
): Promise<Omit<StockMaterialList, 'items'> & { items: Item[] }> {
  // F010-T2 (#233): a row reads its stock figures as `f`, which a condition may filter on; only the list shows them.
  const values = [...params, limit, offset];
  // The count joins the page, so a page past the end still says how many Stock Materials pass.
  const res = await runner.query(
    `WITH filtered AS (
       SELECT m.id, m.name, m.model, m.specification, trim_scale(m.minimum_stock)::text AS minimum_stock, m.is_active, u.id AS base_unit_id, u.name AS base_unit_name,
              br.id AS brand_id, br.name AS brand_name, mc.id AS material_category_id, mc.name AS material_category_name,
              trim_scale(f.current_stock)::text AS current_stock, f.has_stock_movement, ${lowStock('f', 'm.minimum_stock')} AS low_stock
       FROM stock_materials m
       JOIN stock_material_units b ON b.stock_material_id = m.id AND b.is_base
       ${joinUnitEntry('u', 'b.unit_id')}
       ${joinCatalogListEntry('brand', 'br', 'm.brand_id')}
       ${joinCatalogListEntry('material-category', 'mc', 'm.material_category_id')}
       CROSS JOIN LATERAL ${stockFiguresOf('m.id')} f
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ),
     counted AS (SELECT count(*)::int AS total_count FROM filtered),
     paged AS (
       SELECT * FROM filtered
       ORDER BY lower(name) ASC, id ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}
     )
     SELECT p.*, c.total_count
     FROM counted c
     LEFT JOIN paged p ON true
     ORDER BY lower(p.name) ASC, p.id ASC`,
    values
  );
  const totalCount: number = res.rows[0]?.total_count ?? 0;
  const items = res.rows.filter((row: any) => row.id !== null).map(toItem);
  return { items, limit, offset, total_count: totalCount, has_more: offset + items.length < totalCount };
}

// The condition of a text search over the name, the Brand's name, the Model and the Specification (#175 Q15, MC-10),
// its pattern pushed onto `params`.
const searchCondition = (params: unknown[], search: string): string => {
  params.push(containsPattern(search));
  const pattern = `$${params.length}`;
  return `(m.name ILIKE ${pattern} ESCAPE '\\' OR br.name ILIKE ${pattern} ESCAPE '\\' OR m.model ILIKE ${pattern} ESCAPE '\\' OR m.specification ILIKE ${pattern} ESCAPE '\\')`;
};

// F009-T2 (#204): a Stock Material a Supply Officer may choose as a Compatible Stock Material.
export interface StockMaterialChoice extends StockMaterialRow {
  // Whether its active Units include the Request Unit; one that does not is shown greyed (#202 Q19, ADR 0002).
  handles_request_unit: boolean;
}

export interface StockMaterialChoices extends Omit<StockMaterialList, 'items'> {
  items: StockMaterialChoice[];
}

/**
 * F009-T2 (#204): a page of the active Stock Materials found by `search` as the Stock Material list finds them, by
 * name, each saying whether its active Units include the Unit `requestUnitId` (#202 Q8, Q19). It suggests nothing:
 * a match is never a compatibility (MRQ-15, MRQ-26).
 */
export async function stockMaterialChoicesOf(
  runner: pg.Pool | pg.PoolClient,
  requestUnitId: string,
  { search, limit, offset }: { search?: string; limit: number; offset: number }
): Promise<StockMaterialChoices> {
  const params: unknown[] = [];
  const conditions = ['m.is_active'];
  if (search !== undefined) {
    conditions.push(searchCondition(params, search));
  }
  const page = await pageOf(runner, conditions, params, limit, offset, toRow);
  const handled = await runner.query(`SELECT m.id, ${handlesUnit('m.id', '$2')} AS handles_request_unit FROM stock_materials m WHERE m.id = ANY($1::uuid[])`, [
    page.items.map(({ id }) => id),
    requestUnitId,
  ]);
  const handles = new Map<string, boolean>(handled.rows.map((row: any) => [row.id, row.handles_request_unit]));
  return { ...page, items: page.items.map((item) => ({ ...item, handles_request_unit: handles.get(item.id)! })) };
}

/**
 * F008-T5 (#181): the Duplicate Candidates of `name`: every Stock Material, Inactive ones included, whose name equals
 * it, contains it or is contained in it, ignoring case and repeated spaces (#175 MC-17, Q12), but `excludedId`. The
 * lookup and the writes that warn of them all read them here, a write through `client` inside its transaction.
 */
export async function duplicateCandidatesOf(runner: pg.Pool | pg.PoolClient, name: string, excludedId: string | null = null): Promise<DuplicateCandidates> {
  const condition = `(strpos(${comparedName('m.name')}, ${comparedName('$1')}) > 0 OR strpos(${comparedName('$1')}, ${comparedName('m.name')}) > 0)`;
  const conditions = excludedId === null ? [condition] : [condition, 'm.id <> $2'];
  const page = await pageOf(runner, conditions, excludedId === null ? [name] : [name, excludedId], DUPLICATE_CANDIDATES_LIMIT, 0, toRow);
  return { candidates: page.items, total_count: page.total_count, has_more: page.has_more, limit: page.limit, offset: page.offset };
}

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
      conditions.push(searchCondition(params, filters.search));
    }
    if (filters.material_category_id === 'none') {
      conditions.push('m.material_category_id IS NULL');
    } else if (filters.material_category_id !== undefined) {
      params.push(filters.material_category_id);
      conditions.push(`m.material_category_id = $${params.length}`);
    }
    if (filters.minimum_stock !== undefined) {
      conditions.push(`m.minimum_stock IS ${filters.minimum_stock === 'set' ? 'NOT NULL' : 'NULL'}`);
    }
    if (filters.status !== 'all') {
      conditions.push(filters.status === 'active' ? 'm.is_active' : 'NOT m.is_active');
    }
    if (filters.low_stock) {
      conditions.push(lowStock('f', 'm.minimum_stock'));
    }
    return pageOf(this.db, conditions, params, filters.limit, filters.offset, toListRow);
  }

  /** F008-T5 (#181): the Duplicate Candidates of `name`, but the Stock Material `excludedId`. */
  async duplicateCandidates(name: string, excludedId: string | null): Promise<DuplicateCandidates> {
    return duplicateCandidatesOf(this.db, name, excludedId);
  }

  /** A Stock Material with its Units and its history, or null when there is none. */
  async read(id: string): Promise<StockMaterialDetail | null> {
    const res = await this.db.query(
      `SELECT m.id, m.name, m.model, m.specification, m.note, trim_scale(m.minimum_stock)::text AS minimum_stock,
              trim_scale(f.current_stock)::text AS current_stock, f.has_stock_movement, ${lowStock('f', 'm.minimum_stock')} AS low_stock,
              m.is_active, m.version, m.created_by, u.username AS created_by_username, m.recorded_at,
              b.id AS brand_id, b.name AS brand_name, c.id AS material_category_id, c.name AS material_category_name
       FROM stock_materials m
       CROSS JOIN LATERAL ${stockFiguresOf('m.id')} f
       LEFT JOIN users u ON u.id = m.created_by
       ${joinCatalogListEntry('brand', 'b', 'm.brand_id')}
       ${joinCatalogListEntry('material-category', 'c', 'm.material_category_id')}
       WHERE m.id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const { brand_id: _brandId, brand_name: _brandName, material_category_id: _categoryId, material_category_name: _categoryName, ...material } = row;
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
      brand: namedEntryOf(row, 'brand'),
      material_category: namedEntryOf(row, 'material_category'),
      created_by_username: material.created_by_username ?? null,
      recorded_at: new Date(material.recorded_at).toISOString(),
      units,
      history: history.rows.map((row: any) => ({ ...row, recorded_by_username: row.recorded_by_username ?? null, recorded_at: new Date(row.recorded_at).toISOString() })),
    };
  }
}
