import { isValidUuid } from './capability.service.ts';
import { ValidationError } from './validation-error.ts';

// The confirmation that a Loan Conflict or Repair Conflict warning asks for (#74 Q20, #98 Q17), shared
// by the Loan writes and the Repair writes.

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
