import pg from 'pg';
import { assetNamesOf } from './asset-lookups.ts';
import { isValidUuid } from './capability.service.ts';
import { readLoanConflictsOfAssets, type LoanConflict, type LoanItemConflict } from './loan-read.service.ts';
import { readRepairConflictsOfAssets, type ConflictingRepairRecord, type RepairRecordConflict } from './repair-read.service.ts';
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

// A Repair Conflict a Loan write would create (F005-T7, #98 Q17): the written item, as above, and the
// Repair Record whose period it overlaps.
export interface WarnedLoanRepairConflict {
  asset_id: string;
  name: string | null;
  asset_number: string | null;
  loan_item_id: string | null;
  conflicting: ConflictingRepairRecord;
}

/**
 * F004-T7 (#81): a write that would create Loan Conflicts, refused with the list of them until the
 * request confirms each one (#74 Q20, Q25), like an Assignment Conflict's warning. F005-T7 (#105): the
 * Repair Conflicts the same write would create are listed in the same warning, which is named after the
 * Loan Conflicts when there are any (#98 Q17).
 */
export class LoanConflictWarningError extends Error {
  statusCode = 409;
  code: 'LOAN_CONFLICTS_FOUND' | 'REPAIR_CONFLICTS_FOUND';
  conflicts: WarnedLoanConflict[];
  repair_conflicts: WarnedLoanRepairConflict[];

  constructor(conflicts: WarnedLoanConflict[], repairConflicts: WarnedLoanRepairConflict[]) {
    super('This write would create Loan Conflicts or Repair Conflicts. Confirm each one to save it.');
    this.name = 'LoanConflictWarningError';
    this.code = conflicts.length > 0 ? 'LOAN_CONFLICTS_FOUND' : 'REPAIR_CONFLICTS_FOUND';
    this.conflicts = conflicts;
    this.repair_conflicts = repairConflicts;
  }
}

// What a request confirms: the other side of each conflict its warning named, as the user saw it, a
// LoanItem or a Repair Record (F005-T7).
export type ConfirmedConflictInput = { conflicting_loan_item_id: string } | { conflicting_repair_record_id: string };

// The confirmed other sides, well formed and each once, in identifier order.
export interface ConfirmedConflicts {
  loanItemIds: string[];
  repairRecordIds: string[];
}

const normalizedIds = (ids: string[], field: string): string[] => {
  if (ids.some((id) => !isValidUuid(id))) {
    throw new ValidationError(`confirmed_conflicts[].${field} must be a valid UUID`);
  }
  return [...new Set(ids.map((id) => id.trim().toLowerCase()))].sort();
};

/** The LoanItems and Repair Records a request confirms as the other side of a conflict. */
export function normalizeConfirmedConflicts(confirmed: ConfirmedConflictInput[] | undefined): ConfirmedConflicts {
  const all = confirmed ?? [];
  return {
    loanItemIds: normalizedIds(all.flatMap((c) => ('conflicting_loan_item_id' in c ? [c.conflicting_loan_item_id] : [])), 'conflicting_loan_item_id'),
    repairRecordIds: normalizedIds(all.flatMap((c) => ('conflicting_repair_record_id' in c ? [c.conflicting_repair_record_id] : [])), 'conflicting_repair_record_id'),
  };
}

/**
 * A write's retry payload with what it confirms. An unconfirmed request keeps the payload it had before
 * confirmation existed, and one that confirms only LoanItems the payload it had before Repair Conflicts
 * existed, so their fingerprints are unchanged (#74 Q20).
 */
export function withConfirmedConflicts<Payload extends object>(payload: Payload, { loanItemIds, repairRecordIds }: ConfirmedConflicts): Payload {
  return {
    ...payload,
    ...(loanItemIds.length > 0 ? { confirmed_conflicts: loanItemIds } : {}),
    ...(repairRecordIds.length > 0 ? { confirmed_repair_record_conflicts: repairRecordIds } : {}),
  };
}

// A conflict of the written Loan, by the two LoanItems that overlap.
const pairKey = ({ loan_item_id, conflicting }: LoanItemConflict): string => `${loan_item_id}:${conflicting.loan_item_id}`;

// A Repair Conflict between a Repair Record and a LoanItem, by the two of them.
const repairPairKey = ({ repair_record, conflicting }: RepairRecordConflict): string =>
  `${repair_record.repair_record_id}:${conflicting.kind === 'LOAN_ITEM' ? conflicting.loan_item_id : conflicting.repair_record_id}`;

/**
 * Reads the Loan Conflicts and Repair Conflicts of a write's Assets before it, and checks the write's
 * Loan after it, in the caller's transaction, which holds the Assets locked. A conflict of that Loan that
 * was not there before is new; unless the request confirms every new one, the write is refused with all
 * of them, and the refusal rolls the trial write back.
 */
export async function loanConflictCheck(client: pg.PoolClient, assetIds: string[]) {
  const before = new Set((await readLoanConflictsOfAssets(client, assetIds)).map(pairKey));
  const repairBefore = new Set((await readRepairConflictsOfAssets(client, assetIds)).map(repairPairKey));
  return {
    assertConfirmed: async ({ loanId, isNewLoan, confirmed }: { loanId: string; isNewLoan: boolean; confirmed: ConfirmedConflicts }): Promise<void> => {
      const created = (await readLoanConflictsOfAssets(client, assetIds)).filter((conflict) => conflict.loan_id === loanId && !before.has(pairKey(conflict)));
      const repairCreated = (await readRepairConflictsOfAssets(client, assetIds)).filter(
        (conflict) => conflict.conflicting.kind === 'LOAN_ITEM' && conflict.conflicting.loan_id === loanId && !repairBefore.has(repairPairKey(conflict))
      );
      const seenItems = new Set(confirmed.loanItemIds);
      const seenRecords = new Set(confirmed.repairRecordIds);
      if (
        created.every(({ conflicting }) => seenItems.has(conflicting.loan_item_id)) &&
        repairCreated.every(({ repair_record }) => seenRecords.has(repair_record.repair_record_id))
      ) {
        return;
      }
      const assetOf = await assetNamesOf(client, assetIds);
      const named = (assetId: string) => ({ asset_id: assetId, name: assetOf.get(assetId)?.name ?? null, asset_number: assetOf.get(assetId)?.asset_number ?? null });
      throw new LoanConflictWarningError(
        created.map(({ asset_id, loan_item_id, conflicting }) => ({
          ...named(asset_id),
          // A new Loan's item id does not outlive the refusal.
          loan_item_id: isNewLoan ? null : loan_item_id,
          conflicting,
        })),
        repairCreated.map(({ asset_id, repair_record, conflicting }) => ({
          ...named(asset_id),
          loan_item_id: isNewLoan || conflicting.kind !== 'LOAN_ITEM' ? null : conflicting.loan_item_id,
          conflicting: repair_record,
        }))
      );
    },
  };
}
