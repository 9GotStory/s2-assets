// What the API answers about Repair Records (F005-T1, T2), and their labels from GLOSSARY.md (#98 Q14).

import type { PermanentAssignment } from './ReferenceContextFields';

export type RepairKind = 'REPAIR' | 'MAINTENANCE';
export type RepairerKind = 'INTERNAL' | 'EXTERNAL';
export type UnderWarranty = 'YES' | 'NO' | 'UNSPECIFIED';
export type RepairOutcomeValue = 'USABLE' | 'NOT_USABLE';

export interface Repairer {
  kind: RepairerKind;
  name: string | null;
}

// How a Repair Record ended (F005-T2).
export interface RepairOutcome {
  id: string;
  outcome: RepairOutcomeValue;
  outcome_date: string;
  note: string | null;
  document_reference: string | null;
  next_recommended_maintenance_date: string | null;
  // The record's cost before this outcome set it.
  cost_before: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface RepairRecord {
  id: string;
  asset: { id: string; name: string | null; asset_number: string | null };
  repair_kind: RepairKind;
  start_date: string;
  repairer: Repairer;
  symptom_or_work: string;
  under_warranty: UnderWarranty;
  warranty_end_date: string | null;
  // Baht with two decimals, as text.
  cost: string | null;
  document_reference: string | null;
  remark: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
  outcome: RepairOutcome | null;
  // On the Repair Record page only: whether the viewer holds 'repair:record'.
  can_record_repair?: boolean;
  // Asked for with an Outcome Date: where the Asset goes back to on it, shown and never stored.
  assignment_on_outcome_date?: PermanentAssignment;
}

// The Repair Record that keeps an Asset Under Repair.
export interface UnderRepair {
  repair_record_id: string;
  repair_kind: RepairKind;
  start_date: string;
  repairer: Repairer;
}

// Why the server refused a Repair Start.
export type RepairStartRefusal = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'ON_LOAN' | 'NOT_RETURNED'; loan_id: string }
  | { reason: 'UNDER_REPAIR'; repair_record_id: string; repair_kind: RepairKind }
);

export const REPAIR_SECTION_LABEL = 'การซ่อม/บำรุงรักษา';
export const REPAIR_RECORD_LABEL = 'รายการซ่อม/บำรุงรักษา';
export const REPAIR_START_LABEL = 'ส่งซ่อม';
export const REPAIR_OUTCOME_LABEL = 'ผลการซ่อม';
export const RECORD_REPAIR_OUTCOME_LABEL = 'บันทึกผลการซ่อม';
export const OUTCOME_DATE_LABEL = 'วันที่ได้ผล';
export const NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL = 'วันที่แนะนำบำรุงรักษาครั้งถัดไป';

export const REPAIR_KIND_LABELS: Record<RepairKind, string> = { REPAIR: 'ซ่อม', MAINTENANCE: 'บำรุงรักษา' };

// Under Repair reads by the record's kind (#98 Q14).
export const UNDER_REPAIR_LABELS: Record<RepairKind, string> = { REPAIR: 'อยู่ระหว่างซ่อม', MAINTENANCE: 'อยู่ระหว่างบำรุงรักษา' };

// A Repair Outcome reads by the record's kind: ซ่อมไม่ได้ for ซ่อม, ใช้งานไม่ได้ for บำรุงรักษา (#98 Q10, Q16).
export const REPAIR_OUTCOME_LABELS: Record<RepairKind, Record<RepairOutcomeValue, string>> = {
  REPAIR: { USABLE: 'ใช้งานได้', NOT_USABLE: 'ซ่อมไม่ได้' },
  MAINTENANCE: { USABLE: 'ใช้งานได้', NOT_USABLE: 'ใช้งานไม่ได้' },
};

export const REPAIRER_KIND_LABELS: Record<RepairerKind, string> = { INTERNAL: 'ภายใน', EXTERNAL: 'ภายนอก' };

export const UNDER_WARRANTY_LABELS: Record<UnderWarranty, string> = { YES: 'ใช่', NO: 'ไม่ใช่', UNSPECIFIED: 'ไม่ระบุ' };

// The Repairer as a page shows it: its kind, and its name when known.
export const repairerText = ({ kind, name }: Repairer): string => (name ? `${REPAIRER_KIND_LABELS[kind]}: ${name}` : REPAIRER_KIND_LABELS[kind]);

// A cost such as "1500.50" as "1,500.50 บาท", grouped from its text so that no digit goes through a float.
export const costText = (cost: string): string => {
  const [baht, satang = '00'] = cost.split('.');
  return `${baht.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${satang.padEnd(2, '0')} บาท`;
};
