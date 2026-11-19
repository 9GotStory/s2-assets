// What the API answers about the Stock Material catalog (F008-T1, T3, T4), and its labels from GLOSSARY.md (#175 Q17).

// One entry of a list of the catalog: the shared Unit list (F008-T1), the Brand or the Material Category list (F008-T4).
export interface ListEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

export type UnitEntry = ListEntry;

export interface UnitList {
  items: UnitEntry[];
  can_manage: boolean;
}

export interface CatalogList {
  items: ListEntry[];
  can_manage: boolean;
}

// A Stock Material's Brand or Material Category, under its name now; a history entry records it under its name then.
export interface NamedListEntry {
  id: string;
  name: string;
}

// One row of the Stock Material list.
export interface StockMaterialRow {
  id: string;
  name: string;
  model: string | null;
  specification: string | null;
  is_active: boolean;
  base_unit: { unit_id: string; name: string };
  brand: NamedListEntry | null;
  material_category: NamedListEntry | null;
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
  // Null on an Inactive Alternate Unit given no new factor when the Base Unit changed (F008-T3, #178).
  conversion_factor: string | null;
  whole_number_only: boolean;
  is_active: boolean;
}

// A Unit as a history entry recorded it, under its name then (#175 P6).
export interface RecordedUnit {
  unit_id: string;
  name: string;
  is_base: boolean;
  // Null on an Inactive Alternate Unit given no new factor when the Base Unit changed (F008-T3, #178).
  conversion_factor: string | null;
  whole_number_only: boolean;
  is_active: boolean;
}

export type StockMaterialHistoryKind = 'CREATED' | 'CORRECTED' | 'UNITS_CHANGED' | 'DETAILS_CHANGED' | 'INACTIVATED' | 'REACTIVATED';

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
  brand: NamedListEntry | null;
  model: string | null;
  specification: string | null;
  note: string | null;
  material_category: NamedListEntry | null;
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
export const BRAND_LABEL = 'ยี่ห้อ';
export const MODEL_LABEL = 'รุ่น';
export const SPECIFICATION_LABEL = 'คุณลักษณะ';
export const MATERIAL_CATEGORY_LABEL = 'หมวดวัสดุ';
// glossary: no entry — the Material Category filter's option for a Stock Material with no หมวดวัสดุ (Material Category)
export const NO_MATERIAL_CATEGORY_LABEL = 'ไม่มีหมวด';
export const UNIT_LABEL = 'หน่วยนับ';
export const BASE_UNIT_LABEL = 'หน่วยนับหลัก';
export const ALTERNATE_UNIT_LABEL = 'หน่วยนับอื่น';
export const CONVERSION_FACTOR_LABEL = 'อัตราแปลง';
export const WHOLE_NUMBER_UNIT_LABEL = 'นับเป็นจำนวนเต็มเท่านั้น';
export const ACTIVE_LABEL = 'ใช้งานอยู่';
export const INACTIVE_LABEL = 'หยุดใช้';
// glossary: no entry — the list's action, made of the term วัสดุ (Stock Material)
export const ADD_STOCK_MATERIAL_LABEL = 'เพิ่มวัสดุ';
// glossary: no entry — the form's inline action, made of the term หน่วยนับ (Unit)
export const ADD_UNIT_LABEL = 'เพิ่มหน่วยนับ';
// glossary: no entry — the form's action, made of the term หน่วยนับอื่น (Alternate Unit)
export const ADD_ALTERNATE_UNIT_LABEL = 'เพิ่มหน่วยนับอื่น';
// glossary: no entry — the Stock Material page's action, made of the term หน่วยนับ (Unit)
export const EDIT_UNITS_LABEL = 'แก้ไขหน่วยนับ';
// glossary: no entry — the form's inline action, made of the term ยี่ห้อ (Brand)
export const ADD_BRAND_LABEL = 'เพิ่มยี่ห้อ';
// glossary: no entry — the form's inline action, made of the term หมวดวัสดุ (Material Category)
export const ADD_MATERIAL_CATEGORY_LABEL = 'เพิ่มหมวดวัสดุ';
// glossary: no entry — the Stock Material page's action for the หมวดวัสดุ (Material Category) and note, which need no reason
export const EDIT_DETAILS_LABEL = 'แก้ไขข้อมูลอื่น';

// What each kind of history entry is called on the Stock Material page. F008-T1 writes CREATED, T3 UNITS_CHANGED and
// T4 DETAILS_CHANGED; the tickets that write the other kinds name them.
export const HISTORY_KIND_LABELS: Partial<Record<StockMaterialHistoryKind, string>> = {
  CREATED: 'สร้างรายการ',
  UNITS_CHANGED: EDIT_UNITS_LABEL,
  DETAILS_CHANGED: EDIT_DETAILS_LABEL,
};

// What each recorded field is called in a history entry.
export const RECORDED_FIELD_LABELS: Record<string, string> = {
  name: 'ชื่อวัสดุ',
  brand: BRAND_LABEL,
  model: MODEL_LABEL,
  specification: SPECIFICATION_LABEL,
  material_category: MATERIAL_CATEGORY_LABEL,
  note: 'หมายเหตุ',
  units: UNIT_LABEL,
};

// A known Conversion Factor as "1 กล่อง = 5 รีม" (#175 Q5).
export const conversionLine = (unitName: string, conversionFactor: string, baseName: string): string => `1 ${unitName} = ${conversionFactor} ${baseName}`;

// A Unit as one line: the Base Unit, or an Alternate Unit with its Conversion Factor, "-" when unknown (#178), then
// its rules.
export const unitLine = (unit: Pick<RecordedUnit, 'name' | 'is_base' | 'conversion_factor' | 'whole_number_only' | 'is_active'>, baseName: string): string =>
  `${unit.is_base ? `${BASE_UNIT_LABEL} ${unit.name}` : unit.conversion_factor === null ? `${unit.name}: ${CONVERSION_FACTOR_LABEL} -` : conversionLine(unit.name, unit.conversion_factor, baseName)}${unit.whole_number_only ? ` (${WHOLE_NUMBER_UNIT_LABEL})` : ''}${unit.is_active ? '' : ` (${INACTIVE_LABEL})`}`;
