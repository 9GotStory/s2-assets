import pg from 'pg';
import { assetExists } from './asset-lookups.ts';

export type RepairKind = 'REPAIR' | 'MAINTENANCE';
export type RepairerKind = 'INTERNAL' | 'EXTERNAL';
export type UnderWarranty = 'YES' | 'NO' | 'UNSPECIFIED';

// Who did the work: an internal technician, or an external shop or technician, named when known (#98 Q9).
export interface Repairer {
  kind: RepairerKind;
  name: string | null;
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
  r.cost::text AS cost, r.document_reference, r.remark, r.recorded_by, u.username AS recorded_by_username, r.recorded_at, r.is_voided, r.version`;

const RECORD_JOINS = `JOIN assets a ON a.id = r.asset_id
  LEFT JOIN users u ON u.id = r.recorded_by`;

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

/** F005-T1 (#99): reading Repair Records. Nothing here reads an assignment fact (RM-05). */
export class RepairReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** A Repair Record, or null when there is none. */
  async read(repairRecordId: string): Promise<RepairRecord | null> {
    const res = await this.db.query(`SELECT ${RECORD_COLUMNS} FROM repair_records r ${RECORD_JOINS} WHERE r.id = $1`, [repairRecordId]);
    return res.rows.length > 0 ? recordOf(res.rows[0]) : null;
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

  /** The Repair Record that keeps an Asset Under Repair, or null when it is not. */
  async underRepairOf(assetId: string): Promise<UnderRepair | null> {
    return (await underRepairOfAssets(this.db, [assetId])).get(assetId) ?? null;
  }
}
