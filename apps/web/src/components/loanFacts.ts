import { entryLabel, type ReferenceEntry } from './ReferenceContextFields';

export type LoanCondition = 'NORMAL' | 'DAMAGED';

// The phone number comes only to holders of 'loan:record', and only on the Loan page (LR-15).
export type Borrower =
  | { kind: 'INTERNAL'; person: ReferenceEntry }
  | { kind: 'EXTERNAL'; contact_name: string; organization_name: string | null; phone?: string | null };

type EndingKind = 'NONE' | 'LOAN_RETURN' | 'NOT_RETURNED';

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
}

export interface LoanItem {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  due_date: string;
  condition: LoanCondition;
  condition_note: string | null;
  ending_kind: EndingKind;
  is_voided: boolean;
}

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
  items: LoanItem[];
}

// An Asset the server refused to lend, and why.
export type RefusedAsset = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'NOT_FOUND' }
  | { reason: 'ON_LOAN'; loan_id: string }
);

// Labels from GLOSSARY.md (#74 Q30).
export const CONDITION_LABELS: Record<LoanCondition, string> = { NORMAL: 'ปกติ', DAMAGED: 'ชำรุด' };

export const ON_LOAN_LABEL = 'กำลังถูกยืม';

export const borrowerText = (borrower: Borrower): string => {
  if (borrower.kind === 'INTERNAL') {
    return entryLabel(borrower.person);
  }
  return borrower.organization_name ? `${borrower.contact_name} (${borrower.organization_name})` : borrower.contact_name;
};
