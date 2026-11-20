import pg from 'pg';
import { joinUnitEntry, type NamedListEntry } from './catalog-list-entries.ts';
import { comparedName } from './compared-name.ts';

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
}

export interface RequestableMaterialListFilters {
  // Text found in the name, ignoring case and repeated spaces (#202 Q18).
  search?: string;
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

// The kinds of change a history entry records: F009-T1 writes CREATED, T7 INACTIVATED and REACTIVATED, T8 RENAMED and
// DETAILS_CHANGED (0029_requestable_materials).
export type RequestableMaterialHistoryKind = 'CREATED' | 'RENAMED' | 'DETAILS_CHANGED' | 'INACTIVATED' | 'REACTIVATED';

// One entry of a Requestable Material's history, with the values it recorded as they were then, the Request Unit as
// { id, name } (#202 Q17, #175 P6).
export interface RequestableMaterialHistoryEntry {
  version: number;
  kind: RequestableMaterialHistoryKind;
  changes: { field: string; before: string | boolean | NamedListEntry | null; after: string | boolean | NamedListEntry }[];
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface RequestableMaterialDetail extends RequestableMaterialRow {
  description: string | null;
  version: number;
  created_by: string;
  created_by_username: string | null;
  recorded_at: string;
  // Oldest first.
  history: RequestableMaterialHistoryEntry[];
}

const ROW_COLUMNS = `r.id, r.name, r.whole_number_only, r.is_active, u.id AS request_unit_id, u.name AS request_unit_name, u.is_active AS request_unit_is_active`;

const toRow = (row: any): RequestableMaterialRow => ({
  id: row.id,
  name: row.name,
  request_unit: { unit_id: row.request_unit_id, name: row.request_unit_name, unit_is_active: row.request_unit_is_active },
  whole_number_only: row.whole_number_only,
  is_active: row.is_active,
});

/** F009-T1 (#203): the reads of the Requestable Materials: the list and a Requestable Material's page. */
export class RequestableMaterialReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** A page of the Requestable Materials by name, Inactive ones included, with how many pass the filters. */
  async list(filters: RequestableMaterialListFilters): Promise<RequestableMaterialList> {
    const params: unknown[] = [];
    const conditions: string[] = [];
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
    const items = res.rows.filter((row: any) => row.id !== null).map(toRow);
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /** A Requestable Material with its history, or null when there is none. */
  async read(id: string): Promise<RequestableMaterialDetail | null> {
    const res = await this.db.query(
      `SELECT ${ROW_COLUMNS}, r.description, r.version, r.created_by, c.username AS created_by_username, r.recorded_at
       FROM requestable_materials r
       ${joinUnitEntry('u', 'r.request_unit_id')}
       LEFT JOIN users c ON c.id = r.created_by
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
       LEFT JOIN users u ON u.id = h.recorded_by
       WHERE h.requestable_material_id = $1
       ORDER BY h.version ASC`,
      [id]
    );
    return {
      ...toRow(row),
      description: row.description,
      version: row.version,
      created_by: row.created_by,
      created_by_username: row.created_by_username ?? null,
      recorded_at: new Date(row.recorded_at).toISOString(),
      history: history.rows.map((entry: any) => ({ ...entry, recorded_by_username: entry.recorded_by_username ?? null, recorded_at: new Date(entry.recorded_at).toISOString() })),
    };
  }
}
