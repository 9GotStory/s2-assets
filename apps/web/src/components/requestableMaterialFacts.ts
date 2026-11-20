// What the API answers about the Requestable Materials (F009-T1), and their labels from GLOSSARY.md (#202, Web).

import type { NamedListEntry } from './materialFacts';

// The Request Unit of a Requestable Material, under the name its list entry has now.
export interface RequestUnit {
  unit_id: string;
  name: string;
  // Whether the list entry is Inactive; a Requestable Material keeps working with one (#202 Q15).
  unit_is_active: boolean;
}

// One row of the Requestable Material list.
export interface RequestableMaterialRow {
  id: string;
  name: string;
  request_unit: RequestUnit;
  whole_number_only: boolean;
  is_active: boolean;
}

export interface RequestableMaterialList {
  items: RequestableMaterialRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  can_manage: boolean;
}

// F009-T1 writes CREATED; T7 adds INACTIVATED and REACTIVATED, T8 RENAMED and DETAILS_CHANGED.
export type RequestableMaterialHistoryKind = 'CREATED';

// A value a creation records, none before it: the Request Unit under its name then (#202 Q17, #175 P6).
export type RequestableMaterialRecordedChange =
  | { field: 'name' | 'description'; before: null; after: string }
  | { field: 'request_unit'; before: null; after: NamedListEntry }
  | { field: 'whole_number_only'; before: null; after: boolean };

// One entry of a Requestable Material's history.
export interface RequestableMaterialHistoryEntry {
  version: number;
  kind: RequestableMaterialHistoryKind;
  changes: RequestableMaterialRecordedChange[];
  recorded_by: string;
  recorded_by_username: string;
  recorded_at: string;
}

export interface RequestableMaterialDetail extends RequestableMaterialRow {
  description: string | null;
  version: number;
  created_by: string;
  created_by_username: string;
  recorded_at: string;
  history: RequestableMaterialHistoryEntry[];
  can_manage: boolean;
}

// A name already used: the Requestable Material holding it, Inactive or not (#202 Q6).
export interface RequestableMaterialNameTaken {
  code: 'DUPLICATE_NAME';
  entry: { id: string; name: string; is_active: boolean; version: number };
}

export const REQUESTABLE_MATERIAL_LABEL = 'วัสดุสำหรับขอเบิก';
export const REQUEST_UNIT_LABEL = 'หน่วยที่ขอ';
// glossary: no entry — the list's action, made of the term วัสดุสำหรับขอเบิก (Requestable Material)
export const ADD_REQUESTABLE_MATERIAL_LABEL = 'เพิ่มวัสดุสำหรับขอเบิก';

// What the kind of each history entry is called on the Requestable Material page.
export const REQUESTABLE_HISTORY_KIND_LABELS: Record<RequestableMaterialHistoryKind, string> = {
  CREATED: 'สร้างรายการ',
};
