import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { hasStrictControlChars } from './control-characters.ts';
import {
  DOCUMENT_REFERENCE_MAX_LENGTH,
  REMARK_MAX_LENGTH,
  bangkokDate,
  isCalendarDate,
  lockAssetsInIdentifierOrder,
  normalizeText,
} from './assignment.service.ts';
import { loanConflictCheck, normalizeConfirmedConflicts, type ConfirmedLoanConflictInput } from './loan-conflict.ts';
import { CURRENT_DUE_DATE, type LoanCondition, type LoanEndingKind } from './loan-read.service.ts';
import { isSelectablePerson } from './reference.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

// #74 Q9: as many as a Bulk Reassignment.
export const MAX_ASSETS = 100;

const CONTACT_NAME_MAX_LENGTH = 200;
const ORGANIZATION_NAME_MAX_LENGTH = 200;
const PHONE_MAX_LENGTH = 32;
export const CONDITION_NOTE_MAX_LENGTH = 500;
// A reason is free text, bounded as a correction's (MR-06).
export const REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

const PHONE_PATTERN = /^[0-9+\- ]+$/;

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
  // The Loan Conflicts the user saw in a warning and confirms (#74 Q20).
  confirmed_conflicts?: ConfirmedLoanConflictInput[];
}

// What a Loan write answers. It carries no Borrower detail, because the retry-token store keeps it
// and a Loan Correction could not remove it from there (LR-15, #74 Q24).
export interface StartedLoan {
  loan_id: string;
  version: number;
  items: { id: string; asset_id: string }[];
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

export const normalizeBorrower = (borrower: BorrowerInput): LoanFacts['borrower'] => {
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

export const normalizeAuthorizer = (value: string | null | undefined): string | null => {
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

/**
 * The first steps of every write on an existing Loan (#74): it locks the Loan row, then all of its
 * Assets in identifier order, and refuses a client that read another version. The Loan's items cannot
 * change under the caller after this.
 */
export async function lockLoanForWrite(
  client: pg.PoolClient,
  loanId: string,
  expectedVersion: number
): Promise<{ loan: LockedLoan; items: LoanItemOfLockedLoan[] }> {
  const loan = await lockLoan(client, loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  const items = await readItemsOfLockedLoan(client, loanId);
  await lockAssetsInIdentifierOrder(client, [...new Set(items.map(({ asset_id }) => asset_id))]);
  if (loan.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Loan changed since it was read', { version: loan.version }, { version: expectedVersion });
  }
  return { loan, items };
}

/**
 * The LoanItem ids a write names, in identifier order: 1 to MAX_ASSETS of them, well formed, each once.
 * `subject` names the write in a refusal, such as "Not Returned".
 */
export function normalizeLoanItemIds(items: { loan_item_id: string }[], subject: string): string[] {
  if (items.length < 1 || items.length > MAX_ASSETS) {
    throw new ValidationError(`${subject} names 1 to ${MAX_ASSETS} items`);
  }
  if (items.some(({ loan_item_id }) => !isValidUuid(loan_item_id))) {
    throw new ValidationError('loan_item_id must be a valid UUID');
  }
  const ids = items.map(({ loan_item_id }) => loan_item_id.trim().toLowerCase()).sort();
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(`${subject} names each item once`);
  }
  return ids;
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

// A Loan fact a Loan Correction names (#74 Q25). A Loan Return and a Not Returned are ending facts.
export type LoanCorrectionTarget =
  | { kind: 'LOAN' }
  | { kind: 'LOAN_ITEM' | 'LOAN_RETURN' | 'NOT_RETURNED' | 'DUE_DATE_EXTENSION'; id: string };

// The fields a correction compares and amends, by the names its record keeps, and each one's column.
const AMENDABLE_COLUMNS = {
  LOAN: {
    borrower_kind: 'borrower_kind',
    borrower_person_id: 'borrower_person_id',
    borrower_contact_name: 'borrower_contact_name',
    borrower_organization_name: 'borrower_organization_name',
    borrower_phone: 'borrower_phone',
    loan_date: 'loan_date',
    authorizer_person_id: 'authorizer_person_id',
    document_reference: 'document_reference',
    remark: 'remark',
  },
  LOAN_ITEM: { due_date: 'due_date', condition: 'lending_condition', condition_note: 'lending_condition_note' },
  LOAN_RETURN: { return_date: 'ending_date', condition: 'condition', condition_note: 'condition_note' },
  NOT_RETURNED: { not_returned_date: 'ending_date', reason: 'reason' },
  DUE_DATE_EXTENSION: {},
} as const;

const TARGET_TABLES = {
  LOAN: 'loans',
  LOAN_ITEM: 'loan_items',
  LOAN_RETURN: 'loan_item_endings',
  NOT_RETURNED: 'loan_item_endings',
  DUE_DATE_EXTENSION: 'loan_due_date_extensions',
} as const;

// The column of a correction record that names a fact of each kind.
const TARGET_COLUMNS = {
  LOAN: 'loan_id',
  LOAN_ITEM: 'loan_item_id',
  LOAN_RETURN: 'loan_item_ending_id',
  NOT_RETURNED: 'loan_item_ending_id',
  DUE_DATE_EXTENSION: 'due_date_extension_id',
} as const;

// A Loan fact as a correction finds it, under its Loan's lock: its amendable fields, by the names the
// correction record keeps, and the item it belongs to.
export interface StoredLoanFact {
  id: string;
  is_voided: boolean;
  // The LoanItem of an item-level fact, or null for the Loan.
  loan_item_id: string | null;
  fields: Record<string, string | null>;
}

const isoDateOf = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

/** A fact of a Loan whose row the caller holds locked, or null when the Loan has no such fact. */
export async function readStoredLoanFact(client: pg.PoolClient, loanId: string, target: LoanCorrectionTarget): Promise<StoredLoanFact | null> {
  const select = {
    LOAN: `SELECT l.id, l.is_voided, NULL::uuid AS loan_item_id, l.borrower_kind, l.borrower_person_id, l.borrower_contact_name,
                  l.borrower_organization_name, l.borrower_phone, ${isoDateOf('l.loan_date')} AS loan_date, l.authorizer_person_id,
                  l.document_reference, l.remark
           FROM loans l WHERE l.id = $1`,
    LOAN_ITEM: `SELECT li.id, li.is_voided, li.id AS loan_item_id, ${isoDateOf('li.due_date')} AS due_date, li.lending_condition AS condition,
                       li.lending_condition_note AS condition_note
                FROM loan_items li WHERE li.loan_id = $1 AND li.id = $2`,
    LOAN_RETURN: `SELECT e.id, e.is_voided, e.loan_item_id, ${isoDateOf('e.ending_date')} AS return_date, e.condition, e.condition_note
                  FROM loan_item_endings e JOIN loan_items li ON li.id = e.loan_item_id
                  WHERE li.loan_id = $1 AND e.id = $2 AND e.kind = 'LOAN_RETURN'`,
    NOT_RETURNED: `SELECT e.id, e.is_voided, e.loan_item_id, ${isoDateOf('e.ending_date')} AS not_returned_date, e.reason
                   FROM loan_item_endings e JOIN loan_items li ON li.id = e.loan_item_id
                   WHERE li.loan_id = $1 AND e.id = $2 AND e.kind = 'NOT_RETURNED'`,
    DUE_DATE_EXTENSION: `SELECT x.id, x.is_voided, x.loan_item_id
                         FROM loan_due_date_extensions x JOIN loan_items li ON li.id = x.loan_item_id
                         WHERE li.loan_id = $1 AND x.id = $2`,
  }[target.kind];
  const res = await client.query(select, target.kind === 'LOAN' ? [loanId] : [loanId, target.id]);
  if (res.rows.length === 0) {
    return null;
  }
  const { id, is_voided, loan_item_id, ...fields } = res.rows[0];
  return { id, is_voided, loan_item_id, fields };
}

/** Leaves the amended values on one fact, in the caller's transaction. `values` names fields as readStoredLoanFact does. */
export async function amendLoanFact(client: pg.PoolClient, target: LoanCorrectionTarget, factId: string, values: Record<string, string | null>): Promise<void> {
  const columns: Record<string, string> = AMENDABLE_COLUMNS[target.kind];
  const fields = Object.keys(values);
  if (fields.length === 0) {
    return;
  }
  const unknown = fields.find((field) => !Object.hasOwn(columns, field));
  if (unknown !== undefined) {
    throw new Error(`${unknown} is not an amendable field of a ${target.kind}`);
  }
  const assignments = fields.map((field, i) => `${columns[field]} = $${i + 2}`).join(', ');
  await client.query(`UPDATE ${TARGET_TABLES[target.kind]} SET ${assignments} WHERE id = $1`, [factId, ...fields.map((field) => values[field])]);
}

// Each item's ending kind from its non-voided ending facts: a Loan Return wins over a Not Returned (#74).
async function refreshEndingKinds(client: pg.PoolClient, itemIds: string[]): Promise<void> {
  await client.query(
    `UPDATE loan_items li SET ending_kind = CASE
       WHEN EXISTS (SELECT 1 FROM loan_item_endings e WHERE e.loan_item_id = li.id AND e.kind = 'LOAN_RETURN' AND NOT e.is_voided) THEN 'LOAN_RETURN'
       WHEN EXISTS (SELECT 1 FROM loan_item_endings e WHERE e.loan_item_id = li.id AND e.kind = 'NOT_RETURNED' AND NOT e.is_voided) THEN 'NOT_RETURNED'
       ELSE 'NONE' END
     WHERE li.id = ANY($1::uuid[])`,
    [itemIds]
  );
}

/**
 * Voids one fact, in the caller's transaction. Voiding a Loan voids its items, and voiding an item voids
 * every fact on it, so that nothing of it counts (#74 Q25). Each item touched gets its ending kind again.
 */
export async function voidLoanFact(client: pg.PoolClient, loanId: string, target: LoanCorrectionTarget, fact: StoredLoanFact): Promise<void> {
  if (target.kind === 'DUE_DATE_EXTENSION') {
    await client.query('UPDATE loan_due_date_extensions SET is_voided = true WHERE id = $1', [fact.id]);
    return;
  }
  if (target.kind === 'LOAN_RETURN' || target.kind === 'NOT_RETURNED') {
    await client.query('UPDATE loan_item_endings SET is_voided = true WHERE id = $1', [fact.id]);
    await refreshEndingKinds(client, [fact.loan_item_id!]);
    return;
  }
  let itemIds = [fact.id];
  if (target.kind === 'LOAN') {
    await client.query('UPDATE loans SET is_voided = true WHERE id = $1', [loanId]);
    itemIds = (await client.query('UPDATE loan_items SET is_voided = true WHERE loan_id = $1 RETURNING id', [loanId])).rows.map(({ id }: any) => id);
  } else {
    await client.query('UPDATE loan_items SET is_voided = true WHERE id = $1', [fact.id]);
  }
  await client.query('UPDATE loan_item_endings SET is_voided = true WHERE loan_item_id = ANY($1::uuid[])', [itemIds]);
  await client.query('UPDATE loan_due_date_extensions SET is_voided = true WHERE loan_item_id = ANY($1::uuid[])', [itemIds]);
  await refreshEndingKinds(client, itemIds);
}

// Another Loan's item that keeps an Asset, Outstanding or Not Returned (LR-11, #74 Q21).
export interface OtherLoanHolding {
  loan_id: string;
  ending_kind: 'NONE' | 'NOT_RETURNED';
}

/** The item of another Loan that keeps the Asset of `itemId`, or null. The caller holds the Asset locked. */
export async function otherLoanHoldingAssetOf(client: pg.PoolClient, itemId: string): Promise<OtherLoanHolding | null> {
  const res = await client.query(
    `SELECT other.loan_id, other.ending_kind
     FROM loan_items li
     JOIN loan_items other ON other.asset_id = li.asset_id AND other.id <> li.id
     WHERE li.id = $1 AND NOT other.is_voided AND other.ending_kind IN ('NONE', 'NOT_RETURNED')`,
    [itemId]
  );
  return res.rows[0] ?? null;
}

/** The number of a Loan's non-voided items. */
export async function countedItemsOf(client: pg.PoolClient, loanId: string): Promise<number> {
  const res = await client.query('SELECT count(*)::int AS n FROM loan_items WHERE loan_id = $1 AND NOT is_voided', [loanId]);
  return res.rows[0].n;
}

// A date rule of a Loan that a correction would break (#74: the date rules still hold afterwards).
export type BrokenLoanDateRule =
  | 'LOAN_DATE_AFTER_TODAY'
  | 'DUE_DATE_BEFORE_LOAN_DATE'
  | 'RETURN_DATE_BEFORE_LOAN_DATE'
  | 'NOT_RETURNED_DATE_BEFORE_LOAN_DATE'
  | 'ENDING_DATE_AFTER_TODAY'
  | 'RETURN_DATE_BEFORE_NOT_RETURNED_DATE'
  | 'EXTENSION_NOT_AFTER_FIRST_DUE_DATE';

/**
 * The date rules a Loan breaks as it now stands in the caller's transaction, over its non-voided facts:
 * the Loan Date is no later than today; every Due Date, Return Date and Not Returned date is not before
 * the Loan Date, and no ending is after today; a Loan Return is not dated before its item's Not Returned;
 * and every Due Date Extension still moves its item's Due Date later than the first one, which keeps
 * the extended Due Dates after the Loan Date too.
 */
export async function brokenLoanDateRules(client: pg.PoolClient, loanId: string, today: string): Promise<BrokenLoanDateRule[]> {
  const res = await client.query(
    `WITH items AS (SELECT li.id, li.due_date FROM loan_items li WHERE li.loan_id = $1 AND NOT li.is_voided),
          endings AS (SELECT e.loan_item_id, e.kind, e.ending_date FROM loan_item_endings e JOIN items ON items.id = e.loan_item_id WHERE NOT e.is_voided)
     SELECT l.loan_date > $2::date AS "LOAN_DATE_AFTER_TODAY",
            EXISTS (SELECT 1 FROM items WHERE items.due_date < l.loan_date) AS "DUE_DATE_BEFORE_LOAN_DATE",
            EXISTS (SELECT 1 FROM endings WHERE kind = 'LOAN_RETURN' AND ending_date < l.loan_date) AS "RETURN_DATE_BEFORE_LOAN_DATE",
            EXISTS (SELECT 1 FROM endings WHERE kind = 'NOT_RETURNED' AND ending_date < l.loan_date) AS "NOT_RETURNED_DATE_BEFORE_LOAN_DATE",
            EXISTS (SELECT 1 FROM endings WHERE ending_date > $2::date) AS "ENDING_DATE_AFTER_TODAY",
            EXISTS (SELECT 1 FROM endings r JOIN endings n ON n.loan_item_id = r.loan_item_id AND n.kind = 'NOT_RETURNED'
                    WHERE r.kind = 'LOAN_RETURN' AND r.ending_date < n.ending_date) AS "RETURN_DATE_BEFORE_NOT_RETURNED_DATE",
            EXISTS (SELECT 1 FROM loan_due_date_extensions x JOIN items ON items.id = x.loan_item_id
                    WHERE NOT x.is_voided AND x.new_due_date <= items.due_date) AS "EXTENSION_NOT_AFTER_FIRST_DUE_DATE"
     FROM loans l WHERE l.id = $1`,
    [loanId, today]
  );
  return Object.entries(res.rows[0]).flatMap(([rule, broken]) => (broken ? [rule as BrokenLoanDateRule] : []));
}

/** Keeps one Loan Correction record, in the caller's transaction, and returns its id. */
export async function recordLoanCorrection(
  client: pg.PoolClient,
  {
    target,
    factId,
    action,
    reason,
    changes,
    actorId,
  }: { target: LoanCorrectionTarget; factId: string; action: 'AMENDED' | 'VOIDED'; reason: string; changes: unknown[]; actorId: string }
): Promise<string> {
  const res = await client.query(
    `INSERT INTO loan_corrections (${TARGET_COLUMNS[target.kind]}, action, reason, changes, recorded_by)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [factId, action, reason, JSON.stringify(changes), actorId]
  );
  return res.rows[0].id;
}

/**
 * F004-T1 (#75): starting a Loan. A Loan never touches an assignment fact (LR-10). The reads are in
 * loan-read.service.ts.
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
    const confirmed = normalizeConfirmedConflicts(input.confirmed_conflicts);
    // An unconfirmed request keeps the payload it had before confirmation existed (#74 Q20).
    const payload = confirmed.length > 0 ? { version: 1, ...facts, confirmed_conflicts: confirmed } : { version: 1, ...facts };
    return commitOnce(
      this.db,
      { actorId, operation: 'loan:start', retryToken, payload, explicitContinuation: false },
      async (client) => {
        const assetIds = facts.items.map(({ asset_id }) => asset_id);
        // LR-11 refuses an Asset On Loan today before any Loan Conflict is looked at, so no confirmation is offered for it.
        await this.assertLendable(client, assetIds);
        await this.assertNamedPersons(client, facts, today);
        const conflicts = await loanConflictCheck(client, assetIds);
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
        // A backdated Loan may overlap an earlier one of the same Asset (#74 Q20).
        await conflicts.assertConfirmed({ loanId, isNewLoan: true, confirmed });
        return {
          loan_id: loanId,
          version: loanRes.rows[0].version,
          items: itemsRes.rows.map(({ id, asset_id }: any) => ({ id, asset_id })),
        };
      }
    );
  }
}
