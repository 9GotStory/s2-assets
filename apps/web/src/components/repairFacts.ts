// What the API answers about Repair Records (F005-T1), and their labels from GLOSSARY.md (#98 Q14).

export type RepairKind = 'REPAIR' | 'MAINTENANCE';
export type RepairerKind = 'INTERNAL' | 'EXTERNAL';
export type UnderWarranty = 'YES' | 'NO' | 'UNSPECIFIED';

export interface Repairer {
  kind: RepairerKind;
  name: string | null;
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

export const REPAIR_KIND_LABELS: Record<RepairKind, string> = { REPAIR: 'ซ่อม', MAINTENANCE: 'บำรุงรักษา' };

// Under Repair reads by the record's kind (#98 Q14).
export const UNDER_REPAIR_LABELS: Record<RepairKind, string> = { REPAIR: 'อยู่ระหว่างซ่อม', MAINTENANCE: 'อยู่ระหว่างบำรุงรักษา' };

export const REPAIRER_KIND_LABELS: Record<RepairerKind, string> = { INTERNAL: 'ภายใน', EXTERNAL: 'ภายนอก' };

export const UNDER_WARRANTY_LABELS: Record<UnderWarranty, string> = { YES: 'ใช่', NO: 'ไม่ใช่', UNSPECIFIED: 'ไม่ระบุ' };

// The Repairer as a page shows it: its kind, and its name when known.
export const repairerText = ({ kind, name }: Repairer): string => (name ? `${REPAIRER_KIND_LABELS[kind]}: ${name}` : REPAIRER_KIND_LABELS[kind]);

// A cost such as "1500.50" as "1,500.50 บาท", grouped from its text so that no digit goes through a float.
export const costText = (cost: string): string => {
  const [baht, satang = '00'] = cost.split('.');
  return `${baht.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${satang.padEnd(2, '0')} บาท`;
};
