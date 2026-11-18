// What the API answers about the Stock Material catalog (F008-T1), and its labels from GLOSSARY.md (#175 Q17).

// One entry of the shared Unit list.
export interface UnitEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

export interface UnitList {
  items: UnitEntry[];
  can_manage: boolean;
}

// One row of the Stock Material list.
export interface StockMaterialRow {
  id: string;
  name: string;
  model: string | null;
  specification: string | null;
  is_active: boolean;
  base_unit: { unit_id: string; name: string };
}

export interface StockMaterialList {
  items: StockMaterialRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  can_manage: boolean;
}

// One Unit of a Stock Material, under the name its list entry has now.
export interface StockMaterialUnit {
  unit_id: string;
  name: string;
  unit_is_active: boolean;
  is_base: boolean;
  conversion_factor: string;
  whole_number_only: boolean;
  is_active: boolean;
}

// A Unit as a history entry recorded it, under its name then (#175 P6).
export interface RecordedUnit {
  unit_id: string;
  name: string;
  is_base: boolean;
  conversion_factor: string;
  whole_number_only: boolean;
  is_active: boolean;
}

export type StockMaterialHistoryKind = 'CREATED' | 'CORRECTED' | 'UNITS_CHANGED' | 'INACTIVATED' | 'REACTIVATED';

export interface StockMaterialHistoryEntry {
  version: number;
  kind: StockMaterialHistoryKind;
  changes: { field: string; before: unknown; after: unknown }[];
  reason: string | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface StockMaterialDetail {
  id: string;
  name: string;
  model: string | null;
  specification: string | null;
  note: string | null;
  is_active: boolean;
  version: number;
  created_by: string;
  created_by_username: string | null;
  recorded_at: string;
  units: StockMaterialUnit[];
  history: StockMaterialHistoryEntry[];
  can_manage: boolean;
}

export const STOCK_MATERIAL_LABEL = 'วัสดุ';
export const MODEL_LABEL = 'รุ่น';
export const SPECIFICATION_LABEL = 'คุณลักษณะ';
export const UNIT_LABEL = 'หน่วยนับ';
export const BASE_UNIT_LABEL = 'หน่วยนับหลัก';
export const CONVERSION_FACTOR_LABEL = 'อัตราแปลง';
export const WHOLE_NUMBER_UNIT_LABEL = 'นับเป็นจำนวนเต็มเท่านั้น';
export const ACTIVE_LABEL = 'ใช้งานอยู่';
export const INACTIVE_LABEL = 'หยุดใช้';
// glossary: no entry — the list's action, made of the term วัสดุ (Stock Material)
export const ADD_STOCK_MATERIAL_LABEL = 'เพิ่มวัสดุ';
// glossary: no entry — the form's inline action, made of the term หน่วยนับ (Unit)
export const ADD_UNIT_LABEL = 'เพิ่มหน่วยนับ';

// What each kind of history entry is called on the Stock Material page. F008-T1 writes only CREATED; the tickets that
// write the other kinds name them.
export const HISTORY_KIND_LABELS: Partial<Record<StockMaterialHistoryKind, string>> = {
  CREATED: 'สร้างรายการ',
};

// What each recorded field is called in a history entry.
export const RECORDED_FIELD_LABELS: Record<string, string> = {
  name: 'ชื่อวัสดุ',
  model: MODEL_LABEL,
  specification: SPECIFICATION_LABEL,
  note: 'หมายเหตุ',
  units: UNIT_LABEL,
};

// A Unit as one line: the Base Unit, or an Alternate Unit with its Conversion Factor as "1 กล่อง = 5 รีม" (#175 Q5).
export const unitLine = (unit: Pick<RecordedUnit, 'name' | 'is_base' | 'conversion_factor' | 'whole_number_only'>, baseName: string): string =>
  `${unit.is_base ? `${BASE_UNIT_LABEL} ${unit.name}` : `1 ${unit.name} = ${unit.conversion_factor} ${baseName}`}${unit.whole_number_only ? ` (${WHOLE_NUMBER_UNIT_LABEL})` : ''}`;
