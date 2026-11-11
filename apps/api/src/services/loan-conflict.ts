import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { readLoanConflictsOfAssets, type LoanConflict, type LoanItemConflict } from './loan-read.service.ts';
import { ValidationError } from './validation-error.ts';

// A Loan Conflict a write would create, as its warning lists it: the written item, which a new Loan
// has no id for yet because nothing is saved, its Asset, and the other item.
export interface WarnedLoanConflict {
  asset_id: string;
  name: string | null;
  asset_number: string | null;
  loan_item_id: string | null;
  conflicting: LoanConflict;
}

/**
 * F004-T7 (#81): a write that would create Loan Conflicts, refused with the list of them until the
 * request confirms each one (#74 Q20, Q25), like an Assignment Conflict's warning.
 */
export class LoanConflictWarningError extends Error {
  statusCode = 409;
  code = 'LOAN_CONFLICTS_FOUND';
  conflicts: WarnedLoanConflict[];

  constructor(conflicts: WarnedLoanConflict[]) {
    super('This write would create Loan Conflicts. Confirm each one to save it.');
    this.name = 'LoanConflictWarningError';
    this.conflicts = conflicts;
  }
}

// What a request confirms: the LoanItems its warning named as conflicting, as the user saw them.
export interface ConfirmedLoanConflictInput {
  conflicting_loan_item_id: string;
}

/** The confirmed conflicting LoanItem ids, well formed and each once, in identifier order. */
export function normalizeConfirmedConflicts(confirmed: ConfirmedLoanConflictInput[] | undefined): string[] {
  if (confirmed === undefined) {
    return [];
  }
  if (confirmed.some(({ conflicting_loan_item_id: id }) => !isValidUuid(id))) {
    throw new ValidationError('confirmed_conflicts[].conflicting_loan_item_id must be a valid UUID');
  }
  return [...new Set(confirmed.map(({ conflicting_loan_item_id: id }) => id.trim().toLowerCase()))].sort();
}

/**
 * A write's retry payload with what it confirms. An unconfirmed request keeps the payload it had before
 * confirmation existed, so its fingerprint is unchanged (#74 Q20).
 */
export function withConfirmedConflicts<Payload extends object>(payload: Payload, confirmed: string[]): Payload | (Payload & { confirmed_conflicts: string[] }) {
  return confirmed.length > 0 ? { ...payload, confirmed_conflicts: confirmed } : payload;
}

// A conflict of the written Loan, by the two LoanItems that overlap.
const pairKey = ({ loan_item_id, conflicting }: LoanItemConflict): string => `${loan_item_id}:${conflicting.loan_item_id}`;

/**
 * Reads the Loan Conflicts of a write's Assets before it, and checks the write's Loan after it, in the
 * caller's transaction, which holds the Assets locked. A conflict of that Loan that was not there before
 * is new; unless the request confirms every new one, the write is refused with all of them, and the
 * refusal rolls the trial write back.
 */
export async function loanConflictCheck(client: pg.PoolClient, assetIds: string[]) {
  const before = new Set((await readLoanConflictsOfAssets(client, assetIds)).map(pairKey));
  return {
    assertConfirmed: async ({ loanId, isNewLoan, confirmed }: { loanId: string; isNewLoan: boolean; confirmed: string[] }): Promise<void> => {
      const created = (await readLoanConflictsOfAssets(client, assetIds)).filter(
        (conflict) => conflict.loan_id === loanId && !before.has(pairKey(conflict))
      );
      const seen = new Set(confirmed);
      if (created.every(({ conflicting }) => seen.has(conflicting.loan_item_id))) {
        return;
      }
      const assetsRes = await client.query('SELECT id, name, asset_number FROM assets WHERE id = ANY($1::uuid[])', [assetIds]);
      const assetOf = new Map(assetsRes.rows.map((asset: any) => [asset.id, asset]));
      throw new LoanConflictWarningError(
        created.map(({ asset_id, loan_item_id, conflicting }) => ({
          asset_id,
          name: assetOf.get(asset_id)?.name ?? null,
          asset_number: assetOf.get(asset_id)?.asset_number ?? null,
          // A new Loan's item id does not outlive the refusal.
          loan_item_id: isNewLoan ? null : loan_item_id,
          conflicting,
        }))
      );
    },
  };
}
