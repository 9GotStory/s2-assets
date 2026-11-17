// What the API answers about Retirements (F007-T1), and their labels from GLOSSARY.md (#154 Q2, Q22).

import type { RepairKind } from './repairFacts';

export type RetirementMethod = 'SALE' | 'EXCHANGE' | 'HANDOVER_TO_OTHER_AGENCY' | 'CONVERSION_OR_DESTRUCTION' | 'DECLARED_LOSS';

export const RETIREMENT_METHODS: readonly RetirementMethod[] = ['SALE', 'EXCHANGE', 'HANDOVER_TO_OTHER_AGENCY', 'CONVERSION_OR_DESTRUCTION', 'DECLARED_LOSS'];

// A Retirement, its Retirement Date apart from its Recorded At (DR-05).
export interface Retirement {
  id: string;
  retirement_date: string;
  retirement_method: RetirementMethod;
  retirement_reference: string | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
}

// Why a Retirement was refused, naming what keeps the Asset (#154 Q3, P2).
export type RetirementRefusal = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'ALREADY_RETIRED'; retirement_id: string }
  | { reason: 'ON_LOAN'; loan_item_id: string; loan_id: string }
  | { reason: 'UNDER_REPAIR'; repair_record_id: string; repair_kind: RepairKind }
);

export const RETIREMENT_LABEL = 'จำหน่าย';
export const RETIRED_LABEL = 'จำหน่ายแล้ว';
// glossary: no entry — the Asset list's filter value for an Asset that is not Retired
export const NOT_RETIRED_LABEL = 'ยังไม่จำหน่าย';
// glossary: no entry — the Asset page heading made of the term จำหน่าย (Retirement)
export const RETIREMENT_SECTION_LABEL = 'การจำหน่าย';
// glossary: no entry — the Permanent Assignment of a Retired Asset, read as it stood at its Retirement (#154 Q14)
export const AS_AT_RETIREMENT_LABEL = 'ณ วันจำหน่าย';
export const RETIREMENT_DATE_LABEL = 'วันที่จำหน่าย';
export const RETIREMENT_METHOD_LABEL = 'วิธีจำหน่าย';
export const RETIREMENT_REFERENCE_LABEL = 'เอกสารอ้างอิง';

export const RETIREMENT_METHOD_LABELS: Record<RetirementMethod, string> = {
  SALE: 'ขาย',
  EXCHANGE: 'แลกเปลี่ยน',
  HANDOVER_TO_OTHER_AGENCY: 'โอนให้หน่วยงานอื่น',
  CONVERSION_OR_DESTRUCTION: 'แปรสภาพหรือทำลาย',
  DECLARED_LOSS: 'จำหน่ายเป็นสูญ',
};
