import * as crypto from 'node:crypto';
import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import {
  ASSIGNMENT_FIELDS,
  LEGACY_TEXT_FIELDS,
  REFERENCE_ID_FIELDS,
  assertInitialAssignmentEntries,
  assignmentSearch,
  bangkokDate,
  hasAssignmentConflict,
  normalizeInitialAssignment,
  readAssignmentTimeline,
  readCurrentAssignment,
  recordInitialAssignment,
  type AssignmentEvent,
  type AssignmentInput,
  type CurrentAssignment,
  type InitialAssignmentFacts,
  type InitialAssignmentInput,
} from './assignment.service.ts';
import { containsPattern } from './asset-lookups.ts';
import { loanSearch, type AssetSearchLoanFacts } from './loan.service.ts';
import { canonicalJson } from './canonical-json.ts';
import { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

export { NotFoundError, RetryTokenConflictError, StaleBeforeConflictError, ValidationError, canonicalJson };

export interface AssetRecord {
  id: string;
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
  source_reference: string | null;
  source_notes: string | null;
  registered_by: string;
  recorded_at: string | Date;
  created_at?: string | Date;
  updated_at?: string | Date;
  acquisition_id?: string | null;
}

export interface AssetHistoryRecord {
  id: string;
  asset_id: string;
  action: string;
  actor_id: string;
  actor_username?: string;
  recorded_at: string | Date;
  payload: Record<string, any> | null;
  created_at?: string | Date;
}

export interface RegisterAssetInput extends InitialAssignmentInput {
  name?: string | null;
  asset_number?: string | null;
  serial_number?: string | null;
  category?: string | null;
  source_reference?: string | null;
  source_notes?: string | null;
  is_legacy?: boolean;
  explicit_continuation?: boolean;
  acquisition_id?: string | null;
}

export interface BulkRegisterItemInput {
  item_key: string;
  name?: string | null;
  asset_number?: string | null;
  serial_number?: string | null;
  source_reference?: string | null;
  source_notes?: string | null;
  is_legacy?: boolean;
  category?: null;
}

export interface BulkRegisterAssetInput extends InitialAssignmentInput {
  acquisition_id?: string | null;
  explicit_continuation?: boolean;
  items: BulkRegisterItemInput[];
}

export interface BulkRegisterResultItem {
  item_key: string;
  asset_id: string;
  history_id: string;
  initial_assignment_id: string | null;
}

export interface BulkRegisterAssetResult {
  results: BulkRegisterResultItem[];
  total_registered: number;
  shared_acquisition_id: string | null;
}

// The dimension fields and expected-before values a Feature 002 correction named; refused since #50 Q1.
export type ExpectedAssignmentInput = {
  [K in keyof AssignmentInput as `expected_${K}`]?: string | null;
};

export interface CorrectAssetInput extends AssignmentInput, ExpectedAssignmentInput {
  name?: string | null;
  asset_number?: string | null;
  serial_number?: string | null;
  expected_name: string | null;
  expected_asset_number: string | null;
  expected_serial_number: string | null;
  reason?: string | null;
  explicit_continuation?: boolean;
}

export interface AssetRegistrationResult {
  asset: AssetRecord;
  history: AssetHistoryRecord;
  // F003-T1: the separate fact that records the registration's dimension values, if any.
  initial_assignment: AssignmentEvent | null;
}

export interface AssetCorrectionResult {
  asset: AssetRecord;
  history: AssetHistoryRecord | null;
  noop?: boolean;
}

export interface AssetServiceOptions {
  db: pg.Pool | any;
  // The current time; "today" for an Effective Date is its Asia/Bangkok date.
  clock?: () => Date;
}

export interface DuplicateCandidatesResult {
  candidates: AssetRecord[];
  total_count: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

export class DuplicateCandidateWarningError extends Error {
  statusCode: number;
  code: string;
  candidates: AssetRecord[];
  total_count: number;
  has_more: boolean;
  limit: number;
  offset: number;

  constructor(
    message: string,
    candidates: AssetRecord[],
    totalCount: number = candidates.length,
    hasMore: boolean = false,
    limit: number = 50,
    offset: number = 0
  ) {
    super(message);
    this.name = 'DuplicateCandidateWarningError';
    this.statusCode = 409;
    this.code = 'DUPLICATE_CANDIDATES_FOUND';
    this.candidates = candidates;
    this.total_count = totalCount;
    this.has_more = hasMore;
    this.limit = limit;
    this.offset = offset;
  }
}

export interface BulkDuplicateWarning {
  item_key: string;
  field: 'asset_number' | 'serial_number';
  value: string;
  intra_batch: boolean;
  intra_batch_keys?: string[];
  candidates: AssetRecord[];
  total_count: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

export class BulkDuplicateCandidateWarningError extends Error {
  statusCode: number;
  code: string;
  warnings: BulkDuplicateWarning[];

  constructor(
    message: string = 'Exact nonempty identifier matches existing asset records or intra-batch items. Explicit continuation required to register distinct items.',
    warnings: BulkDuplicateWarning[]
  ) {
    super(message);
    this.name = 'BulkDuplicateCandidateWarningError';
    this.statusCode = 409;
    this.code = 'DUPLICATE_CANDIDATES_FOUND';
    this.warnings = warnings;
  }
}

// T4 (#25): each legacy reference text is searched on its own, keeping the dimensions distinct.
export type SearchAssetField =
  | 'stable_id'
  | 'asset_number'
  | 'serial_number'
  | 'name'
  | (typeof LEGACY_TEXT_FIELDS)[number];

export interface SearchAssetItem extends CurrentAssignment, AssetSearchLoanFacts {
  id: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
}

export interface SearchAssetInput {
  field?: SearchAssetField | string;
  value?: string;
  // T4 (#25): reference filters, each an exact entry id; several combine with AND.
  location_id?: string;
  organization_unit_id?: string;
  responsible_person_id?: string;
  // F003-T4 (#54): only Assets with at least one Assignment Conflict.
  has_assignment_conflict?: boolean;
  // F004-T4 (#78): only Assets On Loan, "กำลังถูกยืม".
  on_loan?: boolean;
  limit?: number | string;
  offset?: number | string;
}

export interface SearchAssetResult {
  items: SearchAssetItem[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

const EXACT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidExactUuid(val: unknown): val is string {
  return typeof val === 'string' && val.length === 36 && EXACT_UUID_REGEX.test(val);
}

/**
 * #50 Q1 (#25 D3 as amended, ADR 0001): the registry correction edits name, Asset Number and
 * Serial Number only. Location, OrganizationUnit and Responsible Person change only through an
 * assignment action, so a correction naming any of them, or its expected-before value, is refused.
 */
function refuseAssignmentFields(input: CorrectAssetInput): void {
  const named = ASSIGNMENT_FIELDS.flatMap((field) => [field, `expected_${field}` as const]).filter(
    (field) => input[field] !== undefined
  );
  if (named.length > 0) {
    throw new ValidationError(
      `The registry correction does not change Location, OrganizationUnit or Responsible Person; record an assignment action instead (${named.join(', ')})`
    );
  }
}

export class AssetService {
  private db: any;
  private clock: () => Date = () => new Date();

  constructor(options: AssetServiceOptions | any) {
    if (options && typeof options === 'object') {
      if ('query' in options) {
        this.db = options;
      } else if ('db' in options && options.db) {
        this.db = options.db;
        if (typeof options.clock === 'function') {
          this.clock = options.clock;
        }
      }
    }
  }

  // Today's Asia/Bangkok date, the latest Effective Date a fact may have.
  private today(): string {
    return bangkokDate(this.clock());
  }

  /**
   * Computes a deterministic SHA-256 fingerprint for the normalized registration payload.
   */
  computePayloadFingerprint(input: RegisterAssetInput): string {
    const normalized: Record<string, any> = {
      name: input.name?.trim() || null,
      asset_number: input.asset_number ?? null,
      serial_number: input.serial_number ?? null,
      category: null,
      organization_unit: null,
      source_reference: input.source_reference?.trim() || null,
      source_notes: input.source_notes?.trim() || null,
      is_legacy: input.is_legacy === true,
    };
    if (input.acquisition_id !== undefined && input.acquisition_id !== null) {
      normalized.acquisition_id = input.acquisition_id;
    }
    // The Initial Assignment joins the fingerprint only when supplied, so receipts without one still
    // replay. It joins as a string: the key list given to JSON.stringify below also filters nested keys.
    const initial = normalizeInitialAssignment(input, this.today());
    if (initial) {
      normalized.initial_assignment = canonicalJson(initial);
    }
    const jsonStr = JSON.stringify(normalized, Object.keys(normalized).sort());
    return crypto.createHash('sha256').update(jsonStr).digest('hex');
  }

  /**
   * Computes a deterministic versioned SHA-256 fingerprint for bulk registration intent and idempotency contract.
   * Scoped to ordered rows/item keys, normalized facts, shared association, and explicit continuation.
   */
  computeBulkPayloadFingerprint(input: BulkRegisterAssetInput): string {
    const normalized = {
      version: 1,
      acquisition_id: input.acquisition_id ?? null,
      explicit_continuation: input.explicit_continuation === true,
      items: (input.items || []).map((item) => ({
        item_key: item.item_key,
        name: item.name?.trim() || null,
        asset_number: item.asset_number ?? null,
        serial_number: item.serial_number ?? null,
        category: null,
        organization_unit: null,
        source_reference: item.source_reference?.trim() || null,
        source_notes: item.source_notes?.trim() || null,
        is_legacy: item.is_legacy === true,
      })),
    };
    // The shared Initial Assignment joins the fingerprint only when supplied, so receipts without one still replay.
    const initial = normalizeInitialAssignment(input, this.today());
    const fingerprinted = initial ? { ...normalized, initial_assignment: initial } : normalized;
    return crypto.createHash('sha256').update(canonicalJson(fingerprinted)).digest('hex');
  }

  /**
   * Computes a deterministic versioned SHA-256 fingerprint for correction intent and idempotency contract.
   * Scoped to target asset, presence-aware requested three-field changes, all three expected-before values,
   * normalized reason, and explicit continuation.
   */
  computeCorrectionFingerprint(assetId: string, input: CorrectAssetInput): string {
    const normalized = {
      version: 1,
      asset_id: assetId,
      changes: {
        asset_number: input.asset_number !== undefined ? (input.asset_number ?? null) : undefined,
        serial_number: input.serial_number !== undefined ? (input.serial_number ?? null) : undefined,
        name: input.name !== undefined ? (input.name !== null && input.name !== '' ? input.name : null) : undefined,
      },
      expected_before: {
        asset_number: input.expected_asset_number ?? null,
        serial_number: input.expected_serial_number ?? null,
        name: input.expected_name ?? null,
      },
      reason: (input.reason || '').trim(),
      explicit_continuation: input.explicit_continuation === true,
    };
    return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
  }

  /**
   * Looks up duplicate candidate records matching nonempty asset_number or serial_number exactly.
   * Returns empty array if both identifiers are absent. (AR-11, D2)
   * Supports optional excludeAssetId for self-excluding correction duplicate checks.
   * Enforces bounded candidate retrieval with deterministic tie-breaker and pagination (TECHNOLOGY.md:135).
   */
  async getDuplicateCandidates(
    assetNumber?: string | null,
    serialNumber?: string | null,
    client?: any,
    limit: number = 50,
    offset: number = 0,
    excludeAssetId?: string | null
  ): Promise<DuplicateCandidatesResult> {
    const an =
      assetNumber !== undefined && assetNumber !== null && assetNumber !== ''
        ? assetNumber
        : null;
    const sn =
      serialNumber !== undefined && serialNumber !== null && serialNumber !== ''
        ? serialNumber
        : null;

    const boundedLimit = Math.min(Math.max(1, limit || 50), 100);
    const boundedOffset = Math.max(0, offset || 0);

    if (!an && !sn) {
      return {
        candidates: [],
        total_count: 0,
        has_more: false,
        limit: boundedLimit,
        offset: boundedOffset,
      };
    }

    const runner = client || this.db;
    const excludeId = isValidUuid(excludeAssetId) ? excludeAssetId.trim() : null;

    const queryText = `
      SELECT id, asset_number, serial_number, name, category,
             source_reference, source_notes, registered_by, recorded_at, created_at, updated_at,
             count(*) OVER()::int AS total_count
      FROM assets
      WHERE (($1::varchar IS NOT NULL AND asset_number = $1)
         OR ($2::varchar IS NOT NULL AND serial_number = $2))
        AND ($5::uuid IS NULL OR id != $5)
      ORDER BY recorded_at DESC, id ASC
      LIMIT $3 OFFSET $4;
    `;

    const res = await runner.query(queryText, [an, sn, boundedLimit, boundedOffset, excludeId]);
    let totalCount = 0;
    if (res?.rows && res.rows.length > 0) {
      totalCount = res.rows[0].total_count ?? 0;
    } else if (boundedOffset > 0) {
      const countRes = await runner.query(
        `SELECT count(*)::int AS count FROM assets
         WHERE (($1::varchar IS NOT NULL AND asset_number = $1)
            OR ($2::varchar IS NOT NULL AND serial_number = $2))
           AND ($3::uuid IS NULL OR id != $3)`,
        [an, sn, excludeId]
      );
      totalCount = countRes?.rows?.[0]?.count ?? 0;
    }

    const candidates: AssetRecord[] = (res?.rows || []).map((row: any) => {
      const { total_count, ...asset } = row;
      return asset as AssetRecord;
    });

    const hasMore = boundedOffset + candidates.length < totalCount;

    return {
      candidates,
      total_count: totalCount,
      has_more: hasMore,
      limit: boundedLimit,
      offset: boundedOffset,
    };
  }

  /**
   * Internal helper: validates factual item inputs according to T1 registration rules.
   * Preserves verbatim nonempty identifiers and truthful name requirement for ordinary items.
   */
  private normalizeAndValidateRegistrationItem(
    item: {
      name?: string | null;
      asset_number?: string | null;
      serial_number?: string | null;
      source_reference?: string | null;
      source_notes?: string | null;
      is_legacy?: boolean;
      category?: string | null;
    },
    itemKeyLabel?: string
  ): {
    name: string | null;
    asset_number: string | null;
    serial_number: string | null;
    source_reference: string | null;
    source_notes: string | null;
    is_legacy: boolean;
  } {
    const label = itemKeyLabel ? ` (${itemKeyLabel})` : '';

    if (item.is_legacy !== undefined && typeof item.is_legacy !== 'boolean') {
      throw new ValidationError(`is_legacy must be a boolean${label}`);
    }
    if (item.category !== undefined && item.category !== null) {
      throw new ValidationError(
        itemKeyLabel ? `category must remain unset for ${itemKeyLabel}` : 'Category must remain unset in T1 (R2)'
      );
    }

    if (item.name !== undefined && item.name !== null && typeof item.name !== 'string') {
      throw new ValidationError(`name must be a string${label}`);
    }
    if (
      item.asset_number !== undefined &&
      item.asset_number !== null &&
      typeof item.asset_number !== 'string'
    ) {
      throw new ValidationError(`asset_number must be a string${label}`);
    }
    if (
      item.serial_number !== undefined &&
      item.serial_number !== null &&
      typeof item.serial_number !== 'string'
    ) {
      throw new ValidationError(`serial_number must be a string${label}`);
    }
    if (
      item.source_reference !== undefined &&
      item.source_reference !== null &&
      typeof item.source_reference !== 'string'
    ) {
      throw new ValidationError(`source_reference must be a string${label}`);
    }
    if (
      item.source_notes !== undefined &&
      item.source_notes !== null &&
      typeof item.source_notes !== 'string'
    ) {
      throw new ValidationError(`source_notes must be a string${label}`);
    }

    const isLegacy = item.is_legacy === true;
    const rawName = item.name?.trim();

    if (!isLegacy) {
      if (!rawName || rawName.length === 0) {
        throw new ValidationError(
          itemKeyLabel
            ? `Truthful item name/description is required for ordinary registration (${itemKeyLabel})`
            : 'Truthful item name/description is required for ordinary registration'
        );
      }
    }

    const name = rawName && rawName.length > 0 ? rawName : null;

    // Preserve supplied identifiers without trimming or normalization (Spec Finding 8, D2 verbatim semantics)
    const assetNumber =
      item.asset_number !== undefined && item.asset_number !== null && item.asset_number !== ''
        ? item.asset_number
        : null;
    const serialNumber =
      item.serial_number !== undefined && item.serial_number !== null && item.serial_number !== ''
        ? item.serial_number
        : null;

    const sourceRef =
      item.source_reference !== undefined &&
      item.source_reference !== null &&
      item.source_reference.trim() !== ''
        ? item.source_reference.trim()
        : null;
    const sourceNotes =
      item.source_notes !== undefined &&
      item.source_notes !== null &&
      item.source_notes.trim() !== ''
        ? item.source_notes.trim()
        : null;

    return {
      name,
      asset_number: assetNumber,
      serial_number: serialNumber,
      source_reference: sourceRef,
      source_notes: sourceNotes,
      is_legacy: isLegacy,
    };
  }

  /**
   * Internal helper: inserts a single asset row and corresponding starting 'REGISTERED' history row
   * within an existing caller-owned database transaction client.
   * Guarantees atomic writes and exact historical payload schema.
   */
  private async insertRegisteredAssetRecord(
    client: pg.PoolClient | pg.Pool,
    actorId: string,
    item: {
      name: string | null;
      asset_number: string | null;
      serial_number: string | null;
      source_reference: string | null;
      source_notes: string | null;
      is_legacy: boolean;
    },
    acquisitionId: string | null,
    {
      assetId = crypto.randomUUID(),
      historyId = crypto.randomUUID(),
      initial = null,
    }: { assetId?: string; historyId?: string; initial?: InitialAssignmentFacts | null } = {}
  ): Promise<{
    assetRow: AssetRecord;
    historyRow: AssetHistoryRecord;
    assetId: string;
    historyId: string;
    initialAssignmentId: string | null;
  }> {
    const insertAssetQuery = `
      INSERT INTO assets (
        id, asset_number, serial_number, name, category,
        source_reference, source_notes,
        registered_by, recorded_at, created_at, updated_at,
        acquisition_id
      ) VALUES (
        $1, $2, $3, $4, NULL,
        $5, $6,
        $7, now(), now(), now(),
        $8
      )
      RETURNING *;
    `;
    const assetRes = await client.query(insertAssetQuery, [
      assetId,
      item.asset_number,
      item.serial_number,
      item.name,
      item.source_reference,
      item.source_notes,
      actorId,
      acquisitionId,
    ]);
    const assetRow: AssetRecord = assetRes.rows[0];

    const historyPayload: Record<string, any> = {
      is_legacy: item.is_legacy,
      name: item.name,
      asset_number: item.asset_number,
      serial_number: item.serial_number,
      source_reference: item.source_reference,
      source_notes: item.source_notes,
    };
    if (acquisitionId) {
      historyPayload.acquisition_id = acquisitionId;
    }

    const insertHistoryQuery = `
      INSERT INTO asset_history (
        id, asset_id, action, actor_id, recorded_at, payload, created_at
      ) VALUES (
        $1, $2, 'REGISTERED', $3, $4, $5, $4
      )
      RETURNING *;
    `;
    const historyRes = await client.query(insertHistoryQuery, [
      historyId,
      assetId,
      actorId,
      assetRow.recorded_at,
      JSON.stringify(historyPayload),
    ]);
    const historyRow: AssetHistoryRecord = historyRes.rows[0];

    // The Initial Assignment is a fact of its own, committed with the registration (docs/04 §2.3, #50 Q17).
    const initialAssignmentId = initial ? await recordInitialAssignment(client, { assetId, actorId, facts: initial }) : null;

    return {
      assetRow,
      historyRow,
      assetId,
      historyId,
      initialAssignmentId,
    };
  }

  /**
   * Registers a single truthful or incomplete-legacy Asset and creates starting history fact in one transaction.
   * Supports retry token idempotency contract (D4) and duplicate warning/explicit continuation (D2).
   */
  async registerAsset(
    actorId: string,
    input: RegisterAssetInput,
    options?: { retryToken?: string }
  ): Promise<AssetRegistrationResult> {
    if (!isValidUuid(actorId)) {
      throw new ValidationError('Valid actorId UUID is required for asset registration');
    }

    if (
      input.explicit_continuation !== undefined &&
      typeof input.explicit_continuation !== 'boolean'
    ) {
      throw new ValidationError('explicit_continuation must be a boolean');
    }

    const normalized = this.normalizeAndValidateRegistrationItem(input);
    const { asset_number: assetNumber, serial_number: serialNumber } = normalized;
    const today = this.today();
    const initial = normalizeInitialAssignment(input, today);

    let acquisitionId: string | null = null;
    if (input.acquisition_id !== undefined && input.acquisition_id !== null) {
      if (typeof input.acquisition_id !== 'string' || !isValidExactUuid(input.acquisition_id)) {
        throw new ValidationError('acquisition_id must be a valid exact UUID string');
      }
      acquisitionId = input.acquisition_id;
    }

    const explicitContinuation = input.explicit_continuation === true;

    const retryToken =
      options?.retryToken !== undefined &&
      options.retryToken !== null &&
      options.retryToken.trim() !== ''
        ? options.retryToken.trim()
        : null;
    const fingerprint = retryToken ? this.computePayloadFingerprint(input) : null;

    // Use a transaction client from the pool to guarantee atomicity
    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN');

      // 1. Check and serialize retry token if supplied (D4, Spec Finding 4)
      if (retryToken && fingerprint) {
        // Acquire transaction-scoped advisory lock to serialize concurrent identical requests
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `asset_retry:${actorId}:${retryToken}`,
        ]);

        const tokenRes = await client.query(
          `SELECT payload_fingerprint, response_status, response_body
           FROM registration_retry_tokens
           WHERE actor_id = $1 AND operation = 'asset:register' AND token = $2`,
          [actorId, retryToken]
        );

        if (tokenRes.rows.length > 0) {
          const existing = tokenRes.rows[0];
          if (existing.payload_fingerprint === fingerprint) {
            await client.query('COMMIT');
            return existing.response_body as AssetRegistrationResult;
          } else {
            await client.query('ROLLBACK');
            throw new RetryTokenConflictError(
              'Retry token reused with different payload is rejected without writes'
            );
          }
        }
      }

      // 2. Duplicate candidate check if explicit continuation is not indicated (D2)
      if (!explicitContinuation && (assetNumber || serialNumber)) {
        const dupResult = await this.getDuplicateCandidates(
          assetNumber,
          serialNumber,
          client
        );
        if (dupResult.candidates.length > 0) {
          await client.query('ROLLBACK');
          throw new DuplicateCandidateWarningError(
            'Exact nonempty identifier matches existing asset records. Explicit continuation required to register a distinct item.',
            dupResult.candidates,
            dupResult.total_count,
            dupResult.has_more,
            dupResult.limit,
            dupResult.offset
          );
        }
      }

      // Check referenced acquisition existence
      if (acquisitionId) {
        const acqCheck = await client.query(
          'SELECT id FROM acquisitions WHERE id = $1',
          [acquisitionId]
        );
        if (acqCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new ValidationError('Referenced acquisition not found');
        }
      }

      if (initial) {
        await assertInitialAssignmentEntries(client, initial, today);
      }

      // 3 & 4. Insert asset record and starting history fact via shared helper
      const assetId = crypto.randomUUID();
      const historyId = crypto.randomUUID();
      const { assetRow, historyRow, initialAssignmentId } = await this.insertRegisteredAssetRecord(
        client,
        actorId,
        normalized,
        acquisitionId,
        { assetId, historyId, initial }
      );

      const result: AssetRegistrationResult = {
        asset: {
          id: assetRow.id,
          asset_number: assetRow.asset_number,
          serial_number: assetRow.serial_number,
          name: assetRow.name,
          category: assetRow.category,
          source_reference: assetRow.source_reference,
          source_notes: assetRow.source_notes,
          registered_by: assetRow.registered_by,
          recorded_at: new Date(assetRow.recorded_at).toISOString(),
          created_at: new Date(assetRow.created_at!).toISOString(),
          updated_at: new Date(assetRow.updated_at!).toISOString(),
          acquisition_id: assetRow.acquisition_id || null,
        },
        history: {
          id: historyRow.id,
          asset_id: historyRow.asset_id,
          action: historyRow.action,
          actor_id: historyRow.actor_id,
          recorded_at: new Date(historyRow.recorded_at).toISOString(),
          payload: historyRow.payload,
          created_at: new Date(historyRow.created_at!).toISOString(),
        },
        initial_assignment: initialAssignmentId
          ? ((await readAssignmentTimeline(client, assetId)).find((event) => event.id === initialAssignmentId) ?? null)
          : null,
      };

      // 5. Store retry token result in same transaction (D4)
      if (retryToken && fingerprint) {
        try {
          await client.query(
            `INSERT INTO registration_retry_tokens (
              token, actor_id, operation, payload_fingerprint, response_status, response_body
            ) VALUES ($1, $2, 'asset:register', $3, 201, $4)`,
            [retryToken, actorId, fingerprint, JSON.stringify(result)]
          );
        } catch (insertErr: any) {
          if (insertErr?.code === '23505') {
            // Concurrent race edge-case: query the committed token
            const existingRes = await client.query(
              `SELECT payload_fingerprint, response_body
               FROM registration_retry_tokens
               WHERE actor_id = $1 AND operation = 'asset:register' AND token = $2`,
              [actorId, retryToken]
            );
            if (
              existingRes.rows.length > 0 &&
              existingRes.rows[0].payload_fingerprint === fingerprint
            ) {
              await client.query('COMMIT');
              return existingRes.rows[0].response_body as AssetRegistrationResult;
            }
          }
          throw insertErr;
        }
      }

      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * Registers 1 to 100 assets from an optional shared acquisition reference in a single atomic transaction.
   * Enforces D4 retry token idempotency contract, duplicate candidate warnings with explicit continuation,
   * truthful ordinary name requirements, legacy exceptions, within-batch unique item_keys, and intra-batch
   * identifier duplicate detection.
   */
  async bulkRegisterAssets(
    actorId: string,
    input: BulkRegisterAssetInput,
    options: { retryToken: string }
  ): Promise<BulkRegisterAssetResult> {
    if (!isValidUuid(actorId)) {
      throw new ValidationError('Valid actorId UUID is required for bulk registration');
    }

    const rawToken = options?.retryToken;
    if (
      typeof rawToken !== 'string' ||
      rawToken.trim() === '' ||
      rawToken.length > 128
    ) {
      throw new ValidationError(
        'Non-empty x-retry-token header is required for bulk registration (max 128 characters)'
      );
    }
    const retryToken = rawToken.trim();

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError('Request body must be an object');
    }

    if (
      input.explicit_continuation !== undefined &&
      typeof input.explicit_continuation !== 'boolean'
    ) {
      throw new ValidationError('explicit_continuation must be a boolean');
    }

    let acquisitionId: string | null = null;
    if (input.acquisition_id !== undefined && input.acquisition_id !== null) {
      if (typeof input.acquisition_id !== 'string' || !isValidExactUuid(input.acquisition_id)) {
        throw new ValidationError('acquisition_id must be a valid exact UUID string');
      }
      acquisitionId = input.acquisition_id;
    }

    if (!Array.isArray(input.items)) {
      throw new ValidationError('items must be an array');
    }

    if (input.items.length < 1 || input.items.length > 100) {
      throw new ValidationError('Bulk registration requires between 1 and 100 items');
    }

    const seenItemKeys = new Set<string>();
    const normalizedItems: Array<{
      item_key: string;
      name: string | null;
      asset_number: string | null;
      serial_number: string | null;
      source_reference: string | null;
      source_notes: string | null;
      is_legacy: boolean;
    }> = [];

    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new ValidationError(`Item at index ${i} must be an object`);
      }

      if (typeof item.item_key !== 'string' || !isValidExactUuid(item.item_key)) {
        throw new ValidationError(`Item at index ${i} must have a valid exact UUID item_key`);
      }

      if (seenItemKeys.has(item.item_key)) {
        throw new ValidationError(`Duplicate item_key in batch: ${item.item_key}`);
      }
      seenItemKeys.add(item.item_key);
      const normalized = this.normalizeAndValidateRegistrationItem(item, `item ${item.item_key}`);
      normalizedItems.push({
        item_key: item.item_key,
        ...normalized,
      });
    }

    const explicitContinuation = input.explicit_continuation === true;
    const today = this.today();
    const initial = normalizeInitialAssignment(input, today, ' (shared Initial Assignment)');
    const fingerprint = this.computeBulkPayloadFingerprint(input);

    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN');

      // 1. Transaction-scoped advisory lock and retry token check
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `asset_bulk_retry:${actorId}:${retryToken}`,
      ]);

      const tokenRes = await client.query(
        `SELECT payload_fingerprint, response_status, response_body
         FROM registration_retry_tokens
         WHERE actor_id = $1 AND operation = 'asset:bulk-register' AND token = $2`,
        [actorId, retryToken]
      );

      if (tokenRes.rows.length > 0) {
        const existing = tokenRes.rows[0];
        if (existing.payload_fingerprint === fingerprint) {
          await client.query('COMMIT');
          return existing.response_body as BulkRegisterAssetResult;
        } else {
          await client.query('ROLLBACK');
          throw new RetryTokenConflictError(
            'Retry token reused with different payload is rejected without writes'
          );
        }
      }

      // 2. Check referenced acquisition existence early
      if (acquisitionId) {
        const acqCheck = await client.query('SELECT id FROM acquisitions WHERE id = $1', [
          acquisitionId,
        ]);
        if (acqCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new ValidationError('Referenced acquisition not found');
        }
      }

      if (initial) {
        await assertInitialAssignmentEntries(client, initial, today, ' (shared Initial Assignment)');
      }

      // 3. Duplicate candidate check if explicit continuation is false
      if (!explicitContinuation) {
        const warnings: BulkDuplicateWarning[] = [];

        // A. Intra-batch duplicate checks
        const anToKeys = new Map<string, string[]>();
        const snToKeys = new Map<string, string[]>();

        for (const item of normalizedItems) {
          if (item.asset_number) {
            const keys = anToKeys.get(item.asset_number) || [];
            keys.push(item.item_key);
            anToKeys.set(item.asset_number, keys);
          }
          if (item.serial_number) {
            const keys = snToKeys.get(item.serial_number) || [];
            keys.push(item.item_key);
            snToKeys.set(item.serial_number, keys);
          }
        }

        // Record intra-batch warnings
        for (const [an, keys] of anToKeys.entries()) {
          if (keys.length > 1) {
            for (const k of keys) {
              warnings.push({
                item_key: k,
                field: 'asset_number',
                value: an,
                intra_batch: true,
                intra_batch_keys: keys.filter((otherKey) => otherKey !== k),
                candidates: [],
                total_count: keys.length - 1,
                has_more: false,
                limit: 50,
                offset: 0,
              });
            }
          }
        }

        for (const [sn, keys] of snToKeys.entries()) {
          if (keys.length > 1) {
            for (const k of keys) {
              warnings.push({
                item_key: k,
                field: 'serial_number',
                value: sn,
                intra_batch: true,
                intra_batch_keys: keys.filter((otherKey) => otherKey !== k),
                candidates: [],
                total_count: keys.length - 1,
                has_more: false,
                limit: 50,
                offset: 0,
              });
            }
          }
        }

        // B. Committed database duplicate checks (cache per distinct identifier)
        const checkedAn = new Map<string, DuplicateCandidatesResult>();
        const checkedSn = new Map<string, DuplicateCandidatesResult>();

        for (const item of normalizedItems) {
          if (item.asset_number) {
            if (!checkedAn.has(item.asset_number)) {
              const dupRes = await this.getDuplicateCandidates(
                item.asset_number,
                null,
                client,
                50,
                0
              );
              checkedAn.set(item.asset_number, dupRes);
            }
            const dupRes = checkedAn.get(item.asset_number)!;
            if (dupRes.candidates.length > 0) {
              warnings.push({
                item_key: item.item_key,
                field: 'asset_number',
                value: item.asset_number,
                intra_batch: false,
                candidates: dupRes.candidates,
                total_count: dupRes.total_count,
                has_more: dupRes.has_more,
                limit: dupRes.limit,
                offset: dupRes.offset,
              });
            }
          }

          if (item.serial_number) {
            if (!checkedSn.has(item.serial_number)) {
              const dupRes = await this.getDuplicateCandidates(
                null,
                item.serial_number,
                client,
                50,
                0
              );
              checkedSn.set(item.serial_number, dupRes);
            }
            const dupRes = checkedSn.get(item.serial_number)!;
            if (dupRes.candidates.length > 0) {
              warnings.push({
                item_key: item.item_key,
                field: 'serial_number',
                value: item.serial_number,
                intra_batch: false,
                candidates: dupRes.candidates,
                total_count: dupRes.total_count,
                has_more: dupRes.has_more,
                limit: dupRes.limit,
                offset: dupRes.offset,
              });
            }
          }
        }

        if (warnings.length > 0) {
          await client.query('ROLLBACK');
          throw new BulkDuplicateCandidateWarningError(
            'Exact nonempty identifier matches existing asset records or intra-batch items. Explicit continuation required to register distinct items.',
            warnings
          );
        }
      }

      // 4. Insert each asset and history row via shared helper
      const results: BulkRegisterResultItem[] = [];

      for (const item of normalizedItems) {
        const { assetId, historyId, initialAssignmentId } = await this.insertRegisteredAssetRecord(
          client,
          actorId,
          item,
          acquisitionId,
          { initial }
        );

        results.push({
          item_key: item.item_key,
          asset_id: assetId,
          history_id: historyId,
          initial_assignment_id: initialAssignmentId,
        });
      }

      const finalResult: BulkRegisterAssetResult = {
        results,
        total_registered: results.length,
        shared_acquisition_id: acquisitionId,
      };

      // 5. Store retry token
      try {
        await client.query(
          `INSERT INTO registration_retry_tokens (
            token, actor_id, operation, payload_fingerprint, response_status, response_body
          ) VALUES ($1, $2, 'asset:bulk-register', $3, 201, $4)`,
          [retryToken, actorId, fingerprint, JSON.stringify(finalResult)]
        );
      } catch (insertErr: any) {
        if (insertErr?.code === '23505') {
          const existingRes = await client.query(
            `SELECT payload_fingerprint, response_body
             FROM registration_retry_tokens
             WHERE actor_id = $1 AND operation = 'asset:bulk-register' AND token = $2`,
            [actorId, retryToken]
          );
          if (
            existingRes.rows.length > 0 &&
            existingRes.rows[0].payload_fingerprint === fingerprint
          ) {
            await client.query('COMMIT');
            return existingRes.rows[0].response_body as BulkRegisterAssetResult;
          }
        }
        throw insertErr;
      }

      await client.query('COMMIT');
      return finalResult;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * Corrects registry identity metadata (asset_number, serial_number, name) and, since T4 (#25),
   * reference context on an existing Asset.
   * Preserves Stable ID, original registration facts/time, provenance links, and audit history (P1–P3).
   * Enforces optimistic locking via expected-before comparison, mandatory non-blank reason,
   * AR-08 label loss rule, truthful ordinary name rule, self-excluding duplicate candidate check,
   * and retry token idempotency contract.
   */
  async correctAsset(
    actorId: string,
    assetId: string,
    input: CorrectAssetInput,
    options?: { retryToken?: string }
  ): Promise<AssetCorrectionResult> {
    if (!isValidUuid(actorId)) {
      throw new ValidationError('Valid actorId UUID is required for asset correction');
    }
    if (!isValidUuid(assetId)) {
      throw new ValidationError('Valid assetId UUID is required for asset correction');
    }

    if (
      input.reason !== undefined &&
      input.reason !== null &&
      typeof input.reason !== 'string'
    ) {
      throw new ValidationError('reason must be a string or null');
    }

    if (
      input.explicit_continuation !== undefined &&
      typeof input.explicit_continuation !== 'boolean'
    ) {
      throw new ValidationError('explicit_continuation must be a boolean');
    }

    if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') {
      throw new ValidationError('name must be a string or null');
    }
    if (
      input.asset_number !== undefined &&
      input.asset_number !== null &&
      typeof input.asset_number !== 'string'
    ) {
      throw new ValidationError('asset_number must be a string or null');
    }
    if (
      input.serial_number !== undefined &&
      input.serial_number !== null &&
      typeof input.serial_number !== 'string'
    ) {
      throw new ValidationError('serial_number must be a string or null');
    }

    if (
      !Object.prototype.hasOwnProperty.call(input, 'expected_name') ||
      (input.expected_name !== null && typeof input.expected_name !== 'string')
    ) {
      throw new ValidationError('expected_name must be an own property with string or null value');
    }
    if (
      !Object.prototype.hasOwnProperty.call(input, 'expected_asset_number') ||
      (input.expected_asset_number !== null && typeof input.expected_asset_number !== 'string')
    ) {
      throw new ValidationError('expected_asset_number must be an own property with string or null value');
    }
    if (
      !Object.prototype.hasOwnProperty.call(input, 'expected_serial_number') ||
      (input.expected_serial_number !== null && typeof input.expected_serial_number !== 'string')
    ) {
      throw new ValidationError('expected_serial_number must be an own property with string or null value');
    }

    const explicitContinuation = input.explicit_continuation === true;
    refuseAssignmentFields(input);

    const rawRetryToken = options?.retryToken;
    if (
      rawRetryToken === undefined ||
      rawRetryToken === null ||
      typeof rawRetryToken !== 'string' ||
      rawRetryToken.trim() === ''
    ) {
      throw new ValidationError('Correction retry token is required and must be a nonblank string');
    }
    const retryToken = rawRetryToken.trim();

    const operation = `asset:correct:${assetId.trim()}`;
    const fingerprint = this.computeCorrectionFingerprint(assetId, input);

    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN');

      // 1. Replay matching committed result before expected-before comparison (PO Clarification)
      if (retryToken && fingerprint) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `asset_retry:${actorId}:${operation}:${retryToken}`,
        ]);

        const tokenRes = await client.query(
          `SELECT payload_fingerprint, response_status, response_body
           FROM registration_retry_tokens
           WHERE actor_id = $1 AND operation = $2 AND token = $3`,
          [actorId, operation, retryToken]
        );

        if (tokenRes.rows.length > 0) {
          const existing = tokenRes.rows[0];
          if (existing.payload_fingerprint === fingerprint) {
            await client.query('COMMIT');
            return existing.response_body as AssetCorrectionResult;
          } else {
            await client.query('ROLLBACK');
            throw new RetryTokenConflictError(
              'Retry token reused with different payload is rejected without writes'
            );
          }
        }
      }

      // 2. Lock Asset row for fresh intent
      const assetLockRes = await client.query(
        `SELECT id, asset_number, serial_number, name, category,
                source_reference, source_notes, registered_by, recorded_at, created_at, updated_at
         FROM assets
         WHERE id = $1
         FOR UPDATE`,
        [assetId.trim()]
      );

      if (assetLockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundError('Asset not found');
      }

      const current = assetLockRes.rows[0];

      // 3. Expected-before comparison
      const expectedName =
        input.expected_name !== undefined && input.expected_name !== null && input.expected_name !== ''
          ? input.expected_name
          : null;
      const expectedAssetNumber =
        input.expected_asset_number !== undefined &&
        input.expected_asset_number !== null &&
        input.expected_asset_number !== ''
          ? input.expected_asset_number
          : null;
      const expectedSerialNumber =
        input.expected_serial_number !== undefined &&
        input.expected_serial_number !== null &&
        input.expected_serial_number !== ''
          ? input.expected_serial_number
          : null;

      const currentDbName = current.name ?? null;
      const currentDbAssetNumber = current.asset_number ?? null;
      const currentDbSerialNumber = current.serial_number ?? null;

      if (
        currentDbName !== expectedName ||
        currentDbAssetNumber !== expectedAssetNumber ||
        currentDbSerialNumber !== expectedSerialNumber
      ) {
        await client.query('ROLLBACK');
        throw new StaleBeforeConflictError(
          'Current asset state differs from expected before values',
          {
            name: currentDbName,
            asset_number: currentDbAssetNumber,
            serial_number: currentDbSerialNumber,
          },
          {
            name: expectedName,
            asset_number: expectedAssetNumber,
            serial_number: expectedSerialNumber,
          }
        );
      }

      // 4. Resolve new values and check No-op
      const newName =
        input.name !== undefined
          ? input.name !== null && input.name.trim() !== ''
            ? input.name
            : null
          : currentDbName;

      const newAssetNumber =
        input.asset_number !== undefined
          ? input.asset_number !== null && input.asset_number !== ''
            ? input.asset_number
            : null
          : currentDbAssetNumber;

      const newSerialNumber =
        input.serial_number !== undefined
          ? input.serial_number !== null && input.serial_number !== ''
            ? input.serial_number
            : null
          : currentDbSerialNumber;

      const nameChanged = newName !== currentDbName;
      const assetNumberChanged = newAssetNumber !== currentDbAssetNumber;
      const serialNumberChanged = newSerialNumber !== currentDbSerialNumber;


      const currentAssetFormatted: AssetRecord = {
        id: current.id,
        asset_number: current.asset_number,
        serial_number: current.serial_number,
        name: current.name,
        category: current.category,
        source_reference: current.source_reference,
        source_notes: current.source_notes,
        registered_by: current.registered_by,
        recorded_at: new Date(current.recorded_at).toISOString(),
        created_at: new Date(current.created_at).toISOString(),
        updated_at: new Date(current.updated_at).toISOString(),
      };

      if (!nameChanged && !assetNumberChanged && !serialNumberChanged) {
        // No-op: no fields changed. Commit without writes to asset_history or tokens.
        await client.query('COMMIT');
        return {
          asset: currentAssetFormatted,
          history: null,
          noop: true,
        };
      }

      // 5. Business rules validation:
      // Mandatory non-blank reason is required when changes occur
      if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
        await client.query('ROLLBACK');
        throw new ValidationError('Mandatory non-blank reason is required for correction');
      }

      // Check legacy status from immutable registration starting fact
      const regFactRes = await client.query(
        `SELECT payload FROM asset_history WHERE asset_id = $1 AND action = 'REGISTERED'`,
        [assetId.trim()]
      );
      const isLegacy = Boolean(
        regFactRes.rows[0]?.payload &&
          typeof regFactRes.rows[0].payload === 'object' &&
          regFactRes.rows[0].payload.is_legacy === true
      );

      // Truthful item name/description required for ordinary asset
      if (!isLegacy && (!newName || newName.length === 0)) {
        await client.query('ROLLBACK');
        throw new ValidationError(
          'Truthful item name/description is required for ordinary assets'
        );
      }

      // 6. Duplicate candidate review with self-exclusion
      if (!explicitContinuation && (assetNumberChanged || serialNumberChanged)) {
        const dupResult = await this.getDuplicateCandidates(
          assetNumberChanged ? newAssetNumber : null,
          serialNumberChanged ? newSerialNumber : null,
          client,
          50,
          0,
          assetId.trim()
        );

        if (dupResult.candidates.length > 0) {
          await client.query('ROLLBACK');
          throw new DuplicateCandidateWarningError(
            'Exact nonempty identifier matches existing asset records. Explicit continuation required to correct to this identifier.',
            dupResult.candidates,
            dupResult.total_count,
            dupResult.has_more,
            dupResult.limit,
            dupResult.offset
          );
        }
      }

      // 7. Update asset record
      const updateAssetQuery = `
        UPDATE assets
        SET asset_number = $1,
            serial_number = $2,
            name = $3,
            updated_at = now()
        WHERE id = $4
        RETURNING *;
      `;
      const updateRes = await client.query(updateAssetQuery, [
        newAssetNumber,
        newSerialNumber,
        newName,
        assetId.trim(),
      ]);
      const updatedRow = updateRes.rows[0];

      // 8. Insert correction history fact
      const changes: Record<string, { before: string | null; after: string | null }> = {};
      if (assetNumberChanged) {
        changes.asset_number = { before: currentDbAssetNumber, after: newAssetNumber };
      }
      if (serialNumberChanged) {
        changes.serial_number = { before: currentDbSerialNumber, after: newSerialNumber };
      }
      if (nameChanged) {
        changes.name = { before: currentDbName, after: newName };
      }

      const historyId = crypto.randomUUID();
      const historyPayload = {
        reason: input.reason.trim(),
        changes,
      };

      const insertHistoryQuery = `
        INSERT INTO asset_history (
          id, asset_id, action, actor_id, recorded_at, payload, created_at
        ) VALUES (
          $1, $2, 'CORRECTED', $3, now(), $4, now()
        )
        RETURNING *;
      `;
      const historyRes = await client.query(insertHistoryQuery, [
        historyId,
        assetId.trim(),
        actorId,
        JSON.stringify(historyPayload),
      ]);
      const historyRow = historyRes.rows[0];

      const result: AssetCorrectionResult = {
        asset: {
          id: updatedRow.id,
          asset_number: updatedRow.asset_number,
          serial_number: updatedRow.serial_number,
          name: updatedRow.name,
          category: updatedRow.category,
          source_reference: updatedRow.source_reference,
          source_notes: updatedRow.source_notes,
          registered_by: updatedRow.registered_by,
          recorded_at: new Date(updatedRow.recorded_at).toISOString(),
          created_at: new Date(updatedRow.created_at).toISOString(),
          updated_at: new Date(updatedRow.updated_at).toISOString(),
        },
        history: {
          id: historyRow.id,
          asset_id: historyRow.asset_id,
          action: historyRow.action,
          actor_id: historyRow.actor_id,
          recorded_at: new Date(historyRow.recorded_at).toISOString(),
          payload: historyPayload,
          created_at: new Date(historyRow.created_at).toISOString(),
        },
        noop: false,
      };

      // 9. Store retry token in registration_retry_tokens table
      if (retryToken && fingerprint) {
        try {
          await client.query(
            `INSERT INTO registration_retry_tokens (
              token, actor_id, operation, payload_fingerprint, response_status, response_body
            ) VALUES ($1, $2, $3, $4, 200, $5)`,
            [retryToken, actorId, operation, fingerprint, JSON.stringify(result)]
          );
        } catch (insertErr: any) {
          if (insertErr?.code === '23505') {
            const existingRes = await client.query(
              `SELECT payload_fingerprint, response_body
               FROM registration_retry_tokens
               WHERE actor_id = $1 AND operation = $2 AND token = $3`,
              [actorId, operation, retryToken]
            );
            if (
              existingRes.rows.length > 0 &&
              existingRes.rows[0].payload_fingerprint === fingerprint
            ) {
              await client.query('COMMIT');
              return existingRes.rows[0].response_body as AssetCorrectionResult;
            }
          }
          throw insertErr;
        }
      }

      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * Retrieves an Asset by Stable ID along with its full timeline history facts.
   * Office-wide visibility (R4) - returns record without user/organization segregation.
   */
  async getAssetById(
    id: string
  ): Promise<{
    asset: AssetRecord;
    history: AssetHistoryRecord[];
    current_assignment: CurrentAssignment;
    assignment_version: number;
    has_assignment_conflict: boolean;
  } | null> {
    if (!isValidUuid(id)) {
      return null;
    }

    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

      const assetRes = await client.query(
        `SELECT a.id, a.asset_number, a.serial_number, a.name, a.category,
                a.source_reference, a.source_notes, a.registered_by, a.recorded_at, a.created_at, a.updated_at,
                a.acquisition_id
         FROM assets a
         WHERE a.id = $1`,
        [id.trim()]
      );

      if (assetRes.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const assignment = await readCurrentAssignment(client, id.trim());
      const hasConflict = await hasAssignmentConflict(client, id.trim());

      const historyRes = await client.query(
        `SELECT h.id, h.asset_id, h.action, h.actor_id, u.username as actor_username,
                h.recorded_at, h.payload, h.created_at
         FROM asset_history h
         LEFT JOIN users u ON h.actor_id = u.id
         WHERE h.asset_id = $1
         ORDER BY h.recorded_at ASC, h.created_at ASC`,
        [id.trim()]
      );

      await client.query('COMMIT');

      return {
        asset: {
          id: assetRes.rows[0].id,
          asset_number: assetRes.rows[0].asset_number,
          serial_number: assetRes.rows[0].serial_number,
          name: assetRes.rows[0].name,
          category: assetRes.rows[0].category,
          source_reference: assetRes.rows[0].source_reference,
          source_notes: assetRes.rows[0].source_notes,
          registered_by: assetRes.rows[0].registered_by,
          recorded_at: new Date(assetRes.rows[0].recorded_at).toISOString(),
          created_at: new Date(assetRes.rows[0].created_at).toISOString(),
          updated_at: new Date(assetRes.rows[0].updated_at).toISOString(),
          acquisition_id: assetRes.rows[0].acquisition_id || null,
        },
        history: historyRes.rows.map((row: any) => ({
          id: row.id,
          asset_id: row.asset_id,
          action: row.action,
          actor_id: row.actor_id,
          actor_username: row.actor_username,
          recorded_at: new Date(row.recorded_at).toISOString(),
          payload: row.payload,
          created_at: new Date(row.created_at).toISOString(),
        })),
        current_assignment: assignment.current,
        assignment_version: assignment.version,
        has_assignment_conflict: hasConflict,
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * An Asset's assignment facts in the order of facts (F003-T1), or null when the Asset does not exist.
   * Office-wide visibility, like the Asset itself.
   */
  async getAssignmentTimeline(id: string): Promise<AssignmentEvent[] | null> {
    if (!isValidUuid(id)) {
      return null;
    }

    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const assetRes = await client.query('SELECT 1 FROM assets WHERE id = $1', [id.trim()]);
      const timeline = assetRes.rows.length > 0 ? await readAssignmentTimeline(client, id.trim()) : null;
      await client.query('COMMIT');
      return timeline;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * Bounded identifier/description search (T3).
   * Supports field-based exact matching for stable_id, asset_number, serial_number,
   * case-insensitive literal substring for name, or empty browse when no criteria given.
   * T4 (#25): legacy_text matches any of the three legacy texts the same way, and each
   * reference filter narrows the result independently (AND).
   */
  async searchAssets(input: SearchAssetInput = {}): Promise<SearchAssetResult> {
    const { field, value, limit = 25, offset = 0 } = input;

    // Validate selector presence
    if (field !== undefined && value === undefined) {
      throw new ValidationError('Search value is required when field is specified');
    }
    if (value !== undefined && field === undefined) {
      throw new ValidationError('Search field is required when value is specified');
    }

    if (field !== undefined) {
      const allowedFields = ['stable_id', 'asset_number', 'serial_number', 'name', ...LEGACY_TEXT_FIELDS];
      if (!allowedFields.includes(field)) {
        throw new ValidationError(`Invalid search field: ${field}. Must be one of: ${allowedFields.join(', ')}`);
      }
    }

    if (value !== undefined) {
      if (typeof value !== 'string') {
        throw new ValidationError('Search value must be a string');
      }
      if (value.includes('\0')) {
        throw new ValidationError('Search value must not contain NUL bytes');
      }
      if (Buffer.byteLength(value, 'utf8') > 4096) {
        throw new ValidationError('Search value exceeds maximum length of 4096 bytes');
      }
    }

    // Validate limit
    let parsedLimit = 25;
    if (limit !== undefined) {
      if (typeof limit === 'string') {
        if (!/^[1-9]\d*$/.test(limit)) {
          throw new ValidationError('Limit must be a canonical positive integer');
        }
        parsedLimit = Number(limit);
      } else if (typeof limit === 'number') {
        if (!Number.isInteger(limit)) {
          throw new ValidationError('Limit must be an integer');
        }
        parsedLimit = limit;
      } else {
        throw new ValidationError('Invalid limit type');
      }
      if (parsedLimit < 1 || parsedLimit > 100) {
        throw new ValidationError('Limit must be between 1 and 100');
      }
    }

    // Validate offset
    let parsedOffset = 0;
    if (offset !== undefined) {
      if (typeof offset === 'string') {
        if (!/^(0|[1-9]\d*)$/.test(offset)) {
          throw new ValidationError('Offset must be a canonical non-negative integer');
        }
        parsedOffset = Number(offset);
      } else if (typeof offset === 'number') {
        if (!Number.isInteger(offset)) {
          throw new ValidationError('Offset must be an integer');
        }
        parsedOffset = offset;
      } else {
        throw new ValidationError('Invalid offset type');
      }
      if (parsedOffset < 0 || parsedOffset > 2147483647) {
        throw new ValidationError('Offset must be between 0 and 2147483647');
      }
    }

    // Determine filter conditions and parameters
    const conditions: string[] = [];
    const params: any[] = [];

    const isBrowse = field === undefined || value === undefined || value === '';

    if (!isBrowse && field && value !== undefined) {
      if (field === 'stable_id') {
        if (!isValidExactUuid(value)) {
          throw new ValidationError('Search value for stable_id must be a valid UUID');
        }
        params.push(value);
        conditions.push(`a.id = $${params.length}`);
      } else if (field === 'asset_number') {
        params.push(value);
        conditions.push(`a.asset_number = $${params.length}`);
      } else if (field === 'serial_number') {
        params.push(value);
        conditions.push(`a.serial_number = $${params.length}`);
      } else if (field === 'name' || (LEGACY_TEXT_FIELDS as readonly string[]).includes(field)) {
        if (value.trim() === '') {
          throw new ValidationError(`Search value for ${field} must not be whitespace-only`);
        }
        params.push(containsPattern(value));
        conditions.push(
          field === 'name'
            ? `a.name ILIKE $${params.length} ESCAPE '\\'`
            : assignmentSearch.legacyTextFilter(field as (typeof LEGACY_TEXT_FIELDS)[number], `$${params.length}`)
        );
      }
    }

    for (const filter of REFERENCE_ID_FIELDS) {
      const id = input[filter];
      if (id === undefined) {
        continue;
      }
      if (!isValidExactUuid(id)) {
        throw new ValidationError(`${filter} must be a valid UUID`);
      }
      params.push(id.toLowerCase());
      conditions.push(assignmentSearch.entryFilter(filter, `$${params.length}`));
    }
    if (input.has_assignment_conflict) {
      conditions.push(assignmentSearch.conflictFilter);
    }
    if (input.on_loan) {
      conditions.push(loanSearch.onLoanFilter);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitParamIndex = params.length + 1;
    params.push(parsedLimit);
    const offsetParamIndex = params.length + 1;
    params.push(parsedOffset);

    const query = `
      WITH filtered AS (
        SELECT a.id, a.name, a.asset_number, a.serial_number, a.recorded_at
        FROM assets a
        ${whereClause}
      ),
      counted AS (
        SELECT COUNT(*)::bigint AS total_count FROM filtered
      ),
      paged AS (
        SELECT f.*, ${assignmentSearch.columns}
        FROM filtered f
        ${assignmentSearch.joins('f')}
        ORDER BY f.recorded_at DESC, f.id ASC
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      )
      SELECT r.*, c.total_count
      FROM counted c
      LEFT JOIN paged r ON true
      ORDER BY r.recorded_at DESC, r.id ASC
    `;

    const res = await this.db.query(query, params);

    const totalCount = res.rows.length > 0 && res.rows[0].total_count != null ? Number(res.rows[0].total_count) : 0;
    const rows = res.rows.filter((row: any) => row.id != null);
    const loanFactsOf = await loanSearch.factsOf(this.db, rows.map((row: any) => row.id), this.today());
    const items: SearchAssetItem[] = rows.map((row: any) => ({
      id: row.id,
      name: row.name ?? null,
      asset_number: row.asset_number ?? null,
      serial_number: row.serial_number ?? null,
      ...assignmentSearch.current(row),
      ...loanFactsOf(row.id),
    }));

    const hasMore = parsedOffset + items.length < totalCount;

    return {
      items,
      limit: parsedLimit,
      offset: parsedOffset,
      total_count: totalCount,
      has_more: hasMore,
    };
  }
}
