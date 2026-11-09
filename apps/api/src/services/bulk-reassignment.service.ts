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
import { commitOnce } from './assignment-write.ts';
import { ValidationError } from './validation-error.ts';

// #50 Q4: as many as a bulk registration (Feature 002 D4).
const MAX_ASSETS = 100;

// Each Asset of a batch, with the assignment version it was selected at.
export interface BulkReassignmentAsset {
  asset_id: string;
  expected_assignment_version: number;
}

export interface BulkReassignmentInput extends ReassignmentInput {
  assets: BulkReassignmentAsset[];
  explicit_continuation?: boolean;
}

// What a batch does to its Assets: an event for each one that changes, and no event for the others (MR-01).
interface BulkReassignmentEffect {
  changed: { asset_id: string; event: AssignmentEvent; assignment_version: number }[];
  unchanged: { asset_id: string; assignment_version: number }[];
}

export interface BulkReassignmentResult extends BulkReassignmentEffect {
  bulk_reference: string;
}

// What a batch would do, before anything is saved.
export interface BulkReassignmentPreview {
  changed: { asset_id: string; changes: Pick<AssignmentChange, 'dimension' | 'prior' | 'new'>[] }[];
  unchanged: { asset_id: string }[];
  conflicts: AssignmentConflict[];
}

// The effect of a batch, and the new Assignment Conflicts it found.
interface AppliedBatch extends BulkReassignmentEffect {
  conflicts: AssignmentConflict[];
}

// A request once validated: its Assets in identifier order, and its one set of facts.
interface PreparedBatch {
  assets: BulkReassignmentAsset[];
  facts: ReassignmentFacts;
}

// Whether a batch writes under a confirmation, and so need not look for the conflicts it would create.
type ConflictCheck = 'FIND_CONFLICTS' | 'CONFIRMED';

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

  // Validates the request before any lock.
  private prepare(input: BulkReassignmentInput, today: string): PreparedBatch {
    if (input.assets.length < 1 || input.assets.length > MAX_ASSETS) {
      throw new ValidationError(`A Bulk Reassignment names 1 to ${MAX_ASSETS} Assets`);
    }
    if (input.assets.some(({ asset_id }) => !isValidUuid(asset_id))) {
      throw new ValidationError('asset_id must be a valid UUID');
    }
    const assets = input.assets
      .map(({ asset_id, expected_assignment_version }) => ({ asset_id: asset_id.trim().toLowerCase(), expected_assignment_version }))
      .sort((a, b) => (a.asset_id < b.asset_id ? -1 : 1));
    if (new Set(assets.map(({ asset_id }) => asset_id)).size !== assets.length) {
      throw new ValidationError('A Bulk Reassignment names each Asset once');
    }
    const facts = normalizeReassignment(input, today);
    if (Object.keys(facts.targets).length === 0) {
      throw new ValidationError('A Bulk Reassignment needs a new value for at least one dimension');
    }
    return { assets, facts };
  }

  // Locks the batch and writes its events in the caller's transaction, which decides whether they stay.
  private async apply(
    client: pg.PoolClient,
    actorId: string,
    { assets, facts }: PreparedBatch,
    today: string,
    bulkReference: string,
    conflictCheck: ConflictCheck
  ): Promise<AppliedBatch> {
    const assetIds = assets.map(({ asset_id }) => asset_id);
    const locked = await lockAssetsInIdentifierOrder(client, assetIds);
    const found = new Map(locked.map((asset) => [asset.id, asset]));

    const missing = assetIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundError(`Asset not found: ${missing.join(', ')}`);
    }
    const stale = assets.filter(({ asset_id, expected_assignment_version }) => found.get(asset_id)!.assignment_version !== expected_assignment_version);
    if (stale.length > 0) {
      throw new StaleBeforeConflictError(
        "An Asset's assignment changed since it was read",
        Object.fromEntries(stale.map(({ asset_id }) => [asset_id, found.get(asset_id)!.assignment_version])),
        Object.fromEntries(stale.map(({ asset_id, expected_assignment_version }) => [asset_id, expected_assignment_version]))
      );
    }
    const withInitial = await assetsWithInitialAssignment(client, assetIds);
    const needingInitial = locked.filter(({ id }) => !withInitial.has(id));
    if (needingInitial.length > 0) {
      throw new InitialAssignmentRequiredError(needingInitial);
    }

    const effect: AppliedBatch = { changed: [], unchanged: [], conflicts: [] };
    for (const asset of locked) {
      const conflictsBefore = conflictCheck === 'FIND_CONFLICTS' ? await readAssignmentConflicts(client, asset.id) : [];
      const eventId = await recordReassignmentIfItChanges(client, { assetId: asset.id, actorId, facts, today, bulkReference });
      if (eventId === null) {
        effect.unchanged.push({ asset_id: asset.id, assignment_version: asset.assignment_version });
        continue;
      }
      if (conflictCheck === 'FIND_CONFLICTS') {
        // A Reassignment takes its prior values from the facts before it, so what it contradicts is always a later fact.
        effect.conflicts.push(...newAssignmentConflicts(conflictsBefore, await readAssignmentConflicts(client, asset.id)));
      }
      const timeline = await readAssignmentTimeline(client, asset.id);
      effect.changed.push({
        asset_id: asset.id,
        event: timeline.find(({ id }) => id === eventId)!,
        assignment_version: asset.assignment_version + 1,
      });
    }
    return effect;
  }

  /** What the batch would do: a trial write under the same rules as `record`, always rolled back. */
  async preview(actorId: string, input: BulkReassignmentInput): Promise<BulkReassignmentPreview> {
    const today = bangkokDate(this.clock());
    const batch = this.prepare(input, today);
    const client: pg.PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { changed, unchanged, conflicts } = await this.apply(client, actorId, batch, today, crypto.randomUUID(), 'FIND_CONFLICTS');
      return {
        changed: changed.map(({ asset_id, event }) => ({
          asset_id,
          changes: event.changes.map(({ dimension, prior, new: value }) => ({ dimension, prior, new: value })),
        })),
        unchanged: unchanged.map(({ asset_id }) => ({ asset_id })),
        conflicts,
      };
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      client.release();
    }
  }

  async record(actorId: string, input: BulkReassignmentInput, { retryToken }: { retryToken: string }): Promise<BulkReassignmentResult> {
    const today = bangkokDate(this.clock());
    const batch = this.prepare(input, today);
    const explicitContinuation = input.explicit_continuation === true;
    return commitOnce(
      this.db,
      { actorId, operation: 'assignment:bulk-reassign', retryToken, payload: { version: 1, ...batch }, explicitContinuation },
      async (client) => {
        const bulkReference = crypto.randomUUID();
        const { conflicts, ...effect } = await this.apply(client, actorId, batch, today, bulkReference, explicitContinuation ? 'CONFIRMED' : 'FIND_CONFLICTS');
        if (effect.changed.length === 0) {
          throw new ValidationError('This Bulk Reassignment changes nothing at its Effective Date: every Asset already holds the new values');
        }
        if (conflicts.length > 0) {
          throw new AssignmentConflictWarningError(conflicts);
        }
        return { bulk_reference: bulkReference, ...effect };
      }
    );
  }
}
