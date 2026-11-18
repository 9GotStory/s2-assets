import pg from 'pg';
import {
  assertInitialAssignmentEntries,
  bangkokDate,
  lockAssetsInIdentifierOrder,
  normalizeInitialAssignment,
  normalizeReassignment,
  recordInitialAssignment,
  recordReassignment,
  type InitialAssignmentInput,
  type ReassignmentInput,
} from './assignment.service.ts';
import { writeAssignmentOnce, type AssignmentWriteInput, type RecordedAssignment } from './assignment-write.ts';
import { AssetRetiredError, retiredAmong } from './retirement-read.service.ts';
import { ValidationError } from './validation-error.ts';
import { lockCitedVerificationRevision } from './verification-revision-read.ts';

export type RecordAssignmentInput = AssignmentWriteInput & (
  | ({ kind: 'INITIAL' } & InitialAssignmentInput)
  | ({ kind: 'REASSIGNMENT' } & ReassignmentInput)
);

// Why a Verification Revision cannot be the result a Reassignment moves an Asset from (#125 Q13): it must be a
// revision not voided, of the same Asset, with "Location ไม่ตรงทะเบียน". An id that names no revision is
// NOT_VERIFICATION_REVISION.
export interface CitedVerificationRevisionRefusal {
  verification_revision_id: string;
  reason: 'NOT_VERIFICATION_REVISION' | 'OTHER_ASSET' | 'VOIDED' | 'NO_LOCATION_MISMATCH';
}

/** A Reassignment cites a result it cannot move the Asset from. Nothing is saved, and the answer says why. */
export class CitedVerificationRevisionRefusedError extends Error {
  statusCode = 409;
  code = 'CITED_VERIFICATION_REVISION_REFUSED';
  verification_revision: CitedVerificationRevisionRefusal;

  constructor(refusal: CitedVerificationRevisionRefusal) {
    super(`The Verification Revision cannot be cited by this Reassignment: ${refusal.reason}`);
    this.name = 'CitedVerificationRevisionRefusedError';
    this.verification_revision = refusal;
  }
}

/**
 * #125 Q13: a Reassignment may cite a Verification Revision not voided, of the same Asset, with "Location ไม่ตรงทะเบียน",
 * in a Round open or closed. The revision is read under a share lock of its row, which a Verification Correction
 * voiding it also needs, so the check holds until commit (#132 decision 6933747982). The caller holds the Asset
 * locked; a void locks no Asset, so the two cannot wait on each other in a cycle.
 */
async function assertCitedVerificationRevision(client: pg.PoolClient, assetId: string, revisionId: string): Promise<void> {
  const cited = await lockCitedVerificationRevision(client, revisionId);
  const refuse = (reason: CitedVerificationRevisionRefusal['reason']) => new CitedVerificationRevisionRefusedError({ verification_revision_id: revisionId, reason });
  if (!cited) {
    throw refuse('NOT_VERIFICATION_REVISION');
  }
  if (cited.asset_id !== assetId) {
    throw refuse('OTHER_ASSET');
  }
  if (cited.is_voided) {
    throw refuse('VOIDED');
  }
  if (!cited.has_location_mismatch) {
    throw refuse('NO_LOCATION_MISMATCH');
  }
}

/**
 * F003-T2 (#52): records one assignment fact for one Asset, an Initial Assignment or a Reassignment, which may cite
 * the result it moves the Asset from (F006-T8, #133). A Retired Asset takes neither (F007-T3, #157).
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
  ): { facts: unknown; write: (client: pg.PoolClient) => Promise<string> } {
    if (input.kind === 'INITIAL') {
      if ('verification_revision_id' in input && input.verification_revision_id != null) {
        throw new ValidationError('Only a Reassignment may cite a Verification Revision');
      }
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
    return {
      facts,
      write: async (client) => {
        if (facts.verification_revision_id) {
          await assertCitedVerificationRevision(client, assetId, facts.verification_revision_id);
        }
        return recordReassignment(client, { assetId, actorId, facts, today });
      },
    };
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
        // A Retired Asset takes no new assignment fact, Initial Assignment included (DR-08, #154 Q7, P4). Asked under
        // the Asset's lock, which a Retirement takes too, so one committed first is seen (#154 Q24); the lock is held
        // already, and taking it again reads the Asset's name.
        const [retired] = await retiredAmong(client, await lockAssetsInIdentifierOrder(client, [assetId]));
        if (retired) {
          throw new AssetRetiredError(retired, 'its Permanent Assignment stays as it was when it left use');
        }
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
