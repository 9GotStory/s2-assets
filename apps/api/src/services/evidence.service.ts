import * as crypto from 'node:crypto';
import pg from 'pg';
import { isPlaceholderText } from './acquisition.service.ts';
import { canonicalJson } from './asset.service.ts';

const STRICT_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStrictUuid(id: unknown): id is string {
  return typeof id === 'string' && STRICT_UUID_REGEX.test(id);
}

export interface EvidenceRecord {
  id: string;
  reference_type: string | null;
  reference_text: string | null;
  description: string | null;
  acquisition_id: string | null;
  version: number;
  recorded_at: string;
  created_by: string;
  created_at?: string;
  updated_at?: string;
  asset_ids: string[];
}

export interface EvidenceHistoryEntry {
  id: string;
  evidence_id: string;
  version: number;
  action: 'CREATED' | 'CORRECTED';
  actor_id: string;
  reason: string | null;
  before_state: any;
  after_state: any;
  link_deltas: any;
  recorded_at: string;
}

export interface CreateEvidenceInput {
  reference_type?: string | null;
  reference_text?: string | null;
  description?: string | null;
  acquisition_id?: string | null;
  asset_ids?: string[];
  retry_token?: string | null;
}

export interface CorrectEvidenceInput {
  expected_version: number;
  reason: string;
  reference_type?: string | null;
  reference_text?: string | null;
  description?: string | null;
  acquisition_id?: string | null;
  add_asset_ids?: string[];
  remove_asset_ids?: string[];
  retry_token?: string | null;
}

export interface EvidenceServiceOptions {
  db: pg.Pool | any;
  capabilityService?: any;
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

  constructor(message: string = 'Evidence not found') {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
    this.code = 'NOT_FOUND';
  }
}

export class ConflictError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, code: string = 'CONFLICT') {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.code = code;
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

export class ForbiddenError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
    this.code = 'FORBIDDEN';
  }
}

export class UnauthorizedError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
    this.statusCode = 401;
    this.code = 'UNAUTHORIZED';
  }
}

export function hasStrictControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const PLACEHOLDER_REASONS = new Set([
  'n/a',
  'na',
  'none',
  'test',
  'testing',
  'asdf',
  'sample',
  'placeholder',
  'null',
  'undefined',
  '-',
  '--',
  '---',
  '.',
  '..',
  '...',
  'unknown',
  'no reason',
]);

export function isPlaceholderReason(reason: string): boolean {
  const trimmed = reason.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_REASONS.has(trimmed)) return true;
  if (isPlaceholderText(trimmed)) return true;
  if (/^[\s\-_.~!?/\\*#@^&()+=]+$/.test(trimmed)) return true;
  return false;
}

export function hasDisallowedControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function validateAndNormalizeReferenceType(refType: unknown): string | null {
  if (refType === undefined || refType === null) return null;
  if (typeof refType !== 'string') {
    throw new ValidationError('reference_type must be a string');
  }
  if (refType.length > 100) {
    throw new ValidationError('reference_type must not exceed 100 characters');
  }
  if (hasDisallowedControlChars(refType)) {
    throw new ValidationError('reference_type must not contain control characters');
  }
  const trimmed = refType.trim();
  if (trimmed.length === 0 || isPlaceholderText(trimmed)) return null;
  return trimmed;
}

export function validateReferenceText(refText: unknown): string | null {
  if (refText === undefined || refText === null) return null;
  if (typeof refText !== 'string') {
    throw new ValidationError('reference_text must be a string');
  }
  if (refText.length > 500) {
    throw new ValidationError('reference_text must not exceed 500 characters');
  }
  if (hasDisallowedControlChars(refText)) {
    throw new ValidationError('reference_text must not contain control characters');
  }
  const trimmed = refText.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function validateDescription(desc: unknown): string | null {
  if (desc === undefined || desc === null) return null;
  if (typeof desc !== 'string') {
    throw new ValidationError('description must be a string');
  }
  if (desc.length > 2000) {
    throw new ValidationError('description must not exceed 2000 characters');
  }
  if (hasDisallowedControlChars(desc)) {
    throw new ValidationError('description must not contain control characters');
  }
  const trimmed = desc.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function computeCreateFingerprint(input: {
  reference_type: string | null;
  reference_text: string | null;
  description: string | null;
  acquisition_id: string | null;
  asset_ids: string[];
}): string {
  const normalized = {
    acquisition_id: input.acquisition_id ?? null,
    asset_ids: Array.from(new Set(input.asset_ids)).sort(),
    description: input.description ?? null,
    reference_text: input.reference_text ?? null,
    reference_type: input.reference_type ?? null,
  };
  return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

export function computeCorrectFingerprint(input: {
  expected_version: number;
  reason: string;
  reference_type?: string | null;
  reference_text?: string | null;
  description?: string | null;
  acquisition_id?: string | null;
  add_asset_ids?: string[];
  remove_asset_ids?: string[];
}): string {
  const normalized: Record<string, any> = {
    expected_version: input.expected_version,
    reason: input.reason.trim(),
  };
  if (input.reference_type !== undefined) {
    normalized.reference_type = input.reference_type ?? null;
  }
  if (input.reference_text !== undefined) {
    normalized.reference_text = input.reference_text ?? null;
  }
  if (input.description !== undefined) {
    normalized.description = input.description ?? null;
  }
  if (input.acquisition_id !== undefined) {
    normalized.acquisition_id = input.acquisition_id ?? null;
  }
  if (input.add_asset_ids !== undefined) {
    normalized.add_asset_ids = Array.from(new Set(input.add_asset_ids)).sort();
  }
  if (input.remove_asset_ids !== undefined) {
    normalized.remove_asset_ids = Array.from(new Set(input.remove_asset_ids)).sort();
  }
  return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

export class EvidenceService {
  private db: any;
  private capabilityService?: any;

  constructor(options: EvidenceServiceOptions) {
    this.db = options.db;
    this.capabilityService = options.capabilityService;
  }

  public setCapabilityService(capabilityService: any): void {
    this.capabilityService = capabilityService;
  }

  private async getClient(): Promise<pg.PoolClient> {
    if (this.db && typeof this.db.connect === 'function') {
      return await this.db.connect();
    }
    return this.db;
  }

  /**
   * Validate B2 metadata rules
   */
  private validateMetadata(
    refType: unknown,
    refText: unknown,
    desc: unknown
  ): {
    normalizedRefType: string | null;
    normalizedRefText: string | null;
    normalizedDesc: string | null;
  } {
    const normalizedRefType = validateAndNormalizeReferenceType(refType);
    const normalizedRefText = validateReferenceText(refText);
    const normalizedDesc = validateDescription(desc);

    const hasMeaningfulText =
      normalizedRefText !== null &&
      normalizedRefText.length > 0 &&
      !isPlaceholderText(normalizedRefText);

    const hasMeaningfulDesc =
      normalizedDesc !== null &&
      normalizedDesc.length > 0 &&
      !isPlaceholderText(normalizedDesc);

    if (!hasMeaningfulText && !hasMeaningfulDesc) {
      throw new ValidationError(
        'At least one meaningful reference_text (<=500 chars) or description (<=2000 chars) is required'
      );
    }

    return {
      normalizedRefType,
      normalizedRefText,
      normalizedDesc,
    };
  }

  private async verifyActiveSessionAndUser(
    client: pg.PoolClient | any,
    actorId: string,
    sessionId?: string | null
  ): Promise<void> {
    const userRes = await client.query('SELECT is_active FROM users WHERE id = $1', [actorId]);
    if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
      throw new ForbiddenError('User account is inactive or disabled');
    }

    if (sessionId) {
      const sessRes = await client.query(
        'SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > clock_timestamp()',
        [sessionId, actorId]
      );
      if (sessRes.rows.length === 0) {
        throw new UnauthorizedError('Session expired or revoked');
      }
    }
  }

  private async verifyActorPermissions(
    client: pg.PoolClient | any,
    actorId: string,
    sessionId?: string | null,
    requiredAction?: 'evidence:create' | 'evidence:correct',
    parentChecks?: {
      acquisitionIds?: (string | null | undefined)[];
      assetIds?: (string | null | undefined)[];
    }
  ): Promise<void> {
    await this.verifyActiveSessionAndUser(client, actorId, sessionId);

    if (this.capabilityService) {
      if (requiredAction) {
        const hasAction = await this.capabilityService.hasCapability(actorId, requiredAction);
        if (!hasAction) {
          throw new ForbiddenError(`Forbidden: requires '${requiredAction}' capability`);
        }
      }
      const hasView = await this.capabilityService.hasCapability(actorId, 'evidence:view');
      if (!hasView) {
        throw new ForbiddenError("Forbidden: requires 'evidence:view' capability");
      }

      if (parentChecks?.acquisitionIds) {
        for (const acqId of parentChecks.acquisitionIds) {
          if (acqId) {
            const hasAcq = await this.capabilityService.hasCapability(actorId, 'acquisition:view');
            if (!hasAcq) {
              throw new ForbiddenError("Forbidden: requires 'acquisition:view' capability for target acquisition");
            }
          }
        }
      }

      if (parentChecks?.assetIds && parentChecks.assetIds.length > 0) {
        const validAssetIds = parentChecks.assetIds.filter(Boolean);
        if (validAssetIds.length > 0) {
          const hasAsset = await this.capabilityService.hasCapability(actorId, 'asset:view');
          if (!hasAsset) {
            throw new ForbiddenError("Forbidden: requires 'asset:view' capability for linked assets");
          }
        }
      }
    }
  }

  /**
   * Create an Evidence record with parent links and history (B1, B2, B4)
   */
  async createEvidence(
    actorId: string,
    input: CreateEvidenceInput,
    retryToken?: string | null,
    sessionId?: string | null
  ): Promise<{ id: string; version: number; history_id: string; evidence?: EvidenceRecord }> {
    if (!isStrictUuid(actorId)) {
      throw new ValidationError('Invalid actorId format');
    }

    // Validate metadata fields
    const { normalizedRefType, normalizedRefText, normalizedDesc } = this.validateMetadata(
      input.reference_type,
      input.reference_text,
      input.description
    );

    // Validate parents: explicit null or valid UUID (reject empty string or padding)
    let acquisitionId: string | null = null;
    if (input.acquisition_id !== undefined && input.acquisition_id !== null) {
      if (!isStrictUuid(input.acquisition_id)) {
        throw new ValidationError('Invalid acquisition_id format');
      }
      acquisitionId = input.acquisition_id;
    }

    const rawAssetIds = input.asset_ids || [];
    if (!Array.isArray(rawAssetIds)) {
      throw new ValidationError('asset_ids must be an array of UUIDs');
    }

    for (const assetId of rawAssetIds) {
      if (!isStrictUuid(assetId)) {
        throw new ValidationError(`Invalid asset ID format: ${assetId}`);
      }
    }
    const distinctAssetIds = Array.from(new Set(rawAssetIds)).sort();

    if (distinctAssetIds.length > 100) {
      throw new ValidationError('Cannot link more than 100 distinct assets in a single operation');
    }

    // B1: At least one linked current parent
    if (acquisitionId === null && distinctAssetIds.length === 0) {
      throw new ValidationError(
        'Evidence must be linked to at least one parent (acquisition or asset)'
      );
    }

    // Retry token validation (required, non-blank, <= 128 chars, no control chars)
    if (!retryToken || typeof retryToken !== 'string') {
      throw new ValidationError('retry_token is required');
    }
    const token = retryToken;
    if (token.length === 0 || token.length > 128) {
      throw new ValidationError('retry_token must not exceed 128 characters');
    }
    if (hasStrictControlChars(token)) {
      throw new ValidationError('retry_token must not contain control characters');
    }

    const fingerprint = computeCreateFingerprint({
      reference_type: normalizedRefType,
      reference_text: normalizedRefText,
      description: normalizedDesc,
      acquisition_id: acquisitionId,
      asset_ids: distinctAssetIds,
    });

    const client = await this.getClient();
    const isPool = typeof this.db?.connect === 'function';

    try {
      await client.query('BEGIN');

      // 1. Transactional advisory lock
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `evidence:create:${actorId}:${token}`,
      ]);

      // 2. Deterministic parent row locks (F7)
      if (acquisitionId !== null) {
        const acqCheck = await client.query(
          'SELECT id FROM acquisitions WHERE id = $1 FOR UPDATE',
          [acquisitionId]
        );
        if (acqCheck.rows.length === 0) {
          throw new ValidationError('Acquisition does not exist');
        }
      }

      if (distinctAssetIds.length > 0) {
        const assetsCheck = await client.query(
          'SELECT id, acquisition_id FROM assets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [distinctAssetIds]
        );
        if (assetsCheck.rows.length !== distinctAssetIds.length) {
          throw new ValidationError('One or more assets do not exist');
        }

        // B1: If linked to an acquisition, all assets must belong to that acquisition
        if (acquisitionId !== null) {
          for (const row of assetsCheck.rows) {
            if (row.acquisition_id !== acquisitionId) {
              throw new ConflictError(
                'All linked assets must belong to the linked acquisition',
                'RELATIONSHIP_CONFLICT'
              );
            }
          }
        }
      }

      // 3. Idempotency check with existing token
      const tokenRes = await client.query(
        `SELECT payload_fingerprint, response_status, response_body
         FROM registration_retry_tokens
         WHERE actor_id = $1 AND operation = 'evidence:create' AND token = $2`,
        [actorId, token]
      );

      if (tokenRes.rows.length > 0) {
        const existing = tokenRes.rows[0];
        if (existing.payload_fingerprint === fingerprint) {
          // RENEW AUTHORIZATION BEFORE RETURNING CACHED RECEIPT (F2)
          await this.verifyActorPermissions(
            client,
            actorId,
            sessionId,
            'evidence:create',
            {
              acquisitionIds: [acquisitionId],
              assetIds: distinctAssetIds,
            }
          );

          await client.query('COMMIT');
          // Return compact operation receipt (F1)
          return {
            id: existing.response_body.id,
            version: existing.response_body.version,
            history_id: existing.response_body.history_id,
          };
        } else {
          await client.query('ROLLBACK');
          throw new RetryTokenConflictError(
            'Retry token reused with different payload is rejected without writes'
          );
        }
      }

      // 4. RENEW AUTHORIZATION AFTER ALL LOCK WAITS (F2)
      await this.verifyActorPermissions(
        client,
        actorId,
        sessionId,
        'evidence:create',
        {
          acquisitionIds: [acquisitionId],
          assetIds: distinctAssetIds,
        }
      );

      // 5. Insert evidence_records
      const evInsertRes = await client.query(
        `INSERT INTO evidence_records (
          reference_type, reference_text, description, acquisition_id,
          version, created_by, recorded_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, 1, $5, now(), now(), now()
        ) RETURNING id, reference_type, reference_text, description, acquisition_id, version, recorded_at, created_by, created_at, updated_at`,
        [
          normalizedRefType,
          normalizedRefText,
          normalizedDesc,
          acquisitionId,
          actorId,
        ]
      );

      const record = evInsertRes.rows[0];
      const evidenceId = record.id;

      // 6. Insert evidence_asset_links
      if (distinctAssetIds.length > 0) {
        for (const assetId of distinctAssetIds) {
          await client.query(
            `INSERT INTO evidence_asset_links (evidence_id, asset_id, created_at)
             VALUES ($1, $2, now())
             ON CONFLICT DO NOTHING`,
            [evidenceId, assetId]
          );
        }
      }

      // 7. Insert initial evidence_history (B4)
      const historyId = crypto.randomUUID();
      const afterState = {
        reference_type: normalizedRefType,
        reference_text: normalizedRefText,
        description: normalizedDesc,
        acquisition_id: acquisitionId,
        asset_ids: distinctAssetIds,
      };
      const linkDeltas = {
        added_asset_ids: distinctAssetIds,
        removed_asset_ids: [],
        previous_acquisition_id: null,
        new_acquisition_id: acquisitionId,
      };

      await client.query(
        `INSERT INTO evidence_history (
          id, evidence_id, version, action, actor_id, reason,
          before_state, after_state, link_deltas, recorded_at
        ) VALUES (
          $1, $2, 1, 'CREATED', $3, NULL,
          NULL, $4, $5, now()
        )`,
        [historyId, evidenceId, actorId, JSON.stringify(afterState), JSON.stringify(linkDeltas)]
      );

      const receipt = {
        id: evidenceId,
        version: 1,
        history_id: historyId,
      };

      // 8. Save compact retry token receipt
      await client.query(
        `INSERT INTO registration_retry_tokens (
          token, actor_id, operation, payload_fingerprint, response_status, response_body, created_at
        ) VALUES ($1, $2, 'evidence:create', $3, 201, $4, now())`,
        [token, actorId, fingerprint, JSON.stringify(receipt)]
      );

      await client.query('COMMIT');
      return receipt;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (isPool) {
        client.release();
      }
    }
  }

  /**
   * Correct an Evidence record with versioning and reason (B1, B2, B4)
   */
  async correctEvidence(
    evidenceId: string,
    actorId: string,
    input: CorrectEvidenceInput,
    retryToken?: string | null,
    sessionId?: string | null
  ): Promise<{ id: string; version: number; history_id: string | null; evidence?: EvidenceRecord }> {
    if (!isStrictUuid(evidenceId)) {
      throw new ValidationError('Invalid evidence ID format');
    }
    if (!isStrictUuid(actorId)) {
      throw new ValidationError('Invalid actorId format');
    }

    if (!input.expected_version || typeof input.expected_version !== 'number' || input.expected_version <= 0) {
      throw new ValidationError('expected_version must be a strictly positive integer');
    }

    if (!input.reason || typeof input.reason !== 'string') {
      throw new ValidationError('reason is required for corrections');
    }
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length === 0 || trimmedReason.length > 2000) {
      throw new ValidationError('reason must be between 1 and 2000 characters');
    }
    if (hasDisallowedControlChars(trimmedReason)) {
      throw new ValidationError('reason must not contain control characters');
    }
    if (isPlaceholderReason(trimmedReason)) {
      throw new ValidationError('reason must be a meaningful explanation and not a placeholder');
    }

    // Validate link deltas
    const rawAddIds = input.add_asset_ids || [];
    const rawRemoveIds = input.remove_asset_ids || [];

    if (!Array.isArray(rawAddIds) || !Array.isArray(rawRemoveIds)) {
      throw new ValidationError('add_asset_ids and remove_asset_ids must be arrays of UUIDs');
    }

    for (const id of rawAddIds) {
      if (!isStrictUuid(id)) {
        throw new ValidationError(`Invalid add_asset_ids format: ${id}`);
      }
    }
    for (const id of rawRemoveIds) {
      if (!isStrictUuid(id)) {
        throw new ValidationError(`Invalid remove_asset_ids format: ${id}`);
      }
    }

    const addIds = Array.from(new Set(rawAddIds)).sort();
    const removeIds = Array.from(new Set(rawRemoveIds)).sort();

    // Reject overlapping add/remove IDs
    const removeIdSet = new Set(removeIds);
    for (const id of addIds) {
      if (removeIdSet.has(id)) {
        throw new ValidationError(
          `add_asset_ids and remove_asset_ids must not contain overlapping IDs: ${id}`
        );
      }
    }

    // Limit on touched IDs per mutation <= 100
    const totalTouched = new Set([...addIds, ...removeIds]).size;
    if (totalTouched > 100) {
      throw new ValidationError('Cannot touch more than 100 distinct asset IDs in a single mutation');
    }

    // Retry token validation (required, non-blank, <= 128 chars, no control chars)
    if (!retryToken || typeof retryToken !== 'string') {
      throw new ValidationError('retry_token is required');
    }
    const token = retryToken;
    if (token.length === 0 || token.length > 128) {
      throw new ValidationError('retry_token must not exceed 128 characters');
    }
    if (hasStrictControlChars(token)) {
      throw new ValidationError('retry_token must not contain control characters');
    }

    const operation = `evidence:correct:${evidenceId}`;
    const fingerprint = computeCorrectFingerprint({
      expected_version: input.expected_version,
      reason: trimmedReason,
      reference_type: input.reference_type,
      reference_text: input.reference_text,
      description: input.description,
      acquisition_id: input.acquisition_id,
      add_asset_ids: addIds,
      remove_asset_ids: removeIds,
    });

    const client = await this.getClient();
    const isPool = typeof this.db?.connect === 'function';

    try {
      await client.query('BEGIN');

      // 1. Transactional advisory lock
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${operation}:${actorId}:${token}`,
      ]);

      // 2. Idempotency check with existing token
      const tokenRes = await client.query(
        `SELECT payload_fingerprint, response_status, response_body
         FROM registration_retry_tokens
         WHERE actor_id = $1 AND operation = $2 AND token = $3`,
        [actorId, operation, token]
      );

      if (tokenRes.rows.length > 0) {
        const existing = tokenRes.rows[0];
        if (existing.payload_fingerprint === fingerprint) {
          // RENEW AUTHORIZATION BEFORE RETURNING CACHED RECEIPT (F2)
          const existingEv = await client.query(
            'SELECT acquisition_id FROM evidence_records WHERE id = $1',
            [evidenceId]
          );
          const currentAcq = existingEv.rows[0]?.acquisition_id;
          const targetAcq = input.acquisition_id !== undefined ? input.acquisition_id : currentAcq;
          const linksRes = await client.query(
            'SELECT asset_id FROM evidence_asset_links WHERE evidence_id = $1',
            [evidenceId]
          );
          const curAssetIds = linksRes.rows.map((r: any) => r.asset_id);

          // Retrieve per-receipt before/after parent context (F2)
          const operationAcqIds: (string | null | undefined)[] = [];
          const operationAssetIds: string[] = [];

          const authContext = existing.response_body?._auth_context;
          if (authContext) {
            if (Array.isArray(authContext.acquisition_ids)) {
              operationAcqIds.push(...authContext.acquisition_ids);
            } else if (authContext.acquisition_id) {
              operationAcqIds.push(authContext.acquisition_id);
            }
            if (Array.isArray(authContext.asset_ids)) {
              operationAssetIds.push(...authContext.asset_ids);
            }
          } else if (existing.response_body?.history_id) {
            // Specific history record for this correction
            const histRes = await client.query(
              'SELECT before_state, after_state, link_deltas FROM evidence_history WHERE id = $1',
              [existing.response_body.history_id]
            );
            if (histRes.rows.length > 0) {
              const h = histRes.rows[0];
              const beforeState = typeof h.before_state === 'string' ? JSON.parse(h.before_state) : h.before_state;
              const afterState = typeof h.after_state === 'string' ? JSON.parse(h.after_state) : h.after_state;
              const linkDeltas = typeof h.link_deltas === 'string' ? JSON.parse(h.link_deltas) : h.link_deltas;

              operationAcqIds.push(
                beforeState?.acquisition_id,
                afterState?.acquisition_id,
                linkDeltas?.previous_acquisition_id,
                linkDeltas?.new_acquisition_id
              );
              operationAssetIds.push(
                ...(Array.isArray(beforeState?.asset_ids) ? beforeState.asset_ids : []),
                ...(Array.isArray(afterState?.asset_ids) ? afterState.asset_ids : []),
                ...(Array.isArray(linkDeltas?.added_asset_ids) ? linkDeltas.added_asset_ids : []),
                ...(Array.isArray(linkDeltas?.removed_asset_ids) ? linkDeltas.removed_asset_ids : [])
              );
            }
          }

          const allAcqIds = Array.from(new Set([currentAcq, targetAcq, ...operationAcqIds].filter(Boolean) as string[]));
          const allAssetIds = Array.from(new Set([...curAssetIds, ...addIds, ...removeIds, ...operationAssetIds].filter(Boolean) as string[]));

          await this.verifyActorPermissions(
            client,
            actorId,
            sessionId,
            'evidence:correct',
            {
              acquisitionIds: allAcqIds,
              assetIds: allAssetIds,
            }
          );

          await client.query('COMMIT');
          // Return compact operation receipt (F1/F2)
          return {
            id: existing.response_body.id,
            version: existing.response_body.version,
            history_id: existing.response_body.history_id ?? null,
          };
        } else {
          await client.query('ROLLBACK');
          throw new RetryTokenConflictError(
            'Retry token reused with different payload is rejected without writes'
          );
        }
      }

      // 3. Row lock evidence_records (FOR UPDATE)
      const evCheck = await client.query(
        `SELECT id, reference_type, reference_text, description, acquisition_id,
                version, recorded_at, created_by, created_at, updated_at
         FROM evidence_records
         WHERE id = $1
         FOR UPDATE`,
        [evidenceId]
      );

      if (evCheck.rows.length === 0) {
        throw new NotFoundError('Evidence record not found');
      }

      const current = evCheck.rows[0];

      // Optimistic concurrency check (B4)
      if (current.version !== input.expected_version) {
        throw new ConflictError(
          `Concurrency conflict: expected version ${input.expected_version} does not match current version ${current.version}`,
          'CONCURRENCY_CONFLICT'
        );
      }

      // Fetch current linked asset IDs
      const currentLinksRes = await client.query(
        `SELECT asset_id FROM evidence_asset_links WHERE evidence_id = $1 ORDER BY asset_id ASC`,
        [evidenceId]
      );
      const currentAssetIds = currentLinksRes.rows.map((r) => r.asset_id);
      const currentAssetSet = new Set(currentAssetIds);

      // Compute link changes
      const actuallyAddedIds = addIds.filter((id) => !currentAssetSet.has(id));
      const actuallyRemovedIds = removeIds.filter((id) => currentAssetSet.has(id));

      const finalAssetSet = new Set(currentAssetIds);
      for (const id of addIds) {
        finalAssetSet.add(id);
      }
      for (const id of removeIds) {
        finalAssetSet.delete(id);
      }
      const finalAssetIds = Array.from(finalAssetSet).sort();

      // Target acquisition resolution
      let targetAcquisitionId = current.acquisition_id;
      if (input.acquisition_id !== undefined) {
        if (input.acquisition_id === null) {
          targetAcquisitionId = null;
        } else {
          if (!isStrictUuid(input.acquisition_id)) {
            throw new ValidationError('Invalid acquisition_id format');
          }
          targetAcquisitionId = input.acquisition_id;
        }
      }

      // B1: Cannot remove the final parent
      if (targetAcquisitionId === null && finalAssetIds.length === 0) {
        throw new ConflictError(
          'Cannot remove the final parent: evidence must retain at least one linked acquisition or asset',
          'RELATIONSHIP_CONFLICT'
        );
      }

      // Target metadata resolution with strict B2 validation (F4)
      let targetRefType: string | null = current.reference_type;
      if (input.reference_type !== undefined) {
        targetRefType = validateAndNormalizeReferenceType(input.reference_type);
      }

      let targetRefText: string | null = current.reference_text;
      if (input.reference_text !== undefined) {
        targetRefText = validateReferenceText(input.reference_text);
      }

      let targetDesc: string | null = current.description;
      if (input.description !== undefined) {
        targetDesc = validateDescription(input.description);
      }

      // B2: At least one genuinely meaningful known reference_text OR description
      const hasMeaningfulText =
        targetRefText !== null && targetRefText.length > 0 && !isPlaceholderText(targetRefText);
      const hasMeaningfulDesc =
        targetDesc !== null && targetDesc.length > 0 && !isPlaceholderText(targetDesc);

      if (!hasMeaningfulText && !hasMeaningfulDesc) {
        throw new ValidationError(
          'At least one meaningful reference_text (<=500 chars) or description (<=2000 chars) is required'
        );
      }

      // 4. Deterministic parent row locks (F7)
      const acqsToLock = Array.from(
        new Set([current.acquisition_id, targetAcquisitionId].filter(Boolean) as string[])
      ).sort();
      if (acqsToLock.length > 0) {
        const acqCheck = await client.query(
          'SELECT id FROM acquisitions WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [acqsToLock]
        );
        const foundAcqSet = new Set(acqCheck.rows.map((r: any) => r.id));
        if (targetAcquisitionId !== null && !foundAcqSet.has(targetAcquisitionId)) {
          throw new ValidationError('Target acquisition does not exist');
        }
      }

      const allAssetIdsToLock = Array.from(new Set([...finalAssetIds, ...removeIds, ...addIds])).sort();
      const foundMap = new Map<string, string | null>();
      if (allAssetIdsToLock.length > 0) {
        const assetsCheck = await client.query(
          'SELECT id, acquisition_id FROM assets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [allAssetIdsToLock]
        );
        for (const row of assetsCheck.rows) {
          foundMap.set(row.id, row.acquisition_id);
        }

        for (const assetId of addIds) {
          if (!foundMap.has(assetId)) {
            throw new ValidationError(`Added asset ID does not exist: ${assetId}`);
          }
        }

        // B1: If linked to an acquisition, all final assets must belong to that acquisition
        if (targetAcquisitionId !== null) {
          for (const assetId of finalAssetIds) {
            const assetAcqId = foundMap.get(assetId);
            if (assetAcqId !== targetAcquisitionId) {
              throw new ConflictError(
                'All linked assets must belong to the linked acquisition',
                'RELATIONSHIP_CONFLICT'
              );
            }
          }
        }
      }

      // 5. RENEW AUTHORIZATION AFTER ALL LOCK WAITS (F2)
      await this.verifyActorPermissions(
        client,
        actorId,
        sessionId,
        'evidence:correct',
        {
          acquisitionIds: [current.acquisition_id, targetAcquisitionId],
          assetIds: allAssetIdsToLock,
        }
      );

      // Check No-Op
      const metadataUnchanged =
        targetRefType === current.reference_type &&
        targetRefText === current.reference_text &&
        targetDesc === current.description &&
        targetAcquisitionId === current.acquisition_id;

      const linksUnchanged = actuallyAddedIds.length === 0 && actuallyRemovedIds.length === 0;

      if (metadataUnchanged && linksUnchanged) {
        // No-Op: persist retry token receipt with exact original operation parent footprint without incrementing version or history (F2)
        const noOpReceipt = {
          id: evidenceId,
          version: current.version,
          history_id: null,
          _auth_context: {
            acquisition_ids: current.acquisition_id ? [current.acquisition_id] : [],
            asset_ids: currentAssetIds,
          },
        };

        await client.query(
          `INSERT INTO registration_retry_tokens (
            token, actor_id, operation, payload_fingerprint, response_status, response_body, created_at
          ) VALUES ($1, $2, $3, $4, 200, $5, now())
          ON CONFLICT DO NOTHING`,
          [token, actorId, operation, fingerprint, JSON.stringify(noOpReceipt)]
        );

        await client.query('COMMIT');
        return {
          id: noOpReceipt.id,
          version: noOpReceipt.version,
          history_id: null,
        };
      }

      // Mutate evidence_records
      const newVersion = current.version + 1;
      await client.query(
        `UPDATE evidence_records
         SET reference_type = $1,
             reference_text = $2,
             description = $3,
             acquisition_id = $4,
             version = $5,
             updated_at = now()
         WHERE id = $6`,
        [
          targetRefType,
          targetRefText,
          targetDesc,
          targetAcquisitionId,
          newVersion,
          evidenceId,
        ]
      );

      // Update link table
      if (actuallyRemovedIds.length > 0) {
        await client.query(
          `DELETE FROM evidence_asset_links
           WHERE evidence_id = $1 AND asset_id = ANY($2::uuid[])`,
          [evidenceId, actuallyRemovedIds]
        );
      }

      if (actuallyAddedIds.length > 0) {
        for (const assetId of actuallyAddedIds) {
          await client.query(
            `INSERT INTO evidence_asset_links (evidence_id, asset_id, created_at)
             VALUES ($1, $2, now())
             ON CONFLICT DO NOTHING`,
            [evidenceId, assetId]
          );
        }
      }

      // Insert history entry (B4)
      const historyId = crypto.randomUUID();
      const beforeState = {
        reference_type: current.reference_type,
        reference_text: current.reference_text,
        description: current.description,
        acquisition_id: current.acquisition_id,
        asset_ids: currentAssetIds,
      };
      const afterState = {
        reference_type: targetRefType,
        reference_text: targetRefText,
        description: targetDesc,
        acquisition_id: targetAcquisitionId,
        asset_ids: finalAssetIds,
      };
      const linkDeltas = {
        added_asset_ids: actuallyAddedIds,
        removed_asset_ids: actuallyRemovedIds,
        previous_acquisition_id: current.acquisition_id,
        new_acquisition_id: targetAcquisitionId,
      };

      await client.query(
        `INSERT INTO evidence_history (
          id, evidence_id, version, action, actor_id, reason,
          before_state, after_state, link_deltas, recorded_at
        ) VALUES (
          $1, $2, $3, 'CORRECTED', $4, $5,
          $6, $7, $8, now()
        )`,
        [
          historyId,
          evidenceId,
          newVersion,
          actorId,
          trimmedReason,
          JSON.stringify(beforeState),
          JSON.stringify(afterState),
          JSON.stringify(linkDeltas),
        ]
      );

      const receipt = {
        id: evidenceId,
        version: newVersion,
        history_id: historyId,
        _auth_context: {
          acquisition_ids: [current.acquisition_id, targetAcquisitionId].filter(Boolean),
          asset_ids: Array.from(new Set([...currentAssetIds, ...finalAssetIds])),
        },
      };

      await client.query(
        `INSERT INTO registration_retry_tokens (
          token, actor_id, operation, payload_fingerprint, response_status, response_body, created_at
        ) VALUES ($1, $2, $3, $4, 200, $5, now())`,
        [token, actorId, operation, fingerprint, JSON.stringify(receipt)]
      );

      await client.query('COMMIT');
      return {
        id: receipt.id,
        version: receipt.version,
        history_id: receipt.history_id,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (isPool) {
        client.release();
      }
    }
  }

  /**
   * Get single Evidence record by ID with paginated asset links (F6)
   */
  async getEvidenceById(
    evidenceId: string,
    assetLimit: number = 25,
    assetOffset: number = 0
  ): Promise<
    EvidenceRecord & {
      asset_ids_total: number;
      asset_limit: number;
      asset_offset: number;
      has_more_assets: boolean;
    }
  > {
    if (!isStrictUuid(evidenceId)) {
      throw new ValidationError('Invalid evidence ID format');
    }

    const client = await this.getClient();
    const isPool = typeof this.db?.connect === 'function';

    try {
      const res = await client.query(
        `SELECT id, reference_type, reference_text, description, acquisition_id,
                version, recorded_at, created_by, created_at, updated_at
         FROM evidence_records
         WHERE id = $1`,
        [evidenceId]
      );

      if (res.rows.length === 0) {
        throw new NotFoundError('Evidence record not found');
      }

      const row = res.rows[0];

      // Total linked assets count
      const countRes = await client.query(
        `SELECT count(*)::text as total FROM evidence_asset_links WHERE evidence_id = $1`,
        [evidenceId]
      );
      const totalAssets = Number(countRes.rows[0]?.total || '0');

      // Paginated asset links
      const linksRes = await client.query(
        `SELECT asset_id FROM evidence_asset_links WHERE evidence_id = $1 ORDER BY asset_id ASC LIMIT $2 OFFSET $3`,
        [evidenceId, assetLimit, assetOffset]
      );
      const assetIds = linksRes.rows.map((r) => r.asset_id);

      return {
        id: row.id,
        reference_type: row.reference_type,
        reference_text: row.reference_text,
        description: row.description,
        acquisition_id: row.acquisition_id,
        version: row.version,
        recorded_at: row.recorded_at?.toISOString
          ? row.recorded_at.toISOString()
          : String(row.recorded_at),
        created_by: row.created_by,
        created_at: row.created_at?.toISOString
          ? row.created_at.toISOString()
          : String(row.created_at),
        updated_at: row.updated_at?.toISOString
          ? row.updated_at.toISOString()
          : String(row.updated_at),
        asset_ids: assetIds,
        asset_ids_total: totalAssets,
        asset_limit: assetLimit,
        asset_offset: assetOffset,
        has_more_assets: assetOffset + assetIds.length < totalAssets,
      };
    } finally {
      if (isPool) {
        client.release();
      }
    }
  }

  /**
   * List Evidence records for an Acquisition or Asset with pagination and D3 grants filtering (F2, F6)
   */
  async listEvidence(
    filter: { acquisition_id?: string; asset_id?: string },
    limit: number = 25,
    offset: number = 0,
    userGrants?: { hasAcquisitionView: boolean; hasAssetView: boolean }
  ): Promise<{
    items: (EvidenceRecord & { asset_ids_total: number; has_more_assets: boolean })[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }> {
    const { acquisition_id, asset_id } = filter;

    if (!acquisition_id && !asset_id) {
      throw new ValidationError('Either acquisition_id or asset_id must be provided');
    }
    if (acquisition_id && asset_id) {
      throw new ValidationError('Cannot filter by both acquisition_id and asset_id');
    }

    if (acquisition_id && !isStrictUuid(acquisition_id)) {
      throw new ValidationError('Invalid acquisition_id format');
    }
    if (asset_id && !isStrictUuid(asset_id)) {
      throw new ValidationError('Invalid asset_id format');
    }

    const client = await this.getClient();
    const isPool = typeof this.db?.connect === 'function';

    try {
      let baseWhere = '';
      const params: any[] = [];

      if (acquisition_id) {
        params.push(acquisition_id);
        baseWhere = `WHERE e.acquisition_id = $${params.length}`;
      } else if (asset_id) {
        params.push(asset_id);
        baseWhere = `WHERE EXISTS (SELECT 1 FROM evidence_asset_links l WHERE l.evidence_id = e.id AND l.asset_id = $${params.length})`;
      }

      // D3: Exclude records where user lacks view capability for disclosed parent
      if (userGrants) {
        if (!userGrants.hasAcquisitionView) {
          baseWhere += ` AND e.acquisition_id IS NULL`;
        }
        if (!userGrants.hasAssetView) {
          baseWhere += ` AND NOT EXISTS (SELECT 1 FROM evidence_asset_links l WHERE l.evidence_id = e.id)`;
        }
      }

      const countQuery = `SELECT count(*)::text as total FROM evidence_records e ${baseWhere}`;
      const countRes = await client.query(countQuery, params);
      const total = Number(countRes.rows[0]?.total || '0');

      const itemsQuery = `
        SELECT e.id, e.reference_type, e.reference_text, e.description,
               e.acquisition_id, e.version, e.recorded_at, e.created_by,
               e.created_at, e.updated_at
        FROM evidence_records e
        ${baseWhere}
        ORDER BY e.recorded_at DESC, e.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      const itemsRes = await client.query(itemsQuery, [...params, limit, offset]);

      // Batch load bounded asset links (up to 25 per item) and total counts
      const evidenceIds = itemsRes.rows.map((r) => r.id);
      const linksMap: Record<string, string[]> = {};
      const totalsMap: Record<string, number> = {};

      if (evidenceIds.length > 0) {
        const countsRes = await client.query(
          `SELECT evidence_id, count(*)::text as total
           FROM evidence_asset_links
           WHERE evidence_id = ANY($1::uuid[])
           GROUP BY evidence_id`,
          [evidenceIds]
        );
        for (const row of countsRes.rows) {
          totalsMap[row.evidence_id] = Number(row.total || '0');
        }

        const linksRes = await client.query(
          `SELECT evidence_id, asset_id
           FROM (
             SELECT evidence_id, asset_id,
                    row_number() OVER (PARTITION BY evidence_id ORDER BY asset_id ASC) as rn
             FROM evidence_asset_links
             WHERE evidence_id = ANY($1::uuid[])
           ) sub
           WHERE rn <= 25`,
          [evidenceIds]
        );
        for (const row of linksRes.rows) {
          if (!linksMap[row.evidence_id]) {
            linksMap[row.evidence_id] = [];
          }
          linksMap[row.evidence_id].push(row.asset_id);
        }
      }

      const items = itemsRes.rows.map((row) => {
        const assetIds = linksMap[row.id] || [];
        const assetTotal = totalsMap[row.id] || 0;
        return {
          id: row.id,
          reference_type: row.reference_type,
          reference_text: row.reference_text,
          description: row.description,
          acquisition_id: row.acquisition_id,
          version: row.version,
          recorded_at: row.recorded_at?.toISOString
            ? row.recorded_at.toISOString()
            : String(row.recorded_at),
          created_by: row.created_by,
          created_at: row.created_at?.toISOString
            ? row.created_at.toISOString()
            : String(row.created_at),
          updated_at: row.updated_at?.toISOString
            ? row.updated_at.toISOString()
            : String(row.updated_at),
          asset_ids: assetIds,
          asset_ids_total: assetTotal,
          has_more_assets: assetIds.length < assetTotal,
        };
      });

      return {
        items,
        total,
        limit,
        offset,
        has_more: offset + items.length < total,
      };
    } finally {
      if (isPool) {
        client.release();
      }
    }
  }

  /**
   * Check whether an evidence record touches an acquisition or asset across its history (F2)
   */
  async getEvidenceParentDisclosure(
    evidenceId: string
  ): Promise<{
    hasAcquisition: boolean;
    hasAssets: boolean;
  }> {
    if (!isStrictUuid(evidenceId)) {
      throw new ValidationError('Invalid evidence ID format');
    }

    const client = await this.getClient();
    const isPool = typeof this.db?.connect === 'function';

    try {
      const evCheck = await client.query(
        'SELECT id FROM evidence_records WHERE id = $1',
        [evidenceId]
      );
      if (evCheck.rows.length === 0) {
        throw new NotFoundError('Evidence record not found');
      }

      const checkRes = await client.query(
        `SELECT
          EXISTS(
            SELECT 1 FROM evidence_records WHERE id = $1 AND acquisition_id IS NOT NULL
            UNION
            SELECT 1 FROM evidence_history
            WHERE evidence_id = $1
              AND (
                (before_state IS NOT NULL AND before_state->>'acquisition_id' IS NOT NULL)
                OR (after_state IS NOT NULL AND after_state->>'acquisition_id' IS NOT NULL)
                OR (link_deltas IS NOT NULL AND link_deltas->>'previous_acquisition_id' IS NOT NULL)
                OR (link_deltas IS NOT NULL AND link_deltas->>'new_acquisition_id' IS NOT NULL)
              )
          ) as touches_acquisition,
          EXISTS(
            SELECT 1 FROM evidence_asset_links WHERE evidence_id = $1
            UNION
            SELECT 1 FROM evidence_history
            WHERE evidence_id = $1
              AND (
                (before_state IS NOT NULL AND jsonb_typeof(before_state->'asset_ids') = 'array' AND jsonb_array_length(before_state->'asset_ids') > 0)
                OR (after_state IS NOT NULL AND jsonb_typeof(after_state->'asset_ids') = 'array' AND jsonb_array_length(after_state->'asset_ids') > 0)
                OR (link_deltas IS NOT NULL AND jsonb_typeof(link_deltas->'added_asset_ids') = 'array' AND jsonb_array_length(link_deltas->'added_asset_ids') > 0)
                OR (link_deltas IS NOT NULL AND jsonb_typeof(link_deltas->'removed_asset_ids') = 'array' AND jsonb_array_length(link_deltas->'removed_asset_ids') > 0)
              )
          ) as touches_assets`,
        [evidenceId]
      );

      return {
        hasAcquisition: Boolean(checkRes.rows[0]?.touches_acquisition),
        hasAssets: Boolean(checkRes.rows[0]?.touches_assets),
      };
    } finally {
      if (isPool) {
        client.release();
      }
    }
  }

  /**
   * Get paginated history for an Evidence record (B4, F6)
   */
  async getEvidenceHistory(
    evidenceId: string,
    limit: number = 25,
    offset: number = 0
  ): Promise<{
    items: EvidenceHistoryEntry[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }> {
    if (!isStrictUuid(evidenceId)) {
      throw new ValidationError('Invalid evidence ID format');
    }

    const client = await this.getClient();
    const isPool = typeof this.db?.connect === 'function';

    try {
      const evCheck = await client.query(
        'SELECT id FROM evidence_records WHERE id = $1',
        [evidenceId]
      );
      if (evCheck.rows.length === 0) {
        throw new NotFoundError('Evidence record not found');
      }

      const countRes = await client.query(
        `SELECT count(*)::text as total FROM evidence_history WHERE evidence_id = $1`,
        [evidenceId]
      );
      const total = Number(countRes.rows[0]?.total || '0');

      const res = await client.query(
        `SELECT id, evidence_id, version, action, actor_id, reason,
                before_state, after_state, link_deltas, recorded_at
         FROM evidence_history
         WHERE evidence_id = $1
         ORDER BY version DESC, recorded_at DESC
         LIMIT $2 OFFSET $3`,
        [evidenceId, limit, offset]
      );

      const items: EvidenceHistoryEntry[] = res.rows.map((row) => ({
        id: row.id,
        evidence_id: row.evidence_id,
        version: row.version,
        action: row.action,
        actor_id: row.actor_id,
        reason: row.reason,
        before_state: row.before_state,
        after_state: row.after_state,
        link_deltas: row.link_deltas,
        recorded_at: row.recorded_at?.toISOString
          ? row.recorded_at.toISOString()
          : String(row.recorded_at),
      }));

      return {
        items,
        total,
        limit,
        offset,
        has_more: offset + items.length < total,
      };
    } finally {
      if (isPool) {
        client.release();
      }
    }
  }
}
