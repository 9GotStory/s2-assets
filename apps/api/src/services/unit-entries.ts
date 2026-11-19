// F008-T1 (#176): the Unit list's join for another module's read, as loan-item-periods.ts gives a LoanItem's period
// (CODING_STANDARDS, "A feature's code gets its own files"). unit.service.ts owns the table.
// This module imports nothing, so any service can use it without an import cycle.

/** Joins the Unit list entry `alias` that `unitIdExpression` names, for its name and whether it is active. */
export const joinUnitEntry = (alias: string, unitIdExpression: string): string => `JOIN units ${alias} ON ${alias}.id = ${unitIdExpression}`;
