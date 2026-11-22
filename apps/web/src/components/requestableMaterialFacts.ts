// What the API answers about the Requestable Materials (F009-T1) and their Compatible Stock Materials (F009-T2), and
// their labels from GLOSSARY.md (#202, Web).

import type React from 'react';
import { HISTORY_KIND_LABELS, type NamedListEntry, type StockMaterialRow, type StockMaterialUnit } from './materialFacts';

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
  // F009-T2: whether Requesters are offered it (#202 Q9); an active one that is not shows "ยังไม่มีวัสดุที่ใช้จ่าย".
  is_offered: boolean;
}

export interface RequestableMaterialList {
  items: RequestableMaterialRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  can_manage: boolean;
}

// F009-T1 writes CREATED, T2 the add and the end of a Compatible Stock Material; T7 adds INACTIVATED and
// REACTIVATED, T8 RENAMED and DETAILS_CHANGED.
export type RequestableMaterialHistoryKind = 'CREATED' | 'COMPATIBLE_STOCK_MATERIAL_ADDED' | 'COMPATIBLE_STOCK_MATERIAL_ENDED';

// A value a creation records, none before it: the Request Unit under its name then (#202 Q17, #175 P6). F009-T2: the
// Stock Material an add or an end names, under its name then, after an add and before an end.
export type RequestableMaterialRecordedChange =
  | { field: 'name' | 'description'; before: null; after: string }
  | { field: 'request_unit'; before: null; after: NamedListEntry }
  | { field: 'whole_number_only'; before: null; after: boolean }
  | { field: 'compatible_stock_material'; before: NamedListEntry | null; after: NamedListEntry | null };

// F009-T2: a Compatible Stock Material, with the Stock Material's name, status and Units now, current or ended (P1).
export interface CompatibleStockMaterial {
  stock_material_id: string;
  name: string;
  is_active: boolean;
  is_current: boolean;
  units: StockMaterialUnit[];
}

// F009-T2: a Stock Material a Supply Officer may choose, and whether its active Units include the Request Unit.
export interface StockMaterialChoice extends StockMaterialRow {
  handles_request_unit: boolean;
}

export interface StockMaterialChoices {
  items: StockMaterialChoice[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

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
  // The current ones first.
  compatible_stock_materials: CompatibleStockMaterial[];
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

export const COMPATIBLE_STOCK_MATERIAL_LABEL = 'วัสดุที่ใช้จ่ายได้';
export const NO_COMPATIBLE_STOCK_MATERIAL_LABEL = 'ยังไม่มีวัสดุที่ใช้จ่าย';
// glossary: no entry — the page's action, made of the term วัสดุที่ใช้จ่ายได้ (Compatible Stock Material)
export const ADD_COMPATIBLE_STOCK_MATERIAL_LABEL = 'เพิ่มวัสดุที่ใช้จ่ายได้';
// F009-T2 (#204 start decision 2): ending one, and whether it is current or ended (P1).
export const END_COMPATIBLE_STOCK_MATERIAL_LABEL = 'เลิก';
export const CURRENT_COMPATIBLE_STOCK_MATERIAL_LABEL = 'ใช้อยู่';
export const ENDED_COMPATIBLE_STOCK_MATERIAL_LABEL = 'เลิกแล้ว';
// glossary: no entry — the history entry of an end, made of the term วัสดุที่ใช้จ่ายได้ (Compatible Stock Material)
export const COMPATIBLE_STOCK_MATERIAL_ENDED_LABEL = 'เลิกวัสดุที่ใช้จ่ายได้';

// Why a Stock Material cannot be chosen: its active Units lack the Request Unit `unitName` (#202 Q19, ADR 0002).
export const lacksRequestUnitLine = (unitName: string): string => `ไม่มีหน่วย ${unitName}`;

// What the kind of each history entry is called on the Requestable Material page.
export const REQUESTABLE_HISTORY_KIND_LABELS: Record<RequestableMaterialHistoryKind, string> = {
  CREATED: HISTORY_KIND_LABELS.CREATED,
  COMPATIBLE_STOCK_MATERIAL_ADDED: ADD_COMPATIBLE_STOCK_MATERIAL_LABEL,
  COMPATIBLE_STOCK_MATERIAL_ENDED: COMPATIBLE_STOCK_MATERIAL_ENDED_LABEL,
};

// Whether a Requestable Material shows the "ยังไม่มีวัสดุที่ใช้จ่าย" badge: active, and not offered (#202 Q9).
export const isActiveWithoutCompatibleStockMaterial = (requestable: RequestableMaterialRow): boolean => requestable.is_active && !requestable.is_offered;

// How the "ยังไม่มีวัสดุที่ใช้จ่าย" badge looks beside the name, in the list and on the page.
export const noCompatibleBadgeStyle: React.CSSProperties = {
  marginLeft: '0.5rem',
  padding: '0.125rem 0.5rem',
  backgroundColor: '#fef3c7',
  color: '#92400e',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};
