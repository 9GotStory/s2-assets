// What the API answers about Verification Rounds (F006-T1), Asset Verifications (F006-T2), their
// Discrepancies (F006-T3), their revisions (F006-T4), the Repair Records sent from them (F006-T7) and the
// Reassignments moved from them (F006-T8), and their labels from GLOSSARY.md (#125).

import type { PermanentAssignment, ReferenceEntry } from './ReferenceContextFields';
import { thaiDate, type CitingReassignment } from './assignmentFacts';
import { CONDITION_LABELS, NOT_RETURNED_LABEL, ON_LOAN_LABEL, type LoanCondition } from './loanFacts';
import { UNDER_REPAIR_LABELS, type CitingRepairRecord, type RepairKind } from './repairFacts';

export type VerificationRoundState = 'OPEN' | 'CLOSED' | 'VOIDED';
export type VerificationRoundEventKind = 'OPENED' | 'EDITED' | 'CLOSED' | 'REOPENED' | 'VOIDED';
// What one Verification Revision says.
export type RecordedResult = 'FOUND' | 'NOT_FOUND';
// An Asset's current result in a Round, or Not Yet Verified while it has none.
export type VerificationResult = RecordedResult | 'NOT_YET_VERIFIED';
// A difference a result notes: "Location ไม่ตรงทะเบียน" and "ชำรุด" derived by the server, the other two ticked.
export type Discrepancy = 'LOCATION_MISMATCH' | 'DAMAGED' | 'LABEL_MISSING_OR_DAMAGED' | 'DATA_MISMATCH';

export interface VerificationRoundCounts {
  in_scope: number;
  found: number;
  not_found: number;
  not_yet_verified: number;
  // Current results that note a Discrepancy.
  with_discrepancy: number;
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
  // Null when the Asset was seen where the register says, or Not Found.
  observed_location: ReferenceEntry | null;
  label_missing_or_damaged: boolean;
  data_mismatch: boolean;
  data_mismatch_note: string | null;
  // In the order of DISCREPANCY_LABELS.
  discrepancies: Discrepancy[];
  note: string | null;
  verification_date: string;
  assignment_in_effect: PermanentAssignment;
  loan_context: RecordingContext['loan_context'];
  repair_context: RecordingContext['repair_context'];
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  // The Repair Records that cite it as their Repair Source, voided ones too, and "ส่งซ่อมแล้ว": one not voided
  // does (F006-T7, #125 Q19).
  repair_records: CitingRepairRecord[];
  sent_for_repair: boolean;
  // The Reassignments that cite it, voided ones too, and "ย้ายแล้ว": one not voided does (F006-T8, #125 Q19).
  reassignments: CitingReassignment[];
  reassigned: boolean;
}

// The Verification Correction that voided a revision (F006-T4, #125 Q18).
export interface VerificationCorrection {
  id: string;
  reason: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

// One revision as an entry's revisions list it (GET /verification-rounds/:id/assets/:assetId/verifications).
export interface ListedVerificationRevision extends VerificationRevision {
  is_voided: boolean;
  correction: VerificationCorrection | null;
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
  // The Locations the Scope Snapshot holds, to filter its entries by.
  snapshot_locations: ReferenceEntry[];
  // Whether the viewer holds 'verification:manage' (close, edit) and 'verification:correct' (Reopen, void), F006-T6.
  can_manage_verification: boolean;
  can_correct_verification: boolean;
  // Whether the viewer holds 'repair:record', which "ส่งซ่อม" needs (F006-T7, #125 Q22).
  can_record_repair: boolean;
  // Whether the viewer holds 'assignment:reassign', which "ย้าย" needs (F006-T8, #125 Q22).
  can_reassign: boolean;
}

// What the register showed of an Asset when it joined the Round.
export interface ScopeSnapshot extends PermanentAssignment {
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
}

// Who added a Late Addition to a Round, when and why (F006-T5).
export interface LateAddition {
  reason: string;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface ScopeEntry {
  id: string;
  asset_id: string;
  joined_as: 'OPENING' | 'LATE_ADDITION';
  // Null for an Asset that joined when the Round opened.
  late_addition: LateAddition | null;
  snapshot: ScopeSnapshot;
  result: VerificationResult;
  current: VerificationRevision | null;
  version: number;
  // Voided revisions included.
  revision_count: number;
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
  revision_count: number;
  result: VerificationResult;
  current: VerificationRevision | null;
}

export const VERIFICATION_ROUND_LABEL = 'รอบตรวจ';
// glossary: no entry — the Asset page heading names Feature 006, Annual Asset Verification, not a new term
export const VERIFICATION_PANEL_LABEL = 'ตรวจประจำปี';
// glossary: no entry — a heading made of the term ผลตรวจ (Asset Verification)
export const ASSET_VERIFICATIONS_LABEL = 'ผลตรวจประจำปี';
export const VERIFICATION_DATE_LABEL = 'วันที่ตรวจ';
// glossary: no entry — the action that records a ผลตรวจ (Asset Verification)
export const RECORD_VERIFICATION_LABEL = 'บันทึกผลตรวจ';
export const OPEN_VERIFICATION_ROUND_LABEL = 'เปิดรอบตรวจ';
export const SCOPE_SNAPSHOT_LABEL = 'รายการในรอบ';
export const FISCAL_YEAR_LABEL = 'ปีงบประมาณ';
export const START_DATE_LABEL = 'วันที่เริ่มตรวจ';
export const WHOLE_REGISTER_LABEL = 'ทั้งทะเบียน';
export const OBSERVED_LOCATION_LABEL = 'สถานที่ที่พบ';
export const DISCREPANCY_LABEL = 'ข้อแตกต่าง';
export const REVERIFICATION_LABEL = 'ตรวจซ้ำ';
export const VERIFICATION_REVISIONS_LABEL = 'ประวัติผลตรวจ';
export const LATE_ADDITION_LABEL = 'เพิ่มเข้ารอบภายหลัง';
// A result's follow-up (F006-T7, F006-T8, #125 Q19): derived from the Repair Records and Reassignments that cite
// it, never ticked.
export const SENT_FOR_REPAIR_LABEL = 'ส่งซ่อมแล้ว';
export const REASSIGNED_LABEL = 'ย้ายแล้ว';
// The action that opens the Reassignment form from a result (#125 Q13).
export const REASSIGN_LABEL = 'ย้าย';
export const AWAITING_ACTION_LABEL = 'ยังไม่มี action ต่อ';

export const DISCREPANCY_LABELS: Record<Discrepancy, string> = {
  LOCATION_MISMATCH: 'Location ไม่ตรงทะเบียน',
  DAMAGED: 'ชำรุด',
  LABEL_MISSING_OR_DAMAGED: 'ป้าย/QR หายหรือชำรุด',
  DATA_MISMATCH: 'ข้อมูลไม่ตรงทะเบียน',
};
export const DISCREPANCIES = Object.keys(DISCREPANCY_LABELS) as Discrepancy[];

// A Discrepancy as one line: "ข้อมูลไม่ตรงทะเบียน" with its note.
export const discrepancyText = (discrepancy: Discrepancy, { data_mismatch_note: note }: Pick<VerificationRevision, 'data_mismatch_note'>): string =>
  discrepancy === 'DATA_MISMATCH' && note ? `${DISCREPANCY_LABELS.DATA_MISMATCH}: ${note}` : DISCREPANCY_LABELS[discrepancy];

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

// The Round fields an edit changes, as its history names them (F006-T6, #125 Q27).
export const ROUND_FIELD_LABELS: Record<string, string> = {
  name: 'ชื่อรอบตรวจ',
  fiscal_year: FISCAL_YEAR_LABEL,
  notes: 'หมายเหตุ',
};

// A Round as a refusal or a heading names it: its name and fiscal year.
export const roundLabel = ({ name, fiscal_year: fiscalYear }: Pick<VerificationRoundSummary, 'name' | 'fiscal_year'>): string =>
  `${name} (${FISCAL_YEAR_LABEL} ${fiscalYear})`;

// Whether "ส่งซ่อม" applies to a result: Found ชำรุด (#125 Q12).
export const isFoundDamaged = (revision: Pick<VerificationRevision, 'result' | 'condition'>): boolean => revision.result === 'FOUND' && revision.condition === 'DAMAGED';

// Whether "ย้าย" applies to a result: it has "Location ไม่ตรงทะเบียน" (#125 Q13).
export const hasLocationMismatch = (revision: Pick<VerificationRevision, 'discrepancies'>): boolean => revision.discrepancies.includes('LOCATION_MISMATCH');

// A result as one label, with its Condition when Found: "พบ · สภาพปกติ".
export const resultText = (result: VerificationResult, condition: LoanCondition | null | undefined): string =>
  condition ? `${RESULT_LABELS[result]} · สภาพ${CONDITION_LABELS[condition]}` : RESULT_LABELS[result];

// Who recorded a result, by username when the account has one.
export const recordedByText = ({ recorded_by: recordedBy, recorded_by_username: username }: Pick<VerificationRevision, 'recorded_by' | 'recorded_by_username'>): string =>
  username ?? recordedBy;

// The latest result a refusal names, with when and by whom it was recorded, or that the Asset is Not Yet Verified
// (#125 AV-23, Q20).
export const latestResultText = (current: VerificationRevision | null): string =>
  current
    ? `${resultText(current.result, current.condition)} ${VERIFICATION_DATE_LABEL} ${thaiDate(current.verification_date)} บันทึกโดย ${recordedByText(current)}`
    : RESULT_LABELS.NOT_YET_VERIFIED;

// The Loan or Repair context as one line: context only, never proof the Asset was seen (#125 AV-09).
export const recordedContextText = ({ loan_context: loan, repair_context: repair }: RecordingContext): string | null =>
  [
    loan && `${loan.kind === 'ON_LOAN' ? ON_LOAN_LABEL : NOT_RETURNED_LABEL} ผู้ยืม ${loan.borrower_display} กำหนดคืน ${thaiDate(loan.due_date)}`,
    repair && UNDER_REPAIR_LABELS[repair.repair_kind],
  ]
    .filter(Boolean)
    .join(' · ') || null;
