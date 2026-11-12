import pg from 'pg';
import { containsPattern } from './asset-lookups.ts';
import type { ReferenceEntrySummary } from './assignment.service.ts';

export type VerificationRoundState = 'OPEN' | 'CLOSED' | 'VOIDED';
export type VerificationRoundEventKind = 'OPENED' | 'EDITED' | 'CLOSED' | 'REOPENED' | 'VOIDED';
// An Asset's result in a Round. F006-T1 records none, so every Asset is Not Yet Verified.
export type VerificationResult = 'NOT_YET_VERIFIED';

// How far a Round has gone (#125 AV-19). F006-T2 adds Found, Not Found and Discrepancies.
export interface VerificationRoundCounts {
  in_scope: number;
  not_yet_verified: number;
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

// One Asset in a Round's Scope Snapshot.
export interface ScopeEntry {
  id: string;
  asset_id: string;
  joined_as: 'OPENING' | 'LATE_ADDITION';
  snapshot: ScopeSnapshot;
  result: VerificationResult;
}

export interface ScopeEntryFilters {
  // A text in the snapshot's Asset Number, Serial Number or name, in any case, matched literally (#125 AR-14).
  search?: string;
  limit: number;
  offset: number;
}

export interface ScopeEntryPage {
  items: ScopeEntry[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

const ROUND_COLUMNS = `r.id, r.name, r.fiscal_year, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, r.state,
       (SELECT count(*)::int FROM verification_scope_entries e WHERE e.verification_round_id = r.id) AS in_scope`;

const summaryOf = (row: any): VerificationRoundSummary => ({
  id: row.id,
  name: row.name,
  fiscal_year: row.fiscal_year,
  start_date: row.start_date,
  state: row.state,
  counts: { in_scope: row.in_scope, not_yet_verified: row.in_scope },
});

const entryOf = (id: string | null, name: string, isActive: boolean): ReferenceEntrySummary | null => (id ? { id, name, is_active: isActive } : null);

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

/** F006-T1 (#126): the reads of Verification Rounds and their Scope Snapshots. */
export class VerificationReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** Every Round, newest start date first (#125 AV-17). */
  async list(): Promise<VerificationRoundSummary[]> {
    const res = await this.db.query(`SELECT ${ROUND_COLUMNS} FROM verification_rounds r ORDER BY r.start_date DESC, r.recorded_at DESC, r.id DESC`);
    return res.rows.map(summaryOf);
  }

  /** A Round with its filters and history, or null when there is none. */
  async read(roundId: string): Promise<VerificationRound | null> {
    const res = await this.db.query(
      `SELECT ${ROUND_COLUMNS}, r.notes, r.opened_by, u.username AS opened_by_username, r.recorded_at, r.version
       FROM verification_rounds r LEFT JOIN users u ON u.id = r.opened_by
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
       SELECT p.id, p.asset_id, p.joined_as, p.asset_number, p.serial_number, p.name, p.category,
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
    const items: ScopeEntry[] = res.rows
      .filter((row: any) => row.id !== null)
      .map((row: any) => ({
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
        result: 'NOT_YET_VERIFIED',
      }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }
}
