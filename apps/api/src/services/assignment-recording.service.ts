import pg from 'pg';
import {
  assertInitialAssignmentEntries,
  bangkokDate,
  normalizeInitialAssignment,
  normalizeReassignment,
  recordInitialAssignment,
  recordReassignment,
  type InitialAssignmentInput,
  type ReassignmentInput,
} from './assignment.service.ts';
import { writeAssignmentOnce, type RecordedAssignment } from './assignment-write.ts';
import { ValidationError } from './validation-error.ts';

export type RecordAssignmentInput = { expected_assignment_version: number; explicit_continuation?: boolean } & (
  | ({ kind: 'INITIAL' } & InitialAssignmentInput)
  | ({ kind: 'REASSIGNMENT' } & ReassignmentInput)
);

type Client = pg.PoolClient | pg.Pool;

/**
 * F003-T2 (#52): records one assignment fact for one Asset, an Initial Assignment or a Reassignment.
 */
export class AssignmentRecordingService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Validates the request before any lock: its normalized facts, which the retry fingerprint covers,
  // and the write that records them.
  private prepare(
    actorId: string,
    assetId: string,
    input: RecordAssignmentInput,
    today: string
  ): { facts: unknown; write: (client: Client) => Promise<string> } {
    if (input.kind === 'INITIAL') {
      const facts = normalizeInitialAssignment(input, today);
      if (!facts) {
        throw new ValidationError('An Initial Assignment needs a Location, OrganizationUnit or Responsible Person value');
      }
      return {
        facts,
        write: async (client) => {
          await assertInitialAssignmentEntries(client, facts, today);
          return recordInitialAssignment(client, { assetId, actorId, facts });
        },
      };
    }
    const facts = normalizeReassignment(input, today);
    return { facts, write: (client) => recordReassignment(client, { assetId, actorId, facts, today }) };
  }

  async record(
    actorId: string,
    assetId: string,
    input: RecordAssignmentInput,
    { retryToken }: { retryToken: string }
  ): Promise<RecordedAssignment> {
    const { facts, write } = this.prepare(actorId, assetId, input, bangkokDate(this.clock()));
    return writeAssignmentOnce(
      this.db,
      {
        actorId,
        assetId,
        operation: `assignment:record:${assetId}`,
        retryToken,
        expectedVersion: input.expected_assignment_version,
        payload: { version: 1, kind: input.kind, expected_assignment_version: input.expected_assignment_version, facts },
        explicitContinuation: input.explicit_continuation === true,
        recordsNewFact: true,
      },
      async (client) => {
        const initialRes = await client.query(
          `SELECT 1 FROM assignment_events WHERE asset_id = $1 AND kind = 'INITIAL' AND NOT is_voided`,
          [assetId]
        );
        const hasInitial = initialRes.rows.length > 0;
        if (input.kind === 'INITIAL' && hasInitial) {
          throw new ValidationError('This Asset already has an Initial Assignment; record a Reassignment instead');
        }
        if (input.kind === 'REASSIGNMENT' && !hasInitial) {
          throw new ValidationError('This Asset has no Initial Assignment yet; record one before a Reassignment');
        }
        return write(client);
      }
    );
  }
}
