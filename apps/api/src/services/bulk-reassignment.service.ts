import * as crypto from 'node:crypto';
import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { NotFoundError, StaleBeforeConflictError } from './asset.service.ts';
import { AssignmentConflictWarningError, newAssignmentConflicts } from './assignment-conflict.ts';
import {
  assetsWithInitialAssignment,
  bangkokDate,
  lockAssetsInIdentifierOrder,
  normalizeReassignment,
  readAssignmentConflicts,
  readAssignmentTimeline,
  recordReassignmentIfItChanges,
  type AssignmentChange,
  type AssignmentConflict,
  type AssignmentEvent,
  type LockedAsset,
  type ReassignmentFacts,
  type ReassignmentInput,
} from './assignment.service.ts';
import { commitOnce, rollbackQuietly } from './assignment-write.ts';
import { ValidationError } from './validation-error.ts';

// #50 Q4: as many as a bulk registration (Feature 002 D4).
const MAX_ASSETS = 100;

const normalizedId = (assetId: string): string => assetId.trim().toLowerCase();

// An Asset of a batch, with the assignment version its preview read.
export interface BulkReassignmentAsset {
  asset_id: string;
  expected_assignment_version: number;
}

export interface BulkReassignmentInput extends ReassignmentInput {
  assets: BulkReassignmentAsset[];
  explicit_continuation?: boolean;
}

export interface BulkReassignmentPreviewInput extends ReassignmentInput {
  asset_ids: string[];
}

// An Asset of a batch and an assignment version: the one a preview read, or the one a save left.
interface AssetAtVersion {
  asset_id: string;
  assignment_version: number;
}

export interface BulkReassignmentResult {
  bulk_reference: string;
  changed: (AssetAtVersion & { event: AssignmentEvent })[];
  unchanged: AssetAtVersion[];
}

// What a batch would do, before anything is saved, at the assignment versions the save must then expect.
export interface BulkReassignmentPreview {
  changed: (AssetAtVersion & { changes: Pick<AssignmentChange, 'dimension' | 'prior' | 'new'>[] })[];
  unchanged: AssetAtVersion[];
  conflicts: AssignmentConflict[];
}

// What a batch did to one Asset: its event, or none when it had nothing to change (MR-01).
interface AppliedAsset {
  asset_id: string;
  version_read: number;
  event: AssignmentEvent | null;
}

// The effect of a batch, and the new Assignment Conflicts it found.
interface AppliedBatch {
  assets: AppliedAsset[];
  conflicts: AssignmentConflict[];
}

const unchangedOf = (assets: AppliedAsset[]): AssetAtVersion[] =>
  assets.flatMap(({ asset_id, version_read, event }) => (event ? [] : [{ asset_id, assignment_version: version_read }]));

interface BatchWrite {
  assetIds: string[];
  facts: ReassignmentFacts;
  today: string;
  bulkReference: string;
  // What each Asset must still be at; a preview has none, and reports what it read.
  expectedVersions: Map<string, number> | null;
  // Whether to look for the conflicts the batch would create: a confirmed write has no need to.
  findConflicts: boolean;
}

/** A batch names Assets that need "กำหนดครั้งแรก" first. Answered as a validation failure, by name. */
export class InitialAssignmentRequiredError extends ValidationError {
  assets: { asset_id: string; name: string | null; asset_number: string | null }[];

  constructor(assets: LockedAsset[]) {
    const names = assets.map(({ id, name, asset_number }) => name ?? asset_number ?? id).join(', ');
    super(`These Assets have no Initial Assignment yet; record one before a Bulk Reassignment: ${names}`);
    this.code = 'INITIAL_ASSIGNMENT_REQUIRED';
    this.assets = assets.map(({ id, name, asset_number }) => ({ asset_id: id, name, asset_number }));
  }
}

/**
 * F003-T5 (#55): records the same Reassignment for up to 100 Assets in one transaction. Each changed
 * Asset gets its own event with its own prior values (MR-10), and they share one bulk reference. One
 * warning lists every new Assignment Conflict across the batch, and one confirmation saves it (#50 Q12).
 */
export class BulkReassignmentService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // The batch's Assets in identifier order, validated before any lock.
  private normalizeAssetIds(assetIds: string[]): string[] {
    if (assetIds.length < 1 || assetIds.length > MAX_ASSETS) {
      throw new ValidationError(`A Bulk Reassignment names 1 to ${MAX_ASSETS} Assets`);
    }
    if (assetIds.some((id) => !isValidUuid(id))) {
      throw new ValidationError('asset_id must be a valid UUID');
    }
    const ids = assetIds.map(normalizedId).sort();
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError('A Bulk Reassignment names each Asset once');
    }
    return ids;
  }

  // The batch's one set of facts, validated before any lock.
  private normalizeFacts(input: ReassignmentInput, today: string): ReassignmentFacts {
    const facts = normalizeReassignment(input, today);
    if (Object.keys(facts.targets).length === 0) {
      throw new ValidationError('A Bulk Reassignment needs a new value for at least one dimension');
    }
    return facts;
  }

  // Locks the batch and writes its events in the caller's transaction, which decides whether they stay.
  private async apply(
    client: pg.PoolClient,
    actorId: string,
    { assetIds, facts, today, bulkReference, expectedVersions, findConflicts }: BatchWrite
  ): Promise<AppliedBatch> {
    const locked = await lockAssetsInIdentifierOrder(client, assetIds);
    const found = new Map(locked.map((asset) => [asset.id, asset]));

    const missing = assetIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundError(`Asset not found: ${missing.join(', ')}`);
    }
    const stale = expectedVersions ? locked.filter(({ id, assignment_version }) => assignment_version !== expectedVersions.get(id)) : [];
    if (stale.length > 0) {
      throw new StaleBeforeConflictError(
        "An Asset's assignment changed since it was read",
        Object.fromEntries(stale.map(({ id, assignment_version }) => [id, assignment_version])),
        Object.fromEntries(stale.map(({ id }) => [id, expectedVersions!.get(id)!]))
      );
    }
    const withInitial = await assetsWithInitialAssignment(client, assetIds);
    const needingInitial = locked.filter(({ id }) => !withInitial.has(id));
    if (needingInitial.length > 0) {
      throw new InitialAssignmentRequiredError(needingInitial);
    }

    const applied: AppliedBatch = { assets: [], conflicts: [] };
    for (const asset of locked) {
      const conflictsBefore = findConflicts ? await readAssignmentConflicts(client, asset.id) : [];
      const eventId = await recordReassignmentIfItChanges(client, { assetId: asset.id, actorId, facts, today, bulkReference });
      if (eventId !== null && findConflicts) {
        // A Reassignment takes its prior values from the facts before it, so what it contradicts is always a later fact.
        applied.conflicts.push(...newAssignmentConflicts(conflictsBefore, await readAssignmentConflicts(client, asset.id)));
      }
      applied.assets.push({
        asset_id: asset.id,
        version_read: asset.assignment_version,
        event: eventId === null ? null : (await readAssignmentTimeline(client, asset.id)).find(({ id }) => id === eventId)!,
      });
    }
    return applied;
  }

  /**
   * What the batch would do: a trial write under the same rules as `record`, always rolled back. It
   * reports the version it read of each Asset, which ties the confirmation to what the user reviewed.
   */
  async preview(actorId: string, input: BulkReassignmentPreviewInput): Promise<BulkReassignmentPreview> {
    const today = bangkokDate(this.clock());
    const assetIds = this.normalizeAssetIds(input.asset_ids);
    const facts = this.normalizeFacts(input, today);
    const client: pg.PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { assets, conflicts } = await this.apply(client, actorId, {
        assetIds,
        facts,
        today,
        bulkReference: crypto.randomUUID(),
        expectedVersions: null,
        findConflicts: true,
      });
      return {
        changed: assets.flatMap(({ asset_id, version_read, event }) =>
          event
            ? [{ asset_id, assignment_version: version_read, changes: event.changes.map(({ dimension, prior, new: value }) => ({ dimension, prior, new: value })) }]
            : []
        ),
        unchanged: unchangedOf(assets),
        conflicts,
      };
    } finally {
      await rollbackQuietly(client);
      client.release();
    }
  }

  async record(actorId: string, input: BulkReassignmentInput, { retryToken }: { retryToken: string }): Promise<BulkReassignmentResult> {
    const today = bangkokDate(this.clock());
    const assetIds = this.normalizeAssetIds(input.assets.map(({ asset_id }) => asset_id));
    const facts = this.normalizeFacts(input, today);
    const expectedVersions = new Map(input.assets.map(({ asset_id, expected_assignment_version }) => [normalizedId(asset_id), expected_assignment_version]));
    const explicitContinuation = input.explicit_continuation === true;
    return commitOnce(
      this.db,
      {
        actorId,
        operation: 'assignment:bulk-reassign',
        retryToken,
        payload: { version: 1, assets: assetIds.map((id) => [id, expectedVersions.get(id)]), facts },
        explicitContinuation,
      },
      async (client) => {
        const bulkReference = crypto.randomUUID();
        const { assets, conflicts } = await this.apply(client, actorId, {
          assetIds,
          facts,
          today,
          bulkReference,
          expectedVersions,
          findConflicts: !explicitContinuation,
        });
        if (assets.every(({ event }) => event === null)) {
          throw new ValidationError('This Bulk Reassignment changes nothing at its Effective Date: every Asset already holds the new values');
        }
        if (conflicts.length > 0) {
          throw new AssignmentConflictWarningError(conflicts);
        }
        return {
          bulk_reference: bulkReference,
          changed: assets.flatMap(({ asset_id, version_read, event }) => (event ? [{ asset_id, event, assignment_version: version_read + 1 }] : [])),
          unchanged: unchangedOf(assets),
        };
      }
    );
  }
}
