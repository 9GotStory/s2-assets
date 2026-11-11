import pg from 'pg';
import { assetExists, containsPattern } from './asset-lookups.ts';
import { readAssignmentsAt, type PermanentAssignment } from './assignment.service.ts';

export type RepairKind = 'REPAIR' | 'MAINTENANCE';
export type RepairerKind = 'INTERNAL' | 'EXTERNAL';
export type UnderWarranty = 'YES' | 'NO' | 'UNSPECIFIED';
// ใช้งานได้, or ซ่อมไม่ได้ (ใช้งานไม่ได้ for maintenance): one value, labelled by the record's kind (#98 Q10, Q16).
export type RepairOutcomeValue = 'USABLE' | 'NOT_USABLE';

// Who did the work: an internal technician, or an external shop or technician, named when known (#98 Q9).
export interface Repairer {
  kind: RepairerKind;
  name: string | null;
}

// How a Repair Record ended (F005-T2, #98 Q10, Q22).
export interface RepairOutcome {
  id: string;
  outcome: RepairOutcomeValue;
  outcome_date: string;
  note: string | null;
  document_reference: string | null;
  next_recommended_maintenance_date: string | null;
  // The record's cost before this outcome set it.
  cost_before: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

// A Repair Record as every reader sees it: no field is withheld, cost and Repairer included (#98 Q2).
export interface RepairRecord {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  repair_kind: RepairKind;
  start_date: string;
  repairer: Repairer;
  symptom_or_work: string;
  under_warranty: UnderWarranty;
  warranty_end_date: string | null;
  // Baht with two decimals, as text, or null when not given.
  cost: string | null;
  document_reference: string | null;
  remark: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
  // Its non-voided Repair Outcome, or null while it has none.
  outcome: RepairOutcome | null;
}

// What the Repair list is narrowed by (F005-T3, #98 Q21); every filter given applies.
export interface RepairListFilters {
  // Without one, the records still away; with one, those that ended.
  has_outcome?: boolean;
  repair_kind?: RepairKind;
  outcome?: RepairOutcomeValue;
  repairer_kind?: RepairerKind;
  // A text in the Repairer name or in the symptom or work, in any case, matched literally.
  search?: string;
  limit: number;
  offset: number;
}

export interface RepairList {
  items: RepairRecord[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// The Repair Record that keeps an Asset Under Repair, and what the Asset page shows of it (#98 Q21).
export interface UnderRepair {
  repair_record_id: string;
  repair_kind: RepairKind;
  start_date: string;
  repairer: Repairer;
}

// Under Repair is derived on read, never stored: a non-voided Repair Record without a Repair Outcome (#98 Q1).
const IS_UNDER_REPAIR = 'NOT r.is_voided AND NOT r.has_outcome';

const RECORD_COLUMNS = `r.id, r.asset_id, a.name AS asset_name, a.asset_number, r.repair_kind, to_char(r.start_date, 'YYYY-MM-DD') AS start_date,
  r.repairer_kind, r.repairer_name, r.symptom_or_work, r.under_warranty, to_char(r.warranty_end_date, 'YYYY-MM-DD') AS warranty_end_date,
  r.cost::text AS cost, r.document_reference, r.remark, r.recorded_by, u.username AS recorded_by_username, r.recorded_at, r.is_voided, r.version,
  o.id AS outcome_id, o.outcome, to_char(o.outcome_date, 'YYYY-MM-DD') AS outcome_date, o.note AS outcome_note,
  o.document_reference AS outcome_document_reference, to_char(o.next_recommended_maintenance_date, 'YYYY-MM-DD') AS next_recommended_maintenance_date,
  o.cost_before::text AS outcome_cost_before, o.recorded_by AS outcome_recorded_by, ou.username AS outcome_recorded_by_username, o.recorded_at AS outcome_recorded_at`;

// A record has at most one non-voided Repair Outcome (repair_outcomes_one_per_record).
const RECORD_JOINS = `JOIN assets a ON a.id = r.asset_id
  LEFT JOIN users u ON u.id = r.recorded_by
  LEFT JOIN repair_outcomes o ON o.repair_record_id = r.id AND NOT o.is_voided
  LEFT JOIN users ou ON ou.id = o.recorded_by`;

const outcomeOf = (row: any): RepairOutcome | null =>
  row.outcome_id === null
    ? null
    : {
        id: row.outcome_id,
        outcome: row.outcome,
        outcome_date: row.outcome_date,
        note: row.outcome_note,
        document_reference: row.outcome_document_reference,
        next_recommended_maintenance_date: row.next_recommended_maintenance_date,
        cost_before: row.outcome_cost_before,
        recorded_by: row.outcome_recorded_by,
        recorded_by_username: row.outcome_recorded_by_username ?? null,
        recorded_at: new Date(row.outcome_recorded_at).toISOString(),
      };

const recordOf = (row: any): RepairRecord => ({
  id: row.id,
  asset: { id: row.asset_id, name: row.asset_name, asset_number: row.asset_number },
  repair_kind: row.repair_kind,
  start_date: row.start_date,
  repairer: { kind: row.repairer_kind, name: row.repairer_name },
  symptom_or_work: row.symptom_or_work,
  under_warranty: row.under_warranty,
  warranty_end_date: row.warranty_end_date,
  cost: row.cost,
  document_reference: row.document_reference,
  remark: row.remark,
  recorded_by: row.recorded_by,
  recorded_by_username: row.recorded_by_username ?? null,
  recorded_at: new Date(row.recorded_at).toISOString(),
  is_voided: row.is_voided,
  version: row.version,
  outcome: outcomeOf(row),
});

/**
 * Each of `assetIds` that is Under Repair, by Asset, with its Repair Record (at most one, #98 Q3). A write
 * that decides a rule on it holds the Assets locked, as a Repair Start does.
 */
export async function underRepairOfAssets(db: pg.Pool | pg.PoolClient | any, assetIds: string[]): Promise<Map<string, UnderRepair>> {
  const res = await db.query(
    `SELECT r.asset_id, r.id, r.repair_kind, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, r.repairer_kind, r.repairer_name
     FROM repair_records r
     WHERE r.asset_id = ANY($1::uuid[]) AND ${IS_UNDER_REPAIR}`,
    [assetIds]
  );
  return new Map(
    res.rows.map((row: any): [string, UnderRepair] => [
      row.asset_id,
      { repair_record_id: row.id, repair_kind: row.repair_kind, start_date: row.start_date, repairer: { kind: row.repairer_kind, name: row.repairer_name } },
    ])
  );
}

// An Asset's latest Repair Outcome, as the Start Loan warning reads it (#98 Q20).
export interface LatestRepairOutcome {
  repair_record_id: string;
  repair_kind: RepairKind;
  outcome: RepairOutcomeValue;
  outcome_date: string;
}

/** The latest non-voided Repair Outcome of each of `assetIds` that has one, by Outcome Date then Recorded At. */
export async function latestRepairOutcomesOf(db: pg.Pool | pg.PoolClient | any, assetIds: string[]): Promise<Map<string, LatestRepairOutcome>> {
  const res = await db.query(
    `SELECT DISTINCT ON (r.asset_id) r.asset_id, r.id, r.repair_kind, o.outcome, to_char(o.outcome_date, 'YYYY-MM-DD') AS outcome_date
     FROM repair_outcomes o
     JOIN repair_records r ON r.id = o.repair_record_id
     WHERE r.asset_id = ANY($1::uuid[]) AND NOT o.is_voided AND NOT r.is_voided
     ORDER BY r.asset_id, o.outcome_date DESC, o.recorded_at DESC, o.id DESC`,
    [assetIds]
  );
  return new Map(
    res.rows.map((row: any): [string, LatestRepairOutcome] => [
      row.asset_id,
      { repair_record_id: row.id, repair_kind: row.repair_kind, outcome: row.outcome, outcome_date: row.outcome_date },
    ])
  );
}

/**
 * F005-T1 (#99), T2 (#100): reading Repair Records and their outcomes. The only assignment read is where
 * an Asset goes back to on an Outcome Date, which is shown and never stored (MR-16, MR-17).
 */
export class RepairReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /**
   * A Repair Record, or null when there is none. With `outcomeDate`, it also says where its Asset goes
   * back to on that date: the Permanent Assignment in effect then, in the Feature 003 order (#98 Q21).
   */
  async read(
    repairRecordId: string,
    { outcomeDate }: { outcomeDate?: string } = {}
  ): Promise<(RepairRecord & { assignment_on_outcome_date?: PermanentAssignment }) | null> {
    const res = await this.db.query(`SELECT ${RECORD_COLUMNS} FROM repair_records r ${RECORD_JOINS} WHERE r.id = $1`, [repairRecordId]);
    if (res.rows.length === 0) {
      return null;
    }
    const record = recordOf(res.rows[0]);
    if (outcomeDate === undefined) {
      return record;
    }
    const assignments = await readAssignmentsAt(this.db, [record.asset.id], outcomeDate);
    return { ...record, assignment_on_outcome_date: assignments.get(record.asset.id)! };
  }

  /** The Repair Records of an Asset, newest Start Date first, or null when there is no such Asset. */
  async recordsOfAsset(assetId: string): Promise<RepairRecord[] | null> {
    if (!(await assetExists(this.db, assetId))) {
      return null;
    }
    const res = await this.db.query(
      `SELECT ${RECORD_COLUMNS} FROM repair_records r ${RECORD_JOINS}
       WHERE r.asset_id = $1
       ORDER BY r.start_date DESC, r.recorded_at DESC, r.id DESC`,
      [assetId]
    );
    return res.rows.map(recordOf);
  }

  /** The Repair Records that pass every filter given, newest Start Date first, a page at a time as the Asset list. */
  async list(filters: RepairListFilters): Promise<RepairList> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    const where = (condition: (param: string) => string, value: unknown) => {
      params.push(value);
      conditions.push(condition(`$${params.length}`));
    };
    if (filters.has_outcome !== undefined) {
      conditions.push(filters.has_outcome ? 'r.has_outcome' : 'NOT r.has_outcome');
    }
    if (filters.repair_kind !== undefined) {
      where((param) => `r.repair_kind = ${param}`, filters.repair_kind);
    }
    if (filters.outcome !== undefined) {
      where((param) => `o.outcome = ${param}`, filters.outcome);
    }
    if (filters.repairer_kind !== undefined) {
      where((param) => `r.repairer_kind = ${param}`, filters.repairer_kind);
    }
    if (filters.search !== undefined) {
      where((param) => `(r.repairer_name ILIKE ${param} ESCAPE '\\' OR r.symptom_or_work ILIKE ${param} ESCAPE '\\')`, containsPattern(filters.search));
    }
    params.push(filters.limit, filters.offset);

    // The count joins the page, so a page past the end still says how many records pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT ${RECORD_COLUMNS}, r.start_date AS sort_date
         FROM repair_records r ${RECORD_JOINS}
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY sort_date DESC, recorded_at DESC, id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}
       )
       SELECT p.*, c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       ORDER BY p.sort_date DESC, p.recorded_at DESC, p.id DESC`,
      params
    );
    const totalCount: number = res.rows[0]?.total_count ?? 0;
    const items: RepairRecord[] = res.rows.filter((row: any) => row.id !== null).map(recordOf);
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /**
   * The Asset's Next Recommended Maintenance Date: that of its latest non-voided Repair Outcome, by
   * Outcome Date then Recorded At, that has one (#98 Q7). Nothing is scheduled from it.
   */
  async nextRecommendedMaintenanceDateOf(assetId: string): Promise<string | null> {
    const res = await this.db.query(
      `SELECT to_char(o.next_recommended_maintenance_date, 'YYYY-MM-DD') AS next_date
       FROM repair_outcomes o
       JOIN repair_records r ON r.id = o.repair_record_id
       WHERE r.asset_id = $1 AND NOT r.is_voided AND NOT o.is_voided AND o.next_recommended_maintenance_date IS NOT NULL
       ORDER BY o.outcome_date DESC, o.recorded_at DESC, o.id DESC
       LIMIT 1`,
      [assetId]
    );
    return res.rows[0]?.next_date ?? null;
  }

  /** The Repair Record that keeps an Asset Under Repair, or null when it is not. */
  async underRepairOf(assetId: string): Promise<UnderRepair | null> {
    return (await underRepairOfAssets(this.db, [assetId])).get(assetId) ?? null;
  }
}
