// The period of a LoanItem as Loan Conflicts and Repair Conflicts compare it (F004-T7, F005-T7). This
// module reads no other module and imports nothing at run time, so loan-read.service.ts and
// repair-read.service.ts both read it without an import cycle.

/**
 * The period of each non-voided LoanItem of a non-voided Loan that `scope` keeps, for rows aliased `li`
 * and `l`: from the Loan Date to the effective ending date, the Loan Return's date, otherwise the Not
 * Returned date, and open-ended without either (#74).
 */
export const loanItemPeriods = (scope: string): string => `SELECT li.id AS loan_item_id, li.loan_id, li.asset_id, l.loan_date AS starts,
         coalesce(loan_return.ending_date, not_returned.ending_date) AS ends
       FROM loan_items li
       JOIN loans l ON l.id = li.loan_id
       LEFT JOIN loan_item_endings loan_return
         ON loan_return.loan_item_id = li.id AND loan_return.kind = 'LOAN_RETURN' AND NOT loan_return.is_voided
       LEFT JOIN loan_item_endings not_returned
         ON not_returned.loan_item_id = li.id AND not_returned.kind = 'NOT_RETURNED' AND NOT not_returned.is_voided
       WHERE NOT li.is_voided AND NOT l.is_voided AND ${scope}`;
