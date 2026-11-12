import pg from 'pg';
import type { LoanCondition } from './loan-read.service.ts';

// A Loan Return as another module cites it by id: a Repair Record's Repair Source (F005-T5, #103). This
// module reads no other module's tables and imports no reads at run time, so the Repair modules read
// it while loan-read.service.ts reads theirs, without an import cycle.

export interface CitedLoanReturn {
  loan_return_id: string;
  loan_id: string;
  asset_id: string;
  return_date: string;
  condition: LoanCondition;
  // Voided by a Loan Correction, of it or of its LoanItem or Loan, which voids it too (#74 Q25).
  is_voided: boolean;
}

/** Each of `loanReturnIds` that names a Loan Return, voided or not. A Not Returned is not one. */
export async function loanReturnsOf(db: pg.Pool | pg.PoolClient | any, loanReturnIds: string[]): Promise<Map<string, CitedLoanReturn>> {
  const res = await db.query(
    `SELECT e.id, li.loan_id, li.asset_id, to_char(e.ending_date, 'YYYY-MM-DD') AS return_date, e.condition, e.is_voided
     FROM loan_item_endings e
     JOIN loan_items li ON li.id = e.loan_item_id
     WHERE e.id = ANY($1::uuid[]) AND e.kind = 'LOAN_RETURN'`,
    [loanReturnIds]
  );
  return new Map(
    res.rows.map((row: any): [string, CitedLoanReturn] => [
      row.id,
      { loan_return_id: row.id, loan_id: row.loan_id, asset_id: row.asset_id, return_date: row.return_date, condition: row.condition, is_voided: row.is_voided },
    ])
  );
}
