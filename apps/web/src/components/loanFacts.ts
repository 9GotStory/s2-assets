import { entryLabel, type PermanentAssignment, type ReferenceEntry } from './ReferenceContextFields';

export type LoanCondition = 'NORMAL' | 'DAMAGED';

// The phone number comes only to holders of 'loan:record', and only on the Loan page (LR-15).
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
}

// Who holds an Asset that is On Loan (GET /assets/:id, F004-T1).
export interface OnLoan {
  loan_id: string;
  borrower: Borrower;
  due_date: string;
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
  loan_return: LoanReturn | null;
}

export interface LoanItem {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  due_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: EndingKind;
  is_voided: boolean;
  loan_return: LoanReturn | null;
  // Where an Outstanding item goes back to, when the Loan is read with a Return Date (#74 Q27).
  assignment_on_return_date?: PermanentAssignment;
}

export type LoanStatus = 'OUTSTANDING' | 'PARTIALLY_RETURNED' | 'RETURNED';

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
  status: LoanStatus;
  items: LoanItem[];
  // Whether the viewer holds 'loan:record' (F004-T2).
  can_record_loan: boolean;
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
);

// A LoanItem that has not ended (GLOSSARY.md: Outstanding).
export const isOutstanding = ({ ending_kind: endingKind, is_voided: isVoided }: Pick<LoanItem, 'ending_kind' | 'is_voided'>): boolean =>
  endingKind === 'NONE' && !isVoided;

// Labels from GLOSSARY.md (#74 Q30).
export const CONDITION_LABELS: Record<LoanCondition, string> = { NORMAL: 'ปกติ', DAMAGED: 'ชำรุด' };

export const OUTSTANDING_LABEL = 'ยังไม่คืน';

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  OUTSTANDING: OUTSTANDING_LABEL,
  PARTIALLY_RETURNED: 'คืนบางส่วน',
  RETURNED: 'คืนครบ',
};

// What an item's Loan Return says on a page.
export const loanReturnText = ({ condition, condition_note: note }: Pick<LoanReturn, 'condition' | 'condition_note'>): string =>
  `สภาพเมื่อคืน: ${CONDITION_LABELS[condition]}${note ? ` (${note})` : ''}`;

export const ON_LOAN_LABEL = 'กำลังถูกยืม';

// An Asset by its name, or by what else identifies it.
export const assetLabel = ({ id, name, asset_number: assetNumber }: { id: string; name: string | null; asset_number: string | null }): string =>
  name ?? assetNumber ?? id;

export const borrowerText = (borrower: Borrower): string => {
  if (borrower.kind === 'INTERNAL') {
    return entryLabel(borrower.person);
  }
  return borrower.organization_name ? `${borrower.contact_name} (${borrower.organization_name})` : borrower.contact_name;
};
