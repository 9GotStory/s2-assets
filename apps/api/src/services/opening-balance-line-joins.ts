// F010-T4 (#235): SQL another module joins to read the Opening Balance an Opening Balance line belongs to, such as a
// Stock Movement's source on the รายการเคลื่อนไหว table. A leaf of the Opening Balance module (CODING_STANDARDS, "A
// feature's code gets its own files"): it imports nothing.

/**
 * LEFT JOINs, as `alias`, the Opening Balance of the line whose id is the SQL expression `lineIdExpression`, for
 * `alias.id` and `alias.opening_balance_number`; all of them NULL when the expression names no line.
 */
export const joinOpeningBalanceOfLine = (alias: string, lineIdExpression: string): string =>
  `LEFT JOIN (SELECT obl.id AS line_id, ob.id, ob.opening_balance_number
              FROM opening_balance_lines obl
              JOIN opening_balances ob ON ob.id = obl.opening_balance_id) ${alias} ON ${alias}.line_id = ${lineIdExpression}`;
