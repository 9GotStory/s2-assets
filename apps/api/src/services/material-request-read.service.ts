import pg from 'pg';
import { joinUnitEntry } from './catalog-list-entries.ts';
import { materialRequestState, requestedItemState, type MaterialRequestState } from './material-request-state.ts';
import { requestableMaterialNamesOf } from './requestable-material-read.service.ts';
import { rollbackQuietly } from './retryable-write.ts';

// One row of "คำขอของฉัน" (#202 Q19).
export interface MaterialRequestRow {
  id: string;
  request_number: string;
  recorded_at: string;
  state: MaterialRequestState;
  requested_item_count: number;
}

export interface MaterialRequestListFilters {
  // Only Material Requests in this state; every state when left out (Q19).
  state?: MaterialRequestState;
  limit: number;
  offset: number;
}

export interface MaterialRequestList {
  items: MaterialRequestRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// A Requested Item on the Material Request page: its Requestable Material and Request Unit under their names now
// (#206 start decision 3), the Request Unit the one it recorded (P3), and T5's Cancel facts (P4).
export interface RequestedItem {
  id: string;
  position: number;
  requestable_material_id: string;
  requestable_material_name: string;
  requested_quantity: string;
  request_unit: { unit_id: string; name: string };
  note: string | null;
  state: MaterialRequestState;
  cancelled_by: string | null;
  cancelled_by_username: string | null;
  cancelled_at: string | null;
  cancel_note: string | null;
  // Whether the page offers its Cancel (P9): while it is Pending (#207 start decision 2).
  can_cancel: boolean;
}

// One entry of a Material Request's history: created, or one of T5's Cancels with the Requested Items it cancelled.
export interface MaterialRequestHistoryEntry {
  version: number;
  kind: 'CREATED' | 'REQUESTED_ITEM_CANCELLED' | 'MATERIAL_REQUEST_CANCELLED';
  requested_item_ids: string[] | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string;
  recorded_at: string;
}

export interface MaterialRequestDetail {
  id: string;
  request_number: string;
  requested_by: string;
  requested_by_username: string;
  recorded_at: string;
  note: string | null;
  version: number;
  state: MaterialRequestState;
  // Whether the page offers Cancelling every Pending Requested Item (P9): while any is (#207 start decision 2). Only the
  // Requester who created it reads the page until F009-T6 (#208) widens it and adds who may.
  can_cancel: boolean;
  // In the order asked.
  requested_items: RequestedItem[];
  // Oldest first.
  history: MaterialRequestHistoryEntry[];
}

const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** F009-T4 (#206): the reads of the Material Requests: "คำขอของฉัน" and a Material Request's page (#202 Q19). */
export class MaterialRequestReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /**
   * A page of the Material Requests `requestedBy` created, newest first, with how many pass the filters. The sequence
   * makes the Request Number unique, so the order needs no tiebreak.
   */
  async listOf(requestedBy: string, filters: MaterialRequestListFilters): Promise<MaterialRequestList> {
    const params: unknown[] = [requestedBy];
    const conditions = ['m.requested_by = $1'];
    if (filters.state !== undefined) {
      params.push(filters.state);
      conditions.push(`${materialRequestState('m')} = $${params.length}`);
    }
    const values = [...params, filters.limit, filters.offset];
    // The count joins the page, so a page past the end still says how many Material Requests pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT m.id, m.request_number, m.recorded_at, ${materialRequestState('m')} AS state,
                (SELECT count(*)::int FROM requested_items i WHERE i.material_request_id = m.id) AS requested_item_count
         FROM material_requests m
         WHERE ${conditions.join(' AND ')}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY request_number DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}
       )
       SELECT p.id, p.request_number::text, p.recorded_at, p.state, p.requested_item_count, c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       ORDER BY p.request_number DESC`,
      values
    );
    const totalCount: number = res.rows[0].total_count;
    const items = res.rows
      .filter((row: any) => row.id !== null)
      .map((row: any) => ({
        id: row.id,
        request_number: row.request_number,
        recorded_at: new Date(row.recorded_at).toISOString(),
        state: row.state,
        requested_item_count: row.requested_item_count,
      }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /**
   * A Material Request with its Requested Items and history, or null when there is none. Its reads share one snapshot,
   * so a Cancel committed meanwhile shows on all of them or none (#206 review decision 1, F009-T5).
   */
  async read(id: string): Promise<MaterialRequestDetail | null> {
    const client: pg.PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const detail = await readIn(client, id);
      await client.query('COMMIT');
      return detail;
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }
}

// The Material Request page as `client` reads it, or null when there is none.
const readIn = async (client: pg.PoolClient, id: string): Promise<MaterialRequestDetail | null> => {
    const res = await client.query(
      `SELECT m.id, m.request_number::text, m.requested_by, u.username AS requested_by_username, m.recorded_at, m.note, m.version,
              ${materialRequestState('m')} AS state
       FROM material_requests m
       JOIN users u ON u.id = m.requested_by
       WHERE m.id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const items = await client.query(
      `SELECT i.id, i.position, i.requestable_material_id, trim_scale(i.requested_quantity)::text AS requested_quantity, ru.id AS request_unit_id, ru.name AS request_unit_name, i.note,
              ${requestedItemState('i')} AS state, i.cancelled_by, c.username AS cancelled_by_username, i.cancelled_at, i.cancel_note
       FROM requested_items i
       ${joinUnitEntry('ru', 'i.request_unit_id')}
       LEFT JOIN users c ON c.id = i.cancelled_by
       WHERE i.material_request_id = $1
       ORDER BY i.position ASC`,
      [id]
    );
    const names = await requestableMaterialNamesOf(client, items.rows.map(({ requestable_material_id }: any) => requestable_material_id));
    const history = await client.query(
      `SELECT h.version, h.kind, h.requested_item_ids, h.note, h.recorded_by, u.username AS recorded_by_username, h.recorded_at
       FROM material_request_history h
       JOIN users u ON u.id = h.recorded_by
       WHERE h.material_request_id = $1
       ORDER BY h.version ASC`,
      [id]
    );
    return {
      ...row,
      recorded_at: new Date(row.recorded_at).toISOString(),
      can_cancel: row.state === 'PENDING',
      requested_items: items.rows.map((item: any) => ({
        id: item.id,
        position: item.position,
        requestable_material_id: item.requestable_material_id,
        requestable_material_name: names.get(item.requestable_material_id)!,
        requested_quantity: item.requested_quantity,
        request_unit: { unit_id: item.request_unit_id, name: item.request_unit_name },
        note: item.note,
        state: item.state,
        cancelled_by: item.cancelled_by,
        cancelled_by_username: item.cancelled_by_username,
        cancelled_at: isoOrNull(item.cancelled_at),
        cancel_note: item.cancel_note,
        can_cancel: item.state === 'PENDING',
      })),
      history: history.rows.map((entry: any) => ({ ...entry, recorded_at: new Date(entry.recorded_at).toISOString() })),
    };
};
