import type { AssignmentConflict } from './assignment.service.ts';

/**
 * F003-T4 (#54): a write that would create Assignment Conflicts, refused with the list of them until
 * the request carries explicit confirmation (MR-05, #50 Q12), like Feature 002's duplicate warning.
 */
export class AssignmentConflictWarningError extends Error {
  statusCode = 409;
  code = 'ASSIGNMENT_CONFLICTS_FOUND';
  conflicts: AssignmentConflict[];

  constructor(conflicts: AssignmentConflict[]) {
    super('This write would create Assignment Conflicts. Explicit continuation is required to save it.');
    this.name = 'AssignmentConflictWarningError';
    this.conflicts = conflicts;
  }
}

// What identifies a conflict: the fact, the dimension, and the two values that disagree. A different
// value on either side is a conflict the user has not seen.
const conflictKey = ({ event_id, dimension, recorded_prior, value_just_before }: AssignmentConflict): string =>
  JSON.stringify([
    event_id,
    dimension,
    recorded_prior.entry?.id ?? null,
    recorded_prior.legacy_text,
    value_just_before.entry?.id ?? null,
    value_just_before.legacy_text,
  ]);

/** The conflicts of `after` that `before` does not hold. */
export function newAssignmentConflicts(before: AssignmentConflict[], after: AssignmentConflict[]): AssignmentConflict[] {
  const known = new Set(before.map(conflictKey));
  return after.filter((conflict) => !known.has(conflictKey(conflict)));
}
