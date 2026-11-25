// F010-T4 (#235): SQL another module joins to read the Material Receipt a Receipt Line belongs to, such as a Stock
// Movement's source on the รายการเคลื่อนไหว table. A leaf of the Material Receipt module (CODING_STANDARDS, "A
// feature's code gets its own files"): it imports nothing.

/**
 * LEFT JOINs, as `alias`, the Material Receipt of the Receipt Line whose id is the SQL expression `lineIdExpression`, for
 * `alias.id` and `alias.receipt_number`; all of them NULL when the expression names no line.
 */
export const joinMaterialReceiptOfLine = (alias: string, lineIdExpression: string): string =>
  `LEFT JOIN (SELECT mrl.id AS line_id, mr.id, mr.receipt_number
              FROM material_receipt_lines mrl
              JOIN material_receipts mr ON mr.id = mrl.material_receipt_id) ${alias} ON ${alias}.line_id = ${lineIdExpression}`;
