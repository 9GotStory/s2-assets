import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { hasStrictControlChars } from './evidence.service.ts';

/**
 * T4 (#25, D7-A): flat managed reference lists for Asset reference context.
 * An Administrator adds, renames, deactivates and reactivates entries; nothing is deleted.
 */
export const REFERENCE_KIND_TABLES = Object.freeze({
  locations: 'locations',
  'organization-units': 'organization_units',
  persons: 'persons',
} as const);

export type ReferenceKind = keyof typeof REFERENCE_KIND_TABLES;

export function isReferenceKind(kind: unknown): kind is ReferenceKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(REFERENCE_KIND_TABLES, kind);
}

export interface ReferenceEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

export interface ReferenceListResult {
  items: ReferenceEntry[];
  total: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

export class ReferenceError extends Error {
  readonly statusCode: 400 | 404 | 409;
  readonly code: string;

  constructor(statusCode: 400 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = 'ReferenceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const REFERENCE_NAME_MAX_LENGTH = 200;

/** Trims a supplied entry name and rejects blank, overlong or control-character input. */
export function normalizeReferenceName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ReferenceError(400, 'VALIDATION_FAILED', 'name must be a string');
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new ReferenceError(400, 'VALIDATION_FAILED', 'name must not be blank');
  }
  if (name.length > REFERENCE_NAME_MAX_LENGTH) {
    throw new ReferenceError(400, 'VALIDATION_FAILED', `name must be at most ${REFERENCE_NAME_MAX_LENGTH} characters`);
  }
  if (hasStrictControlChars(name)) {
    throw new ReferenceError(400, 'VALIDATION_FAILED', 'name must not contain control characters');
  }
  return name;
}

const toEntry = (row: any): ReferenceEntry => ({
  id: row.id,
  name: row.name,
  is_active: row.is_active,
  version: row.version,
});

const isUniqueViolation = (err: any) => err?.code === '23505';

export class ReferenceService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  async list(
    kind: ReferenceKind,
    options: { includeInactive: boolean; limit: number; offset: number }
  ): Promise<ReferenceListResult> {
    const table = REFERENCE_KIND_TABLES[kind];
    const res = await this.db.query(
      `SELECT id, name, is_active, version, count(*) OVER()::int AS total
       FROM ${table}
       WHERE ($1::boolean OR is_active)
       ORDER BY lower(name) ASC, id ASC
       LIMIT $2 OFFSET $3`,
      [options.includeInactive, options.limit, options.offset]
    );
    let total = res.rows[0]?.total ?? 0;
    if (res.rows.length === 0 && options.offset > 0) {
      const countRes = await this.db.query(
        `SELECT count(*)::int AS total FROM ${table} WHERE ($1::boolean OR is_active)`,
        [options.includeInactive]
      );
      total = countRes.rows[0]?.total ?? 0;
    }
    return {
      items: res.rows.map(toEntry),
      total,
      has_more: options.offset + res.rows.length < total,
      limit: options.limit,
      offset: options.offset,
    };
  }

  async create(kind: ReferenceKind, actorId: string, rawName: unknown): Promise<ReferenceEntry> {
    const name = normalizeReferenceName(rawName);
    const table = REFERENCE_KIND_TABLES[kind];
    try {
      const res = await this.db.query(
        `INSERT INTO ${table} (name, created_by, updated_by) VALUES ($1, $2, $2)
         RETURNING id, name, is_active, version`,
        [name, actorId]
      );
      return toEntry(res.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ReferenceError(409, 'DUPLICATE_NAME', 'An entry with this name already exists');
      }
      throw err;
    }
  }

  /**
   * Renames, deactivates or reactivates one entry under optimistic concurrency. A request that
   * changes nothing returns the entry unchanged, at the same version.
   */
  async update(
    kind: ReferenceKind,
    actorId: string,
    id: string,
    changes: { expected_version: number; name?: unknown; is_active?: boolean }
  ): Promise<ReferenceEntry> {
    if (!isValidUuid(id)) {
      throw new ReferenceError(400, 'VALIDATION_FAILED', 'id must be a UUID');
    }
    const table = REFERENCE_KIND_TABLES[kind];
    const newName = changes.name === undefined ? undefined : normalizeReferenceName(changes.name);

    const client = typeof this.db.connect === 'function' ? await this.db.connect() : this.db;
    const shouldRelease = typeof this.db.connect === 'function';
    try {
      await client.query('BEGIN');
      const currentRes = await client.query(
        `SELECT id, name, is_active, version FROM ${table} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentRes.rows.length === 0) {
        throw new ReferenceError(404, 'NOT_FOUND', 'Reference entry not found');
      }
      const current = toEntry(currentRes.rows[0]);
      if (current.version !== changes.expected_version) {
        throw new ReferenceError(409, 'VERSION_CONFLICT', 'The entry changed since it was read');
      }

      const name = newName ?? current.name;
      const isActive = changes.is_active ?? current.is_active;
      if (name === current.name && isActive === current.is_active) {
        await client.query('COMMIT');
        return current;
      }

      const updated = await client.query(
        `UPDATE ${table}
         SET name = $2, is_active = $3, version = version + 1, updated_by = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, name, is_active, version`,
        [id, name, isActive, actorId]
      );
      await client.query('COMMIT');
      return toEntry(updated.rows[0]);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error on closed connection
      }
      if (isUniqueViolation(err)) {
        throw new ReferenceError(409, 'DUPLICATE_NAME', 'An entry with this name already exists');
      }
      throw err;
    } finally {
      if (shouldRelease) client.release();
    }
  }
}
