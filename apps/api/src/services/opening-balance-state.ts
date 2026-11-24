// F010-T2 (#233): the one SQL source of an Opening Balance's state (#231 Q20; CODING_STANDARDS, "A derived condition
// has one SQL source"). The list, the page and the writes read it. A leaf of the Opening Balance module: it imports
// nothing.

// ร่าง until confirmed (ยืนยันยอดตั้งต้น), then ยืนยันแล้ว.
export const OPENING_BALANCE_STATES = ['DRAFT', 'CONFIRMED'] as const;
export type OpeningBalanceState = (typeof OPENING_BALANCE_STATES)[number];

/** SQL giving the state of the Opening Balance joined as `openingBalance`. */
export const openingBalanceState = (openingBalance: string): string => `(CASE WHEN ${openingBalance}.confirmed_at IS NULL THEN 'DRAFT' ELSE 'CONFIRMED' END)`;
