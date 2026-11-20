// What the API answers about the Stock Material catalog (F008-T1, T3, T4, T5, T6, T8), and its labels from GLOSSARY.md (#175 Q17).

// One entry of a list of the catalog: the shared Unit list (F008-T1), the Brand or the Material Category list (F008-T4).
export interface ListEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

export type UnitEntry = ListEntry;

// F008-T8 (#183): one change of a list entry, as the entry's own history records it (#175 P6): its addition, a
// rename with the old and the new name, or a change of status.
export interface ListEntryHistoryEntry {
  version: number;
  action: 'CREATED' | 'CHANGED';
  changes: { name?: { before: string | null; after: string }; is_active?: { before: boolean | null; after: boolean } };
  actor_id: string;
  actor_username: string | null;
  recorded_at: string;
}

// An entry as its list answers it (F008-T8): how many Stock Materials use it, Inactive ones included, and its history.
export interface ListedEntry extends ListEntry {
  usage_count: number;
  history: ListEntryHistoryEntry[];
}

export interface UnitList {
  items: ListedEntry[];
  can_manage: boolean;
}

export interface CatalogList {
  items: ListedEntry[];
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
  // F008-T6 (#182): in the Base Unit, a decimal string without trailing zeros, or none.
  minimum_stock: string | null;
}

// F008-T5 (#181): the Duplicate Candidates a create or a Material Correction was refused with, in Feature 002's
// DUPLICATE_CANDIDATES_FOUND contract: at most 50, with how many there are.
export interface DuplicateCandidatesFound {
  candidates: StockMaterialRow[];
  total_count: number;
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
  // F008-T6 (#182): in the Base Unit, a decimal string without trailing zeros, or none.
  minimum_stock: string | null;
  is_active: boolean;
  version: number;
  created_by: string;
  created_by_username: string | null;
  recorded_at: string;
  units: StockMaterialUnit[];
  history: StockMaterialHistoryEntry[];
  can_manage: boolean;
  // F008-T7 (#180, #175 P9): "หยุดใช้" on a Stock Material in use, "เปิดใช้อีกครั้ง" on an Inactive one.
  can_inactivate: boolean;
  can_reactivate: boolean;
}

export const STOCK_MATERIAL_LABEL = 'วัสดุ';
export const BRAND_LABEL = 'ยี่ห้อ';
export const MODEL_LABEL = 'รุ่น';
export const SPECIFICATION_LABEL = 'คุณลักษณะ';
export const MATERIAL_CATEGORY_LABEL = 'หมวดวัสดุ';
export const NO_MATERIAL_CATEGORY_LABEL = 'ไม่มีหมวด';
export const UNIT_LABEL = 'หน่วยนับ';
export const BASE_UNIT_LABEL = 'หน่วยนับหลัก';
export const ALTERNATE_UNIT_LABEL = 'หน่วยนับอื่น';
export const CONVERSION_FACTOR_LABEL = 'อัตราแปลง';
export const WHOLE_NUMBER_UNIT_LABEL = 'นับเป็นจำนวนเต็มเท่านั้น';
export const ACTIVE_LABEL = 'ใช้งานอยู่';
export const INACTIVE_LABEL = 'หยุดใช้';
export const REACTIVATE_LABEL = 'เปิดใช้อีกครั้ง';
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
export const EDIT_DETAILS_LABEL = 'แก้ไขข้อมูลอื่น';
export const MINIMUM_STOCK_LABEL = 'จำนวนขั้นต่ำ';
export const DUPLICATE_CANDIDATE_LABEL = 'รายการที่อาจซ้ำ';
export const DIFFERENT_STOCK_MATERIAL_LABEL = 'เป็นคนละรายการ';
export const MATERIAL_CORRECTION_LABEL = 'แก้ไขรายการที่บันทึกผิด';
// glossary: no entry — the list filter's option, made of the term จำนวนขั้นต่ำ (Minimum Stock)
export const MINIMUM_STOCK_SET_LABEL = 'ตั้งจำนวนขั้นต่ำแล้ว';
// glossary: no entry — the list filter's option, made of the term จำนวนขั้นต่ำ (Minimum Stock)
export const MINIMUM_STOCK_NOT_SET_LABEL = 'ยังไม่ตั้งจำนวนขั้นต่ำ';
// glossary: no entry — the maintenance page of the "วัสดุ" menu, made of the term ยี่ห้อ (Brand)
export const CATALOG_LISTS_LABEL = 'ยี่ห้อ หมวดวัสดุ และหน่วยนับ';
export const RENAME_LABEL = 'เปลี่ยนชื่อ';

// What each kind of history entry is called on the Stock Material page. F008-T1 writes CREATED, T3 UNITS_CHANGED,
// T4 DETAILS_CHANGED, T5 CORRECTED, and T7 INACTIVATED and REACTIVATED.
export const HISTORY_KIND_LABELS: Record<StockMaterialHistoryKind, string> = {
  CREATED: 'สร้างรายการ',
  CORRECTED: MATERIAL_CORRECTION_LABEL,
  UNITS_CHANGED: EDIT_UNITS_LABEL,
  DETAILS_CHANGED: EDIT_DETAILS_LABEL,
  INACTIVATED: INACTIVE_LABEL,
  REACTIVATED: REACTIVATE_LABEL,
};

// What each recorded field is called in a history entry.
export const RECORDED_FIELD_LABELS: Record<string, string> = {
  name: 'ชื่อวัสดุ',
  brand: BRAND_LABEL,
  model: MODEL_LABEL,
  specification: SPECIFICATION_LABEL,
  material_category: MATERIAL_CATEGORY_LABEL,
  note: 'หมายเหตุ',
  minimum_stock: MINIMUM_STOCK_LABEL,
  units: UNIT_LABEL,
  // F008-T7 (#180): whether the Stock Material is ใช้งานอยู่ or หยุดใช้.
  is_active: 'สถานะ',
};

// A Minimum Stock with its Base Unit, as "10 รีม", or "-" for none (F008-T6, #175 MC-20).
export const minimumStockLine = (minimumStock: string | null, baseName: string): string => (minimumStock === null ? '-' : `${minimumStock} ${baseName}`);

// An amount as typed, as the server stores it: trimmed, without leading zeros or trailing decimal zeros ("010.50" is
// "10.5"), so that a form compares it the way the server does (CODING_STANDARDS); what is not a decimal stays as typed
// but for those zeros, for the server to refuse.
export const amountAsStored = (text: string): string =>
  text
    .trim()
    .replace(/^0+(?=\d)/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

// A known Conversion Factor as "1 กล่อง = 5 รีม" (#175 Q5).
export const conversionLine = (unitName: string, conversionFactor: string, baseName: string): string => `1 ${unitName} = ${conversionFactor} ${baseName}`;

// A Unit as one line: the Base Unit, or an Alternate Unit with its Conversion Factor, "-" when unknown (#178), then
// its rules.
export const unitLine = (unit: Pick<RecordedUnit, 'name' | 'is_base' | 'conversion_factor' | 'whole_number_only' | 'is_active'>, baseName: string): string =>
  `${unit.is_base ? `${BASE_UNIT_LABEL} ${unit.name}` : unit.conversion_factor === null ? `${unit.name}: ${CONVERSION_FACTOR_LABEL} -` : conversionLine(unit.name, unit.conversion_factor, baseName)}${unit.whole_number_only ? ` (${WHOLE_NUMBER_UNIT_LABEL})` : ''}${unit.is_active ? '' : ` (${INACTIVE_LABEL})`}`;
