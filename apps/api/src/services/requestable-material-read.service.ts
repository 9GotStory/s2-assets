import pg from 'pg';
import { joinUnitEntry, type NamedListEntry } from './catalog-list-entries.ts';
import { comparedName } from './compared-name.ts';
import { pendingRequestedItemCount } from './material-request-pending-count.ts';
import { offered } from './requestable-material-offered.ts';
import { stockMaterialChoicesOf, stockMaterialSummariesOf, type StockMaterialChoices, type StockMaterialSummary } from './stock-material-read.service.ts';

// The Request Unit of a Requestable Material, under the name its list entry has now (#175 Q19).
export interface RequestUnit {
  unit_id: string;
  name: string;
  // Whether the list entry is Inactive; a Requestable Material keeps working with one (#202 Q15).
  unit_is_active: boolean;
}

// One row of the Requestable Material list (#202 Q19).
export interface RequestableMaterialRow {
  id: string;
  name: string;
  request_unit: RequestUnit;
  whole_number_only: boolean;
  is_active: boolean;
  // F009-T2 (#204): whether Requesters are offered it (#202 Q9); an active one that is not shows "ยังไม่มีวัสดุที่ใช้จ่าย".
  is_offered: boolean;
}

export interface RequestableMaterialListFilters {
  // Text found in the name, ignoring case and repeated spaces (#202 Q18).
  search?: string;
  // F009-T7 (#209): ใช้งานอยู่, หยุดใช้ or ทั้งหมด (#202 Q19).
  status: 'active' | 'inactive' | 'all';
  limit: number;
  offset: number;
}

export interface RequestableMaterialList {
  items: RequestableMaterialRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// The kinds of change a history entry records: F009-T1 writes CREATED, T2 the adds and ends of a Compatible Stock
// Material, T7 INACTIVATED and REACTIVATED; T8 adds RENAMED and DETAILS_CHANGED, which 0029_requestable_materials
// already takes.
export type RequestableMaterialHistoryKind = 'CREATED' | 'COMPATIBLE_STOCK_MATERIAL_ADDED' | 'COMPATIBLE_STOCK_MATERIAL_ENDED' | 'INACTIVATED' | 'REACTIVATED';

// One entry of a Requestable Material's history, with the values it recorded as they were then, the Request Unit as
// { id, name } (#202 Q17, #175 P6).
export interface RequestableMaterialHistoryEntry {
  version: number;
  kind: RequestableMaterialHistoryKind;
  changes: { field: string; before: string | boolean | NamedListEntry | null; after: string | boolean | NamedListEntry }[];
  recorded_by: string;
  recorded_by_username: string;
  recorded_at: string;
}

// F009-T2 (#204): a Compatible Stock Material (วัสดุที่ใช้จ่ายได้), with the Stock Material's name, status and Units
// now, current (ใช้อยู่) or ended (เลิกแล้ว) (#202 P1, Q19).
export interface CompatibleStockMaterial extends StockMaterialSummary {
  is_current: boolean;
}

export interface RequestableMaterialDetail extends RequestableMaterialRow {
  description: string | null;
  version: number;
  created_by: string;
  created_by_username: string;
  recorded_at: string;
  // The current ones first, each part by the Stock Material's name.
  compatible_stock_materials: CompatibleStockMaterial[];
  // Oldest first.
  history: RequestableMaterialHistoryEntry[];
  // F009-T7 (#209): how many Pending Requested Items ask for it, for the confirmation of making it Inactive or ending
  // its last Compatible Stock Material (#202 Q16, P6).
  pending_requested_item_count: number;
}

// F009-T4 (#206): one offered Requestable Material as a Requester finds it: its name, Request Unit, whole-number
// setting and description alone (#202 MRQ-01, Q18).
export interface OfferedRequestableMaterial {
  id: string;
  name: string;
  request_unit: { unit_id: string; name: string };
  whole_number_only: boolean;
  description: string | null;
}

export interface OfferedRequestableMaterialList {
  items: OfferedRequestableMaterial[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

/**
 * F009-T4 (#206): the names the Requestable Materials `ids` have now, for the Material Request page, which shows a
 * Requested Item's Requestable Material under its name now (#206 start decision 3).
 */
export async function requestableMaterialNamesOf(db: pg.Pool | pg.PoolClient, ids: string[]): Promise<Map<string, string>> {
  const res = await db.query('SELECT id, name FROM requestable_materials WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(res.rows.map(({ id, name }: any) => [id, name]));
}

const ROW_COLUMNS = `r.id, r.name, r.whole_number_only, r.is_active, ${offered('r')} AS is_offered, u.id AS request_unit_id, u.name AS request_unit_name, u.is_active AS request_unit_is_active`;

const toRow = (row: any): RequestableMaterialRow => ({
  id: row.id,
  name: row.name,
  request_unit: { unit_id: row.request_unit_id, name: row.request_unit_name, unit_is_active: row.request_unit_is_active },
  whole_number_only: row.whole_number_only,
  is_active: row.is_active,
  is_offered: row.is_offered,
});

/** F009-T1 (#203): the reads of the Requestable Materials: the list and a Requestable Material's page. */
export class RequestableMaterialReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** A page of the Requestable Materials by name, of the status asked for, with how many pass the filters. */
  async list(filters: RequestableMaterialListFilters): Promise<RequestableMaterialList> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (filters.status !== 'all') {
      conditions.push(filters.status === 'active' ? 'r.is_active' : 'NOT r.is_active');
    }
    if (filters.search !== undefined) {
      params.push(filters.search);
      conditions.push(`strpos(${comparedName('r.name')}, ${comparedName(`$${params.length}`)}) > 0`);
    }
    const values = [...params, filters.limit, filters.offset];
    // The count joins the page, so a page past the end still says how many Requestable Materials pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT ${ROW_COLUMNS}
         FROM requestable_materials r
         ${joinUnitEntry('u', 'r.request_unit_id')}
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY lower(name) ASC
         LIMIT $${values.length - 1} OFFSET $${values.length}
       )
       SELECT p.*, c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       ORDER BY lower(p.name) ASC`,
      values
    );
    // `counted` has one row, which the page joins.
    const totalCount: number = res.rows[0].total_count;
    const items = res.rows.filter((row: any) => row.id !== null).map(toRow);
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /**
   * F009-T4 (#206): a page of the Requestable Materials offered to Requesters, by name, found by text in the name
   * ignoring case and repeated spaces (#202 Q9, Q18). Offered comes from its one SQL source (P10).
   */
  async offeredList(filters: Omit<RequestableMaterialListFilters, 'status'>): Promise<OfferedRequestableMaterialList> {
    const params: unknown[] = [];
    const conditions = [offered('r')];
    if (filters.search !== undefined) {
      params.push(filters.search);
      conditions.push(`strpos(${comparedName('r.name')}, ${comparedName(`$${params.length}`)}) > 0`);
    }
    const values = [...params, filters.limit, filters.offset];
    // requestable_materials_name_unique makes the compared name unique, so the order needs no tiebreak.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT r.id, r.name, r.whole_number_only, r.description, u.id AS request_unit_id, u.name AS request_unit_name
         FROM requestable_materials r
         ${joinUnitEntry('u', 'r.request_unit_id')}
         WHERE ${conditions.join(' AND ')}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY lower(name) ASC
         LIMIT $${values.length - 1} OFFSET $${values.length}
       )
       SELECT p.*, c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       ORDER BY lower(p.name) ASC`,
      values
    );
    const totalCount: number = res.rows[0].total_count;
    const items = res.rows
      .filter((row: any) => row.id !== null)
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        request_unit: { unit_id: row.request_unit_id, name: row.request_unit_name },
        whole_number_only: row.whole_number_only,
        description: row.description,
      }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /** A Requestable Material with its history, or null when there is none. */
  async read(id: string): Promise<RequestableMaterialDetail | null> {
    const res = await this.db.query(
      `SELECT ${ROW_COLUMNS}, r.description, r.version, r.created_by, c.username AS created_by_username, r.recorded_at
       FROM requestable_materials r
       ${joinUnitEntry('u', 'r.request_unit_id')}
       JOIN users c ON c.id = r.created_by
       WHERE r.id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const history = await this.db.query(
      `SELECT h.version, h.kind, h.changes, h.recorded_by, u.username AS recorded_by_username, h.recorded_at
       FROM requestable_material_history h
       JOIN users u ON u.id = h.recorded_by
       WHERE h.requestable_material_id = $1
       ORDER BY h.version ASC`,
      [id]
    );
    const pairs = await this.db.query('SELECT stock_material_id, is_current FROM compatible_stock_materials WHERE requestable_material_id = $1', [id]);
    const current = new Map<string, boolean>(pairs.rows.map((pair: any) => [pair.stock_material_id, pair.is_current]));
    const compatible = (await stockMaterialSummariesOf(this.db, [...current.keys()])).map((summary) => ({ ...summary, is_current: current.get(summary.stock_material_id)! }));
    return {
      ...toRow(row),
      description: row.description,
      version: row.version,
      created_by: row.created_by,
      created_by_username: row.created_by_username,
      recorded_at: new Date(row.recorded_at).toISOString(),
      // The summaries come by name; a stable sort keeps that order within each part.
      compatible_stock_materials: [...compatible.filter((entry) => entry.is_current), ...compatible.filter((entry) => !entry.is_current)],
      history: history.rows.map((entry: any) => ({ ...entry, recorded_at: new Date(entry.recorded_at).toISOString() })),
      pending_requested_item_count: await pendingRequestedItemCount(this.db, id),
    };
  }

  /**
   * F009-T2 (#204): the Stock Materials a Supply Officer may choose as a Compatible Stock Material of the Requestable
   * Material `id`, each saying whether it handles its Request Unit, or null when there is no such Requestable Material.
   */
  async stockMaterialChoices(id: string, filters: { search?: string; limit: number; offset: number }): Promise<StockMaterialChoices | null> {
    const res = await this.db.query('SELECT request_unit_id FROM requestable_materials WHERE id = $1', [id]);
    if (res.rows.length === 0) {
      return null;
    }
    return stockMaterialChoicesOf(this.db, res.rows[0].request_unit_id, filters);
  }
}
