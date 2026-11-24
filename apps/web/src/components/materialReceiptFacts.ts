// F010-T3 (#234): what the Material Receipt (รายการรับวัสดุ) pages show and send, and their labels (GLOSSARY.md, Material
// Stock; #231 Q4–Q11, Q24, Q25).
import type { LineStockMovement } from './openingBalanceFacts';

export type MaterialReceiptState = 'DRAFT' | 'RECEIVED';

// An entry of the Source Party or Source Type list under its name now.
export interface ReceiptListEntry {
  id: string;
  name: string;
  is_active: boolean;
}

// One row of the Material Receipt list.
export interface MaterialReceiptRow {
  id: string;
  // A bigint as digits, or none while Draft.
  receipt_number: string | null;
  received_date: string | null;
  source_party: { id: string; name: string } | null;
  state: MaterialReceiptState;
  line_count: number;
  created_at: string;
}

export interface MaterialReceiptList {
  items: MaterialReceiptRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  can_manage: boolean;
}

export interface MaterialReceiptLine {
  id: string;
  position: number;
  stock_material: { id: string; name: string; is_active: boolean };
  unit: { unit_id: string; name: string } | null;
  quantity: string | null;
  unit_price: string | null;
  note: string | null;
  is_voided: boolean;
  stock_movement_id: string | null;
  stock_movements: LineStockMovement[];
}

export interface MaterialReceiptHistoryEntry {
  version: number;
  kind: 'CONFIRMED' | 'CORRECTED' | 'VOIDED';
  facts: Record<string, unknown>;
  reason: string | null;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface MaterialReceiptDetail {
  id: string;
  receipt_number: string | null;
  received_date: string | null;
  source_party: ReceiptListEntry | null;
  source_type: ReceiptListEntry | null;
  receipt_reference: string | null;
  note: string | null;
  state: MaterialReceiptState;
  version: number;
  created_by_username: string | null;
  created_at: string;
  confirmed_by_username: string | null;
  confirmed_at: string | null;
  lines: MaterialReceiptLine[];
  history: MaterialReceiptHistoryEntry[];
  can_manage: boolean;
}

// A confirm refused, each failing rule named by its field (#231 Q25).
export interface ReceiptConfirmProblem {
  field: string;
  message: string;
  in_effect_opening_balance?: { opening_balance_id: string; opening_balance_number: string; as_of_date: string };
}

// The "วัสดุ" menu's entry (#231 Q2, Q24).
export const RECEIVE_MATERIAL_LABEL = 'รับวัสดุ';
export const RECEIPT_NUMBER_LABEL = 'เลขที่รับ';
export const RECEIVED_DATE_LABEL = 'วันที่รับ';
export const RECEIPT_REFERENCE_LABEL = 'เอกสารอ้างอิง';
export const UNIT_PRICE_LABEL = 'ราคาต่อหน่วย';
export const CONFIRM_RECEIPT_LABEL = 'ยืนยันรับวัสดุ';
// glossary: no entry — the action that starts a Draft, made of the term รายการรับวัสดุ (Material Receipt)
export const ADD_MATERIAL_RECEIPT_LABEL = 'เพิ่มรายการรับวัสดุ';
// glossary: no entry — a form field: a line's amount, worked out from ราคาต่อหน่วย (Unit Price) and never stored
export const AMOUNT_LABEL = 'จำนวนเงิน';
// glossary: no entry — a form field: the note under the amounts, which GLOSSARY.md words under ราคาต่อหน่วย (Unit Price)
export const AMOUNT_FOR_REFERENCE_LABEL = 'ใช้เพื่ออ้างอิงเท่านั้น ระบบไม่บันทึกมูลค่าของวัสดุ';

export const MATERIAL_RECEIPT_STATE_LABELS: Record<MaterialReceiptState, string> = {
  DRAFT: 'ร่าง',
  RECEIVED: 'รับแล้ว',
};

export const MATERIAL_RECEIPT_HISTORY_KIND_LABELS: Record<MaterialReceiptHistoryEntry['kind'], string> = {
  CONFIRMED: CONFIRM_RECEIPT_LABEL,
  CORRECTED: 'แก้ไขรายการที่บันทึกผิด',
  VOIDED: 'ยกเลิกรายการ',
};

/** "เลขที่รับ <n>", or "-" while Draft. */
export const receiptNumberLine = (number: string | null): string => (number === null ? '-' : `${RECEIPT_NUMBER_LABEL} ${number}`);

// Every quantity and price is a decimal string of at most four places (#175 P1), so an amount has at most eight.
const PRICE_SCALE = 10_000n;
const AMOUNT_PLACES = 8;
const DECIMAL = /^(\d+)(?:\.(\d{1,4}))?$/;

// A decimal string of at most four places as a count of ten-thousandths, or null when it is not one.
const scaled = (text: string): bigint | null => {
  const match = DECIMAL.exec(text.trim());
  return match === null ? null : BigInt(match[1]) * PRICE_SCALE + BigInt((match[2] ?? '').padEnd(4, '0'));
};

/**
 * A line's amount, the quantity times the Unit Price, as a count of 10^-8, worked out exactly and never rounded; null
 * when either is missing or not a decimal (Q8).
 */
export const lineAmount = (quantity: string, unitPrice: string): bigint | null => {
  const [q, p] = [scaled(quantity), scaled(unitPrice)];
  return q === null || p === null ? null : q * p;
};

/** An amount from `lineAmount` or a sum of them, grouped by thousands, with at least two decimal places and no rounding. */
export const formatAmount = (amount: bigint): string => {
  const digits = amount.toString().padStart(AMOUNT_PLACES + 1, '0');
  const whole = digits.slice(0, -AMOUNT_PLACES).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(-AMOUNT_PLACES).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction}`;
};
