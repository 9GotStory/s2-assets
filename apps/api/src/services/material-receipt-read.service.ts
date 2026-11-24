import pg from 'pg';
import { containsPattern } from './asset-lookups.ts';
import { joinCatalogListEntry, joinUnitEntry, type NamedListEntry } from './catalog-list-entries.ts';
import { materialReceiptState, type MaterialReceiptState } from './material-receipt-state.ts';
import { joinStockMaterial } from './stock-material-joins.ts';
import { stockMovementsOfMaterialReceiptLines, type StockMovementRow } from './stock-movements.ts';

// One row of the Material Receipt list (#231 story 56; Q24).
export interface MaterialReceiptRow {
  id: string;
  // A bigint as a string of digits, or none while Draft (P1).
  receipt_number: string | null;
  received_date: string | null;
  // The Source Party under its name now, or none.
  source_party: NamedListEntry | null;
  state: MaterialReceiptState;
  line_count: number;
  created_at: string;
}

export interface MaterialReceiptListFilters {
  // Text found in the Receipt Number, the Receipt Reference, the Source Party name or a line's Stock Material name.
  search?: string;
  state?: MaterialReceiptState;
  limit: number;
  offset: number;
}

export interface MaterialReceiptList {
  items: MaterialReceiptRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// A list entry a Material Receipt names, under its name now.
export interface ReceiptListEntry extends NamedListEntry {
  is_active: boolean;
}

// A Receipt Line as a Material Receipt's page shows it, each name as it is now, with the Stock Movements it made
// (story 58).
export interface MaterialReceiptLine {
  id: string;
  position: number;
  stock_material: { id: string; name: string; is_active: boolean };
  unit: { unit_id: string; name: string } | null;
  quantity: string | null;
  // Per Original Unit, for reference only (Q8).
  unit_price: string | null;
  note: string | null;
  is_voided: boolean;
  // Its one Stock Movement in effect, or none.
  stock_movement_id: string | null;
  stock_movements: StockMovementRow[];
}

export interface MaterialReceiptHistoryEntry {
  version: number;
  kind: 'CONFIRMED' | 'CORRECTED' | 'VOIDED';
  // What the entry records, with names as they were then (#175 P6).
  facts: Record<string, unknown>;
  reason: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface MaterialReceiptDetail {
  id: string;
  receipt_number: string | null;
  received_date: string | null;
  source_party: ReceiptListEntry | null;
  source_type: ReceiptListEntry | null;
  receipt_reference: string | null;
  note: string | null;
  state: MaterialReceiptState;
  version: number;
  created_by: string;
  created_by_username: string | null;
  created_at: string;
  confirmed_by: string | null;
  confirmed_by_username: string | null;
  confirmed_at: string | null;
  lines: MaterialReceiptLine[];
  // Oldest first; none while Draft (P1).
  history: MaterialReceiptHistoryEntry[];
}

// A Material Receipt holding a Stock Material's Stock Movement in effect (story 40).
export interface InEffectMaterialReceipt {
  material_receipt_id: string;
  receipt_number: string;
}

const isoOrNull = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());

// The list entry a row joined as `<prefix>_id`, `<prefix>_name` and `<prefix>_is_active`, or null when it names none.
const receiptEntryOf = (row: any, prefix: string): ReceiptListEntry | null =>
  row[`${prefix}_id`] === null ? null : { id: row[`${prefix}_id`], name: row[`${prefix}_name`], is_active: row[`${prefix}_is_active`] };

/**
 * F010-T3 (#234): of the Stock Materials `ids`, those with a Stock Movement in effect from a Material Receipt, each with
 * the Material Receipt of the lowest Receipt Number whose line points at one (MSL-04). An Opening Balance confirm names
 * it when it refuses the Stock Material (story 40; #234 start decision 3).
 */
export async function materialReceiptsInEffectOf(runner: pg.Pool | pg.PoolClient, ids: string[]): Promise<Map<string, InEffectMaterialReceipt>> {
  const res = await runner.query(
    `SELECT DISTINCT ON (l.stock_material_id) l.stock_material_id, mr.id AS material_receipt_id, mr.receipt_number::text AS receipt_number
     FROM material_receipt_lines l
     JOIN material_receipts mr ON mr.id = l.material_receipt_id
     WHERE l.stock_material_id = ANY($1::uuid[]) AND l.stock_movement_id IS NOT NULL
     ORDER BY l.stock_material_id, mr.receipt_number`,
    [ids]
  );
  return new Map(res.rows.map(({ stock_material_id: id, ...receipt }: any) => [id, receipt]));
}

// The column of material_receipts that names an entry of each list a Material Receipt names.
const USAGE_COLUMNS = { 'source-party': 'source_party_id', 'source-type': 'source_type_id' } as const;

/**
 * F010-T3 (#234): how many Material Receipts name each entry of the list `kind`, by its id, Drafts and Received alike,
 * since a rename shows on all of them (#231 Model; #234 start decision 4). An entry that none names is left out.
 */
export async function materialReceiptUsageOf(runner: pg.Pool | pg.PoolClient, kind: keyof typeof USAGE_COLUMNS): Promise<Map<string, number>> {
  const column = USAGE_COLUMNS[kind];
  const res = await runner.query(`SELECT ${column} AS id, count(*)::int AS usage_count FROM material_receipts WHERE ${column} IS NOT NULL GROUP BY ${column}`);
  return new Map(res.rows.map((row: { id: string; usage_count: number }) => [row.id, row.usage_count]));
}

/** F010-T3 (#234): the Material Receipt reads: the list and a Material Receipt's page, Drafts included (P8). */
export class MaterialReceiptReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** The Material Receipts, newest first, a page at a time, with how many pass the filters. */
  async list(filters: MaterialReceiptListFilters): Promise<MaterialReceiptList> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (filters.state !== undefined) {
      params.push(filters.state);
      conditions.push(`${materialReceiptState('mr')} = $${params.length}`);
    }
    if (filters.search !== undefined) {
      params.push(containsPattern(filters.search));
      const pattern = `$${params.length}`;
      conditions.push(`(mr.receipt_number::text ILIKE ${pattern} ESCAPE '\\' OR mr.receipt_reference ILIKE ${pattern} ESCAPE '\\' OR sp.name ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM material_receipt_lines sl ${joinStockMaterial('sm', 'sl.stock_material_id')}
                   WHERE sl.material_receipt_id = mr.id AND sm.name ILIKE ${pattern} ESCAPE '\\'))`);
    }
    const values = [...params, filters.limit, filters.offset];
    // The count joins the page, so a page past the end still says how many pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT mr.id, mr.receipt_number::text AS receipt_number, mr.received_date::text AS received_date,
                sp.id AS source_party_id, sp.name AS source_party_name, ${materialReceiptState('mr')} AS state, mr.created_at,
                (SELECT count(*)::int FROM material_receipt_lines cl WHERE cl.material_receipt_id = mr.id) AS line_count
         FROM material_receipts mr
         ${joinCatalogListEntry('source-party', 'sp', 'mr.source_party_id')}
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
    // counted gives one row however many pass.
    const totalCount: number = res.rows[0].total_count;
    const items = res.rows
      .filter((row: any) => row.id !== null)
      .map((row: any) => ({
        id: row.id,
        receipt_number: row.receipt_number,
        received_date: row.received_date,
        source_party: row.source_party_id === null ? null : { id: row.source_party_id, name: row.source_party_name },
        state: row.state,
        line_count: row.line_count,
        created_at: new Date(row.created_at).toISOString(),
      }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /** A Material Receipt with its lines, their Stock Movements and its history, or null when there is none. */
  async read(id: string): Promise<MaterialReceiptDetail | null> {
    const res = await this.db.query(
      `SELECT mr.id, mr.receipt_number::text AS receipt_number, mr.received_date::text AS received_date,
              sp.id AS source_party_id, sp.name AS source_party_name, sp.is_active AS source_party_is_active,
              st.id AS source_type_id, st.name AS source_type_name, st.is_active AS source_type_is_active,
              mr.receipt_reference, mr.note, ${materialReceiptState('mr')} AS state, mr.version,
              mr.created_by, cu.username AS created_by_username, mr.created_at, mr.confirmed_by, fu.username AS confirmed_by_username, mr.confirmed_at
       FROM material_receipts mr
       ${joinCatalogListEntry('source-party', 'sp', 'mr.source_party_id')}
       ${joinCatalogListEntry('source-type', 'st', 'mr.source_type_id')}
       LEFT JOIN users cu ON cu.id = mr.created_by
       LEFT JOIN users fu ON fu.id = mr.confirmed_by
       WHERE mr.id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const lines = await this.db.query(
      `SELECT l.id, l.position, l.stock_material_id, sm.name AS stock_material_name, sm.is_active AS stock_material_is_active,
              l.unit_id, u.name AS unit_name, trim_scale(l.quantity)::text AS quantity, trim_scale(l.unit_price)::text AS unit_price,
              l.note, l.is_voided, l.stock_movement_id
       FROM material_receipt_lines l
       ${joinStockMaterial('sm', 'l.stock_material_id')}
       LEFT ${joinUnitEntry('u', 'l.unit_id')}
       WHERE l.material_receipt_id = $1
       ORDER BY l.position`,
      [id]
    );
    const movements = await stockMovementsOfMaterialReceiptLines(
      this.db,
      lines.rows.map((line: any) => line.id)
    );
    const history = await this.db.query(
      `SELECT h.version, h.kind, h.facts, h.reason, h.recorded_by, u.username AS recorded_by_username, h.recorded_at
       FROM material_receipt_history h
       LEFT JOIN users u ON u.id = h.recorded_by
       WHERE h.material_receipt_id = $1
       ORDER BY h.version ASC`,
      [id]
    );
    return {
      id: row.id,
      receipt_number: row.receipt_number,
      received_date: row.received_date,
      source_party: receiptEntryOf(row, 'source_party'),
      source_type: receiptEntryOf(row, 'source_type'),
      receipt_reference: row.receipt_reference,
      note: row.note,
      state: row.state,
      version: row.version,
      created_by: row.created_by,
      created_by_username: row.created_by_username,
      created_at: new Date(row.created_at).toISOString(),
      confirmed_by: row.confirmed_by,
      confirmed_by_username: row.confirmed_by_username,
      confirmed_at: isoOrNull(row.confirmed_at),
      lines: lines.rows.map((line: any) => ({
        id: line.id,
        position: line.position,
        stock_material: { id: line.stock_material_id, name: line.stock_material_name, is_active: line.stock_material_is_active },
        unit: line.unit_id === null ? null : { unit_id: line.unit_id, name: line.unit_name },
        quantity: line.quantity,
        unit_price: line.unit_price,
        note: line.note,
        is_voided: line.is_voided,
        stock_movement_id: line.stock_movement_id,
        stock_movements: movements.get(line.id) ?? [],
      })),
      history: history.rows.map((entry: any) => ({ ...entry, recorded_at: new Date(entry.recorded_at).toISOString() })),
    };
  }
}
