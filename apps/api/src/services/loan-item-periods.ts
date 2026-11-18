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

/**
 * F007-T6 (#160): the business dates of each non-voided LoanItem of a non-voided Loan that `scope` keeps, for rows
 * aliased `li`, as a Retirement Conflict compares them (#154 P1): its Loan Date, by the LoanItem, and its non-voided
 * Loan Return or Not Returned ending, by the ending. A Due Date and a Due Date Extension are none. Each row names the
 * Asset, the kind, the fact, its date and the Loan.
 */
export const loanItemBusinessDates = (scope: string): string => `SELECT li.asset_id, 'LOAN_DATE' AS kind, li.id AS fact_id, l.loan_date AS fact_date, l.id AS record_id
       FROM loan_items li
       JOIN loans l ON l.id = li.loan_id
       WHERE NOT li.is_voided AND NOT l.is_voided AND ${scope}
       UNION ALL
       SELECT li.asset_id, ending.kind, ending.id, ending.ending_date, l.id
       FROM loan_item_endings ending
       JOIN loan_items li ON li.id = ending.loan_item_id
       JOIN loans l ON l.id = li.loan_id
       WHERE NOT ending.is_voided AND NOT li.is_voided AND NOT l.is_voided AND ${scope}`;
