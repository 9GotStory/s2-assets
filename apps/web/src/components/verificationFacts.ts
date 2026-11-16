// What the API answers about Verification Rounds (F006-T1) and Asset Verifications (F006-T2), and their labels
// from GLOSSARY.md (#125).

import type { PermanentAssignment, ReferenceEntry } from './ReferenceContextFields';
import { thaiDate } from './assignmentFacts';
import { CONDITION_LABELS, NOT_RETURNED_LABEL, ON_LOAN_LABEL, type LoanCondition } from './loanFacts';
import { UNDER_REPAIR_LABELS, type RepairKind } from './repairFacts';

export type VerificationRoundState = 'OPEN' | 'CLOSED' | 'VOIDED';
export type VerificationRoundEventKind = 'OPENED' | 'EDITED' | 'CLOSED' | 'REOPENED' | 'VOIDED';
// What one Verification Revision says.
export type RecordedResult = 'FOUND' | 'NOT_FOUND';
// An Asset's current result in a Round, or Not Yet Verified while it has none.
export type VerificationResult = RecordedResult | 'NOT_YET_VERIFIED';

export interface VerificationRoundCounts {
  in_scope: number;
  found: number;
  not_found: number;
  not_yet_verified: number;
}

// What a result keeps of the Asset's Loan and Repair facts at recording: context only (#125 AV-09, Q14).
export interface RecordingContext {
  loan_context: { kind: 'ON_LOAN' | 'NOT_RETURNED'; loan_item_id: string; borrower_display: string; due_date: string } | null;
  repair_context: { repair_record_id: string; repair_kind: RepairKind } | null;
}

// One recorded result, with what the server kept of the Asset when it was recorded (#125 Q14, Q26).
export interface VerificationRevision {
  id: string;
  revision_number: number;
  result: RecordedResult;
  condition: LoanCondition | null;
  note: string | null;
  verification_date: string;
  assignment_in_effect: PermanentAssignment;
  loan_context: RecordingContext['loan_context'];
  repair_context: RecordingContext['repair_context'];
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface VerificationRoundSummary {
  id: string;
  name: string;
  // A Buddhist-era year.
  fiscal_year: number;
  start_date: string;
  state: VerificationRoundState;
  counts: VerificationRoundCounts;
}

export interface VerificationRoundList {
  items: VerificationRoundSummary[];
  // Whether the viewer holds 'verification:manage'.
  can_manage_verification: boolean;
}

export interface VerificationRoundEvent {
  id: string;
  kind: VerificationRoundEventKind;
  reason: string | null;
  changes: { field: string; before: unknown; after: unknown }[];
  counts: { found: number; not_found: number; not_yet_verified: number; with_discrepancy: number } | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface VerificationRound extends VerificationRoundSummary {
  notes: string | null;
  filters: { organization_units: ReferenceEntry[]; locations: ReferenceEntry[] };
  opened_by: string;
  opened_by_username: string | null;
  recorded_at: string;
  version: number;
  history: VerificationRoundEvent[];
}

// What the register showed of an Asset when it joined the Round.
export interface ScopeSnapshot extends PermanentAssignment {
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
}

export interface ScopeEntry {
  id: string;
  asset_id: string;
  joined_as: 'OPENING' | 'LATE_ADDITION';
  snapshot: ScopeSnapshot;
  result: VerificationResult;
  current: VerificationRevision | null;
  version: number;
}

export interface ScopeEntryPage {
  items: ScopeEntry[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// The Round that a refused opening names (#125 Q17).
export interface OpenVerificationRound {
  id: string;
  name: string;
  fiscal_year: number;
  start_date: string;
}

// The Asset page's "ตรวจประจำปี" panel while a Round is open (GET /assets/:id, F006-T2).
export interface AssetVerificationPanel {
  open_round: OpenVerificationRound;
  // Null when the Asset is not in the open Round's Scope Snapshot.
  entry: { id: string; version: number; result: VerificationResult; current: VerificationRevision | null } | null;
  // The context a result recorded now would keep.
  context: RecordingContext;
}

// An Asset's result in one Round it belongs to (GET /assets/:id/verifications, F006-T2).
export interface AssetVerification {
  round: Pick<VerificationRoundSummary, 'id' | 'name' | 'fiscal_year' | 'start_date' | 'state'>;
  entry_id: string;
  joined_as: 'OPENING' | 'LATE_ADDITION';
  result: VerificationResult;
  current: VerificationRevision | null;
}

export const VERIFICATION_ROUND_LABEL = 'รอบตรวจ';
export const VERIFICATION_PANEL_LABEL = 'ตรวจประจำปี';
export const ASSET_VERIFICATIONS_LABEL = 'ผลตรวจประจำปี';
export const VERIFICATION_DATE_LABEL = 'วันที่ตรวจ';
export const RECORD_VERIFICATION_LABEL = 'บันทึกผลตรวจ';
export const OPEN_VERIFICATION_ROUND_LABEL = 'เปิดรอบตรวจ';
export const SCOPE_SNAPSHOT_LABEL = 'รายการในรอบ';
export const FISCAL_YEAR_LABEL = 'ปีงบประมาณ';
export const START_DATE_LABEL = 'วันที่เริ่มตรวจ';
export const WHOLE_REGISTER_LABEL = 'ทั้งทะเบียน';

export const ROUND_STATE_LABELS: Record<VerificationRoundState, string> = {
  OPEN: 'เปิดอยู่',
  CLOSED: 'ปิดรอบแล้ว',
  VOIDED: 'ยกเลิกแล้ว',
};

export const RESULT_LABELS: Record<VerificationResult, string> = {
  FOUND: 'พบ',
  NOT_FOUND: 'ไม่พบในการตรวจ',
  NOT_YET_VERIFIED: 'ยังไม่ได้ตรวจ',
};

export const ROUND_EVENT_LABELS: Record<VerificationRoundEventKind, string> = {
  OPENED: 'เปิดรอบ',
  EDITED: 'แก้ไขข้อมูลรอบ',
  CLOSED: 'ปิดรอบ',
  REOPENED: 'เปิดรอบอีกครั้ง',
  VOIDED: 'ยกเลิกรอบ',
};

// A Round as a refusal or a heading names it: its name and fiscal year.
export const roundLabel = ({ name, fiscal_year: fiscalYear }: Pick<VerificationRoundSummary, 'name' | 'fiscal_year'>): string =>
  `${name} (${FISCAL_YEAR_LABEL} ${fiscalYear})`;

// A result as one label, with its Condition when Found: "พบ · สภาพปกติ".
export const resultText = (result: VerificationResult, condition: LoanCondition | null | undefined): string =>
  condition ? `${RESULT_LABELS[result]} · สภาพ${CONDITION_LABELS[condition]}` : RESULT_LABELS[result];

// Who recorded a result, by username when the account has one.
export const recordedByText = ({ recorded_by: recordedBy, recorded_by_username: username }: Pick<VerificationRevision, 'recorded_by' | 'recorded_by_username'>): string =>
  username ?? recordedBy;

// The Loan or Repair context as one line: context only, never proof the Asset was seen (#125 AV-09).
export const recordedContextText = ({ loan_context: loan, repair_context: repair }: RecordingContext): string | null =>
  [
    loan && `${loan.kind === 'ON_LOAN' ? ON_LOAN_LABEL : NOT_RETURNED_LABEL} ผู้ยืม ${loan.borrower_display} กำหนดคืน ${thaiDate(loan.due_date)}`,
    repair && UNDER_REPAIR_LABELS[repair.repair_kind],
  ]
    .filter(Boolean)
    .join(' · ') || null;
