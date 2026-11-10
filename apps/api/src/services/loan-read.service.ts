import pg from 'pg';
import { assetExists, containsPattern } from './asset-lookups.ts';
import { bangkokDate, readAssignmentsAt, type PermanentAssignment, type ReferenceEntrySummary } from './assignment.service.ts';

// The reads of Loans: the Loan page, the Loan list, an Asset's Loans and the Asset search's view of them.
// Every write to the Loan tables stays in loan.service.ts (#76); this module writes nothing (#80).

export type LoanCondition = 'NORMAL' | 'DAMAGED';

export type Borrower =
  | { kind: 'INTERNAL'; person: ReferenceEntrySummary }
  | { kind: 'EXTERNAL'; contact_name: string; organization_name: string | null; phone?: string | null };

// The Loan Return of a LoanItem. Its Condition belongs to that moment (#74 Q10).
export interface LoanReturn {
  id: string;
  return_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  document_reference: string | null;
  remark: string | null;
  action_reference: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  // "คืนเกินกำหนด": the Return Date is after the item's current Due Date, derived on read (#74 Q5).
  returned_after_due_date: boolean;
}

// The ending of a LoanItem whose Asset did not come back ("ปิดโดยไม่ได้รับคืน", #74 Q11, Q21). It is
// not a Loan Return, and it says nothing of the Asset itself.
export interface NotReturned {
  id: string;
  // The date it became known.
  not_returned_date: string;
  reason: string;
  action_reference: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export type LoanEndingKind = 'NONE' | 'LOAN_RETURN' | 'NOT_RETURNED';

// A Due Date Extension of one LoanItem ("เลื่อนกำหนดคืน", #74 Q6, Q28).
export interface DueDateExtension {
  id: string;
  prior_due_date: string;
  new_due_date: string;
  reason: string | null;
  action_reference: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
}

// An ending fact voided by a Loan Correction: it stays shown, struck through, and counts in nothing (#74 Q25).
export type VoidedEnding = ({ kind: 'LOAN_RETURN' } & Omit<LoanReturn, 'returned_after_due_date'>) | ({ kind: 'NOT_RETURNED' } & NotReturned);

export interface LoanItem {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  // The current Due Date: that of the latest Due Date Extension, or the Due Date as first recorded.
  due_date: string;
  // The Due Date as first recorded, which a Loan Correction amends (#74 Q25).
  first_due_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: LoanEndingKind;
  is_voided: boolean;
  is_overdue: boolean;
  loan_return: LoanReturn | null;
  not_returned: NotReturned | null;
  // Oldest first.
  voided_endings: VoidedEnding[];
  // Oldest first, a voided one among them.
  due_date_extensions: DueDateExtension[];
  // Where an Outstanding or Not Returned item goes back to, when the Loan is read with a Return Date (#74 Q27).
  assignment_on_return_date?: PermanentAssignment;
}

// One LoanItem of an Asset, with its Loan. The phone number is read on the Loan page only (LR-15).
export interface AssetLoanItem {
  id: string;
  loan_id: string;
  loan_date: string;
  due_date: string;
  borrower: Borrower;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: LoanEndingKind;
  is_voided: boolean;
  is_overdue: boolean;
  loan_return: LoanReturn | null;
  not_returned: NotReturned | null;
}

// Who holds an Asset that is On Loan.
export interface OnLoan {
  loan_id: string;
  borrower: Borrower;
  due_date: string;
  is_overdue: boolean;
}

// The Not Returned that keeps an Asset from a new Loan until it comes back (#74 Q21).
export interface AssetNotReturned {
  loan_id: string;
  not_returned_date: string;
}

// Derived from a Loan's non-voided items, and never stored (#74 Q1). CLOSED is "ปิดแล้ว": every item
// has ended and at least one is Not Returned (#74 Q22). A voided Loan has none (#74 Q25).
export type LoanStatus = 'OUTSTANDING' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CLOSED';

// What a correction changed of one field. A Person entry is read by its current name (#50 Q20), and the
// phone number's change keeps neither value (#74 Q24).
export type LoanCorrectionField =
  | { field: 'borrower_person_id' | 'authorizer_person_id'; before: ReferenceEntrySummary | null; after: ReferenceEntrySummary | null }
  | { field: 'borrower_phone' }
  | { field: string; before: string | null; after: string | null };

// One Loan Correction of a Loan or a fact on it (#74 Q18, Q25): who, when, why, and the before and after.
export interface LoanCorrection {
  id: string;
  target: { kind: 'LOAN' | 'LOAN_ITEM' | 'LOAN_RETURN' | 'NOT_RETURNED' | 'DUE_DATE_EXTENSION'; id: string };
  action: 'AMENDED' | 'VOIDED';
  reason: string;
  changes: LoanCorrectionField[];
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface Loan {
  id: string;
  borrower: Borrower;
  loan_date: string;
  authorizer: ReferenceEntrySummary | null;
  document_reference: string | null;
  remark: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
  // Null for a voided Loan.
  status: LoanStatus | null;
  // Whether any of its items is Overdue (#74 Q5).
  is_overdue: boolean;
  items: LoanItem[];
  // Oldest first.
  corrections: LoanCorrection[];
}

// One row of the Loan list (F004-T3). It carries no phone number, for anyone (LR-15).
export interface LoanListRow {
  id: string;
  borrower: Borrower;
  loan_date: string;
  item_count: number;
  returned_count: number;
  not_returned_count: number;
  // Null for a voided Loan, which stays listed.
  status: LoanStatus | null;
  is_voided: boolean;
  is_overdue: boolean;
}

export interface LoanListFilters {
  status?: LoanStatus;
  overdue?: boolean;
  borrower_kind?: Borrower['kind'];
  borrower_person_id?: string;
  // An External Borrower's contact or organization name, never the phone number (#74 Q24).
  borrower_name?: string;
  limit: number;
  offset: number;
}

export interface LoanList {
  items: LoanListRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// A LoanItem's current Due Date, for a row aliased `li`: the new date of its latest non-voided Due Date
// Extension by Recorded At, otherwise the Due Date as first recorded (#74). An extension only extends,
// so of two recorded in one instant the later date is the later extension.
export const CURRENT_DUE_DATE = `coalesce((SELECT x.new_due_date FROM loan_due_date_extensions x
                                    WHERE x.loan_item_id = li.id AND NOT x.is_voided
                                    ORDER BY x.recorded_at DESC, x.new_due_date DESC LIMIT 1), li.due_date)`;

// An Outstanding LoanItem, for a row aliased `li` (GLOSSARY.md: Outstanding).
const ITEM_IS_OUTSTANDING = `li.ending_kind = 'NONE' AND NOT li.is_voided`;

// LR-06, #74 Q5: an Outstanding LoanItem whose current Due Date is before today, for a row aliased `li`
// and today's Asia/Bangkok date as the parameter `today`. An item due today is not Overdue.
const itemIsOverdue = (today: string): string => `(${ITEM_IS_OUTSTANDING} AND ${CURRENT_DUE_DATE} < ${today}::date)`;

const LOAN_COLUMNS = `l.id, l.borrower_kind, l.borrower_person_id, l.borrower_contact_name, l.borrower_organization_name,
       l.borrower_phone, to_char(l.loan_date, 'YYYY-MM-DD') AS loan_date, l.authorizer_person_id, l.document_reference, l.remark,
       l.recorded_by, u.username AS recorded_by_username, l.recorded_at, l.is_voided, l.version,
       borrower.name AS borrower_name, borrower.is_active AS borrower_is_active,
       authorizer.name AS authorizer_name, authorizer.is_active AS authorizer_is_active`;

const LOAN_JOINS = `LEFT JOIN users u ON u.id = l.recorded_by
       LEFT JOIN persons borrower ON borrower.id = l.borrower_person_id
       LEFT JOIN persons authorizer ON authorizer.id = l.authorizer_person_id`;

// A LoanItem's non-voided Loan Return, of which there is at most one, for a row aliased `li`.
const LOAN_RETURN_COLUMNS = `loan_return.id AS return_id, to_char(loan_return.ending_date, 'YYYY-MM-DD') AS return_date,
       loan_return.condition AS return_condition, loan_return.condition_note AS return_condition_note,
       loan_return.document_reference AS return_document_reference, loan_return.remark AS return_remark,
       loan_return.action_reference AS return_action_reference, loan_return.recorded_by AS return_recorded_by,
       loan_return_user.username AS return_recorded_by_username, loan_return.recorded_at AS return_recorded_at,
       loan_return.ending_date > ${CURRENT_DUE_DATE} AS return_after_due_date`;

const LOAN_RETURN_JOINS = `LEFT JOIN loan_item_endings loan_return
         ON loan_return.loan_item_id = li.id AND loan_return.kind = 'LOAN_RETURN' AND NOT loan_return.is_voided
       LEFT JOIN users loan_return_user ON loan_return_user.id = loan_return.recorded_by`;

// A LoanItem's non-voided Not Returned, of which there is at most one, for a row aliased `li`.
const NOT_RETURNED_COLUMNS = `not_returned.id AS not_returned_id, to_char(not_returned.ending_date, 'YYYY-MM-DD') AS not_returned_date,
       not_returned.reason AS not_returned_reason, not_returned.action_reference AS not_returned_action_reference,
       not_returned.recorded_by AS not_returned_recorded_by, not_returned_user.username AS not_returned_recorded_by_username,
       not_returned.recorded_at AS not_returned_recorded_at`;

const NOT_RETURNED_JOINS = `LEFT JOIN loan_item_endings not_returned
         ON not_returned.loan_item_id = li.id AND not_returned.kind = 'NOT_RETURNED' AND NOT not_returned.is_voided
       LEFT JOIN users not_returned_user ON not_returned_user.id = not_returned.recorded_by`;

const notReturnedOfRow = (row: any): NotReturned | null =>
  row.not_returned_id
    ? {
        id: row.not_returned_id,
        not_returned_date: row.not_returned_date,
        reason: row.not_returned_reason,
        action_reference: row.not_returned_action_reference,
        recorded_by: row.not_returned_recorded_by,
        recorded_by_username: row.not_returned_recorded_by_username ?? null,
        recorded_at: new Date(row.not_returned_recorded_at).toISOString(),
      }
    : null;

const loanReturnOf = (row: any): LoanReturn | null =>
  row.return_id
    ? {
        id: row.return_id,
        return_date: row.return_date,
        condition: row.return_condition,
        condition_note: row.return_condition_note,
        document_reference: row.return_document_reference,
        remark: row.return_remark,
        action_reference: row.return_action_reference,
        recorded_by: row.return_recorded_by,
        recorded_by_username: row.return_recorded_by_username ?? null,
        recorded_at: new Date(row.return_recorded_at).toISOString(),
        returned_after_due_date: row.return_after_due_date,
      }
    : null;

// An item a Loan Return can still end: Outstanding, or Not Returned and come back later (#74 Q21).
const isReturnable = ({ ending_kind, is_voided }: Pick<LoanItem, 'ending_kind' | 'is_voided'>): boolean =>
  ending_kind !== 'LOAN_RETURN' && !is_voided;

// The list's SQL derives the same status over the same items.
const statusOf = (items: Pick<LoanItem, 'ending_kind' | 'is_voided'>[]): LoanStatus => {
  const counted = items.filter(({ is_voided }) => !is_voided);
  const countOf = (kind: LoanEndingKind) => counted.filter(({ ending_kind }) => ending_kind === kind).length;
  const returned = countOf('LOAN_RETURN');
  if (countOf('NONE') === 0 && countOf('NOT_RETURNED') > 0) {
    return 'CLOSED';
  }
  if (returned === 0) {
    return 'OUTSTANDING';
  }
  return returned === counted.length ? 'RETURNED' : 'PARTIALLY_RETURNED';
};

const borrowerOf = (row: any, includePhone: boolean): Borrower =>
  row.borrower_kind === 'INTERNAL'
    ? { kind: 'INTERNAL', person: { id: row.borrower_person_id, name: row.borrower_name, is_active: row.borrower_is_active } }
    : {
        kind: 'EXTERNAL',
        contact_name: row.borrower_contact_name,
        organization_name: row.borrower_organization_name,
        ...(includePhone ? { phone: row.borrower_phone } : {}),
      };

/** Who holds each of `assetIds` that is On Loan, by Asset: its Outstanding item of the latest Loan (LR-11 allows one). */
async function onLoanOfAssets(db: pg.Pool | any, assetIds: string[], today: string): Promise<Map<string, OnLoan>> {
  const res = await db.query(
    `SELECT DISTINCT ON (li.asset_id) li.asset_id, to_char(${CURRENT_DUE_DATE}, 'YYYY-MM-DD') AS due_date, ${itemIsOverdue('$2')} AS is_overdue, ${LOAN_COLUMNS}
     FROM loan_items li
     JOIN loans l ON l.id = li.loan_id
     ${LOAN_JOINS}
     WHERE li.asset_id = ANY($1::uuid[]) AND ${ITEM_IS_OUTSTANDING}
     ORDER BY li.asset_id, l.loan_date DESC, l.recorded_at DESC, li.id DESC`,
    [assetIds, today]
  );
  return new Map(
    res.rows.map((row: any): [string, OnLoan] => [
      row.asset_id,
      { loan_id: row.id, borrower: borrowerOf(row, false), due_date: row.due_date, is_overdue: row.is_overdue },
    ])
  );
}

/** The Condition of the latest Loan Return by Return Date of each of `assetIds` that has had one (#74 Q23). */
async function latestLoanReturnConditionsOf(db: pg.Pool | any, assetIds: string[]): Promise<Map<string, LoanCondition>> {
  const res = await db.query(
    `SELECT DISTINCT ON (li.asset_id) li.asset_id, e.condition
     FROM loan_item_endings e
     JOIN loan_items li ON li.id = e.loan_item_id
     WHERE li.asset_id = ANY($1::uuid[]) AND e.kind = 'LOAN_RETURN' AND NOT e.is_voided AND NOT li.is_voided
     ORDER BY li.asset_id, e.ending_date DESC, e.recorded_at DESC, e.id DESC`,
    [assetIds]
  );
  return new Map(res.rows.map((row: any): [string, LoanCondition] => [row.asset_id, row.condition]));
}

// What a row of the Asset search says of Loans (F004-T4). The latest Condition warns a new Loan from the
// list as it does from the Asset page (#76 decision 4).
export interface AssetSearchLoanFacts {
  on_loan: OnLoan | null;
  latest_loan_return_condition: LoanCondition | null;
}

/**
 * The Asset search's view of Loans (F004-T4), as `assignmentSearch` is its view of assignments: a filter
 * for a row aliased `a`, and what each result row says.
 */
export const loanSearch = {
  // The Asset is On Loan: one of its LoanItems is Outstanding.
  onLoanFilter: `EXISTS (SELECT 1 FROM loan_items li WHERE li.asset_id = a.id AND ${ITEM_IS_OUTSTANDING})`,
  factsOf: async (db: pg.Pool | any, assetIds: string[], today: string): Promise<(assetId: string) => AssetSearchLoanFacts> => {
    const onLoan = await onLoanOfAssets(db, assetIds, today);
    const latestConditions = await latestLoanReturnConditionsOf(db, assetIds);
    return (assetId) => ({ on_loan: onLoan.get(assetId) ?? null, latest_loan_return_condition: latestConditions.get(assetId) ?? null });
  },
};
// The voided ending facts of a Loan's items, by item, oldest first (#74 Q25).
async function readVoidedEndingsOf(db: pg.Pool | any, loanId: string): Promise<Map<string, VoidedEnding[]>> {
  const res = await db.query(
    `SELECT e.id, e.loan_item_id, e.kind, to_char(e.ending_date, 'YYYY-MM-DD') AS ending_date, e.condition, e.condition_note, e.reason,
            e.document_reference, e.remark, e.action_reference, e.recorded_by, u.username AS recorded_by_username, e.recorded_at
     FROM loan_item_endings e
     JOIN loan_items li ON li.id = e.loan_item_id
     LEFT JOIN users u ON u.id = e.recorded_by
     WHERE li.loan_id = $1 AND e.is_voided
     ORDER BY e.recorded_at, e.id`,
    [loanId]
  );
  const byItem = new Map<string, VoidedEnding[]>();
  for (const row of res.rows) {
    const common = {
      id: row.id,
      action_reference: row.action_reference,
      recorded_by: row.recorded_by,
      recorded_by_username: row.recorded_by_username ?? null,
      recorded_at: new Date(row.recorded_at).toISOString(),
    };
    const ending: VoidedEnding =
      row.kind === 'LOAN_RETURN'
        ? {
            kind: 'LOAN_RETURN',
            ...common,
            return_date: row.ending_date,
            condition: row.condition,
            condition_note: row.condition_note,
            document_reference: row.document_reference,
            remark: row.remark,
          }
        : { kind: 'NOT_RETURNED', ...common, not_returned_date: row.ending_date, reason: row.reason };
    byItem.set(row.loan_item_id, [...(byItem.get(row.loan_item_id) ?? []), ending]);
  }
  return byItem;
}

const PERSON_FIELDS = new Set(['borrower_person_id', 'authorizer_person_id']);

/** The corrections of a Loan and of every fact on it, oldest first, with each named Person by current name. */
async function readCorrectionsOf(db: pg.Pool | any, loanId: string): Promise<LoanCorrection[]> {
  const res = await db.query(
    `SELECT c.id, c.action, c.reason, c.changes, c.recorded_by, u.username AS recorded_by_username, c.recorded_at,
            coalesce(c.loan_id, c.loan_item_id, c.loan_item_ending_id, c.due_date_extension_id) AS target_id,
            CASE WHEN c.loan_id IS NOT NULL THEN 'LOAN'
                 WHEN c.loan_item_id IS NOT NULL THEN 'LOAN_ITEM'
                 WHEN c.due_date_extension_id IS NOT NULL THEN 'DUE_DATE_EXTENSION'
                 ELSE e.kind END AS target_kind
     FROM loan_corrections c
     LEFT JOIN loan_items li ON li.id = c.loan_item_id
     LEFT JOIN loan_item_endings e ON e.id = c.loan_item_ending_id
     LEFT JOIN loan_items ending_item ON ending_item.id = e.loan_item_id
     LEFT JOIN loan_due_date_extensions x ON x.id = c.due_date_extension_id
     LEFT JOIN loan_items extension_item ON extension_item.id = x.loan_item_id
     LEFT JOIN users u ON u.id = c.recorded_by
     WHERE $1 IN (c.loan_id, li.loan_id, ending_item.loan_id, extension_item.loan_id)
     ORDER BY c.recorded_at, c.id`,
    [loanId]
  );
  const personIds = [
    ...new Set(
      res.rows.flatMap(({ changes }: any) =>
        changes.filter(({ field }: any) => PERSON_FIELDS.has(field)).flatMap(({ before, after }: any) => [before, after].filter(Boolean))
      )
    ),
  ];
  const persons = new Map<string, ReferenceEntrySummary>(
    personIds.length > 0
      ? (await db.query('SELECT id, name, is_active FROM persons WHERE id = ANY($1::uuid[])', [personIds])).rows.map((person: any) => [person.id, person])
      : []
  );
  const personOf = (id: string | null) => (id ? (persons.get(id) ?? null) : null);
  return res.rows.map((row: any) => ({
    id: row.id,
    target: { kind: row.target_kind, id: row.target_id },
    action: row.action,
    reason: row.reason,
    changes: row.changes.map((change: any) =>
      PERSON_FIELDS.has(change.field) ? { field: change.field, before: personOf(change.before), after: personOf(change.after) } : change
    ),
    recorded_by: row.recorded_by,
    recorded_by_username: row.recorded_by_username ?? null,
    recorded_at: new Date(row.recorded_at).toISOString(),
  }));
}

/**
 * F004-T1 (#75) to T6 (#80): reading Loans. Only a read with a Return Date looks at an assignment fact.
 */
export class LoanReadService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * A Loan with its items, or null when there is none. The phone number needs `includePhone` (LR-15).
   * With `returnDate`, each Outstanding item also says where it goes back to on that date (MR-16).
   */
  async read(loanId: string, { includePhone, returnDate }: { includePhone: boolean; returnDate?: string }): Promise<Loan | null> {
    const loanRes = await this.db.query(
      `SELECT ${LOAN_COLUMNS}
       FROM loans l
       ${LOAN_JOINS}
       WHERE l.id = $1`,
      [loanId]
    );
    if (loanRes.rows.length === 0) {
      return null;
    }
    const row = loanRes.rows[0];
    const itemsRes = await this.db.query(
      `SELECT li.id, li.asset_id, a.name AS asset_name, a.asset_number, to_char(${CURRENT_DUE_DATE}, 'YYYY-MM-DD') AS due_date,
              to_char(li.due_date, 'YYYY-MM-DD') AS first_due_date, li.lending_condition, li.lending_condition_note, li.ending_kind, li.is_voided,
              ${itemIsOverdue('$2')} AS is_overdue, ${LOAN_RETURN_COLUMNS}, ${NOT_RETURNED_COLUMNS}
       FROM loan_items li
       JOIN assets a ON a.id = li.asset_id
       ${LOAN_RETURN_JOINS}
       ${NOT_RETURNED_JOINS}
       WHERE li.loan_id = $1
       ORDER BY a.name NULLS LAST, a.id`,
      [loanId, bangkokDate(this.clock())]
    );
    const extensionsRes = await this.db.query(
      `SELECT x.id, x.loan_item_id, to_char(x.prior_due_date, 'YYYY-MM-DD') AS prior_due_date,
              to_char(x.new_due_date, 'YYYY-MM-DD') AS new_due_date, x.reason, x.action_reference,
              x.recorded_by, u.username AS recorded_by_username, x.recorded_at, x.is_voided
       FROM loan_due_date_extensions x
       JOIN loan_items li ON li.id = x.loan_item_id
       LEFT JOIN users u ON u.id = x.recorded_by
       WHERE li.loan_id = $1
       ORDER BY x.recorded_at, x.new_due_date`,
      [loanId]
    );
    const extensionsOf = (itemId: string): DueDateExtension[] =>
      extensionsRes.rows
        .filter(({ loan_item_id }: any) => loan_item_id === itemId)
        .map(({ loan_item_id: _itemId, recorded_by_username, recorded_at, ...extension }: any) => ({
          ...extension,
          recorded_by_username: recorded_by_username ?? null,
          recorded_at: new Date(recorded_at).toISOString(),
        }));
    const voidedEndings = await readVoidedEndingsOf(this.db, loanId);
    const assignments = returnDate
      ? await readAssignmentsAt(this.db, itemsRes.rows.filter(isReturnable).map((item: any) => item.asset_id), returnDate)
      : null;
    return {
      id: row.id,
      borrower: borrowerOf(row, includePhone),
      loan_date: row.loan_date,
      authorizer: row.authorizer_person_id
        ? { id: row.authorizer_person_id, name: row.authorizer_name, is_active: row.authorizer_is_active }
        : null,
      document_reference: row.document_reference,
      remark: row.remark,
      recorded_by: row.recorded_by,
      recorded_by_username: row.recorded_by_username ?? null,
      recorded_at: new Date(row.recorded_at).toISOString(),
      is_voided: row.is_voided,
      version: row.version,
      status: row.is_voided ? null : statusOf(itemsRes.rows),
      is_overdue: itemsRes.rows.some((item: any) => item.is_overdue),
      items: itemsRes.rows.map((item: any) => ({
        id: item.id,
        asset: { id: item.asset_id, name: item.asset_name, asset_number: item.asset_number },
        due_date: item.due_date,
        first_due_date: item.first_due_date,
        condition: item.lending_condition,
        condition_note: item.lending_condition_note,
        ending_kind: item.ending_kind,
        is_voided: item.is_voided,
        is_overdue: item.is_overdue,
        loan_return: loanReturnOf(item),
        not_returned: notReturnedOfRow(item),
        voided_endings: voidedEndings.get(item.id) ?? [],
        due_date_extensions: extensionsOf(item.id),
        assignment_on_return_date: assignments?.get(item.asset_id),
      })),
      corrections: await readCorrectionsOf(this.db, loanId),
    };
  }

  /** The Loans that pass every filter given, latest Loan Date first, a page at a time as the Asset list. */
  async list(filters: LoanListFilters): Promise<LoanList> {
    const params: unknown[] = [bangkokDate(this.clock())];
    const conditions: string[] = [];
    const where = (condition: (param: string) => string, value: unknown) => {
      params.push(value);
      conditions.push(condition(`$${params.length}`));
    };
    if (filters.borrower_kind !== undefined) {
      where((param) => `borrower_kind = ${param}`, filters.borrower_kind);
    }
    if (filters.borrower_person_id !== undefined) {
      where((param) => `borrower_person_id = ${param}`, filters.borrower_person_id);
    }
    if (filters.borrower_name !== undefined) {
      where(
        (param) => `(borrower_contact_name ILIKE ${param} ESCAPE '\\' OR borrower_organization_name ILIKE ${param} ESCAPE '\\')`,
        containsPattern(filters.borrower_name)
      );
    }
    if (filters.status !== undefined) {
      where((param) => `status = ${param}`, filters.status);
    }
    if (filters.overdue) {
      conditions.push('is_overdue');
    }
    params.push(filters.limit, filters.offset);

    // The status follows statusOf, over the same non-voided items, and a voided Loan has none.
    const res = await this.db.query(
      `WITH summarized AS (
         SELECT l.id, l.borrower_kind, l.borrower_person_id, l.borrower_contact_name, l.borrower_organization_name,
                to_char(l.loan_date, 'YYYY-MM-DD') AS loan_date, l.loan_date AS sort_date, l.recorded_at,
                borrower.name AS borrower_name, borrower.is_active AS borrower_is_active,
                l.is_voided, items.item_count, items.returned_count, items.not_returned_count, items.is_overdue,
                CASE WHEN l.is_voided THEN NULL
                     WHEN items.outstanding_count = 0 AND items.not_returned_count > 0 THEN 'CLOSED'
                     WHEN items.returned_count = 0 THEN 'OUTSTANDING'
                     WHEN items.returned_count = items.item_count THEN 'RETURNED'
                     ELSE 'PARTIALLY_RETURNED' END AS status
         FROM loans l
         LEFT JOIN persons borrower ON borrower.id = l.borrower_person_id
         CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE NOT li.is_voided)::int AS item_count,
                  count(*) FILTER (WHERE NOT li.is_voided AND li.ending_kind = 'LOAN_RETURN')::int AS returned_count,
                  count(*) FILTER (WHERE NOT li.is_voided AND li.ending_kind = 'NOT_RETURNED')::int AS not_returned_count,
                  count(*) FILTER (WHERE NOT li.is_voided AND li.ending_kind = 'NONE')::int AS outstanding_count,
                  coalesce(bool_or(${itemIsOverdue('$1')}), false) AS is_overdue
           FROM loan_items li
           WHERE li.loan_id = l.id
         ) items
       ),
       filtered AS (
         SELECT * FROM summarized
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
    const items: LoanListRow[] = res.rows
      .filter((row: any) => row.id !== null)
      .map((row: any) => ({
        id: row.id,
        borrower: borrowerOf(row, false),
        loan_date: row.loan_date,
        item_count: row.item_count,
        returned_count: row.returned_count,
        not_returned_count: row.not_returned_count,
        status: row.status,
        is_voided: row.is_voided,
        is_overdue: row.is_overdue,
      }));
    return { items, limit: filters.limit, offset: filters.offset, total_count: totalCount, has_more: filters.offset + items.length < totalCount };
  }

  private async readItemsOfAsset(assetId: string): Promise<AssetLoanItem[]> {
    const res = await this.db.query(
      `SELECT li.id AS item_id, to_char(${CURRENT_DUE_DATE}, 'YYYY-MM-DD') AS due_date, li.lending_condition, li.lending_condition_note,
              li.ending_kind, li.is_voided AS item_is_voided, ${itemIsOverdue('$2')} AS is_overdue,
              ${LOAN_COLUMNS}, ${LOAN_RETURN_COLUMNS}, ${NOT_RETURNED_COLUMNS}
       FROM loan_items li
       JOIN loans l ON l.id = li.loan_id
       ${LOAN_JOINS}
       ${LOAN_RETURN_JOINS}
       ${NOT_RETURNED_JOINS}
       WHERE li.asset_id = $1
       ORDER BY l.loan_date DESC, l.recorded_at DESC, li.id DESC`,
      [assetId, bangkokDate(this.clock())]
    );
    return res.rows.map((row: any) => ({
      id: row.item_id,
      loan_id: row.id,
      loan_date: row.loan_date,
      due_date: row.due_date,
      borrower: borrowerOf(row, false),
      condition: row.lending_condition,
      condition_note: row.lending_condition_note,
      ending_kind: row.ending_kind,
      is_voided: row.item_is_voided,
      is_overdue: row.is_overdue,
      loan_return: loanReturnOf(row),
      not_returned: notReturnedOfRow(row),
    }));
  }

  /** The LoanItems of an Asset with their Loans, latest Loan Date first, or null when there is no such Asset. */
  async itemsOfAsset(assetId: string): Promise<AssetLoanItem[] | null> {
    return (await assetExists(this.db, assetId)) ? this.readItemsOfAsset(assetId) : null;
  }

  /** The Condition of an Asset's latest Loan Return by Return Date, or null when it has had none (#74 Q23). */
  async latestLoanReturnConditionOf(assetId: string): Promise<LoanCondition | null> {
    return (await latestLoanReturnConditionsOf(this.db, [assetId])).get(assetId) ?? null;
  }

  /** Who holds an Asset, or null when it is not On Loan. */
  async onLoanOf(assetId: string): Promise<OnLoan | null> {
    return (await onLoanOfAssets(this.db, [assetId], bangkokDate(this.clock()))).get(assetId) ?? null;
  }

  /** The Not Returned that keeps an Asset from a new Loan, or null when there is none (#74 Q21). */
  async assetNotReturnedOf(assetId: string): Promise<AssetNotReturned | null> {
    const items = await this.readItemsOfAsset(assetId);
    const notReturned = items.find(({ ending_kind, is_voided }) => ending_kind === 'NOT_RETURNED' && !is_voided);
    return notReturned?.not_returned ? { loan_id: notReturned.loan_id, not_returned_date: notReturned.not_returned.not_returned_date } : null;
  }
}
