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
  cancelled_by: string | null;
  cancelled_by_username: string | null;
  cancelled_at: string | null;
  cancel_note: string | null;
}

// F009-T4 writes CREATED; T5 adds REQUESTED_ITEM_CANCELLED and MATERIAL_REQUEST_CANCELLED, which 0031 already takes.
export type MaterialRequestHistoryKind = 'CREATED';

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

// What each state is called.
export const MATERIAL_REQUEST_STATE_LABELS: Record<MaterialRequestState, string> = {
  PENDING: PENDING_LABEL,
  CANCELLED: CANCELLED_LABEL,
};

// What the kind of each history entry is called on the Material Request page.
export const MATERIAL_REQUEST_HISTORY_KIND_LABELS: Record<MaterialRequestHistoryKind, string> = {
  CREATED: HISTORY_KIND_LABELS.CREATED,
};

// "รายการที่ขอที่ 2": the Requested Item at the zero-based `position`, as a refusal names it.
export const requestedItemAt = (position: number): string => `${REQUESTED_ITEM_LABEL}ที่ ${position + 1}`;

// A Request Number as shown: a plain number (#202 P3).
export const requestNumberLine = (requestNumber: string): string => `${REQUEST_NUMBER_LABEL} ${requestNumber}`;
