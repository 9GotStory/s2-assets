// F010-T4 (#235): what a Stock Material's รายการเคลื่อนไหว table shows, and its labels (GLOSSARY.md, Material Stock;
// #231 Q16, Q23, P6).
import { RECEIPT_NUMBER_LABEL, RECEIVE_MATERIAL_LABEL } from './materialReceiptFacts';
import { OPENING_BALANCE_LABEL, OPENING_BALANCE_NUMBER_LABEL } from './openingBalanceFacts';

export type StockMovementKind = 'OPENING_BALANCE' | 'MATERIAL_RECEIPT' | 'REVERSAL';

// The record whose line made the Stock Movement, or whose Stock Movement a Reversal takes back.
export interface StockMovementSource {
  kind: 'OPENING_BALANCE' | 'MATERIAL_RECEIPT';
  id: string;
  number: string;
}

export interface StockLedgerRow {
  id: string;
  kind: StockMovementKind;
  effective_date: string;
  source: StockMovementSource;
  original_quantity: string;
  original_unit: { unit_id: string; name: string };
  // The Conversion Snapshot.
  base_unit: { unit_id: string; name: string };
  conversion_factor: string;
  // Signed, in the Base Unit.
  base_quantity: string;
  // The stock right after it, in the Base Unit.
  balance: string;
  recorded_by_username: string | null;
  recorded_at: string;
}

export interface StockLedger {
  items: StockLedgerRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  // Newest first.
  fiscal_years: number[];
}

export const EFFECTIVE_DATE_LABEL = 'วันที่มีผล';
export const RECORDED_AT_LABEL = 'วันที่บันทึก';
export const REVERSAL_LABEL = 'กลับรายการ';

export const STOCK_MOVEMENT_KIND_LABELS: Record<StockMovementKind, string> = {
  OPENING_BALANCE: OPENING_BALANCE_LABEL,
  MATERIAL_RECEIPT: RECEIVE_MATERIAL_LABEL,
  REVERSAL: REVERSAL_LABEL,
};

// The page and the number label of each source record.
export const STOCK_MOVEMENT_SOURCES: Record<StockMovementSource['kind'], { path: string; numberLabel: string }> = {
  OPENING_BALANCE: { path: '/opening-balances', numberLabel: OPENING_BALANCE_NUMBER_LABEL },
  MATERIAL_RECEIPT: { path: '/material-receipts', numberLabel: RECEIPT_NUMBER_LABEL },
};
