import pg from 'pg';
import { assetExists, containsPattern } from './asset-lookups.ts';
import type { PermanentAssignment, ReferenceEntrySummary } from './assignment.service.ts';
import { loanContextOf, type LoanContext } from './loan-read.service.ts';
import { underRepairOfAssets, type RepairKind } from './repair-read.service.ts';

export type VerificationRoundState = 'OPEN' | 'CLOSED' | 'VOIDED';
export type VerificationRoundEventKind = 'OPENED' | 'EDITED' | 'CLOSED' | 'REOPENED' | 'VOIDED';
// What one Verification Revision says (#125 Q6).
export type RecordedResult = 'FOUND' | 'NOT_FOUND';
// An Asset's current result in a Round: that of its latest revision not voided, or Not Yet Verified with none.
export type VerificationResult = RecordedResult | 'NOT_YET_VERIFIED';
export type VerificationCondition = 'NORMAL' | 'DAMAGED';

// How far a Round has gone (#125 AV-19). F006-T3 adds Discrepancies.
export interface VerificationRoundCounts {
  in_scope: number;
  found: number;
  not_found: number;
  not_yet_verified: number;
}

// The open Round, as a refusal or the Asset page names it (#125 Q17).
export interface OpenVerificationRound {
  id: string;
  name: string;
  fiscal_year: number;
  start_date: string;
}

// The Repair Record that keeps an Asset Under Repair, as an Asset Verification keeps it (#125 Q14).
export interface RepairContext {
  repair_record_id: string;
  repair_kind: RepairKind;
}

// What a result keeps of an Asset's Loan and Repair facts at recording: context only, never proof that the
// Asset was seen, and never a reason to refuse a result (#125 AV-09, LR-14).
export interface RecordingContext {
  loan_context: LoanContext | null;
  repair_context: RepairContext | null;
}

// One recorded result of an Asset in a Round (F006-T2, #125 Q6, Q8, Q14, Q26), with what the server derived
// when it was recorded. Nothing recorded later changes it (Q15).
export interface VerificationRevision {
  id: string;
  revision_number: number;
  result: RecordedResult;
  // ปกติ or ชำรุด when Found, and null when Not Found.
  condition: VerificationCondition | null;
  note: string | null;
  verification_date: string;
  // The Permanent Assignment in effect on the Verification Date, as the register showed it at recording.
  assignment_in_effect: PermanentAssignment;
  // The Loan and Repair context at recording.
  loan_context: LoanContext | null;
  repair_context: RepairContext | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

// A Round as the Round list shows it (#125 AV-17).
export interface VerificationRoundSummary {
  id: string;
  name: string;
  fiscal_year: number;
  start_date: string;
  state: VerificationRoundState;
  counts: VerificationRoundCounts;
}

// One event of a Round's history (#125 Q10, Q27, Q28, P4).
export interface VerificationRoundEvent {
  id: string;
  kind: VerificationRoundEventKind;
  reason: string | null;
  // An edit's before and after of each field it changed.
  changes: { field: string; before: unknown; after: unknown }[];
  // A close's counts at that moment.
  counts: { found: number; not_found: number; not_yet_verified: number; with_discrepancy: number } | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface VerificationRound extends VerificationRoundSummary {
  notes: string | null;
  // The entries the Round was opened with, each by its current name; none in either covers the whole register.
  filters: { organization_units: ReferenceEntrySummary[]; locations: ReferenceEntrySummary[] };
  opened_by: string;
  opened_by_username: string | null;
  recorded_at: string;
  version: number;
  history: VerificationRoundEvent[];
}

// What the register showed of an Asset when it joined the Round (#125 Q4): its identity and Current
// Assignment, each entry read by its current name, as the Asset list shows a Current Assignment.
export interface ScopeSnapshot {
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
  location: ReferenceEntrySummary | null;
  organization_unit: ReferenceEntrySummary | null;
  responsible_person: ReferenceEntrySummary | null;
  legacy_location_text: string | null;
  legacy_organization_unit_text: string | null;
  legacy_responsible_person_text: string | null;
}

// One Asset in a Round's Scope Snapshot, with its current result.
export interface ScopeEntry {
  id: string;
  asset_id: string;
  joined_as: 'OPENING' | 'LATE_ADDITION';
  snapshot: ScopeSnapshot;
  result: VerificationResult;
  current: VerificationRevision | null;
  // The version a write on the current result expects (#125 AV-23).
  version: number;
}

export interface ScopeEntryFilters {
  // A text in the snapshot's Asset Number, Serial Number or name, in any case, matched literally (#125 AR-14).
  search?: string;
  // The current result (#125 AV-19).
  result?: VerificationResult;
  limit: number;
  offset: number;
}

// What the Asset page's "ตรวจประจำปี" panel shows while a Round is open (#125 Q5, Q20).
export interface AssetVerificationPanel {
  open_round: OpenVerificationRound;
  // The Asset's scope entry in the open Round, or null when the Asset is not in its Scope Snapshot (AV-18).
  entry: ({ id: string; version: number } & CurrentResult) | null;
  // The context a result recorded now would keep (Q14).
  context: RecordingContext;
}

// An Asset's current result in a Round, and the revision that says it.
interface CurrentResult {
  result: VerificationResult;
  current: VerificationRevision | null;
}

const currentResultOf = (current: VerificationRevision | undefined): CurrentResult => ({ result: current?.result ?? 'NOT_YET_VERIFIED', current: current ?? null });

// An Asset's Asset Verification in one Round it belongs to, as its "ผลตรวจประจำปี" section lists it (#125 Q21).
export interface AssetVerification extends CurrentResult {
  round: Pick<VerificationRoundSummary, 'id' | 'name' | 'fiscal_year' | 'start_date' | 'state'>;
  entry_id: string;
  joined_as: ScopeEntry['joined_as'];
}

export interface ScopeEntryPage {
  items: ScopeEntry[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// The current result of the scope entry aliased `e`: its latest revision not voided, or Not Yet Verified (#125 AV-12).
const CURRENT_RESULT = `coalesce((SELECT v.result FROM verification_revisions v
                                  WHERE v.verification_scope_entry_id = e.id AND NOT v.is_voided
                                  ORDER BY v.revision_number DESC LIMIT 1), 'NOT_YET_VERIFIED')`;

// A Round's columns, for a row aliased `r` joined with ROUND_COUNTS.
const ROUND_COLUMNS = `r.id, r.name, r.fiscal_year, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, r.state,
       counted.in_scope, counted.found, counted.not_found`;

const ROUND_COUNTS = `CROSS JOIN LATERAL (
         SELECT count(*)::int AS in_scope,
                count(*) FILTER (WHERE current_result = 'FOUND')::int AS found,
                count(*) FILTER (WHERE current_result = 'NOT_FOUND')::int AS not_found
         FROM (SELECT ${CURRENT_RESULT} AS current_result FROM verification_scope_entries e WHERE e.verification_round_id = r.id) results
       ) counted`;

const summaryOf = (row: any): VerificationRoundSummary => ({
  id: row.id,
  name: row.name,
  fiscal_year: row.fiscal_year,
  start_date: row.start_date,
  state: row.state,
  counts: { in_scope: row.in_scope, found: row.found, not_found: row.not_found, not_yet_verified: row.in_scope - row.found - row.not_found },
});

const entryOf = (id: string | null, name: string, isActive: boolean): ReferenceEntrySummary | null => (id ? { id, name, is_active: isActive } : null);

const revisionOf = (row: any): VerificationRevision => ({
  id: row.id,
  revision_number: row.revision_number,
  result: row.result,
  condition: row.condition,
  note: row.note,
  verification_date: row.verification_date,
  assignment_in_effect: {
    location: entryOf(row.location_id, row.location_name, row.location_active),
    organization_unit: entryOf(row.organization_unit_id, row.organization_unit_name, row.organization_unit_active),
    responsible_person: entryOf(row.responsible_person_id, row.responsible_person_name, row.responsible_person_active),
    legacy_location_text: row.legacy_location_text,
    legacy_organization_unit_text: row.legacy_organization_unit_text,
    legacy_responsible_person_text: row.legacy_responsible_person_text,
  },
  loan_context: row.loan_context
    ? { kind: row.loan_context, loan_item_id: row.loan_item_id, borrower_display: row.loan_borrower_display, due_date: row.loan_due_date }
    : null,
  repair_context: row.repair_record_id ? { repair_record_id: row.repair_record_id, repair_kind: row.repair_kind } : null,
  recorded_by: row.recorded_by,
  recorded_by_username: row.recorded_by_username ?? null,
  recorded_at: new Date(row.recorded_at).toISOString(),
});

/** The open Round, or null when none is. */
export async function openVerificationRoundOf(client: pg.PoolClient | pg.Pool): Promise<OpenVerificationRound | null> {
  const res = await client.query(
    `SELECT id, name, fiscal_year, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM verification_rounds WHERE state = 'OPEN'`
  );
  return res.rows[0] ?? null;
}

/** The Loan and Repair context of an Asset now, as a result recorded now keeps it (#125 Q14). It locks nothing. */
export async function recordingContextOf(db: pg.Pool | pg.PoolClient | any, assetId: string): Promise<RecordingContext> {
  const repair = (await underRepairOfAssets(db, [assetId])).get(assetId);
  return {
    loan_context: await loanContextOf(db, assetId),
    repair_context: repair ? { repair_record_id: repair.repair_record_id, repair_kind: repair.repair_kind } : null,
  };
}

/** The current result of each of `entryIds` that has one, by scope entry: its latest revision not voided. */
export async function currentRevisionsOf(db: pg.Pool | pg.PoolClient | any, entryIds: string[]): Promise<Map<string, VerificationRevision>> {
  const res = await db.query(
    `SELECT DISTINCT ON (v.verification_scope_entry_id) v.verification_scope_entry_id, v.id, v.revision_number, v.result, v.condition, v.note,
            to_char(v.verification_date, 'YYYY-MM-DD') AS verification_date,
            v.location_id, l.name AS location_name, l.is_active AS location_active, v.legacy_location_text,
            v.organization_unit_id, o.name AS organization_unit_name, o.is_active AS organization_unit_active, v.legacy_organization_unit_text,
            v.responsible_person_id, pe.name AS responsible_person_name, pe.is_active AS responsible_person_active, v.legacy_responsible_person_text,
            v.loan_context, v.loan_item_id, v.loan_borrower_display, to_char(v.loan_due_date, 'YYYY-MM-DD') AS loan_due_date,
            v.repair_record_id, v.repair_kind, v.recorded_by, u.username AS recorded_by_username, v.recorded_at
     FROM verification_revisions v
     LEFT JOIN locations l ON l.id = v.location_id
     LEFT JOIN organization_units o ON o.id = v.organization_unit_id
     LEFT JOIN persons pe ON pe.id = v.responsible_person_id
     LEFT JOIN users u ON u.id = v.recorded_by
     WHERE v.verification_scope_entry_id = ANY($1::uuid[]) AND NOT v.is_voided
     ORDER BY v.verification_scope_entry_id, v.revision_number DESC`,
    [entryIds]
  );
  return new Map(res.rows.map((row: any) => [row.verification_scope_entry_id, revisionOf(row)]));
}

const eventOf = (row: any): VerificationRoundEvent => ({
  id: row.id,
  kind: row.kind,
  reason: row.reason,
  changes: row.changes,
  counts:
    row.kind === 'CLOSED'
      ? { found: row.found_count, not_found: row.not_found_count, not_yet_verified: row.not_yet_verified_count, with_discrepancy: row.discrepancy_count }
      : null,
  recorded_by: row.recorded_by,
  recorded_by_username: row.recorded_by_username,
  recorded_at: row.recorded_at,
});

/** F006-T1 (#126), F006-T2 (#127): the reads of Verification Rounds, their Scope Snapshots and results. */
export class VerificationReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** Every Round, newest start date first (#125 AV-17). */
  async list(): Promise<VerificationRoundSummary[]> {
    const res = await this.db.query(`SELECT ${ROUND_COLUMNS} FROM verification_rounds r ${ROUND_COUNTS} ORDER BY r.start_date DESC, r.recorded_at DESC, r.id DESC`);
    return res.rows.map(summaryOf);
  }

  /** A Round with its filters and history, or null when there is none. */
  async read(roundId: string): Promise<VerificationRound | null> {
    const res = await this.db.query(
      `SELECT ${ROUND_COLUMNS}, r.notes, r.opened_by, u.username AS opened_by_username, r.recorded_at, r.version
       FROM verification_rounds r ${ROUND_COUNTS} LEFT JOIN users u ON u.id = r.opened_by
       WHERE r.id = $1`,
      [roundId]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const filters = await this.db.query(
      `SELECT f.organization_unit_id, o.name AS organization_unit_name, o.is_active AS organization_unit_active,
              f.location_id, l.name AS location_name, l.is_active AS location_active
       FROM verification_round_filters f
       LEFT JOIN organization_units o ON o.id = f.organization_unit_id
       LEFT JOIN locations l ON l.id = f.location_id
       WHERE f.verification_round_id = $1
       ORDER BY coalesce(o.name, l.name), coalesce(f.organization_unit_id, f.location_id)`,
      [roundId]
    );
    const events = await this.db.query(
      `SELECT ev.id, ev.kind, ev.reason, ev.changes, ev.found_count, ev.not_found_count, ev.not_yet_verified_count, ev.discrepancy_count,
              ev.recorded_by, u.username AS recorded_by_username, ev.recorded_at
       FROM verification_round_events ev LEFT JOIN users u ON u.id = ev.recorded_by
       WHERE ev.verification_round_id = $1
       ORDER BY ev.recorded_at, ev.id`,
      [roundId]
    );
    return {
      ...summaryOf(row),
      notes: row.notes,
      filters: {
        organization_units: filters.rows.flatMap((f: any) => entryOf(f.organization_unit_id, f.organization_unit_name, f.organization_unit_active) ?? []),
        locations: filters.rows.flatMap((f: any) => entryOf(f.location_id, f.location_name, f.location_active) ?? []),
      },
      opened_by: row.opened_by,
      opened_by_username: row.opened_by_username,
      recorded_at: row.recorded_at,
      version: row.version,
      history: events.rows.map(eventOf),
    };
  }

  /**
   * A page of a Round's Scope Snapshot by Asset Number, then name, then Asset, a page at a time as the Asset
   * list; or null when there is no such Round.
   */
  async entries(roundId: string, filters: ScopeEntryFilters): Promise<ScopeEntryPage | null> {
    const exists = await this.db.query('SELECT 1 FROM verification_rounds WHERE id = $1', [roundId]);
    if (exists.rows.length === 0) {
      return null;
    }
    const params: unknown[] = [roundId];
    const conditions = ['e.verification_round_id = $1'];
    if (filters.search !== undefined) {
      params.push(containsPattern(filters.search));
      const param = `$${params.length}`;
      conditions.push(`(e.asset_number ILIKE ${param} ESCAPE '\\' OR e.serial_number ILIKE ${param} ESCAPE '\\' OR e.name ILIKE ${param} ESCAPE '\\')`);
    }
    if (filters.result !== undefined) {
      params.push(filters.result);
      conditions.push(`${CURRENT_RESULT} = $${params.length}`);
    }
    params.push(filters.limit, filters.offset);

    // The count joins the page, so a page past the end still says how many entries pass.
    const res = await this.db.query(
      `WITH filtered AS (
         SELECT e.* FROM verification_scope_entries e WHERE ${conditions.join(' AND ')}
       ),
       counted AS (SELECT count(*)::int AS total_count FROM filtered),
       paged AS (
         SELECT * FROM filtered
         ORDER BY asset_number NULLS LAST, name NULLS LAST, asset_id
         LIMIT $${params.length - 1} OFFSET $${params.length}
       )
       SELECT p.id, p.asset_id, p.joined_as, p.version, p.asset_number, p.serial_number, p.name, p.category,
              p.location_id, l.name AS location_name, l.is_active AS location_active, p.legacy_location_text,
              p.organization_unit_id, o.name AS organization_unit_name, o.is_active AS organization_unit_active, p.legacy_organization_unit_text,
              p.responsible_person_id, pe.name AS responsible_person_name, pe.is_active AS responsible_person_active, p.legacy_responsible_person_text,
              c.total_count
       FROM counted c
       LEFT JOIN paged p ON true
       LEFT JOIN locations l ON l.id = p.location_id
       LEFT JOIN organization_units o ON o.id = p.organization_unit_id
       LEFT JOIN persons pe ON pe.id = p.responsible_person_id
       ORDER BY p.asset_number NULLS LAST, p.name NULLS LAST, p.asset_id`,
      params
    );
    const totalCount: number = res.rows[0]?.total_count ?? 0;
    const rows = res.rows.filter((row: any) => row.id !== null);
    const current = await currentRevisionsOf(this.db, rows.map((row: any) => row.id));
    const items: ScopeEntry[] = rows.map((row: any) => ({
        id: row.id,
        asset_id: row.asset_id,
        joined_as: row.joined_as,
        snapshot: {
          asset_number: row.asset_number,
          serial_number: row.serial_number,
          name: row.name,
          category: row.category,
          location: entryOf(row.location_id, row.location_name, row.location_active),
          organization_unit: entryOf(row.organization_unit_id, row.organization_unit_name, row.organization_unit_active),
          responsible_person: entryOf(row.responsible_person_id, row.responsible_person_name, row.responsible_person_active),
          legacy_location_text: row.legacy_location_text,
          legacy_organization_unit_text: row.legacy_organization_unit_text,
          legacy_responsible_person_text: row.legacy_responsible_person_text,
        },
        ...currentResultOf(current.get(row.id)),
        version: row.version,
      }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  /** The Asset page's "ตรวจประจำปี" panel, or null while no Round is open (#125 Q5). Opening it records nothing (AV-04). */
  async panelOf(assetId: string): Promise<AssetVerificationPanel | null> {
    const openRound = await openVerificationRoundOf(this.db);
    if (!openRound) {
      return null;
    }
    const res = await this.db.query('SELECT id, version FROM verification_scope_entries WHERE verification_round_id = $1 AND asset_id = $2', [openRound.id, assetId]);
    const row = res.rows[0];
    const context = await recordingContextOf(this.db, assetId);
    if (!row) {
      return { open_round: openRound, entry: null, context };
    }
    const current = (await currentRevisionsOf(this.db, [row.id])).get(row.id);
    return { open_round: openRound, entry: { id: row.id, version: row.version, ...currentResultOf(current) }, context };
  }

  /** An Asset's current result in every Round it belongs to, newest start date first, or null when there is no such Asset (#125 Q21). */
  async verificationsOfAsset(assetId: string): Promise<AssetVerification[] | null> {
    if (!(await assetExists(this.db, assetId))) {
      return null;
    }
    const res = await this.db.query(
      `SELECT e.id AS entry_id, e.joined_as, r.id, r.name, r.fiscal_year, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, r.state
       FROM verification_scope_entries e JOIN verification_rounds r ON r.id = e.verification_round_id
       WHERE e.asset_id = $1
       ORDER BY r.start_date DESC, r.recorded_at DESC, r.id DESC`,
      [assetId]
    );
    const current = await currentRevisionsOf(this.db, res.rows.map((row: any) => row.entry_id));
    return res.rows.map((row: any) => ({
      round: { id: row.id, name: row.name, fiscal_year: row.fiscal_year, start_date: row.start_date, state: row.state },
      entry_id: row.entry_id,
      joined_as: row.joined_as,
      ...currentResultOf(current.get(row.entry_id)),
    }));
  }
}
