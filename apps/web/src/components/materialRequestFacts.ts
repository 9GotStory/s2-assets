// What the API answers about the Requester's Material Requests (F009-T4), and their labels from GLOSSARY.md (#202, Web).

import { HISTORY_KIND_LABELS } from './materialFacts';

// The states of a Requested Item and a Material Request in Feature 009 (#202 Q13).
export type MaterialRequestState = 'PENDING' | 'CANCELLED';

// One offered Requestable Material as a Requester finds it (#202 Q18).
export interface OfferedRequestableMaterial {
  id: string;
  name: string;
  request_unit: { unit_id: string; name: string };
  whole_number_only: boolean;
  description: string | null;
}

export interface OfferedRequestableMaterialList {
  items: OfferedRequestableMaterial[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// One row of "คำขอของฉัน".
export interface MaterialRequestRow {
  id: string;
  request_number: string;
  recorded_at: string;
  state: MaterialRequestState;
  requested_item_count: number;
}

export interface MaterialRequestList {
  items: MaterialRequestRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

// A Requested Item, its Requestable Material and Request Unit under their names now (#206 start decision 3).
export interface RequestedItem {
  id: string;
  position: number;
  requestable_material_id: string;
  requestable_material_name: string;
  requested_quantity: string;
  request_unit: { unit_id: string; name: string };
  note: string | null;
  state: MaterialRequestState;
  // Who Cancelled it, when and why, all null while it is Pending (F009-T5, #202 P4).
  cancelled_by: string | null;
  cancelled_by_username: string | null;
  cancelled_at: string | null;
  cancel_note: string | null;
  // Whether the page offers its Cancel (P9).
  can_cancel: boolean;
}

// F009-T4 writes CREATED; F009-T5 writes a Requested Item's Cancel and a Material Request's, each naming the Requested
// Items it Cancelled.
export type MaterialRequestHistoryKind = 'CREATED' | 'REQUESTED_ITEM_CANCELLED' | 'MATERIAL_REQUEST_CANCELLED';

export interface MaterialRequestHistoryEntry {
  version: number;
  kind: MaterialRequestHistoryKind;
  requested_item_ids: string[] | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string;
  recorded_at: string;
}

export interface MaterialRequestDetail {
  id: string;
  request_number: string;
  requested_by: string;
  requested_by_username: string;
  recorded_at: string;
  note: string | null;
  version: number;
  state: MaterialRequestState;
  // Whether the page offers Cancelling every Pending Requested Item (P9).
  can_cancel: boolean;
  requested_items: RequestedItem[];
  history: MaterialRequestHistoryEntry[];
}

export const MATERIAL_REQUEST_LABEL = 'คำขอเบิก';
export const REQUEST_NUMBER_LABEL = 'เลขที่คำขอ';
export const REQUESTED_ITEM_LABEL = 'รายการที่ขอ';
export const REQUESTED_QUANTITY_LABEL = 'จำนวนที่ขอ';
export const PENDING_LABEL = 'รอพิจารณา';
export const CANCELLED_LABEL = 'ยกเลิกแล้ว';
export const REQUESTER_LABEL = 'ผู้ขอเบิก';
// The Requester's menu and its pages (#202 Q19).
export const REQUEST_MATERIALS_LABEL = 'ขอเบิกวัสดุ';
export const MY_MATERIAL_REQUESTS_LABEL = 'คำขอของฉัน';
export const CREATE_MATERIAL_REQUEST_LABEL = 'สร้างคำขอเบิก';
// F009-T5 (#207 start decision 3): Cancel on a Requested Item's row, and on the whole Material Request.
export const CANCEL_LABEL = 'ยกเลิก';
// glossary: no entry — the history entry and form of a Requested Item's Cancel, made of the term ยกเลิก (Cancel)
export const CANCEL_REQUESTED_ITEM_LABEL = 'ยกเลิกรายการที่ขอ';
// glossary: no entry — the page's action, made of the term ยกเลิก (Cancel)
export const CANCEL_MATERIAL_REQUEST_LABEL = 'ยกเลิกคำขอเบิก';
// glossary: no entry — the Cancel form's submit, made of the term ยกเลิก (Cancel)
export const CONFIRM_CANCEL_LABEL = 'ยืนยันการยกเลิก';
// glossary: no entry — a form field
export const CANCEL_NOTE_LABEL = 'หมายเหตุการยกเลิก';
// P7: a Cancel's note is at most 500 characters.
export const CANCEL_NOTE_MAX_LENGTH = 500;

// What each state is called.
export const MATERIAL_REQUEST_STATE_LABELS: Record<MaterialRequestState, string> = {
  PENDING: PENDING_LABEL,
  CANCELLED: CANCELLED_LABEL,
};

// What the kind of each history entry is called on the Material Request page.
export const MATERIAL_REQUEST_HISTORY_KIND_LABELS: Record<MaterialRequestHistoryKind, string> = {
  CREATED: HISTORY_KIND_LABELS.CREATED,
  REQUESTED_ITEM_CANCELLED: CANCEL_REQUESTED_ITEM_LABEL,
  MATERIAL_REQUEST_CANCELLED: CANCEL_MATERIAL_REQUEST_LABEL,
};

// "รายการที่ขอที่ 2": the Requested Item at the zero-based `position`, as a refusal names it.
export const requestedItemAt = (position: number): string => `${REQUESTED_ITEM_LABEL}ที่ ${position + 1}`;

// A Request Number as shown: a plain number (#202 P3).
export const requestNumberLine = (requestNumber: string): string => `${REQUEST_NUMBER_LABEL} ${requestNumber}`;
