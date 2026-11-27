// F010-T3 (#234): the one SQL source of a Material Receipt's state (#231 Q4; CODING_STANDARDS, "A derived condition has
// one SQL source"). The list, the page and the writes read it. A leaf of the Material Receipt module: it imports
// nothing.

// ร่าง until confirmed (ยืนยันรับวัสดุ), then รับแล้ว. F010-T7 (#238): a Received one with every line voided, as only the
// void of the whole Material Receipt leaves it, is ยกเลิกแล้ว (#231 Model; start comment 7184458771).
export const MATERIAL_RECEIPT_STATES = ['DRAFT', 'RECEIVED', 'VOIDED'] as const;
export type MaterialReceiptState = (typeof MATERIAL_RECEIPT_STATES)[number];

/** SQL giving the state of the Material Receipt joined as `materialReceipt`. */
export const materialReceiptState = (materialReceipt: string): string =>
  `(CASE WHEN ${materialReceipt}.confirmed_at IS NULL THEN 'DRAFT'
         WHEN NOT EXISTS (SELECT 1 FROM material_receipt_lines state_line WHERE state_line.material_receipt_id = ${materialReceipt}.id AND NOT state_line.is_voided) THEN 'VOIDED'
         ELSE 'RECEIVED' END)`;
