import pg from 'pg';
import { assetExists } from './asset.service.ts';
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
}

export type LoanEndingKind = 'NONE' | 'LOAN_RETURN' | 'NOT_RETURNED';

export interface LoanItem {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  due_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: LoanEndingKind;
  is_voided: boolean;
  loan_return: LoanReturn | null;
  // Where an Outstanding item goes back to, when the Loan is read with a Return Date (#74 Q27).
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
  loan_return: LoanReturn | null;
}

// Who holds an Asset that is On Loan.
export interface OnLoan {
  loan_id: string;
  borrower: Borrower;
  due_date: string;
}

// Derived from a Loan's non-voided items, and never stored (#74 Q1).
export type LoanStatus = 'OUTSTANDING' | 'PARTIALLY_RETURNED' | 'RETURNED';

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
  items: LoanItem[];
}

// An Asset that cannot be lent, and why. It names the Loan that holds it, never that Loan's Borrower (LR-15).
export type RefusedAsset = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'NOT_FOUND' }
  | { reason: 'ON_LOAN'; loan_id: string }
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
       loan_return_user.username AS return_recorded_by_username, loan_return.recorded_at AS return_recorded_at`;

const LOAN_RETURN_JOINS = `LEFT JOIN loan_item_endings loan_return
         ON loan_return.loan_item_id = li.id AND loan_return.kind = 'LOAN_RETURN' AND NOT loan_return.is_voided
       LEFT JOIN users loan_return_user ON loan_return_user.id = loan_return.recorded_by`;

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
      }
    : null;

const isOutstanding = ({ ending_kind, is_voided }: Pick<LoanItem, 'ending_kind' | 'is_voided'>): boolean => ending_kind === 'NONE' && !is_voided;

const statusOf = (items: Pick<LoanItem, 'ending_kind' | 'is_voided'>[]): LoanStatus => {
  const counted = items.filter(({ is_voided }) => !is_voided);
  const returned = counted.filter(({ ending_kind }) => ending_kind === 'LOAN_RETURN').length;
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
}

/** The items of a Loan whose row the caller holds locked, so they cannot change under it. */
export async function readItemsOfLockedLoan(client: pg.PoolClient, loanId: string): Promise<LoanItemOfLockedLoan[]> {
  const res = await client.query(
    `SELECT li.id, li.asset_id, a.name, a.asset_number, li.ending_kind, li.is_voided
     FROM loan_items li
     JOIN assets a ON a.id = li.asset_id
     WHERE li.loan_id = $1`,
    [loanId]
  );
  return res.rows;
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
    const heldRes = await client.query(
      `SELECT asset_id, loan_id FROM loan_items WHERE asset_id = ANY($1::uuid[]) AND NOT is_voided AND ending_kind = 'NONE'`,
      [assetIds]
    );
    const heldBy = new Map<string, string>(heldRes.rows.map((row: any) => [row.asset_id, row.loan_id]));

    const refused = assetIds.flatMap((assetId): RefusedAsset[] => {
      const asset = locked.get(assetId);
      if (!asset) {
        return [{ asset_id: assetId, name: null, asset_number: null, reason: 'NOT_FOUND' }];
      }
      const loanId = heldBy.get(assetId);
      return loanId ? [{ asset_id: assetId, name: asset.name, asset_number: asset.asset_number, reason: 'ON_LOAN', loan_id: loanId }] : [];
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
      `SELECT li.id, li.asset_id, a.name AS asset_name, a.asset_number, to_char(li.due_date, 'YYYY-MM-DD') AS due_date,
              li.lending_condition, li.lending_condition_note, li.ending_kind, li.is_voided, ${LOAN_RETURN_COLUMNS}
       FROM loan_items li
       JOIN assets a ON a.id = li.asset_id
       ${LOAN_RETURN_JOINS}
       WHERE li.loan_id = $1
       ORDER BY a.name NULLS LAST, a.id`,
      [loanId]
    );
    const assignments = returnDate
      ? await readAssignmentsAt(this.db, itemsRes.rows.filter(isOutstanding).map((item: any) => item.asset_id), returnDate)
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
      items: itemsRes.rows.map((item: any) => ({
        id: item.id,
        asset: { id: item.asset_id, name: item.asset_name, asset_number: item.asset_number },
        due_date: item.due_date,
        condition: item.lending_condition,
        condition_note: item.lending_condition_note,
        ending_kind: item.ending_kind,
        is_voided: item.is_voided,
        loan_return: loanReturnOf(item),
        assignment_on_return_date: assignments?.get(item.asset_id),
      })),
    };
  }

  private async readItemsOfAsset(assetId: string): Promise<AssetLoanItem[]> {
    const res = await this.db.query(
      `SELECT li.id AS item_id, to_char(li.due_date, 'YYYY-MM-DD') AS due_date, li.lending_condition, li.lending_condition_note,
              li.ending_kind, li.is_voided AS item_is_voided, ${LOAN_COLUMNS}, ${LOAN_RETURN_COLUMNS}
       FROM loan_items li
       JOIN loans l ON l.id = li.loan_id
       ${LOAN_JOINS}
       ${LOAN_RETURN_JOINS}
       WHERE li.asset_id = $1
       ORDER BY l.loan_date DESC, l.recorded_at DESC, li.id DESC`,
      [assetId]
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
      loan_return: loanReturnOf(row),
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
    return held ? { loan_id: held.loan_id, borrower: held.borrower, due_date: held.due_date } : null;
  }
}
