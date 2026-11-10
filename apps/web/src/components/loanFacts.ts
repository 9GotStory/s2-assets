import { entryLabel, type PermanentAssignment, type ReferenceEntry } from './ReferenceContextFields';

export type LoanCondition = 'NORMAL' | 'DAMAGED';

// The phone number comes only to holders of 'loan:record' or 'loan:correct', and only on the Loan page (LR-15).
export type Borrower =
  | { kind: 'INTERNAL'; person: ReferenceEntry }
  | { kind: 'EXTERNAL'; contact_name: string; organization_name: string | null; phone?: string | null };

type EndingKind = 'NONE' | 'LOAN_RETURN' | 'NOT_RETURNED';

// The Loan Return of a LoanItem (F004-T2).
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
  // "คืนเกินกำหนด", derived by the server (F004-T3).
  returned_after_due_date: boolean;
}

// The ending of an item whose Asset did not come back, "ปิดโดยไม่ได้รับคืน" (F004-T5).
export interface NotReturned {
  id: string;
  not_returned_date: string;
  reason: string;
  action_reference: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

// A Due Date Extension of one item, "เลื่อนกำหนดคืน" (F004-T5).
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

// The Not Returned that keeps an Asset from a new Loan (GET /assets/:id, F004-T5).
export interface AssetNotReturned {
  loan_id: string;
  not_returned_date: string;
}

// Who holds an Asset that is On Loan (GET /assets/:id, F004-T1).
export interface OnLoan {
  loan_id: string;
  borrower: Borrower;
  due_date: string;
  is_overdue: boolean;
}

// One LoanItem of an Asset, with its Loan (GET /assets/:id/loans, F004-T1).
export interface AssetLoanItem {
  id: string;
  loan_id: string;
  loan_date: string;
  due_date: string;
  borrower: Borrower;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: EndingKind;
  is_voided: boolean;
  is_overdue: boolean;
  loan_return: LoanReturn | null;
  not_returned: NotReturned | null;
}

// An ending fact voided by a Loan Correction, shown struck through (F004-T6).
export type VoidedEnding = ({ kind: 'LOAN_RETURN' } & Omit<LoanReturn, 'returned_after_due_date'>) | ({ kind: 'NOT_RETURNED' } & NotReturned);

// The facts a Loan Correction names (F004-T6, #74 Q25).
export type LoanCorrectionTarget =
  | { kind: 'LOAN' }
  | { kind: 'LOAN_ITEM' | 'LOAN_RETURN' | 'NOT_RETURNED' | 'DUE_DATE_EXTENSION'; id: string };

// What a correction changed of one field. A Person entry comes by its current name, and the phone
// number's change carries neither value (#74 Q24).
export type LoanCorrectionField =
  | { field: 'borrower_person_id' | 'authorizer_person_id'; before: ReferenceEntry | null; after: ReferenceEntry | null }
  | { field: 'borrower_phone' }
  | { field: string; before: string | null; after: string | null };

// One Loan Correction (F004-T6): who, when, why, and the before and after.
export interface LoanCorrection {
  id: string;
  target: { kind: LoanCorrectionTarget['kind']; id: string };
  action: 'AMENDED' | 'VOIDED';
  reason: string;
  changes: LoanCorrectionField[];
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface LoanItem {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  // The current Due Date, derived by the server from the item's Due Date Extensions.
  due_date: string;
  // The Due Date as first recorded, which a Loan Correction amends (F004-T6).
  first_due_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: EndingKind;
  is_voided: boolean;
  is_overdue: boolean;
  loan_return: LoanReturn | null;
  not_returned: NotReturned | null;
  voided_endings: VoidedEnding[];
  due_date_extensions: DueDateExtension[];
  // Where an Outstanding or Not Returned item goes back to, when the Loan is read with a Return Date (#74 Q27).
  assignment_on_return_date?: PermanentAssignment;
}

export type LoanStatus = 'OUTSTANDING' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CLOSED';

export interface Loan {
  id: string;
  borrower: Borrower;
  loan_date: string;
  authorizer: ReferenceEntry | null;
  document_reference: string | null;
  remark: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
  // Null for a voided Loan.
  status: LoanStatus | null;
  is_overdue: boolean;
  items: LoanItem[];
  corrections: LoanCorrection[];
  // Whether the viewer holds 'loan:record' (F004-T2) and 'loan:correct' (F004-T6).
  can_record_loan: boolean;
  can_correct_loan: boolean;
}

// One row of the Loan list (GET /loans, F004-T3). It carries no phone number.
export interface LoanListRow {
  id: string;
  borrower: Borrower;
  loan_date: string;
  item_count: number;
  returned_count: number;
  not_returned_count: number;
  // Null for a voided Loan.
  status: LoanStatus | null;
  is_voided: boolean;
  is_overdue: boolean;
}

// A LoanItem the server refused a write for Outstanding items, and why (F004-T5).
export interface RefusedOutstandingItem {
  loan_item_id: string;
  asset_id: string | null;
  name: string | null;
  asset_number: string | null;
  reason: 'NOT_FOUND' | 'VOIDED' | 'ALREADY_RETURNED' | 'NOT_RETURNED';
}

// A LoanItem the server refused a Loan Return, and why (F004-T2).
export interface RefusedLoanItem {
  loan_item_id: string;
  asset_id: string | null;
  name: string | null;
  asset_number: string | null;
  reason: 'NOT_FOUND' | 'VOIDED' | 'ALREADY_RETURNED';
}

// An Asset the server refused to lend, and why.
export type RefusedAsset = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'NOT_FOUND' }
  | { reason: 'ON_LOAN'; loan_id: string }
  | { reason: 'NOT_RETURNED'; loan_id: string }
);

// A LoanItem that has not ended (GLOSSARY.md: Outstanding).
export const isOutstanding = ({ ending_kind: endingKind, is_voided: isVoided }: Pick<LoanItem, 'ending_kind' | 'is_voided'>): boolean =>
  endingKind === 'NONE' && !isVoided;

// A LoanItem a Loan Return can still end: Outstanding, or Not Returned and come back later (#74 Q21).
export const isReturnable = ({ ending_kind: endingKind, is_voided: isVoided }: Pick<LoanItem, 'ending_kind' | 'is_voided'>): boolean =>
  endingKind !== 'LOAN_RETURN' && !isVoided;

// Labels from GLOSSARY.md (#74 Q30).
export const CONDITION_LABELS: Record<LoanCondition, string> = { NORMAL: 'ปกติ', DAMAGED: 'ชำรุด' };

export const OUTSTANDING_LABEL = 'ยังไม่คืน';

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  OUTSTANDING: OUTSTANDING_LABEL,
  PARTIALLY_RETURNED: 'คืนบางส่วน',
  RETURNED: 'คืนครบ',
  CLOSED: 'ปิดแล้ว',
};

// A fact voided by a Loan Correction, which stays shown, struck through (GLOSSARY.md: Loan Correction).
export const VOIDED_LABEL = 'ยกเลิกแล้ว';

// What a voided fact no longer counts in, as the void form and a voided Loan say it.
export const VOIDED_COUNTS_IN_NOTHING = 'ไม่นับรวมในสถานะ เกินกำหนด และกำลังถูกยืม';

// The Loan's status as a page shows it: "ปิดแล้ว" says how many items did not come back (#74 Q22), and a
// voided Loan has none.
export const loanStatusText = (status: LoanStatus | null, notReturnedCount: number): string => {
  if (status === null) {
    return VOIDED_LABEL;
  }
  return status === 'CLOSED' ? `${LOAN_STATUS_LABELS.CLOSED} (ไม่ได้รับคืน ${notReturnedCount} ชิ้น)` : LOAN_STATUS_LABELS[status];
};

export const voidedStyle = { textDecoration: 'line-through', color: '#6b7280' } as const;

// The UI's label for Not Returned (#74 Q30), and that of a Due Date Extension.
export const NOT_RETURNED_LABEL = 'ปิดโดยไม่ได้รับคืน';
export const DUE_DATE_EXTENSION_LABEL = 'เลื่อนกำหนดคืน';

// Why a write for Outstanding items refused one (F004-T5).
export const NOT_OUTSTANDING_LABELS: Record<RefusedOutstandingItem['reason'], string> = {
  NOT_FOUND: 'ไม่พบรายการนี้ในการยืม',
  VOIDED: 'รายการนี้ถูกยกเลิกแล้ว',
  ALREADY_RETURNED: 'คืนแล้ว',
  NOT_RETURNED: NOT_RETURNED_LABEL,
};

// What an item's Loan Return says on a page.
export const loanReturnText = ({ condition, condition_note: note }: Pick<LoanReturn, 'condition' | 'condition_note'>): string =>
  `สภาพเมื่อคืน: ${CONDITION_LABELS[condition]}${note ? ` (${note})` : ''}`;

export const ON_LOAN_LABEL = 'กำลังถูกยืม';

// The action that starts a Loan, from the Asset page or the Asset list.
export const START_LOAN_LABEL = 'บันทึกการยืม';

// Derived by the server from today's Asia/Bangkok date (F004-T3, #74 Q5).
export const OVERDUE_LABEL = 'เกินกำหนด';
export const RETURNED_LATE_LABEL = 'คืนเกินกำหนด';

// An Asset by its name, or by what else identifies it.
export const assetLabel = ({ id, name, asset_number: assetNumber }: LoanItem['asset']): string =>
  name ?? assetNumber ?? id;

export const borrowerText = (borrower: Borrower): string => {
  if (borrower.kind === 'INTERNAL') {
    return entryLabel(borrower.person);
  }
  return borrower.organization_name ? `${borrower.contact_name} (${borrower.organization_name})` : borrower.contact_name;
};
