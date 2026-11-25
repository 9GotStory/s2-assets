// F010-T2 (#233): what the Opening Balance (ยอดตั้งต้น) pages show and send, and their labels (GLOSSARY.md, Material
// Stock; #231 Q13, Q20, Q24, Q25).

export type OpeningBalanceState = 'DRAFT' | 'CONFIRMED';

// One row of the Opening Balance list.
export interface OpeningBalanceRow {
  id: string;
  // A bigint as digits, or none while Draft.
  opening_balance_number: string | null;
  as_of_date: string | null;
  source: string | null;
  state: OpeningBalanceState;
  line_count: number;
  created_at: string;
}

export interface OpeningBalanceList {
  items: OpeningBalanceRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  can_manage: boolean;
}

// A Stock Movement a line made, with its quantity as entered and in the Base Unit.
export interface LineStockMovement {
  id: string;
  kind: string;
  effective_date: string;
  original_quantity: string;
  original_unit: { unit_id: string; name: string };
  base_unit: { unit_id: string; name: string };
  conversion_factor: string;
  base_quantity: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface OpeningBalanceLine {
  id: string;
  position: number;
  stock_material: { id: string; name: string; is_active: boolean };
  unit: { unit_id: string; name: string } | null;
  quantity: string | null;
  note: string | null;
  is_voided: boolean;
  stock_movement_id: string | null;
  stock_movements: LineStockMovement[];
}

export interface OpeningBalanceHistoryEntry {
  version: number;
  kind: 'CONFIRMED' | 'CORRECTED' | 'VOIDED';
  facts: Record<string, unknown>;
  reason: string | null;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface OpeningBalanceDetail {
  id: string;
  opening_balance_number: string | null;
  as_of_date: string | null;
  source: string | null;
  note: string | null;
  state: OpeningBalanceState;
  version: number;
  created_by_username: string | null;
  created_at: string;
  confirmed_by_username: string | null;
  confirmed_at: string | null;
  lines: OpeningBalanceLine[];
  history: OpeningBalanceHistoryEntry[];
  can_manage: boolean;
}

// A confirm refused, each failing rule named by its field (#231 Q25).
export interface ConfirmProblem {
  field: string;
  message: string;
  in_effect_opening_balance?: { opening_balance_id: string; opening_balance_number: string };
  // F010-T3 (#234 start decision 3): or the Material Receipt holding it.
  in_effect_material_receipt?: { material_receipt_id: string; receipt_number: string };
}

export const OPENING_BALANCE_LABEL = 'ยอดตั้งต้น';
export const AS_OF_DATE_LABEL = 'ยอด ณ วันที่';
export const OPENING_BALANCE_SOURCE_LABEL = 'ที่มาของยอด';
export const CONFIRM_OPENING_BALANCE_LABEL = 'ยืนยันยอดตั้งต้น';
export const STOCK_MOVEMENT_LABEL = 'รายการเคลื่อนไหว';
// glossary: no entry — the action that starts a Draft, made of the term ยอดตั้งต้น (Opening Balance)
export const ADD_OPENING_BALANCE_LABEL = 'เพิ่มยอดตั้งต้น';
// glossary: no entry — the running number's caption, made of the term ยอดตั้งต้น (Opening Balance)
export const OPENING_BALANCE_NUMBER_LABEL = 'เลขที่ยอดตั้งต้น';
// glossary: no entry — the Draft form's save, made of the term ร่าง (Draft)
export const SAVE_DRAFT_LABEL = 'บันทึกร่าง';
// glossary: no entry — the Draft page's edit, made of the term ร่าง (Draft)
export const EDIT_DRAFT_LABEL = 'แก้ไขร่าง';
// glossary: no entry — removing a Draft for good, made of the term ร่าง (Draft)
export const REMOVE_DRAFT_LABEL = 'ลบร่าง';

export const OPENING_BALANCE_STATE_LABELS: Record<OpeningBalanceState, string> = {
  DRAFT: 'ร่าง',
  CONFIRMED: 'ยืนยันแล้ว',
};

export const OPENING_BALANCE_HISTORY_KIND_LABELS: Record<OpeningBalanceHistoryEntry['kind'], string> = {
  CONFIRMED: CONFIRM_OPENING_BALANCE_LABEL,
  CORRECTED: 'แก้ไขรายการที่บันทึกผิด',
  VOIDED: 'ยกเลิกรายการ',
};

/** "เลขที่ยอดตั้งต้น <n>", or "-" while Draft. */
export const openingBalanceNumberLine = (number: string | null): string => (number === null ? '-' : `${OPENING_BALANCE_NUMBER_LABEL} ${number}`);
