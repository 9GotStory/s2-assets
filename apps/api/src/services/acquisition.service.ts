import * as crypto from 'node:crypto';
import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { ValidationError, RetryTokenConflictError, canonicalJson } from './asset.service.ts';

export interface AcquisitionRecord {
  id: string;
  acquisition_type: string | null;
  acquisition_date: string | null;
  total_amount: string | null;
  currency: string | null;
  source_reference: string | null;
  notes: string | null;
  recorded_at: string;
  created_by: string;
  created_at?: string;
  updated_at?: string;
  assets?: Array<{
    id: string;
    asset_number: string | null;
    serial_number: string | null;
    name: string | null;
    recorded_at: string;
  }>;
  total_assets?: number;
  has_more?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateAcquisitionInput {
  acquisition_type?: string | null;
  acquisition_date?: string | null;
  total_amount?: string | null;
  currency?: string | null;
  source_reference?: string | null;
  notes?: string | null;
}

export interface AcquisitionServiceOptions {
  db: pg.Pool | any;
}

const GREGORIAN_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DECIMAL_AMOUNT_REGEX = /^(0|[1-9]\d{0,15})\.\d{2}$/;

const DISALLOWED_UNKNOWN_TYPES = new Set(['unknown', 'n/a', '-', 'none', 'null', 'undefined']);

const PLACEHOLDER_STRINGS = new Set([
  '-',
  '--',
  '---',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  '.',
  '..',
  '...',
  '?',
  '??',
  '???',
  'unknown',
  'blank',
  'empty',
  '-/-',
]);

export function isPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_STRINGS.has(trimmed.toLowerCase())) return true;
  if (/^[\s\-_.~!?/\\*#@^&()+=]+$/.test(trimmed)) return true;
  return false;
}

export function isValidGregorianDate(dateStr: string): boolean {
  if (!GREGORIAN_DATE_REGEX.test(dateStr)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Month in JS Date is 0-indexed
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function formatDateOnly(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'string') {
    return val.split('T')[0];
  }
  if (val instanceof Date) {
    const year = val.getFullYear();
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const day = String(val.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(val);
}

export class AcquisitionService {
  private db: any;

  constructor(options: AcquisitionServiceOptions | any) {
    if (options && typeof options === 'object') {
      if ('query' in options) {
        this.db = options;
      } else if ('db' in options && options.db) {
        this.db = options.db;
      }
    }
  }

  /**
   * Computes deterministic SHA-256 fingerprint for normalized acquisition payload.
   */
  computePayloadFingerprint(input: CreateAcquisitionInput): string {
    const normalized = {
      acquisition_type: input.acquisition_type?.trim() || null,
      acquisition_date: input.acquisition_date || null,
      total_amount: input.total_amount ?? null,
      currency: input.currency ?? null,
      source_reference: input.source_reference?.trim() || null,
      notes: input.notes?.trim() || null,
    };
    return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
  }

  /**
   * Validates acquisition input according to D1 rules.
   */
  validateInput(input: CreateAcquisitionInput): {
    acquisition_type: string | null;
    acquisition_date: string | null;
    total_amount: string | null;
    currency: string | null;
    source_reference: string | null;
    notes: string | null;
  } {
    // 1. acquisition_type validation
    let acqType: string | null = null;
    if (input.acquisition_type !== undefined && input.acquisition_type !== null) {
      if (typeof input.acquisition_type !== 'string') {
        throw new ValidationError('acquisition_type must be a string');
      }
      const trimmed = input.acquisition_type.trim();
      if (trimmed.length === 0) {
        throw new ValidationError('acquisition_type must not be blank');
      }
      if (isPlaceholderText(trimmed) || DISALLOWED_UNKNOWN_TYPES.has(trimmed.toLowerCase())) {
        throw new ValidationError('Invented unknown acquisition_type labels are rejected');
      }
      if (trimmed.length > 255) {
        throw new ValidationError('acquisition_type exceeds maximum length of 255 characters');
      }
      acqType = trimmed;
    }

    // 2. acquisition_date validation
    let acqDate: string | null = null;
    if (input.acquisition_date !== undefined && input.acquisition_date !== null) {
      if (typeof input.acquisition_date !== 'string') {
        throw new ValidationError('acquisition_date must be a string');
      }
      const trimmed = input.acquisition_date.trim();
      if (!isValidGregorianDate(trimmed)) {
        throw new ValidationError('acquisition_date must be a valid Gregorian date in YYYY-MM-DD format');
      }
      acqDate = trimmed;
    }

    // 3. total_amount and currency validation
    let totalAmt: string | null = null;
    let curr: string | null = null;

    const hasTotal = input.total_amount !== undefined && input.total_amount !== null;
    const hasCurrency = input.currency !== undefined && input.currency !== null;

    if (hasTotal !== hasCurrency) {
      throw new ValidationError('total_amount and currency must be provided together or both omitted');
    }

    if (hasTotal && hasCurrency) {
      if (typeof input.total_amount !== 'string') {
        throw new ValidationError('total_amount must be a decimal string with two fractional digits');
      }
      if (!DECIMAL_AMOUNT_REGEX.test(input.total_amount)) {
        throw new ValidationError('total_amount must be a decimal string with exactly two fractional digits (e.g. 150.00)');
      }
      if (typeof input.currency !== 'string' || input.currency !== 'THB') {
        throw new ValidationError('currency must be THB');
      }
      totalAmt = input.total_amount;
      curr = 'THB';
    }

    // 4. source_reference validation
    let srcRef: string | null = null;
    if (input.source_reference !== undefined && input.source_reference !== null) {
      if (typeof input.source_reference !== 'string') {
        throw new ValidationError('source_reference must be a string');
      }
      const trimmed = input.source_reference.trim();
      if (trimmed.length === 0) {
        throw new ValidationError('source_reference must not be blank');
      }
      if (isPlaceholderText(trimmed)) {
        throw new ValidationError('source_reference cannot be a placeholder value (e.g. "-", "n/a")');
      }
      if (trimmed.length > 255) {
        throw new ValidationError('source_reference exceeds maximum length of 255 characters');
      }
      srcRef = trimmed;
    }

    // 5. notes validation
    let notesVal: string | null = null;
    if (input.notes !== undefined && input.notes !== null) {
      if (typeof input.notes !== 'string') {
        throw new ValidationError('notes must be a string');
      }
      const trimmed = input.notes.trim();
      if (trimmed.length === 0) {
        throw new ValidationError('notes must not be blank');
      }
      if (isPlaceholderText(trimmed)) {
        throw new ValidationError('notes cannot be a placeholder value (e.g. "-", "n/a")');
      }
      if (trimmed.length > 2000) {
        throw new ValidationError('notes exceeds maximum length of 2000 characters');
      }
      notesVal = trimmed;
    }

    // Minimum requirement: At least one genuinely known approved Acquisition fact
    if (!acqType && !acqDate && !totalAmt && !srcRef && !notesVal) {
      throw new ValidationError('At least one known approved acquisition fact is required to create an acquisition reference');
    }

    return {
      acquisition_type: acqType,
      acquisition_date: acqDate,
      total_amount: totalAmt,
      currency: curr,
      source_reference: srcRef,
      notes: notesVal,
    };
  }

  /**
   * Creates a new Acquisition reference with retry token idempotency contract.
   */
  async createAcquisition(
    actorId: string,
    input: CreateAcquisitionInput,
    options?: { retryToken?: string }
  ): Promise<AcquisitionRecord> {
    if (!isValidUuid(actorId)) {
      throw new ValidationError('Valid actorId UUID is required for acquisition creation');
    }

    const rawToken = options?.retryToken;
    if (rawToken === undefined || rawToken === null || typeof rawToken !== 'string' || rawToken.trim() === '') {
      throw new ValidationError('Missing or blank retry token: acquisition creation requires a nonblank retry token');
    }
    const retryToken = rawToken.trim();

    if ((input as any).retry_token !== undefined && (input as any).retry_token !== null) {
      const payloadToken = String((input as any).retry_token).trim();
      if (payloadToken && payloadToken !== retryToken) {
        throw new ValidationError('Contradictory retry token in options and payload');
      }
    }

    const validated = this.validateInput(input);
    const fingerprint = this.computePayloadFingerprint(input);

    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN');

      // 1. Idempotency check with advisory lock
      if (retryToken && fingerprint) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `acquisition_retry:${actorId}:${retryToken}`,
        ]);

        const tokenRes = await client.query(
          `SELECT payload_fingerprint, response_status, response_body
           FROM registration_retry_tokens
           WHERE actor_id = $1 AND operation = 'acquisition:create' AND token = $2`,
          [actorId, retryToken]
        );

        if (tokenRes.rows.length > 0) {
          const existing = tokenRes.rows[0];
          if (existing.payload_fingerprint === fingerprint) {
            await client.query('COMMIT');
            return existing.response_body as AcquisitionRecord;
          } else {
            await client.query('ROLLBACK');
            throw new RetryTokenConflictError(
              'Retry token reused with different payload is rejected without writes'
            );
          }
        }
      }

      // 2. Insert acquisition record
      const acqId = crypto.randomUUID();
      const insertQuery = `
        INSERT INTO acquisitions (
          id, acquisition_type, acquisition_date, total_amount, currency,
          source_reference, notes, recorded_at, created_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, now(), $8, now(), now()
        )
        RETURNING id, acquisition_type, acquisition_date, total_amount, currency,
                  source_reference, notes, recorded_at, created_by, created_at, updated_at;
      `;

      const insertRes = await client.query(insertQuery, [
        acqId,
        validated.acquisition_type,
        validated.acquisition_date,
        validated.total_amount,
        validated.currency,
        validated.source_reference,
        validated.notes,
        actorId,
      ]);

      const row = insertRes.rows[0];

      // Format date
      const formattedDate = formatDateOnly(row.acquisition_date);

      const result: AcquisitionRecord = {
        id: row.id,
        acquisition_type: row.acquisition_type,
        acquisition_date: formattedDate,
        total_amount: row.total_amount !== null ? String(row.total_amount) : null,
        currency: row.currency,
        source_reference: row.source_reference,
        notes: row.notes,
        recorded_at: new Date(row.recorded_at).toISOString(),
        created_by: row.created_by,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };

      // 3. Store retry token
      if (retryToken && fingerprint) {
        try {
          await client.query(
            `INSERT INTO registration_retry_tokens (
              token, actor_id, operation, payload_fingerprint, response_status, response_body
            ) VALUES ($1, $2, 'acquisition:create', $3, 201, $4)`,
            [retryToken, actorId, fingerprint, JSON.stringify(result)]
          );
        } catch (insertErr: any) {
          if (insertErr?.code === '23505') {
            const existingRes = await client.query(
              `SELECT payload_fingerprint, response_body
               FROM registration_retry_tokens
               WHERE actor_id = $1 AND operation = 'acquisition:create' AND token = $2`,
              [actorId, retryToken]
            );
            if (
              existingRes.rows.length > 0 &&
              existingRes.rows[0].payload_fingerprint === fingerprint
            ) {
              await client.query('COMMIT');
              return existingRes.rows[0].response_body as AcquisitionRecord;
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
        // ignore rollback on closed connection
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * Retrieves an Acquisition by exact UUID, optionally including linked assets with pagination.
   */
  async getAcquisitionById(
    id: string,
    options?: { includeAssets?: boolean; limit?: number; offset?: number }
  ): Promise<AcquisitionRecord | null> {
    if (!isValidUuid(id)) {
      return null;
    }

    const pool = this.db;
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const shouldRelease = typeof pool.connect === 'function';

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

      const acqRes = await client.query(
        `SELECT id, acquisition_type, acquisition_date, total_amount, currency,
                source_reference, notes, recorded_at, created_by, created_at, updated_at
         FROM acquisitions
         WHERE id = $1`,
        [id.trim()]
      );

      if (acqRes.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const row = acqRes.rows[0];

      const formattedDate = formatDateOnly(row.acquisition_date);

      const result: AcquisitionRecord = {
        id: row.id,
        acquisition_type: row.acquisition_type,
        acquisition_date: formattedDate,
        total_amount: row.total_amount !== null ? String(row.total_amount) : null,
        currency: row.currency,
        source_reference: row.source_reference,
        notes: row.notes,
        recorded_at: new Date(row.recorded_at).toISOString(),
        created_by: row.created_by,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };

      if (options?.includeAssets) {
        const limit = Math.min(Math.max(1, options.limit || 25), 100);
        const offset = Math.max(0, options.offset || 0);

        const assetsRes = await client.query(
          `SELECT id, asset_number, serial_number, name, recorded_at,
                  count(*) OVER()::int as total_count
           FROM assets
           WHERE acquisition_id = $1
           ORDER BY recorded_at DESC, id ASC
           LIMIT $2 OFFSET $3`,
          [id.trim(), limit, offset]
        );

        let totalAssets = 0;
        if (assetsRes.rows.length > 0) {
          totalAssets = assetsRes.rows[0].total_count ?? 0;
        } else if (offset > 0) {
          const countRes = await client.query(
            `SELECT count(*)::int as count FROM assets WHERE acquisition_id = $1`,
            [id.trim()]
          );
          totalAssets = countRes.rows[0]?.count ?? 0;
        }

        const linkedAssets = assetsRes.rows.map((r: any) => ({
          id: r.id,
          asset_number: r.asset_number,
          serial_number: r.serial_number,
          name: r.name,
          recorded_at: new Date(r.recorded_at).toISOString(),
        }));

        result.assets = linkedAssets;
        result.total_assets = totalAssets;
        result.has_more = offset + linkedAssets.length < totalAssets;
        result.limit = limit;
        result.offset = offset;
      }

      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }
}
