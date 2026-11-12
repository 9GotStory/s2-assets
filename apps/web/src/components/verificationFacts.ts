// What the API answers about Verification Rounds (F006-T1), and their labels from GLOSSARY.md (#125).

import type { PermanentAssignment, ReferenceEntry } from './ReferenceContextFields';

export type VerificationRoundState = 'OPEN' | 'CLOSED' | 'VOIDED';
export type VerificationRoundEventKind = 'OPENED' | 'EDITED' | 'CLOSED' | 'REOPENED' | 'VOIDED';
// An Asset's result in a Round; F006-T1 records none.
export type VerificationResult = 'NOT_YET_VERIFIED';

export interface VerificationRoundCounts {
  in_scope: number;
  not_yet_verified: number;
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

export const VERIFICATION_ROUND_LABEL = 'รอบตรวจ';
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
