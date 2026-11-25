// F010-T3 (#234): the one SQL source of a Material Receipt's state (#231 Q4; CODING_STANDARDS, "A derived condition has
// one SQL source"). The list, the page and the writes read it. A leaf of the Material Receipt module: it imports
// nothing.

// ร่าง until confirmed (ยืนยันรับวัสดุ), then รับแล้ว; T7 (#238) shows a Received one with every line voided as ยกเลิกแล้ว.
export const MATERIAL_RECEIPT_STATES = ['DRAFT', 'RECEIVED'] as const;
export type MaterialReceiptState = (typeof MATERIAL_RECEIPT_STATES)[number];

/** SQL giving the state of the Material Receipt joined as `materialReceipt`. */
export const materialReceiptState = (materialReceipt: string): string => `(CASE WHEN ${materialReceipt}.confirmed_at IS NULL THEN 'DRAFT' ELSE 'RECEIVED' END)`;
