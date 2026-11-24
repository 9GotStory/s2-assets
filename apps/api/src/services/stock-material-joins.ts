// F010-T2 (#233): SQL another module joins to read a Stock Material by id, such as an Opening Balance line's name and
// status. A leaf of the Stock Material module (CODING_STANDARDS, "A feature's code gets its own files"): it imports
// nothing.

/** Joins the Stock Material `alias` that the SQL expression `idExpression` names, for its name and whether it is active. */
export const joinStockMaterial = (alias: string, idExpression: string): string => `JOIN stock_materials ${alias} ON ${alias}.id = ${idExpression}`;
