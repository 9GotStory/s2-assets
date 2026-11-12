import pg from 'pg';
import { assetExists, containsPattern } from './asset-lookups.ts';
import { readAssignmentsAt, type PermanentAssignment } from './assignment.service.ts';
import { loanItemPeriods } from './loan-item-periods.ts';
import { loanReturnsOf, type CitedLoanReturn } from './loan-return-read.ts';

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

// The Loan Return recorded ชำรุด that led to a Repair Record (F005-T5, LR-13, RM-08), with its Loan. It is
// read as it stands now: voided later by a Loan Correction, the record still cites it (#98 Q5).
export type RepairSource = Omit<CitedLoanReturn, 'asset_id'>;

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
  // Null when it was sent with none, as from the Asset page (#98 Q5).
  repair_source: RepairSource | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
  // Its non-voided Repair Outcome, or null while it has none.
  outcome: RepairOutcome | null;
  // Its Repair Outcomes voided by a Repair Correction, oldest first: shown struck through, counted in nothing (#98 Q18).
  voided_outcomes: RepairOutcome[];
  // The other Repair Records and LoanItems of its Asset whose periods overlap its own, earliest first (#98 Q17).
  conflicts: RepairConflict[];
}

// A Repair Record as the other side of a Repair Conflict: its period runs from its Start Date to its
// Outcome Date, open-ended without one (#98 Q17).
export interface ConflictingRepairRecord {
  kind: 'REPAIR_RECORD';
  repair_record_id: string;
  repair_kind: RepairKind;
  start_date: string;
  outcome_date: string | null;
}

// A LoanItem as the other side of a Repair Conflict, with the period Feature 004 gives it.
export interface ConflictingLoanItem {
  kind: 'LOAN_ITEM';
  loan_id: string;
  loan_item_id: string;
  loan_date: string;
  // Its effective ending date, or null while it has none.
  ending_date: string | null;
}

/** A Repair Conflict as one Repair Record sees it: the other Repair Record or LoanItem whose period overlaps its own. */
export type RepairConflict = ConflictingRepairRecord | ConflictingLoanItem;

/** The id of a Repair Conflict's other side, a LoanItem or a Repair Record. */
export const conflictingIdOf = (conflicting: RepairConflict): string => (conflicting.kind === 'LOAN_ITEM' ? conflicting.loan_item_id : conflicting.repair_record_id);

/** A Repair Conflict of one Repair Record, with the record and its Asset. */
export interface RepairRecordConflict {
  asset_id: string;
  repair_record: ConflictingRepairRecord;
  conflicting: RepairConflict;
}

// What a correction changed of one field. A Repair Source is read as it stands now, as the record reads it.
export type RepairCorrectionField =
  | { field: 'repair_source_loan_return_id'; before: RepairSource | null; after: RepairSource | null }
  | { field: string; before: string | null; after: string | null };

// One Repair Correction of a Repair Record or its Repair Outcome (#98 Q18): who, when, why, and the before and after.
export interface RepairCorrection {
  id: string;
  target: { kind: 'REPAIR_RECORD' | 'REPAIR_OUTCOME'; id: string };
  action: 'AMENDED' | 'VOIDED';
  reason: string;
  changes: RepairCorrectionField[];
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

// What the Repair list is narrowed by (F005-T3, #98 Q21); every filter given applies.
export interface RepairListFilters {
  // Whether the record has a Repair Outcome. A voided record has neither, as it counts in nothing (#98 Q18).
  has_outcome?: boolean;
  repair_kind?: RepairKind;
  outcome?: RepairOutcomeValue;
  repairer_kind?: RepairerKind;
  // A text in the Repairer name or in the symptom or work, in any case, matched literally.
  search?: string;
  // "มี conflict ค้างตรวจ": a record in a Repair Conflict (#98 Q17).
  has_repair_conflict?: boolean;
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

// The period of each non-voided Repair Record that `scope` keeps, for rows aliased `r`: from its Start Date
// to the Outcome Date of its non-voided Repair Outcome, and open-ended without one (#98 Q17).
const repairRecordPeriods = (scope: string): string => `SELECT r.id AS repair_record_id, r.asset_id, r.repair_kind, r.start_date AS starts, o.outcome_date AS ends
       FROM repair_records r
       LEFT JOIN repair_outcomes o ON o.repair_record_id = r.id AND NOT o.is_voided
       WHERE NOT r.is_voided AND ${scope}`;

// Two periods `p` and `o` of one Asset overlap when each starts strictly before the other ends, so a shared
// boundary day is none (#98 Q17).
const PERIODS_OVERLAP = `p.starts < coalesce(o.ends, 'infinity'::date) AND o.starts < coalesce(p.ends, 'infinity'::date)`;

// Every Repair Conflict of the Assets that `assetScope` keeps, given the column naming an Asset, once per
// Repair Record in it: two Repair Records conflict once from each side, a Repair Record and a LoanItem
// once. Never stored (#98 Q17).
const repairConflictPairs = (assetScope: (assetColumn: string) => string): string => `WITH repairs AS (${repairRecordPeriods(assetScope('r.asset_id'))}),
       lent_periods AS (${loanItemPeriods(assetScope('li.asset_id'))})
     SELECT p.asset_id, p.repair_record_id, p.repair_kind, p.starts, p.ends, 'REPAIR_RECORD' AS conflicting_kind, o.repair_record_id AS conflicting_id,
            NULL::uuid AS conflicting_loan_id, o.repair_kind AS conflicting_repair_kind, o.starts AS conflicting_starts, o.ends AS conflicting_ends
     FROM repairs p
     JOIN repairs o ON o.asset_id = p.asset_id AND o.repair_record_id <> p.repair_record_id
     WHERE ${PERIODS_OVERLAP}
     UNION ALL
     SELECT p.asset_id, p.repair_record_id, p.repair_kind, p.starts, p.ends, 'LOAN_ITEM', o.loan_item_id,
            o.loan_id, NULL, o.starts, o.ends
     FROM repairs p
     JOIN lent_periods o ON o.asset_id = p.asset_id
     WHERE ${PERIODS_OVERLAP}`;

/**
 * The Repair Conflicts of `assetIds`, once per Repair Record they involve, computed on read and never
 * stored (#98 Q17). A write that decides on them holds the Assets locked.
 */
export async function readRepairConflictsOfAssets(db: pg.Pool | pg.PoolClient | any, assetIds: string[]): Promise<RepairRecordConflict[]> {
  const res = await db.query(
    `SELECT c.asset_id, c.repair_record_id, c.repair_kind, to_char(c.starts, 'YYYY-MM-DD') AS start_date, to_char(c.ends, 'YYYY-MM-DD') AS outcome_date,
            c.conflicting_kind, c.conflicting_id, c.conflicting_loan_id, c.conflicting_repair_kind,
            to_char(c.conflicting_starts, 'YYYY-MM-DD') AS conflicting_starts, to_char(c.conflicting_ends, 'YYYY-MM-DD') AS conflicting_ends
     FROM (${repairConflictPairs((assetColumn) => `${assetColumn} = ANY($1::uuid[])`)}) c
     ORDER BY c.asset_id, c.conflicting_starts, c.conflicting_id`,
    [assetIds]
  );
  return res.rows.map((row: any): RepairRecordConflict => ({
    asset_id: row.asset_id,
    repair_record: { kind: 'REPAIR_RECORD', repair_record_id: row.repair_record_id, repair_kind: row.repair_kind, start_date: row.start_date, outcome_date: row.outcome_date },
    conflicting:
      row.conflicting_kind === 'REPAIR_RECORD'
        ? { kind: 'REPAIR_RECORD', repair_record_id: row.conflicting_id, repair_kind: row.conflicting_repair_kind, start_date: row.conflicting_starts, outcome_date: row.conflicting_ends }
        : { kind: 'LOAN_ITEM', loan_id: row.conflicting_loan_id, loan_item_id: row.conflicting_id, loan_date: row.conflicting_starts, ending_date: row.conflicting_ends },
  }));
}

const RECORD_COLUMNS = `r.id, r.asset_id, a.name AS asset_name, a.asset_number, r.repair_kind, to_char(r.start_date, 'YYYY-MM-DD') AS start_date,
  r.repairer_kind, r.repairer_name, r.symptom_or_work, r.under_warranty, to_char(r.warranty_end_date, 'YYYY-MM-DD') AS warranty_end_date,
  r.cost::text AS cost, r.document_reference, r.remark, r.repair_source_loan_return_id, r.recorded_by, u.username AS recorded_by_username, r.recorded_at, r.is_voided, r.version,
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

// The voided Repair Outcomes of each of `repairRecordIds`, by record, oldest first.
async function voidedOutcomesOf(db: pg.Pool | any, repairRecordIds: string[]): Promise<Map<string, RepairOutcome[]>> {
  const res = await db.query(
    `SELECT o.repair_record_id, o.id AS outcome_id, o.outcome, to_char(o.outcome_date, 'YYYY-MM-DD') AS outcome_date, o.note AS outcome_note,
            o.document_reference AS outcome_document_reference, to_char(o.next_recommended_maintenance_date, 'YYYY-MM-DD') AS next_recommended_maintenance_date,
            o.cost_before::text AS outcome_cost_before, o.recorded_by AS outcome_recorded_by, u.username AS outcome_recorded_by_username, o.recorded_at AS outcome_recorded_at
     FROM repair_outcomes o
     LEFT JOIN users u ON u.id = o.recorded_by
     WHERE o.repair_record_id = ANY($1::uuid[]) AND o.is_voided
     ORDER BY o.recorded_at, o.id`,
    [repairRecordIds]
  );
  const voided = new Map<string, RepairOutcome[]>();
  for (const row of res.rows) {
    voided.set(row.repair_record_id, [...(voided.get(row.repair_record_id) ?? []), outcomeOf(row)!]);
  }
  return voided;
}

const repairSourceOf = (cited: CitedLoanReturn | undefined): RepairSource | null => {
  if (!cited) {
    return null;
  }
  const { asset_id: _assetId, ...source } = cited;
  return source;
};

const recordOf = (row: any, sources: Map<string, CitedLoanReturn>, voidedOutcomes: Map<string, RepairOutcome[]>, conflicts: Map<string, RepairConflict[]>): RepairRecord => ({
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
  repair_source: repairSourceOf(sources.get(row.repair_source_loan_return_id)),
  recorded_by: row.recorded_by,
  recorded_by_username: row.recorded_by_username ?? null,
  recorded_at: new Date(row.recorded_at).toISOString(),
  is_voided: row.is_voided,
  version: row.version,
  outcome: outcomeOf(row),
  voided_outcomes: voidedOutcomes.get(row.id) ?? [],
  conflicts: conflicts.get(row.id) ?? [],
});

// Repair Sources by Loan Return, read through the Loan module.
const sourcesOf = async (db: pg.Pool | any, loanReturnIds: string[]): Promise<Map<string, CitedLoanReturn>> => {
  const ids = [...new Set(loanReturnIds)];
  return ids.length > 0 ? loanReturnsOf(db, ids) : new Map<string, CitedLoanReturn>();
};

// Repair Records from their rows, each with its Repair Source read through the Loan module and its Repair Conflicts.
async function recordsOf(db: pg.Pool | any, rows: any[]): Promise<RepairRecord[]> {
  const sources = await sourcesOf(db, rows.map((row) => row.repair_source_loan_return_id).filter(Boolean));
  const voidedOutcomes = rows.length > 0 ? await voidedOutcomesOf(db, rows.map((row) => row.id)) : new Map<string, RepairOutcome[]>();
  const conflicts = new Map<string, RepairConflict[]>();
  if (rows.length > 0) {
    for (const { repair_record: { repair_record_id: id }, conflicting } of await readRepairConflictsOfAssets(db, [...new Set(rows.map((row) => row.asset_id as string))])) {
      conflicts.set(id, [...(conflicts.get(id) ?? []), conflicting]);
    }
  }
  return rows.map((row) => recordOf(row, sources, voidedOutcomes, conflicts));
}

const SOURCE_FIELD = 'repair_source_loan_return_id';

/** The corrections of a Repair Record and of its Repair Outcomes, oldest first, each Repair Source as it stands now. */
async function readCorrectionsOf(db: pg.Pool | any, repairRecordId: string): Promise<RepairCorrection[]> {
  const res = await db.query(
    `SELECT c.id, c.action, c.reason, c.changes, c.recorded_by, u.username AS recorded_by_username, c.recorded_at,
            coalesce(c.repair_record_id, c.repair_outcome_id) AS target_id,
            CASE WHEN c.repair_record_id IS NOT NULL THEN 'REPAIR_RECORD' ELSE 'REPAIR_OUTCOME' END AS target_kind
     FROM repair_corrections c
     LEFT JOIN repair_outcomes o ON o.id = c.repair_outcome_id
     LEFT JOIN users u ON u.id = c.recorded_by
     WHERE $1 IN (c.repair_record_id, o.repair_record_id)
     ORDER BY c.recorded_at, c.id`,
    [repairRecordId]
  );
  const sources = await sourcesOf(
    db,
    res.rows.flatMap(({ changes }: any) => changes.filter(({ field }: any) => field === SOURCE_FIELD).flatMap(({ before, after }: any) => [before, after].filter(Boolean)))
  );
  const sourceOf = (id: string | null) => (id ? repairSourceOf(sources.get(id)) : null);
  return res.rows.map((row: any) => ({
    id: row.id,
    target: { kind: row.target_kind, id: row.target_id },
    action: row.action,
    reason: row.reason,
    changes: row.changes.map((change: any) => (change.field === SOURCE_FIELD ? { field: SOURCE_FIELD, before: sourceOf(change.before), after: sourceOf(change.after) } : change)),
    recorded_by: row.recorded_by,
    recorded_by_username: row.recorded_by_username ?? null,
    recorded_at: new Date(row.recorded_at).toISOString(),
  }));
}

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

// What a row of the Asset search says of Repair Records (F005-T4, #98 Q21): the Repair Record that keeps
// the Asset Under Repair, for the list's badge and the bulk Reassignment notice (#98 Q11).
export interface AssetSearchRepairFacts {
  under_repair: UnderRepair | null;
}

/**
 * The Asset search's view of Repair Records (F005-T4), as `loanSearch` is its view of Loans: a filter for
 * a row aliased `a`, and what each result row says.
 */
export const repairSearch = {
  // The Asset is Under Repair.
  underRepairFilter: `EXISTS (SELECT 1 FROM repair_records r WHERE r.asset_id = a.id AND ${IS_UNDER_REPAIR})`,
  factsOf: async (db: pg.Pool | any, assetIds: string[]): Promise<(assetId: string) => AssetSearchRepairFacts> => {
    const underRepair = await underRepairOfAssets(db, assetIds);
    return (assetId) => ({ under_repair: underRepair.get(assetId) ?? null });
  },
};

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

// A Repair Record as the Loan page lists it beside the Loan Return it cites (F005-T5, RM-08, #98 Q5).
export interface CitingRepairRecord {
  id: string;
  repair_kind: RepairKind;
  start_date: string;
  is_voided: boolean;
}

/** The Repair Records citing each of `loanReturnIds` as their Repair Source, oldest Start Date first. */
export async function repairRecordsCiting(db: pg.Pool | pg.PoolClient | any, loanReturnIds: string[]): Promise<Map<string, CitingRepairRecord[]>> {
  const res = await db.query(
    `SELECT r.repair_source_loan_return_id, r.id, r.repair_kind, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, r.is_voided
     FROM repair_records r
     WHERE r.repair_source_loan_return_id = ANY($1::uuid[])
     ORDER BY r.start_date, r.recorded_at, r.id`,
    [loanReturnIds]
  );
  const citing = new Map<string, CitingRepairRecord[]>();
  for (const { repair_source_loan_return_id: loanReturnId, ...record } of res.rows) {
    citing.set(loanReturnId, [...(citing.get(loanReturnId) ?? []), record]);
  }
  return citing;
}

/**
 * F005-T1 (#99), T2 (#100), T6 (#104): reading Repair Records, their outcomes and corrections. The only
 * assignment read is where an Asset goes back to on an Outcome Date, which is shown and never stored
 * (MR-16, MR-17).
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
  ): Promise<(RepairRecord & { corrections: RepairCorrection[]; assignment_on_outcome_date?: PermanentAssignment }) | null> {
    const res = await this.db.query(`SELECT ${RECORD_COLUMNS} FROM repair_records r ${RECORD_JOINS} WHERE r.id = $1`, [repairRecordId]);
    if (res.rows.length === 0) {
      return null;
    }
    const [listed] = await recordsOf(this.db, res.rows);
    const record = { ...listed, corrections: await readCorrectionsOf(this.db, repairRecordId) };
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
    return recordsOf(this.db, res.rows);
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
      conditions.push(filters.has_outcome ? 'NOT r.is_voided AND r.has_outcome' : IS_UNDER_REPAIR);
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
    if (filters.has_repair_conflict) {
      conditions.push(`r.id IN (SELECT conflict.repair_record_id FROM (${repairConflictPairs(() => 'true')}) conflict)`);
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
    const items = await recordsOf(this.db, res.rows.filter((row: any) => row.id !== null));
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

  /** Whether any Repair Record of an Asset is in a Repair Conflict (#98 Q17). */
  async hasRepairConflict(assetId: string): Promise<boolean> {
    return (await readRepairConflictsOfAssets(this.db, [assetId])).length > 0;
  }

  /** The Repair Record that keeps an Asset Under Repair, or null when it is not. */
  async underRepairOf(assetId: string): Promise<UnderRepair | null> {
    return (await underRepairOfAssets(this.db, [assetId])).get(assetId) ?? null;
  }
}
