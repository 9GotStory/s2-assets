import * as crypto from 'node:crypto';
import pg from 'pg';
import { isValidUuid } from './capability.service.ts';

export interface AssetRecord {
  id: string;
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
  organization_unit: string | null;
  source_reference: string | null;
  source_notes: string | null;
  registered_by: string;
  recorded_at: string | Date;
  created_at?: string | Date;
  updated_at?: string | Date;
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

export interface RegisterAssetInput {
  name?: string | null;
  asset_number?: string | null;
  serial_number?: string | null;
  category?: string | null;
  organization_unit?: string | null;
  source_reference?: string | null;
  source_notes?: string | null;
  is_legacy?: boolean;
  explicit_continuation?: boolean;
}

export interface AssetRegistrationResult {
  asset: AssetRecord;
  history: AssetHistoryRecord;
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

export type SearchAssetField = 'stable_id' | 'asset_number' | 'serial_number' | 'name';

export interface SearchAssetItem {
  id: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
}

export interface SearchAssetInput {
  field?: SearchAssetField | string;
  value?: string;
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
    const normalized = {
      name: input.name?.trim() || null,
      asset_number: input.asset_number ?? null,
      serial_number: input.serial_number ?? null,
      category: null,
      organization_unit: null,
      source_reference: input.source_reference?.trim() || null,
      source_notes: input.source_notes?.trim() || null,
      is_legacy: input.is_legacy === true,
    };
    const jsonStr = JSON.stringify(normalized, Object.keys(normalized).sort());
    return crypto.createHash('sha256').update(jsonStr).digest('hex');
  }

  /**
   * Looks up duplicate candidate records matching nonempty asset_number or serial_number exactly.
   * Returns empty array if both identifiers are absent. (AR-11, D2)
   * Enforces bounded candidate retrieval with deterministic tie-breaker and pagination (TECHNOLOGY.md:135).
   */
  async getDuplicateCandidates(
    assetNumber?: string | null,
    serialNumber?: string | null,
    client?: any,
    limit: number = 50,
    offset: number = 0
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
    const queryText = `
      SELECT id, asset_number, serial_number, name, category, organization_unit,
             source_reference, source_notes, registered_by, recorded_at, created_at, updated_at,
             count(*) OVER()::int AS total_count
      FROM assets
      WHERE ($1::varchar IS NOT NULL AND asset_number = $1)
         OR ($2::varchar IS NOT NULL AND serial_number = $2)
      ORDER BY recorded_at DESC, id ASC
      LIMIT $3 OFFSET $4;
    `;

    const res = await runner.query(queryText, [an, sn, boundedLimit, boundedOffset]);
    let totalCount = 0;
    if (res?.rows && res.rows.length > 0) {
      totalCount = res.rows[0].total_count ?? 0;
    } else if (boundedOffset > 0) {
      const countRes = await runner.query(
        `SELECT count(*)::int AS count FROM assets
         WHERE ($1::varchar IS NOT NULL AND asset_number = $1)
            OR ($2::varchar IS NOT NULL AND serial_number = $2)`,
        [an, sn]
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

    // Strict boolean type validation (Standards Finding 1)
    if (input.is_legacy !== undefined && typeof input.is_legacy !== 'boolean') {
      throw new ValidationError('is_legacy must be a boolean');
    }
    if (
      input.explicit_continuation !== undefined &&
      typeof input.explicit_continuation !== 'boolean'
    ) {
      throw new ValidationError('explicit_continuation must be a boolean');
    }

    // Strict category restriction - unset in T1 (Spec Finding 6, R2)
    if (input.category !== undefined && input.category !== null) {
      throw new ValidationError('Category must remain unset in T1 (R2)');
    }

    // Strict organization unit restriction - separately gated (Spec Finding 7, D7)
    if (input.organization_unit !== undefined && input.organization_unit !== null) {
      throw new ValidationError('Organization unit is not accepted in T1 registration (D7)');
    }

    // String type validation
    if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') {
      throw new ValidationError('name must be a string');
    }
    if (
      input.asset_number !== undefined &&
      input.asset_number !== null &&
      typeof input.asset_number !== 'string'
    ) {
      throw new ValidationError('asset_number must be a string');
    }
    if (
      input.serial_number !== undefined &&
      input.serial_number !== null &&
      typeof input.serial_number !== 'string'
    ) {
      throw new ValidationError('serial_number must be a string');
    }
    if (
      input.source_reference !== undefined &&
      input.source_reference !== null &&
      typeof input.source_reference !== 'string'
    ) {
      throw new ValidationError('source_reference must be a string');
    }
    if (
      input.source_notes !== undefined &&
      input.source_notes !== null &&
      typeof input.source_notes !== 'string'
    ) {
      throw new ValidationError('source_notes must be a string');
    }

    const isLegacy = input.is_legacy === true;
    const rawName = input.name?.trim();

    if (!isLegacy) {
      if (!rawName || rawName.length === 0) {
        throw new ValidationError('Truthful item name/description is required for ordinary registration');
      }
    }

    const name = rawName && rawName.length > 0 ? rawName : null;

    // Preserve supplied identifiers without trimming or normalization (Spec Finding 8)
    const assetNumber =
      input.asset_number !== undefined &&
      input.asset_number !== null &&
      input.asset_number !== ''
        ? input.asset_number
        : null;
    const serialNumber =
      input.serial_number !== undefined &&
      input.serial_number !== null &&
      input.serial_number !== ''
        ? input.serial_number
        : null;

    const category = null;
    const orgUnit = null;
    const sourceRef =
      input.source_reference !== undefined &&
      input.source_reference !== null &&
      input.source_reference.trim() !== ''
        ? input.source_reference.trim()
        : null;
    const sourceNotes =
      input.source_notes !== undefined &&
      input.source_notes !== null &&
      input.source_notes.trim() !== ''
        ? input.source_notes.trim()
        : null;

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

      // 3. Insert asset record (AR-01, AR-02, AR-04, R1, R2)
      const assetId = crypto.randomUUID();
      const insertAssetQuery = `
        INSERT INTO assets (
          id, asset_number, serial_number, name, category,
          organization_unit, source_reference, source_notes,
          registered_by, recorded_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, now(), now(), now()
        )
        RETURNING *;
      `;
      const assetRes = await client.query(insertAssetQuery, [
        assetId,
        assetNumber,
        serialNumber,
        name,
        category,
        orgUnit,
        sourceRef,
        sourceNotes,
        actorId,
      ]);
      const assetRow = assetRes.rows[0];

      // 4. Insert starting history fact (AR-07, AC-16)
      const historyId = crypto.randomUUID();
      const historyPayload = {
        is_legacy: isLegacy,
        name,
        asset_number: assetNumber,
        serial_number: serialNumber,
        source_reference: sourceRef,
        source_notes: sourceNotes,
      };

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
      const historyRow = historyRes.rows[0];

      const result: AssetRegistrationResult = {
        asset: {
          id: assetRow.id,
          asset_number: assetRow.asset_number,
          serial_number: assetRow.serial_number,
          name: assetRow.name,
          category: assetRow.category,
          organization_unit: assetRow.organization_unit,
          source_reference: assetRow.source_reference,
          source_notes: assetRow.source_notes,
          registered_by: assetRow.registered_by,
          recorded_at: new Date(assetRow.recorded_at).toISOString(),
          created_at: new Date(assetRow.created_at).toISOString(),
          updated_at: new Date(assetRow.updated_at).toISOString(),
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
   * Retrieves an Asset by Stable ID along with its full timeline history facts.
   * Office-wide visibility (R4) - returns record without user/organization segregation.
   */
  async getAssetById(
    id: string
  ): Promise<{ asset: AssetRecord; history: AssetHistoryRecord[] } | null> {
    if (!isValidUuid(id)) {
      return null;
    }

    const assetRes = await this.db.query(
      `SELECT id, asset_number, serial_number, name, category, organization_unit,
              source_reference, source_notes, registered_by, recorded_at, created_at, updated_at
       FROM assets
       WHERE id = $1`,
      [id.trim()]
    );

    if (assetRes.rows.length === 0) {
      return null;
    }

    const historyRes = await this.db.query(
      `SELECT h.id, h.asset_id, h.action, h.actor_id, u.username as actor_username,
              h.recorded_at, h.payload, h.created_at
       FROM asset_history h
       LEFT JOIN users u ON h.actor_id = u.id
       WHERE h.asset_id = $1
       ORDER BY h.recorded_at ASC, h.created_at ASC`,
      [id.trim()]
    );

    return {
      asset: {
        id: assetRes.rows[0].id,
        asset_number: assetRes.rows[0].asset_number,
        serial_number: assetRes.rows[0].serial_number,
        name: assetRes.rows[0].name,
        category: assetRes.rows[0].category,
        organization_unit: assetRes.rows[0].organization_unit,
        source_reference: assetRes.rows[0].source_reference,
        source_notes: assetRes.rows[0].source_notes,
        registered_by: assetRes.rows[0].registered_by,
        recorded_at: new Date(assetRes.rows[0].recorded_at).toISOString(),
        created_at: new Date(assetRes.rows[0].created_at).toISOString(),
        updated_at: new Date(assetRes.rows[0].updated_at).toISOString(),
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
    };
  }

  /**
   * Bounded identifier/description search (T3).
   * Supports field-based exact matching for stable_id, asset_number, serial_number,
   * case-insensitive literal substring for name, or empty browse when no criteria given.
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
      const allowedFields = ['stable_id', 'asset_number', 'serial_number', 'name'];
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

    // Determine filter condition and parameters
    let whereClause = '';
    const params: any[] = [];

    const isBrowse = field === undefined || value === undefined || value === '';

    if (!isBrowse && field && value !== undefined) {
      if (field === 'stable_id') {
        if (!isValidExactUuid(value)) {
          throw new ValidationError('Search value for stable_id must be a valid UUID');
        }
        params.push(value);
        whereClause = `WHERE id = $${params.length}`;
      } else if (field === 'asset_number') {
        params.push(value);
        whereClause = `WHERE asset_number = $${params.length}`;
      } else if (field === 'serial_number') {
        params.push(value);
        whereClause = `WHERE serial_number = $${params.length}`;
      } else if (field === 'name') {
        if (value.trim() === '') {
          throw new ValidationError('Search value for name must not be whitespace-only');
        }
        const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        params.push(`%${escaped}%`);
        whereClause = `WHERE name ILIKE $${params.length} ESCAPE '\\'`;
      }
    }

    const limitParamIndex = params.length + 1;
    params.push(parsedLimit);
    const offsetParamIndex = params.length + 1;
    params.push(parsedOffset);

    const query = `
      WITH filtered AS (
        SELECT id, name, asset_number, serial_number, recorded_at
        FROM assets
        ${whereClause}
      ),
      counted AS (
        SELECT COUNT(*)::bigint AS total_count FROM filtered
      ),
      paged AS (
        SELECT id, name, asset_number, serial_number, recorded_at
        FROM filtered
        ORDER BY recorded_at DESC, id ASC
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      )
      SELECT p.id, p.name, p.asset_number, p.serial_number, c.total_count
      FROM counted c
      LEFT JOIN paged p ON true
      ORDER BY p.recorded_at DESC, p.id ASC
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
