import pg from 'pg';
import { warnedAssetLookup } from './asset-lookups.ts';
import type { ConfirmedConflicts } from './conflict-confirmation.ts';
import { conflictingIdOf, readRepairConflictsOfAssets, type RepairConflict, type RepairRecordConflict } from './repair-read.service.ts';

// A Repair Conflict a Repair write would create, as its warning lists it: the written record, which a
// Repair Start has no id for yet because nothing is saved, its Asset, and the other Repair Record or LoanItem.
export interface WarnedRepairConflict {
  asset_id: string;
  name: string | null;
  asset_number: string | null;
  repair_record_id: string | null;
  conflicting: RepairConflict;
}

/**
 * F005-T7 (#105): a Repair write that would create Repair Conflicts, refused with the list of them until
 * the request confirms each one, as a Loan Conflict's warning is (#98 Q17).
 */
export class RepairConflictWarningError extends Error {
  statusCode = 409;
  code = 'REPAIR_CONFLICTS_FOUND';
  repair_conflicts: WarnedRepairConflict[];

  constructor(repairConflicts: WarnedRepairConflict[]) {
    super('This write would create Repair Conflicts. Confirm each one to save it.');
    this.name = 'RepairConflictWarningError';
    this.repair_conflicts = repairConflicts;
  }
}

// The other side of a Repair Conflict, by its kind and id.
const otherKey = (conflicting: RepairConflict): string => `${conflicting.kind}:${conflictingIdOf(conflicting)}`;

const pairKey = ({ repair_record, conflicting }: RepairRecordConflict): string => `${repair_record.repair_record_id}:${otherKey(conflicting)}`;

/**
 * Reads the Repair Conflicts of a Repair write's Asset before it, and checks the written record after it,
 * in the caller's transaction, which holds the Asset locked. A conflict of that record that was not there
 * before is new; unless the request confirms every new one, the write is refused with all of them, and
 * the refusal rolls the trial write back.
 */
export async function repairConflictCheck(client: pg.PoolClient, assetId: string) {
  const before = new Set((await readRepairConflictsOfAssets(client, [assetId])).map(pairKey));
  return {
    assertConfirmed: async ({ repairRecordId, isNewRecord, confirmed }: { repairRecordId: string; isNewRecord: boolean; confirmed: ConfirmedConflicts }): Promise<void> => {
      const created = (await readRepairConflictsOfAssets(client, [assetId])).filter(
        (conflict) => conflict.repair_record.repair_record_id === repairRecordId && !before.has(pairKey(conflict))
      );
      const seen = new Set([...confirmed.loanItemIds.map((id) => `LOAN_ITEM:${id}`), ...confirmed.repairRecordIds.map((id) => `REPAIR_RECORD:${id}`)]);
      if (created.every(({ conflicting }) => seen.has(otherKey(conflicting)))) {
        return;
      }
      const named = await warnedAssetLookup(client, [assetId]);
      throw new RepairConflictWarningError(
        created.map(({ conflicting }) => ({
          ...named(assetId),
          // A new record's id does not outlive the refusal.
          repair_record_id: isNewRecord ? null : repairRecordId,
          conflicting,
        }))
      );
    },
  };
}
