import pg from 'pg';
import { assignmentBusinessDates } from './assignment-business-dates.ts';
import { isValidUuid } from './capability.service.ts';
import { loanItemBusinessDates } from './loan-item-periods.ts';
import { repairRecordBusinessDates } from './repair-business-dates.ts';
import { foundRevisionBusinessDates } from './verification-revision-read.ts';
import { ValidationError } from './validation-error.ts';

// F007-T6 (#160): the facts a Retirement Conflict compares with a Retirement Date (#154 P1), by kind.
export const RETIREMENT_CONFLICT_KINDS = ['INITIAL_ASSIGNMENT', 'REASSIGNMENT', 'LOAN_DATE', 'LOAN_RETURN', 'NOT_RETURNED', 'REPAIR_START', 'REPAIR_OUTCOME', 'FOUND'] as const;
export type RetirementConflictKind = (typeof RETIREMENT_CONFLICT_KINDS)[number];

/**
 * A fact of a Retired Asset, not voided, whose business date is later than the Retirement Date (DR-18): its kind,
 * the fact, its date, and the record it belongs to, which the Asset page links to. The fact is the assignment fact,
 * the LoanItem for its Loan Date, the Loan Return or Not Returned ending, the Repair Record for its Start Date, the
 * Repair Outcome, or the Found Verification Revision; the record is that assignment fact, the Loan, the Repair
 * Record, or the Verification Round.
 */
export interface RetirementConflict {
  kind: RetirementConflictKind;
  fact_id: string;
  fact_date: string;
  record_id: string;
}

// Every business date of the Assets that `assetScope` keeps, given the column naming an Asset, as rows of
// (asset_id, kind, fact_id, fact_date, record_id). Each module that owns a fact gives its own (CODING_STANDARDS, a
// feature's code gets its own files).
const businessDatesOf = (assetScope: (assetColumn: string) => string): string =>
  [
    assignmentBusinessDates(assetScope('e.asset_id')),
    loanItemBusinessDates(assetScope('li.asset_id')),
    repairRecordBusinessDates(assetScope('r.asset_id')),
    foundRevisionBusinessDates(assetScope('entry.asset_id')),
  ].join('\n       UNION ALL\n       ');

/**
 * The Retirement Conflicts of a Retirement of the Asset `assetId` dated `retirementDate`, both SQL expressions: its
 * facts with a later business date. A fact on the same day is none (#154 Q8). The one SQL source of the condition.
 */
export const retirementConflictFacts = (assetId: string, retirementDate: string): string => `SELECT f.kind, f.fact_id, f.fact_date, f.record_id
       FROM (${businessDatesOf((assetColumn) => `${assetColumn} = ${assetId}`)}) f
       WHERE f.fact_date > ${retirementDate}`;

/**
 * The Retirement Conflicts that a Retirement of `assetId` dated `retirementDate` has, or would have, oldest first,
 * derived on read and never stored (DR-18). A write that decides on them holds the Asset locked.
 */
export async function retirementConflictsAt(db: pg.Pool | pg.PoolClient | any, assetId: string, retirementDate: string): Promise<RetirementConflict[]> {
  const res = await db.query(
    `SELECT c.kind, c.fact_id, to_char(c.fact_date, 'YYYY-MM-DD') AS fact_date, c.record_id
     FROM (${retirementConflictFacts('$1::uuid', '$2::date')}) c
     ORDER BY c.fact_date, c.kind, c.fact_id`,
    [assetId, retirementDate]
  );
  return res.rows;
}

// What a request confirms of a Retirement Conflict warning: each fact it listed, by kind and id, the
// `confirmed_conflicts` contract of Features 004 and 005 (#154 Q21).
export interface ConfirmedRetirementConflictInput {
  conflicting_fact_kind: RetirementConflictKind;
  conflicting_fact_id: string;
}

// A Retirement Conflict's fact, by its kind and id.
const factKeyOf = ({ kind, fact_id }: Pick<RetirementConflict, 'kind' | 'fact_id'>): string => `${kind}:${fact_id}`;

/** The facts a request confirms, well formed and each once, in order. */
export function normalizeConfirmedRetirementConflicts(confirmed: ConfirmedRetirementConflictInput[] | undefined): string[] {
  const all = confirmed ?? [];
  if (all.some(({ conflicting_fact_id }) => !isValidUuid(conflicting_fact_id))) {
    throw new ValidationError('confirmed_conflicts[].conflicting_fact_id must be a valid UUID');
  }
  return [...new Set(all.map(({ conflicting_fact_kind, conflicting_fact_id }) => factKeyOf({ kind: conflicting_fact_kind, fact_id: conflicting_fact_id.trim().toLowerCase() })))].sort();
}

/** A Retirement write's retry payload with what it confirms. An unconfirmed request keeps the payload it had before (#74 Q20). */
export function withConfirmedRetirementConflicts<Payload extends object>(payload: Payload, confirmed: string[]): Payload {
  return confirmed.length > 0 ? { ...payload, confirmed_conflicts: confirmed } : payload;
}

/**
 * F007-T6 (#160): a Retirement write whose Retirement Date would fall before other facts of its Asset, refused with
 * the list of them until the request confirms each one (DR-18, #154 Q21). Nothing is saved.
 */
export class RetirementConflictWarningError extends Error {
  statusCode = 409;
  code = 'RETIREMENT_CONFLICTS_FOUND';
  retirement_conflicts: RetirementConflict[];

  constructor(retirementConflicts: RetirementConflict[]) {
    super('This Retirement Date falls before other facts of the Asset. Confirm each one to save it.');
    this.name = 'RetirementConflictWarningError';
    this.retirement_conflicts = retirementConflicts;
  }
}

/** Refuses a write with `created`, the Retirement Conflicts it would create, unless the request confirms every one. */
export function assertRetirementConflictsConfirmed(created: RetirementConflict[], confirmed: string[]): void {
  const seen = new Set(confirmed);
  if (!created.every((conflict) => seen.has(factKeyOf(conflict)))) {
    throw new RetirementConflictWarningError(created);
  }
}

/** The conflicts of `after` that `before` does not hold: those an amended Retirement Date creates. */
export function newRetirementConflicts(before: RetirementConflict[], after: RetirementConflict[]): RetirementConflict[] {
  const known = new Set(before.map(factKeyOf));
  return after.filter((conflict) => !known.has(factKeyOf(conflict)));
}
