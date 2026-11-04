import * as crypto from 'node:crypto';
import pg from 'pg';
import { isValidUuid } from './capability.service.ts';

export interface AssetRecord {
  id: string;
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
  location_id?: string | null;
  organization_unit_id?: string | null;
  responsible_person_id?: string | null;
  legacy_location_text?: string | null;
  legacy_organization_unit_text?: string | null;
  legacy_responsible_person_text?: string | null;
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

/**
 * T4 (#25, D7-A): optional reference context. Each id names an active entry of its list; each
 * legacy text keeps what an old record said when it matches no entry (AR-06, AR-10).
 */
export interface ReferenceContextInput {
  location_id?: string | null;
  organization_unit_id?: string | null;
  responsible_person_id?: string | null;
  legacy_location_text?: string | null;
  legacy_organization_unit_text?: string | null;
  legacy_responsible_person_text?: string | null;
}

export type NormalizedReferenceContext = { [K in keyof ReferenceContextInput]-?: string | null };

export interface ReferenceEntrySummary {
  id: string;
  name: string;
  is_active: boolean;
}

export interface AssetReferenceContext {
  location: ReferenceEntrySummary | null;
  organization_unit: ReferenceEntrySummary | null;
  responsible_person: ReferenceEntrySummary | null;
  legacy_location_text: string | null;
  legacy_organization_unit_text: string | null;
  legacy_responsible_person_text: string | null;
}

export const REFERENCE_ID_FIELDS = [
  ['location_id', 'locations'],
  ['organization_unit_id', 'organization_units'],
  ['responsible_person_id', 'persons'],
] as const;

export const LEGACY_TEXT_FIELDS = [
  'legacy_location_text',
  'legacy_organization_unit_text',
  'legacy_responsible_person_text',
] as const;

export const LEGACY_TEXT_MAX_LENGTH = 500;

type ReferenceContextField = keyof ReferenceContextInput;

const REFERENCE_CONTEXT_FIELDS: readonly ReferenceContextField[] = [
  ...REFERENCE_ID_FIELDS.map(([field]) => field),
  ...LEGACY_TEXT_FIELDS,
];

const expectedKey = (field: ReferenceContextField) => `expected_${field}` as keyof ExpectedReferenceContextInput;
// Line breaks and tabs are allowed in legacy text; other control characters are not. This is the
// rule of evidence.service's hasDisallowedControlChars, which is not imported because
// evidence.service imports this module.
function hasForbiddenLegacyTextCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface RegisterAssetInput extends ReferenceContextInput {
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

export interface BulkRegisterAssetInput extends ReferenceContextInput {
  acquisition_id?: string | null;
  explicit_continuation?: boolean;
  items: BulkRegisterItemInput[];
}

export interface BulkRegisterResultItem {
  item_key: string;
  asset_id: string;
  history_id: string;
}

export interface BulkRegisterAssetResult {
  results: BulkRegisterResultItem[];
  total_registered: number;
  shared_acquisition_id: string | null;
}

// T4 (#25): the expected-before value of each reference field a correction names.
export type ExpectedReferenceContextInput = {
  [K in keyof ReferenceContextInput as `expected_${K}`]?: string | null;
};

export interface CorrectAssetInput extends ReferenceContextInput, ExpectedReferenceContextInput {
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
}

export interface AssetCorrectionResult {
  asset: AssetRecord;
  history: AssetHistoryRecord | null;
  noop?: boolean;
}

export interface AssetServiceOptions {
  db: pg.Pool | any;
}

export class ValidationError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_FAILED';
  }
}

export class NotFoundError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string = 'Asset not found') {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
    this.code = 'NOT_FOUND';
  }
}

export class StaleBeforeConflictError extends Error {
  statusCode: number;
  code: string;
  current_values?: Record<string, string | null>;
  expected_values?: Record<string, string | null>;

  constructor(
    message: string = 'Current asset state differs from expected before values',
    currentValues?: Record<string, string | null>,
    expectedValues?: Record<string, string | null>
  ) {
    super(message);
    this.name = 'StaleBeforeConflictError';
    this.statusCode = 409;
    this.code = 'STALE_BEFORE_CONFLICT';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
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

export class RetryTokenConflictError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string = 'Retry token payload mismatch') {
    super(message);
    this.name = 'RetryTokenConflictError';
    this.statusCode = 409;
    this.code = 'RETRY_TOKEN_PAYLOAD_MISMATCH';
  }
}

/**
 * Deterministically serializes values with recursively sorted keys.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

export type SearchAssetField = 'stable_id' | 'asset_number' | 'serial_number' | 'name' | 'legacy_text';

export interface SearchAssetItem {
  id: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
  location: ReferenceEntrySummary | null;
  organization_unit: ReferenceEntrySummary | null;
  responsible_person: ReferenceEntrySummary | null;
}

export interface SearchAssetInput {
  field?: SearchAssetField | string;
  value?: string;
  // T4 (#25): reference filters, each an exact entry id; several combine with AND.
  location_id?: string;
  organization_unit_id?: string;
  responsible_person_id?: string;
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
 * T4 (#25): validates and normalizes optional reference context. Ids must be UUIDs; legacy text is
 * trimmed, blank becomes null, and it is kept as recorded otherwise.
 */
export function normalizeReferenceContext(
  input: ReferenceContextInput,
  label: string = ''
): NormalizedReferenceContext {
  const context = {} as NormalizedReferenceContext;
  for (const [field] of REFERENCE_ID_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      context[field] = null;
    } else if (!isValidUuid(value)) {
      throw new ValidationError(`${field} must be a valid UUID${label}`);
    } else {
      context[field] = value.trim().toLowerCase();
    }
  }
  for (const field of LEGACY_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      context[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new ValidationError(`${field} must be a string or null${label}`);
    }
    const text = value.trim();
    if (text.length > LEGACY_TEXT_MAX_LENGTH) {
      throw new ValidationError(`${field} must be at most ${LEGACY_TEXT_MAX_LENGTH} characters${label}`);
    }
    if (hasForbiddenLegacyTextCharacters(text)) {
      throw new ValidationError(`${field} must not contain control characters${label}`);
    }
    context[field] = text.length > 0 ? text : null;
  }
  return context;
}

const hasReferenceContext = (context: NormalizedReferenceContext): boolean =>
  Object.values(context).some((value) => value !== null);

// The reference-context columns of an `assets` row, as AssetRecord fields.
const referenceColumns = (row: any): NormalizedReferenceContext => ({
  location_id: row.location_id ?? null,
  organization_unit_id: row.organization_unit_id ?? null,
  responsible_person_id: row.responsible_person_id ?? null,
  legacy_location_text: row.legacy_location_text ?? null,
  legacy_organization_unit_text: row.legacy_organization_unit_text ?? null,
  legacy_responsible_person_text: row.legacy_responsible_person_text ?? null,
});

/**
 * T4 (#25): the reference fields a correction names, normalized like registration. Each corrected
 * field needs its expected-before value; an expected value given alone is still checked.
 */
function normalizeReferenceCorrection(input: CorrectAssetInput): {
  changes: Partial<NormalizedReferenceContext>;
  expected: Partial<NormalizedReferenceContext>;
} {
  for (const field of REFERENCE_CONTEXT_FIELDS) {
    if (input[field] !== undefined && input[expectedKey(field)] === undefined) {
      throw new ValidationError(`${expectedKey(field)} is required when ${field} is corrected`);
    }
  }
  const named = (source: ReferenceContextInput, context: NormalizedReferenceContext) =>
    Object.fromEntries(
      REFERENCE_CONTEXT_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, context[field]])
    ) as Partial<NormalizedReferenceContext>;
  const expectedInput = Object.fromEntries(
    REFERENCE_CONTEXT_FIELDS.map((field) => [field, input[expectedKey(field)]])
  ) as ReferenceContextInput;
  return {
    changes: named(input, normalizeReferenceContext(input)),
    expected: named(expectedInput, normalizeReferenceContext(expectedInput, ' (expected before value)')),
  };
}

const ASSET_REFERENCE_SELECT = `location_id, organization_unit_id, responsible_person_id,
             legacy_location_text, legacy_organization_unit_text, legacy_responsible_person_text`;

// The list entries an `assets` row aliased `a` names, for display in detail and search.
const REFERENCE_ENTRY_SELECT = `l.name AS location_name, l.is_active AS location_active,
                o.name AS organization_unit_name, o.is_active AS organization_unit_active,
                p.name AS responsible_person_name, p.is_active AS responsible_person_active`;
const REFERENCE_ENTRY_JOINS = `LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN organization_units o ON o.id = a.organization_unit_id
         LEFT JOIN persons p ON p.id = a.responsible_person_id`;

const referenceEntries = (row: any): Pick<AssetReferenceContext, 'location' | 'organization_unit' | 'responsible_person'> => {
  const entry = (prefix: string): ReferenceEntrySummary | null =>
    row[`${prefix}_id`] ? { id: row[`${prefix}_id`], name: row[`${prefix}_name`], is_active: row[`${prefix}_active`] } : null;
  return {
    location: entry('location'),
    organization_unit: entry('organization_unit'),
    responsible_person: entry('responsible_person'),
  };
};

// A case-insensitive literal substring pattern for ILIKE ... ESCAPE '\'.
const containsPattern = (value: string): string =>
  `%${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

export class AssetService {
  private db: any;

  constructor(options: AssetServiceOptions | any) {
    if (options && typeof options === 'object') {
      if ('query' in options) {
        this.db = options;
      } else if ('db' in options && options.db) {
        this.db = options.db;
      }
    }
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
    // T4 context joins the fingerprint only when supplied, so pre-T4 receipts still replay.
    const context = normalizeReferenceContext(input);
    if (hasReferenceContext(context)) {
      normalized.reference_context = canonicalJson(context);
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
    // T4 shared context joins the fingerprint only when supplied, so pre-T4 receipts still replay.
    const context = normalizeReferenceContext(input);
    const fingerprinted = hasReferenceContext(context) ? { ...normalized, reference_context: context } : normalized;
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
      // T4 (#25): present only when the correction names reference context, so earlier receipts still match.
      reference_context: REFERENCE_CONTEXT_FIELDS.some(
        (field) => input[field] !== undefined || input[expectedKey(field)] !== undefined
      )
        ? {
            changes: Object.fromEntries(REFERENCE_CONTEXT_FIELDS.map((field) => [field, input[field]])),
            expected_before: Object.fromEntries(REFERENCE_CONTEXT_FIELDS.map((field) => [field, input[expectedKey(field)]])),
          }
        : undefined,
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
      SELECT id, asset_number, serial_number, name, category, ${ASSET_REFERENCE_SELECT},
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
   * T4: every reference id must name an entry that is active now. FOR SHARE holds the entries
   * until commit, so a concurrent deactivation waits for this write.
   */
  private async assertActiveReferences(
    client: pg.PoolClient | pg.Pool,
    context: Partial<NormalizedReferenceContext>,
    label: string = ''
  ): Promise<void> {
    for (const [field, table] of REFERENCE_ID_FIELDS) {
      const id = context[field];
      if (!id) continue;
      const res = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND is_active FOR SHARE`, [id]);
      if (res.rows.length === 0) {
        throw new ValidationError(`${field} must name an active entry${label}`);
      }
    }
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
    assetId: string = crypto.randomUUID(),
    historyId: string = crypto.randomUUID(),
    referenceContext: NormalizedReferenceContext = normalizeReferenceContext({})
  ): Promise<{
    assetRow: AssetRecord;
    historyRow: AssetHistoryRecord;
    assetId: string;
    historyId: string;
  }> {
    const insertAssetQuery = `
      INSERT INTO assets (
        id, asset_number, serial_number, name, category,
        source_reference, source_notes,
        registered_by, recorded_at, created_at, updated_at,
        acquisition_id,
        location_id, organization_unit_id, responsible_person_id,
        legacy_location_text, legacy_organization_unit_text, legacy_responsible_person_text
      ) VALUES (
        $1, $2, $3, $4, NULL,
        $5, $6,
        $7, now(), now(), now(),
        $8,
        $9, $10, $11,
        $12, $13, $14
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
      referenceContext.location_id,
      referenceContext.organization_unit_id,
      referenceContext.responsible_person_id,
      referenceContext.legacy_location_text,
      referenceContext.legacy_organization_unit_text,
      referenceContext.legacy_responsible_person_text,
    ]);
    const assetRow: AssetRecord = assetRes.rows[0];

    const historyPayload: Record<string, any> = {
      is_legacy: item.is_legacy,
      name: item.name,
      asset_number: item.asset_number,
      serial_number: item.serial_number,
      source_reference: item.source_reference,
      source_notes: item.source_notes,
      ...(hasReferenceContext(referenceContext) ? referenceContext : {}),
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

    return {
      assetRow,
      historyRow,
      assetId,
      historyId,
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
    const {
      name,
      asset_number: assetNumber,
      serial_number: serialNumber,
      is_legacy: isLegacy,
      source_reference: sourceRef,
      source_notes: sourceNotes,
    } = normalized;
    const referenceContext = normalizeReferenceContext(input);

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

      await this.assertActiveReferences(client, referenceContext);

      // 3 & 4. Insert asset record and starting history fact via shared helper
      const assetId = crypto.randomUUID();
      const historyId = crypto.randomUUID();
      const { assetRow, historyRow } = await this.insertRegisteredAssetRecord(
        client,
        actorId,
        normalized,
        acquisitionId,
        assetId,
        historyId,
        referenceContext
      );

      const historyPayload: Record<string, any> = {
        is_legacy: isLegacy,
        name,
        asset_number: assetNumber,
        serial_number: serialNumber,
        source_reference: sourceRef,
        source_notes: sourceNotes,
        ...(hasReferenceContext(referenceContext) ? referenceContext : {}),
      };
      if (acquisitionId) {
        historyPayload.acquisition_id = acquisitionId;
      }

      const result: AssetRegistrationResult = {
        asset: {
          id: assetRow.id,
          asset_number: assetRow.asset_number,
          serial_number: assetRow.serial_number,
          name: assetRow.name,
          category: assetRow.category,
          ...referenceColumns(assetRow),
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
          payload: historyPayload,
          created_at: new Date(historyRow.created_at!).toISOString(),
        },
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
    const referenceContext = normalizeReferenceContext(input, ' (shared reference context)');
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

      await this.assertActiveReferences(client, referenceContext, ' (shared reference context)');

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
        const { assetId, historyId } = await this.insertRegisteredAssetRecord(
          client,
          actorId,
          item,
          acquisitionId,
          undefined,
          undefined,
          referenceContext
        );

        results.push({
          item_key: item.item_key,
          asset_id: assetId,
          history_id: historyId,
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
    const referenceCorrection = normalizeReferenceCorrection(input);

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
        `SELECT id, asset_number, serial_number, name, category, ${ASSET_REFERENCE_SELECT},
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
      const currentReference = referenceColumns(current);
      const expectedReferenceFields = Object.keys(referenceCorrection.expected) as ReferenceContextField[];

      if (
        currentDbName !== expectedName ||
        currentDbAssetNumber !== expectedAssetNumber ||
        currentDbSerialNumber !== expectedSerialNumber ||
        expectedReferenceFields.some((field) => currentReference[field] !== referenceCorrection.expected[field])
      ) {
        await client.query('ROLLBACK');
        throw new StaleBeforeConflictError(
          'Current asset state differs from expected before values',
          {
            name: currentDbName,
            asset_number: currentDbAssetNumber,
            serial_number: currentDbSerialNumber,
            ...Object.fromEntries(expectedReferenceFields.map((field) => [field, currentReference[field]])),
          },
          {
            name: expectedName,
            asset_number: expectedAssetNumber,
            serial_number: expectedSerialNumber,
            ...referenceCorrection.expected,
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

      const newReference: NormalizedReferenceContext = { ...currentReference, ...referenceCorrection.changes };
      const changedReferenceFields = REFERENCE_CONTEXT_FIELDS.filter(
        (field) => newReference[field] !== currentReference[field]
      );

      const currentAssetFormatted: AssetRecord = {
        id: current.id,
        asset_number: current.asset_number,
        serial_number: current.serial_number,
        name: current.name,
        category: current.category,
        ...referenceColumns(current),
        source_reference: current.source_reference,
        source_notes: current.source_notes,
        registered_by: current.registered_by,
        recorded_at: new Date(current.recorded_at).toISOString(),
        created_at: new Date(current.created_at).toISOString(),
        updated_at: new Date(current.updated_at).toISOString(),
      };

      if (!nameChanged && !assetNumberChanged && !serialNumberChanged && changedReferenceFields.length === 0) {
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

      // A newly named entry must be active; an entry the Asset already names may stay after deactivation.
      await this.assertActiveReferences(
        client,
        Object.fromEntries(changedReferenceFields.map((field) => [field, newReference[field]]))
      );

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
            location_id = $5,
            organization_unit_id = $6,
            responsible_person_id = $7,
            legacy_location_text = $8,
            legacy_organization_unit_text = $9,
            legacy_responsible_person_text = $10,
            updated_at = now()
        WHERE id = $4
        RETURNING *;
      `;
      const updateRes = await client.query(updateAssetQuery, [
        newAssetNumber,
        newSerialNumber,
        newName,
        assetId.trim(),
        newReference.location_id,
        newReference.organization_unit_id,
        newReference.responsible_person_id,
        newReference.legacy_location_text,
        newReference.legacy_organization_unit_text,
        newReference.legacy_responsible_person_text,
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
      for (const field of changedReferenceFields) {
        changes[field] = { before: currentReference[field], after: newReference[field] };
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
          ...referenceColumns(updatedRow),
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
  ): Promise<{ asset: AssetRecord; history: AssetHistoryRecord[]; reference_context: AssetReferenceContext } | null> {
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
                a.location_id, a.organization_unit_id, a.responsible_person_id,
                a.legacy_location_text, a.legacy_organization_unit_text, a.legacy_responsible_person_text,
                a.source_reference, a.source_notes, a.registered_by, a.recorded_at, a.created_at, a.updated_at,
                a.acquisition_id,
                ${REFERENCE_ENTRY_SELECT}
         FROM assets a
         ${REFERENCE_ENTRY_JOINS}
         WHERE a.id = $1`,
        [id.trim()]
      );

      if (assetRes.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

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

      const row = assetRes.rows[0];

      return {
        asset: {
          id: assetRes.rows[0].id,
          asset_number: assetRes.rows[0].asset_number,
          serial_number: assetRes.rows[0].serial_number,
          name: assetRes.rows[0].name,
          category: assetRes.rows[0].category,
          ...referenceColumns(row),
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
        reference_context: {
          ...referenceEntries(row),
          legacy_location_text: row.legacy_location_text ?? null,
          legacy_organization_unit_text: row.legacy_organization_unit_text ?? null,
          legacy_responsible_person_text: row.legacy_responsible_person_text ?? null,
        },
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
      const allowedFields = ['stable_id', 'asset_number', 'serial_number', 'name', 'legacy_text'];
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
        conditions.push(`id = $${params.length}`);
      } else if (field === 'asset_number') {
        params.push(value);
        conditions.push(`asset_number = $${params.length}`);
      } else if (field === 'serial_number') {
        params.push(value);
        conditions.push(`serial_number = $${params.length}`);
      } else if (field === 'name' || field === 'legacy_text') {
        if (value.trim() === '') {
          throw new ValidationError(`Search value for ${field} must not be whitespace-only`);
        }
        params.push(containsPattern(value));
        const columns = field === 'name' ? ['name'] : LEGACY_TEXT_FIELDS;
        conditions.push(`(${columns.map((column) => `${column} ILIKE $${params.length} ESCAPE '\\'`).join(' OR ')})`);
      }
    }

    for (const [filter] of REFERENCE_ID_FIELDS) {
      const id = input[filter];
      if (id === undefined) {
        continue;
      }
      if (!isValidExactUuid(id)) {
        throw new ValidationError(`${filter} must be a valid UUID`);
      }
      params.push(id.toLowerCase());
      conditions.push(`${filter} = $${params.length}`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitParamIndex = params.length + 1;
    params.push(parsedLimit);
    const offsetParamIndex = params.length + 1;
    params.push(parsedOffset);

    const query = `
      WITH filtered AS (
        SELECT id, name, asset_number, serial_number, recorded_at,
               location_id, organization_unit_id, responsible_person_id
        FROM assets
        ${whereClause}
      ),
      counted AS (
        SELECT COUNT(*)::bigint AS total_count FROM filtered
      ),
      paged AS (
        SELECT a.id, a.name, a.asset_number, a.serial_number, a.recorded_at,
               a.location_id, a.organization_unit_id, a.responsible_person_id,
               ${REFERENCE_ENTRY_SELECT}
        FROM filtered a
        ${REFERENCE_ENTRY_JOINS}
        ORDER BY a.recorded_at DESC, a.id ASC
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      )
      SELECT r.*, c.total_count
      FROM counted c
      LEFT JOIN paged r ON true
      ORDER BY r.recorded_at DESC, r.id ASC
    `;

    const res = await this.db.query(query, params);

    const totalCount = res.rows.length > 0 && res.rows[0].total_count != null ? Number(res.rows[0].total_count) : 0;
    const items: SearchAssetItem[] = res.rows
      .filter((row: any) => row.id != null)
      .map((row: any) => ({
        id: row.id,
        name: row.name ?? null,
        asset_number: row.asset_number ?? null,
        serial_number: row.serial_number ?? null,
        ...referenceEntries(row),
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
