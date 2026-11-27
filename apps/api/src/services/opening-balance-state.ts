// F010-T2 (#233): the one SQL source of an Opening Balance's state (#231 Q20; CODING_STANDARDS, "A derived condition
// has one SQL source"). The list, the page and the writes read it. A leaf of the Opening Balance module: it imports
// nothing.

// ร่าง until confirmed (ยืนยันยอดตั้งต้น), then ยืนยันแล้ว. F010-T7 (#238): a confirmed one with every line voided, as only
// the void of the whole Opening Balance leaves it, is ยกเลิกแล้ว (start comment 7184458771).
export const OPENING_BALANCE_STATES = ['DRAFT', 'CONFIRMED', 'VOIDED'] as const;
export type OpeningBalanceState = (typeof OPENING_BALANCE_STATES)[number];

/** SQL giving the state of the Opening Balance joined as `openingBalance`. */
export const openingBalanceState = (openingBalance: string): string =>
  `(CASE WHEN ${openingBalance}.confirmed_at IS NULL THEN 'DRAFT'
         WHEN NOT EXISTS (SELECT 1 FROM opening_balance_lines state_line WHERE state_line.opening_balance_id = ${openingBalance}.id AND NOT state_line.is_voided) THEN 'VOIDED'
         ELSE 'CONFIRMED' END)`;
