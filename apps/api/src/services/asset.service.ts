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

export class DuplicateCandidateWarningError extends Error {
  statusCode: number;
  code: string;
  candidates: AssetRecord[];

  constructor(message: string, candidates: AssetRecord[]) {
    super(message);
    this.name = 'DuplicateCandidateWarningError';
    this.statusCode = 409;
    this.code = 'DUPLICATE_CANDIDATES_FOUND';
    this.candidates = candidates;
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
   * Enforces bounded candidate retrieval with deterministic tie-breaker (TECHNOLOGY.md:135).
   */
  async getDuplicateCandidates(
    assetNumber?: string | null,
    serialNumber?: string | null,
    client?: any,
    limit: number = 50
  ): Promise<AssetRecord[]> {
    const an =
      assetNumber !== undefined && assetNumber !== null && assetNumber !== ''
        ? assetNumber
        : null;
    const sn =
      serialNumber !== undefined && serialNumber !== null && serialNumber !== ''
        ? serialNumber
        : null;

    if (!an && !sn) {
      return [];
    }

    const boundedLimit = Math.min(Math.max(1, limit || 50), 100);
    const runner = client || this.db;
    const queryText = `
      SELECT id, asset_number, serial_number, name, category, organization_unit,
             source_reference, source_notes, registered_by, recorded_at, created_at, updated_at
      FROM assets
      WHERE ($1::varchar IS NOT NULL AND asset_number = $1)
         OR ($2::varchar IS NOT NULL AND serial_number = $2)
      ORDER BY recorded_at DESC, id ASC
      LIMIT $3;
    `;

    const res = await runner.query(queryText, [an, sn, boundedLimit]);
    return res?.rows || [];
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
        const candidates = await this.getDuplicateCandidates(
          assetNumber,
          serialNumber,
          client
        );
        if (candidates.length > 0) {
          await client.query('ROLLBACK');
          throw new DuplicateCandidateWarningError(
            'Exact nonempty identifier matches existing asset records. Explicit continuation required to register a distinct item.',
            candidates
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
}
