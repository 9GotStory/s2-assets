import pg from 'pg';
import { assetExists, containsPattern } from './asset.service.ts';
import { isValidUuid } from './capability.service.ts';
import { hasStrictControlChars } from './control-characters.ts';
import {
  DOCUMENT_REFERENCE_MAX_LENGTH,
  REMARK_MAX_LENGTH,
  bangkokDate,
  isCalendarDate,
  lockAssetsInIdentifierOrder,
  normalizeText,
  readAssignmentsAt,
  type PermanentAssignment,
  type ReferenceEntrySummary,
} from './assignment.service.ts';
import { isSelectablePerson } from './reference.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

// #74 Q9: as many as a Bulk Reassignment.
export const MAX_ASSETS = 100;

const CONTACT_NAME_MAX_LENGTH = 200;
const ORGANIZATION_NAME_MAX_LENGTH = 200;
const PHONE_MAX_LENGTH = 32;
export const CONDITION_NOTE_MAX_LENGTH = 500;

const PHONE_PATTERN = /^[0-9+\- ]+$/;

export type LoanCondition = 'NORMAL' | 'DAMAGED';

export type BorrowerInput =
  | { kind: 'INTERNAL'; person_id: string }
  | { kind: 'EXTERNAL'; contact_name: string; organization_name?: string | null; phone?: string | null };

export interface LoanItemInput {
  asset_id: string;
  condition: LoanCondition;
  condition_note?: string | null;
}

export interface StartLoanInput {
  assets: LoanItemInput[];
  borrower: BorrowerInput;
  loan_date: string;
  due_date: string;
  authorizer_person_id?: string | null;
  document_reference?: string | null;
  remark?: string | null;
}

// What a Loan write answers. It carries no Borrower detail, because the retry-token store keeps it
// and a Loan Correction could not remove it from there (LR-15, #74 Q24).
export interface StartedLoan {
  loan_id: string;
  version: number;
  items: { id: string; asset_id: string }[];
}

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

export interface LoanItem {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  // The current Due Date: that of the latest Due Date Extension, or the Due Date as first recorded.
  due_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: LoanEndingKind;
  is_voided: boolean;
  is_overdue: boolean;
  loan_return: LoanReturn | null;
  not_returned: NotReturned | null;
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
// has ended and at least one is Not Returned (#74 Q22).
export type LoanStatus = 'OUTSTANDING' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CLOSED';

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
  status: LoanStatus;
  // Whether any of its items is Overdue (#74 Q5).
  is_overdue: boolean;
  items: LoanItem[];
}

// One row of the Loan list (F004-T3). It carries no phone number, for anyone (LR-15).
export interface LoanListRow {
  id: string;
  borrower: Borrower;
  loan_date: string;
  item_count: number;
  returned_count: number;
  not_returned_count: number;
  status: LoanStatus;
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

// An Asset that cannot be lent, and why. It names the Loan that holds it, never that Loan's Borrower (LR-15).
export type RefusedAsset = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'NOT_FOUND' }
  | { reason: 'ON_LOAN'; loan_id: string }
  | { reason: 'NOT_RETURNED'; loan_id: string }
);

/** A Loan names Assets that cannot be lent. Nothing is saved, and the answer names each one and why. */
export class AssetsNotLendableError extends Error {
  statusCode = 409;
  code = 'ASSETS_NOT_LENDABLE';
  assets: RefusedAsset[];

  constructor(assets: RefusedAsset[]) {
    super(`These Assets cannot be lent: ${assets.map(({ asset_id, name, asset_number }) => name ?? asset_number ?? asset_id).join(', ')}`);
    this.name = 'AssetsNotLendableError';
    this.assets = assets;
  }
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface LoanFacts {
  items: { asset_id: string; condition: LoanCondition; condition_note: string | null }[];
  borrower:
    | { kind: 'INTERNAL'; person_id: string }
    | { kind: 'EXTERNAL'; contact_name: string; organization_name: string | null; phone: string | null };
  loan_date: string;
  due_date: string;
  authorizer_person_id: string | null;
  document_reference: string | null;
  remark: string | null;
}

// One line of text: trimmed, blank as none, bounded, and with no control character, even at its ends.
const normalizeLine = (value: string | null | undefined, field: string, maxLength: number): string | null => {
  if (hasStrictControlChars(value ?? '')) {
    throw new ValidationError(`${field} must not contain control characters`);
  }
  const text = value?.trim() ?? '';
  if (text.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return text.length > 0 ? text : null;
};

const normalizePhone = (value: string | null | undefined): string | null => {
  const phone = normalizeLine(value, 'borrower.phone', PHONE_MAX_LENGTH);
  if (phone !== null && !PHONE_PATTERN.test(phone)) {
    throw new ValidationError('borrower.phone must contain only digits, spaces, plus and hyphen');
  }
  return phone;
};

const normalizeBorrower = (borrower: BorrowerInput): LoanFacts['borrower'] => {
  if (borrower.kind === 'INTERNAL') {
    if (!isValidUuid(borrower.person_id)) {
      throw new ValidationError('borrower.person_id must name a Person Reference List entry');
    }
    return { kind: 'INTERNAL', person_id: borrower.person_id.trim().toLowerCase() };
  }
  const contactName = normalizeLine(borrower.contact_name, 'borrower.contact_name', CONTACT_NAME_MAX_LENGTH);
  if (contactName === null) {
    throw new ValidationError('borrower.contact_name is required for an External Borrower');
  }
  return {
    kind: 'EXTERNAL',
    contact_name: contactName,
    organization_name: normalizeLine(borrower.organization_name, 'borrower.organization_name', ORGANIZATION_NAME_MAX_LENGTH),
    phone: normalizePhone(borrower.phone),
  };
};

// The items of a request in Asset identifier order.
const normalizeItems = (items: LoanItemInput[]): LoanFacts['items'] => {
  if (items.length < 1 || items.length > MAX_ASSETS) {
    throw new ValidationError(`A Loan names 1 to ${MAX_ASSETS} Assets`);
  }
  if (items.some(({ asset_id }) => !isValidUuid(asset_id))) {
    throw new ValidationError('asset_id must be a valid UUID');
  }
  const normalized = items
    .map(({ asset_id, condition, condition_note }) => ({
      asset_id: asset_id.trim().toLowerCase(),
      condition,
      condition_note: normalizeText(condition_note, 'condition_note', CONDITION_NOTE_MAX_LENGTH, ''),
    }))
    .sort((a, b) => (a.asset_id < b.asset_id ? -1 : 1));
  if (new Set(normalized.map(({ asset_id }) => asset_id)).size !== normalized.length) {
    throw new ValidationError('A Loan names each Asset once');
  }
  return normalized;
};

// #74 Q3, Q4: dates compare as text, which YYYY-MM-DD keeps in calendar order.
const normalizeDates = (input: StartLoanInput, today: string): Pick<LoanFacts, 'loan_date' | 'due_date'> => {
  const { loan_date: loanDate, due_date: dueDate } = input;
  if (!isCalendarDate(loanDate)) {
    throw new ValidationError('loan_date must be a date (YYYY-MM-DD)');
  }
  if (loanDate > today) {
    throw new ValidationError(`loan_date must not be after today (${today}, Asia/Bangkok)`);
  }
  if (!isCalendarDate(dueDate)) {
    throw new ValidationError('due_date must be a date (YYYY-MM-DD)');
  }
  if (dueDate < loanDate) {
    throw new ValidationError('due_date must not be before loan_date');
  }
  return { loan_date: loanDate, due_date: dueDate };
};

const normalizeAuthorizer = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isValidUuid(value)) {
    throw new ValidationError('authorizer_person_id must name a Person Reference List entry');
  }
  return value.trim().toLowerCase();
};

const normalizeFacts = (input: StartLoanInput, today: string): LoanFacts => ({
  items: normalizeItems(input.assets),
  borrower: normalizeBorrower(input.borrower),
  ...normalizeDates(input, today),
  authorizer_person_id: normalizeAuthorizer(input.authorizer_person_id),
  document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
  remark: normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, ''),
});

// A LoanItem's current Due Date, for a row aliased `li`: the new date of its latest non-voided Due Date
// Extension by Recorded At, otherwise the Due Date as first recorded (#74). An extension only extends,
// so of two recorded in one instant the later date is the later extension.
const CURRENT_DUE_DATE = `coalesce((SELECT x.new_due_date FROM loan_due_date_extensions x
                                    WHERE x.loan_item_id = li.id AND NOT x.is_voided
                                    ORDER BY x.recorded_at DESC, x.new_due_date DESC LIMIT 1), li.due_date)`;

// LR-06, #74 Q5: an Outstanding LoanItem whose current Due Date is before today, for a row aliased `li`
// and today's Asia/Bangkok date as the parameter `today`. An item due today is not Overdue.
const itemIsOverdue = (today: string): string =>
  `(li.ending_kind = 'NONE' AND NOT li.is_voided AND ${CURRENT_DUE_DATE} < ${today}::date)`;

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

const notReturnedOf = (row: any): NotReturned | null =>
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

const isOutstanding = ({ ending_kind, is_voided }: Pick<LoanItem, 'ending_kind' | 'is_voided'>): boolean => ending_kind === 'NONE' && !is_voided;

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

// A Loan under a write's lock.
export interface LockedLoan {
  id: string;
  loan_date: string;
  version: number;
}

/** Locks a Loan's row, the first lock of any write on an existing Loan (#74), or null when there is none. */
export async function lockLoan(client: pg.PoolClient, loanId: string): Promise<LockedLoan | null> {
  const res = await client.query(`SELECT id, to_char(loan_date, 'YYYY-MM-DD') AS loan_date, version FROM loans WHERE id = $1 FOR UPDATE`, [loanId]);
  return res.rows[0] ?? null;
}

// A LoanItem as a write on its locked Loan sees it, with its Asset's names.
export interface LoanItemOfLockedLoan {
  id: string;
  asset_id: string;
  name: string | null;
  asset_number: string | null;
  ending_kind: LoanEndingKind;
  is_voided: boolean;
  // The current Due Date.
  due_date: string;
  // The date of the item's non-voided Not Returned, or null.
  not_returned_date: string | null;
}

/** The items of a Loan whose row the caller holds locked, so they cannot change under it. */
export async function readItemsOfLockedLoan(client: pg.PoolClient, loanId: string): Promise<LoanItemOfLockedLoan[]> {
  const res = await client.query(
    `SELECT li.id, li.asset_id, a.name, a.asset_number, li.ending_kind, li.is_voided,
            to_char(${CURRENT_DUE_DATE}, 'YYYY-MM-DD') AS due_date, to_char(not_returned.ending_date, 'YYYY-MM-DD') AS not_returned_date
     FROM loan_items li
     JOIN assets a ON a.id = li.asset_id
     LEFT JOIN loan_item_endings not_returned
       ON not_returned.loan_item_id = li.id AND not_returned.kind = 'NOT_RETURNED' AND NOT not_returned.is_voided
     WHERE li.loan_id = $1`,
    [loanId]
  );
  return res.rows;
}

// A LoanItem that a write for Outstanding items cannot take, and why.
export interface RefusedOutstandingItem {
  loan_item_id: string;
  asset_id: string | null;
  name: string | null;
  asset_number: string | null;
  reason: 'NOT_FOUND' | 'VOIDED' | 'ALREADY_RETURNED' | 'NOT_RETURNED';
}

/** A write for Outstanding items names one that is not. Nothing is saved, and the answer names each one and why. */
export class LoanItemsNotOutstandingError extends Error {
  statusCode = 409;
  code = 'LOAN_ITEMS_NOT_OUTSTANDING';
  items: RefusedOutstandingItem[];

  constructor(items: RefusedOutstandingItem[]) {
    super(`These items are not Outstanding: ${items.map(({ loan_item_id, name, asset_number }) => name ?? asset_number ?? loan_item_id).join(', ')}`);
    this.name = 'LoanItemsNotOutstandingError';
    this.items = items;
  }
}

/**
 * Refuses the write unless every item named is an Outstanding item of the locked Loan: a Not Returned
 * and a Due Date Extension take nothing else (#74).
 */
export function assertOutstanding(itemIds: string[], loanItems: LoanItemOfLockedLoan[]): void {
  const itemById = new Map(loanItems.map((item) => [item.id, item]));
  const refused = itemIds.flatMap((loanItemId): RefusedOutstandingItem[] => {
    const item = itemById.get(loanItemId);
    if (!item) {
      return [{ loan_item_id: loanItemId, asset_id: null, name: null, asset_number: null, reason: 'NOT_FOUND' }];
    }
    const { asset_id, name, asset_number } = item;
    if (item.is_voided) {
      return [{ loan_item_id: loanItemId, asset_id, name, asset_number, reason: 'VOIDED' }];
    }
    if (item.ending_kind === 'NONE') {
      return [];
    }
    return [{ loan_item_id: loanItemId, asset_id, name, asset_number, reason: item.ending_kind === 'LOAN_RETURN' ? 'ALREADY_RETURNED' : 'NOT_RETURNED' }];
  });
  if (refused.length > 0) {
    throw new LoanItemsNotOutstandingError(refused);
  }
}

// One Not Returned recording's facts, which every item shares (#74 Q21).
export interface NotReturnedFacts {
  not_returned_date: string;
  reason: string;
  loan_item_ids: string[];
}

/** Records one Not Returned per item and each item's ending kind, together in the caller's transaction (#74). */
export async function recordNotReturned(
  client: pg.PoolClient,
  { facts, actionReference, actorId }: { facts: NotReturnedFacts; actionReference: string; actorId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO loan_item_endings (loan_item_id, kind, ending_date, reason, action_reference, recorded_by)
     SELECT item_id, 'NOT_RETURNED', $1, $2, $3, $4
     FROM unnest($5::uuid[]) AS item_id`,
    [facts.not_returned_date, facts.reason, actionReference, actorId, facts.loan_item_ids]
  );
  await client.query(`UPDATE loan_items SET ending_kind = 'NOT_RETURNED' WHERE id = ANY($1::uuid[])`, [facts.loan_item_ids]);
}

// One Due Date Extension recording: the new date and reason it shares, and each item's prior date.
export interface DueDateExtensionFacts {
  new_due_date: string;
  reason: string | null;
  items: { loan_item_id: string; prior_due_date: string }[];
}

/** Records one Due Date Extension per item, in the caller's transaction (#74 Q6). */
export async function recordDueDateExtensions(
  client: pg.PoolClient,
  { facts, actionReference, actorId }: { facts: DueDateExtensionFacts; actionReference: string; actorId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO loan_due_date_extensions (loan_item_id, prior_due_date, new_due_date, reason, action_reference, recorded_by)
     SELECT item.id, item.prior_due_date, $1, $2, $3, $4
     FROM unnest($5::uuid[], $6::date[]) AS item(id, prior_due_date)`,
    [
      facts.new_due_date,
      facts.reason,
      actionReference,
      actorId,
      facts.items.map(({ loan_item_id }) => loan_item_id),
      facts.items.map(({ prior_due_date }) => prior_due_date),
    ]
  );
}

// One recording's facts: what its items share, and each item's own Condition (#74 Q29).
export interface LoanReturnFacts {
  return_date: string;
  document_reference: string | null;
  remark: string | null;
  items: { loan_item_id: string; condition: LoanCondition; condition_note: string | null }[];
}

/** Records one ending fact per item and each item's ending kind, together in the caller's transaction (#74). */
export async function recordLoanReturns(
  client: pg.PoolClient,
  { facts, actionReference, actorId }: { facts: LoanReturnFacts; actionReference: string; actorId: string }
): Promise<void> {
  const itemIds = facts.items.map(({ loan_item_id }) => loan_item_id);
  await client.query(
    `INSERT INTO loan_item_endings (loan_item_id, kind, ending_date, condition, condition_note, document_reference, remark, action_reference, recorded_by)
     SELECT item.id, 'LOAN_RETURN', $1, item.condition, item.note, $2, $3, $4, $5
     FROM unnest($6::uuid[], $7::text[], $8::text[]) AS item(id, condition, note)`,
    [
      facts.return_date,
      facts.document_reference,
      facts.remark,
      actionReference,
      actorId,
      itemIds,
      facts.items.map(({ condition }) => condition),
      facts.items.map(({ condition_note }) => condition_note),
    ]
  );
  await client.query(`UPDATE loan_items SET ending_kind = 'LOAN_RETURN' WHERE id = ANY($1::uuid[])`, [itemIds]);
}

/** Increments a locked Loan's version, as every write on it does, and returns the new version. */
export async function incrementLoanVersion(client: pg.PoolClient, loanId: string): Promise<number> {
  const res = await client.query('UPDATE loans SET version = version + 1 WHERE id = $1 RETURNING version', [loanId]);
  return res.rows[0].version;
}

/**
 * F004-T1 (#75): starting a Loan and reading it. A Loan never touches an assignment fact (LR-10), and
 * only a read with a Return Date looks at one.
 */
export class LoanService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Locks the Assets, in identifier order, and refuses the Loan if any of them cannot be lent (LR-11).
  private async assertLendable(client: pg.PoolClient, assetIds: string[]): Promise<void> {
    const locked = new Map((await lockAssetsInIdentifierOrder(client, assetIds)).map((asset) => [asset.id, asset]));
    // An Asset whose LoanItem ended Not Returned stays out of a new Loan, whatever its date (#74 Q21).
    const heldRes = await client.query(
      `SELECT asset_id, loan_id, ending_kind FROM loan_items
       WHERE asset_id = ANY($1::uuid[]) AND NOT is_voided AND ending_kind IN ('NONE', 'NOT_RETURNED')`,
      [assetIds]
    );
    const heldBy = new Map<string, { loan_id: string; ending_kind: LoanEndingKind }>(heldRes.rows.map((row: any) => [row.asset_id, row]));

    const refused = assetIds.flatMap((assetId): RefusedAsset[] => {
      const asset = locked.get(assetId);
      if (!asset) {
        return [{ asset_id: assetId, name: null, asset_number: null, reason: 'NOT_FOUND' }];
      }
      const held = heldBy.get(assetId);
      if (!held) {
        return [];
      }
      const reason = held.ending_kind === 'NONE' ? 'ON_LOAN' : 'NOT_RETURNED';
      return [{ asset_id: assetId, name: asset.name, asset_number: asset.asset_number, reason, loan_id: held.loan_id }];
    });
    if (refused.length > 0) {
      throw new AssetsNotLendableError(refused);
    }
  }

  // A Person named on a Loan must be on the list and, unless the Loan Date is before today, active (#74 Q7, Q14).
  private async assertNamedPersons(client: pg.PoolClient, facts: LoanFacts, today: string): Promise<void> {
    const allowInactive = facts.loan_date < today;
    const named = [
      { field: 'borrower.person_id', id: facts.borrower.kind === 'INTERNAL' ? facts.borrower.person_id : null },
      { field: 'authorizer_person_id', id: facts.authorizer_person_id },
    ];
    for (const { field, id } of named) {
      if (id && !(await isSelectablePerson(client, id, { allowInactive }))) {
        throw new ValidationError(`${field} must name ${allowInactive ? 'an' : 'an active'} entry of the Person Reference List`);
      }
    }
  }

  async start(actorId: string, input: StartLoanInput, { retryToken }: { retryToken: string }): Promise<StartedLoan> {
    const today = bangkokDate(this.clock());
    const facts = normalizeFacts(input, today);
    return commitOnce(
      this.db,
      { actorId, operation: 'loan:start', retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        await this.assertLendable(client, facts.items.map(({ asset_id }) => asset_id));
        await this.assertNamedPersons(client, facts, today);
        const { borrower, items } = facts;
        const external = borrower.kind === 'EXTERNAL' ? borrower : null;
        const loanRes = await client.query(
          `INSERT INTO loans (borrower_kind, borrower_person_id, borrower_contact_name, borrower_organization_name, borrower_phone,
                              loan_date, authorizer_person_id, document_reference, remark, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, version`,
          [
            borrower.kind,
            borrower.kind === 'INTERNAL' ? borrower.person_id : null,
            external?.contact_name ?? null,
            external?.organization_name ?? null,
            external?.phone ?? null,
            facts.loan_date,
            facts.authorizer_person_id,
            facts.document_reference,
            facts.remark,
            actorId,
          ]
        );
        const loanId: string = loanRes.rows[0].id;
        const itemsRes = await client.query(
          `INSERT INTO loan_items (loan_id, asset_id, due_date, lending_condition, lending_condition_note)
           SELECT $1, asset_id, $2, condition, note
           FROM unnest($3::uuid[], $4::text[], $5::text[]) AS item(asset_id, condition, note)
           RETURNING id, asset_id`,
          [loanId, facts.due_date, items.map(({ asset_id }) => asset_id), items.map(({ condition }) => condition), items.map(({ condition_note }) => condition_note)]
        );
        return {
          loan_id: loanId,
          version: loanRes.rows[0].version,
          items: itemsRes.rows.map(({ id, asset_id }: any) => ({ id, asset_id })),
        };
      }
    );
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
              li.lending_condition, li.lending_condition_note, li.ending_kind, li.is_voided,
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
      status: statusOf(itemsRes.rows),
      is_overdue: itemsRes.rows.some((item: any) => item.is_overdue),
      items: itemsRes.rows.map((item: any) => ({
        id: item.id,
        asset: { id: item.asset_id, name: item.asset_name, asset_number: item.asset_number },
        due_date: item.due_date,
        condition: item.lending_condition,
        condition_note: item.lending_condition_note,
        ending_kind: item.ending_kind,
        is_voided: item.is_voided,
        is_overdue: item.is_overdue,
        loan_return: loanReturnOf(item),
        not_returned: notReturnedOf(item),
        due_date_extensions: extensionsOf(item.id),
        assignment_on_return_date: assignments?.get(item.asset_id),
      })),
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

    // The status follows statusOf, over the same non-voided items.
    const res = await this.db.query(
      `WITH summarized AS (
         SELECT l.id, l.borrower_kind, l.borrower_person_id, l.borrower_contact_name, l.borrower_organization_name,
                to_char(l.loan_date, 'YYYY-MM-DD') AS loan_date, l.loan_date AS sort_date, l.recorded_at,
                borrower.name AS borrower_name, borrower.is_active AS borrower_is_active,
                items.item_count, items.returned_count, items.not_returned_count, items.is_overdue,
                CASE WHEN items.outstanding_count = 0 AND items.not_returned_count > 0 THEN 'CLOSED'
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
      not_returned: notReturnedOf(row),
    }));
  }

  /** The LoanItems of an Asset with their Loans, latest Loan Date first, or null when there is no such Asset. */
  async itemsOfAsset(assetId: string): Promise<AssetLoanItem[] | null> {
    return (await assetExists(this.db, assetId)) ? this.readItemsOfAsset(assetId) : null;
  }

  /** The Condition of an Asset's latest Loan Return by Return Date, or null when it has had none (#74 Q23). */
  async latestLoanReturnConditionOf(assetId: string): Promise<LoanCondition | null> {
    const res = await this.db.query(
      `SELECT e.condition
       FROM loan_item_endings e
       JOIN loan_items li ON li.id = e.loan_item_id
       WHERE li.asset_id = $1 AND e.kind = 'LOAN_RETURN' AND NOT e.is_voided AND NOT li.is_voided
       ORDER BY e.ending_date DESC, e.recorded_at DESC, e.id DESC
       LIMIT 1`,
      [assetId]
    );
    return res.rows[0]?.condition ?? null;
  }

  /** Who holds an Asset, or null when it is not On Loan. */
  async onLoanOf(assetId: string): Promise<OnLoan | null> {
    const items = await this.readItemsOfAsset(assetId);
    const held = items.find(isOutstanding);
    return held ? { loan_id: held.loan_id, borrower: held.borrower, due_date: held.due_date, is_overdue: held.is_overdue } : null;
  }

  /** The Not Returned that keeps an Asset from a new Loan, or null when there is none (#74 Q21). */
  async notReturnedOf(assetId: string): Promise<AssetNotReturned | null> {
    const items = await this.readItemsOfAsset(assetId);
    const closed = items.find(({ ending_kind, is_voided }) => ending_kind === 'NOT_RETURNED' && !is_voided);
    return closed?.not_returned ? { loan_id: closed.loan_id, not_returned_date: closed.not_returned.not_returned_date } : null;
  }
}
