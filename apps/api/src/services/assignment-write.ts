import pg from 'pg';
import { NotFoundError, StaleBeforeConflictError } from './asset.service.ts';
import { AssignmentConflictWarningError, newAssignmentConflicts } from './assignment-conflict.ts';
import {
  readAssignmentConflicts,
  readAssignmentTimeline,
  readCurrentAssignment,
  type AssignmentEvent,
  type CurrentAssignment,
} from './assignment.service.ts';
import { commitOnce, type RetryableWrite } from './retryable-write.ts';

export interface RecordedAssignment {
  event: AssignmentEvent;
  current_assignment: CurrentAssignment;
  assignment_version: number;
}

// What every assignment write's request carries besides its facts.
export interface AssignmentWriteInput {
  expected_assignment_version: number;
  explicit_continuation?: boolean;
}

export interface AssignmentWriteRequest extends RetryableWrite {
  assetId: string;
  expectedVersion: number;
  // Whether `write` records a new fact, whose id does not outlive a refusal.
  recordsNewFact: boolean;
}

/**
 * One write of an Asset's assignment facts, in one transaction, under the contract every such write
 * keeps. It locks the Asset, checks the client's expected assignment version and writes; `write`
 * returns the id of the event it wrote and increments the version. A write that would create new
 * Assignment Conflicts is refused with a warning unless the request confirms them, and the expected
 * version ties that confirmation to the timeline the user saw.
 */
export async function writeAssignmentOnce(
  db: pg.Pool | any,
  { assetId, expectedVersion, recordsNewFact, ...retryable }: AssignmentWriteRequest,
  write: (client: pg.PoolClient) => Promise<string>
): Promise<RecordedAssignment> {
  return commitOnce(db, retryable, async (client) => {
    const assetRes = await client.query('SELECT assignment_version FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
    if (assetRes.rows.length === 0) {
      throw new NotFoundError('Asset not found');
    }
    const currentVersion: number = assetRes.rows[0].assignment_version;
    if (currentVersion !== expectedVersion) {
      throw new StaleBeforeConflictError(
        "The Asset's assignment changed since it was read",
        { assignment_version: currentVersion },
        { assignment_version: expectedVersion }
      );
    }

    const { explicitContinuation } = retryable;
    const conflictsBefore = explicitContinuation ? [] : await readAssignmentConflicts(client, assetId);
    const eventId = await write(client);
    if (!explicitContinuation) {
      // The trial write lets the same reads decide; the refusal rolls it back, so nothing is saved.
      const created = newAssignmentConflicts(conflictsBefore, await readAssignmentConflicts(client, assetId));
      if (created.length > 0) {
        throw new AssignmentConflictWarningError(
          created.map((conflict) => (recordsNewFact && conflict.event_id === eventId ? { ...conflict, event_id: null } : conflict))
        );
      }
    }

    const { current, version } = await readCurrentAssignment(client, assetId);
    const timeline = await readAssignmentTimeline(client, assetId);
    return {
      event: timeline.find(({ id }) => id === eventId)!,
      current_assignment: current,
      assignment_version: version,
    };
  });
}
