import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { hasStrictControlChars } from './control-characters.ts';

/**
 * T4 (#25, D7-A): flat managed reference lists for Asset reference context, each with the Asset
 * column that names one of its entries. An Administrator adds, renames, deactivates and
 * reactivates entries; nothing is deleted.
 */
export const REFERENCE_LISTS = Object.freeze({
  locations: { table: 'locations', assetColumn: 'location_id', historyColumn: 'location_id' },
  'organization-units': {
    table: 'organization_units',
    assetColumn: 'organization_unit_id',
    historyColumn: 'organization_unit_id',
  },
  persons: { table: 'persons', assetColumn: 'responsible_person_id', historyColumn: 'person_id' },
} as const);

export type ReferenceKind = keyof typeof REFERENCE_LISTS;
export type AssetReferenceColumn = (typeof REFERENCE_LISTS)[ReferenceKind]['assetColumn'];

export function isReferenceKind(kind: unknown): kind is ReferenceKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(REFERENCE_LISTS, kind);
}

/**
 * Locks each entry an Asset is to name FOR SHARE, so a concurrent deactivation waits for the
 * caller's write, and returns the first Asset column whose entry is missing from its own list or,
 * unless `allowInactive`, inactive: only active entries are assigned now (D7, F003 Q16).
 */
export async function findUnassignableEntry(
  client: pg.PoolClient | pg.Pool,
  ids: Partial<Record<AssetReferenceColumn, string | null>>,
  { allowInactive = false }: { allowInactive?: boolean } = {}
): Promise<AssetReferenceColumn | null> {
  for (const { table, assetColumn } of Object.values(REFERENCE_LISTS)) {
    const id = ids[assetColumn];
    if (!id) continue;
    const res = await client.query(
      `SELECT 1 FROM ${table} WHERE id = $1 AND (is_active OR $2::boolean) FOR SHARE`,
      [id, allowInactive]
    );
    if (res.rows.length === 0) {
      return assetColumn;
    }
  }
  return null;
}

export interface ReferenceEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

// One maintenance change of an entry (#25 PO decision 3): CREATED or CHANGED, at the entry
// version it produced, with each changed field's before and after.
export interface ReferenceHistoryItem {
  version: number;
  action: 'CREATED' | 'CHANGED';
  changes: Record<string, { before: string | boolean | null; after: string | boolean }>;
  actor_id: string;
  actor_username: string | null;
  recorded_at: string;
}

export interface ReferenceListResult {
  items: ReferenceEntry[];
  total: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

// Named apart from the built-in ReferenceError.
export class ReferenceListError extends Error {
  readonly statusCode: 400 | 404 | 409;
  readonly code: string;

  constructor(statusCode: 400 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = 'ReferenceListError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const REFERENCE_NAME_MAX_LENGTH = 200;

/** Trims a supplied entry name and rejects blank, overlong or control-character input. */
export function normalizeReferenceName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ReferenceListError(400, 'VALIDATION_FAILED', 'name must be a string');
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new ReferenceListError(400, 'VALIDATION_FAILED', 'name must not be blank');
  }
  if (name.length > REFERENCE_NAME_MAX_LENGTH) {
    throw new ReferenceListError(400, 'VALIDATION_FAILED', `name must be at most ${REFERENCE_NAME_MAX_LENGTH} characters`);
  }
  if (hasStrictControlChars(name)) {
    throw new ReferenceListError(400, 'VALIDATION_FAILED', 'name must not contain control characters');
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
    const table = REFERENCE_LISTS[kind].table;
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

  // Runs work in one transaction on one connection, rolling back on any error.
  private async transaction<T>(work: (client: pg.PoolClient | pg.Pool) => Promise<T>): Promise<T> {
    const client = typeof this.db.connect === 'function' ? await this.db.connect() : this.db;
    const shouldRelease = typeof this.db.connect === 'function';
    try {
      await client.query('BEGIN');
      const result = await work(client);
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
      if (shouldRelease) client.release();
    }
  }

  private async recordHistory(
    client: pg.PoolClient | pg.Pool,
    kind: ReferenceKind,
    actorId: string,
    entry: ReferenceEntry,
    action: ReferenceHistoryItem['action'],
    changes: ReferenceHistoryItem['changes']
  ): Promise<void> {
    await client.query(
      `INSERT INTO reference_entry_history (${REFERENCE_LISTS[kind].historyColumn}, version, action, changes, actor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.id, entry.version, action, JSON.stringify(changes), actorId]
    );
  }

  async create(kind: ReferenceKind, actorId: string, rawName: unknown): Promise<ReferenceEntry> {
    const name = normalizeReferenceName(rawName);
    const table = REFERENCE_LISTS[kind].table;
    try {
      return await this.transaction(async (client) => {
        const res = await client.query(
          `INSERT INTO ${table} (name, created_by, updated_by) VALUES ($1, $2, $2)
           RETURNING id, name, is_active, version`,
          [name, actorId]
        );
        const created = toEntry(res.rows[0]);
        await this.recordHistory(client, kind, actorId, created, 'CREATED', {
          name: { before: null, after: created.name },
          is_active: { before: null, after: created.is_active },
        });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ReferenceListError(409, 'DUPLICATE_NAME', 'An entry with this name already exists');
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
      throw new ReferenceListError(400, 'VALIDATION_FAILED', 'id must be a UUID');
    }
    const table = REFERENCE_LISTS[kind].table;
    const newName = changes.name === undefined ? undefined : normalizeReferenceName(changes.name);

    try {
      return await this.transaction(async (client) => {
        const currentRes = await client.query(
          `SELECT id, name, is_active, version FROM ${table} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (currentRes.rows.length === 0) {
          throw new ReferenceListError(404, 'NOT_FOUND', 'Reference entry not found');
        }
        const current = toEntry(currentRes.rows[0]);
        if (current.version !== changes.expected_version) {
          throw new ReferenceListError(409, 'VERSION_CONFLICT', 'The entry changed since it was read');
        }

        const name = newName ?? current.name;
        const isActive = changes.is_active ?? current.is_active;
        const changed: ReferenceHistoryItem['changes'] = {};
        if (name !== current.name) {
          changed.name = { before: current.name, after: name };
        }
        if (isActive !== current.is_active) {
          changed.is_active = { before: current.is_active, after: isActive };
        }
        if (Object.keys(changed).length === 0) {
          return current;
        }

        const updatedRes = await client.query(
          `UPDATE ${table}
           SET name = $2, is_active = $3, version = version + 1, updated_by = $4, updated_at = now()
           WHERE id = $1
           RETURNING id, name, is_active, version`,
          [id, name, isActive, actorId]
        );
        const updated = toEntry(updatedRes.rows[0]);
        await this.recordHistory(client, kind, actorId, updated, 'CHANGED', changed);
        return updated;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ReferenceListError(409, 'DUPLICATE_NAME', 'An entry with this name already exists');
      }
      throw err;
    }
  }

  /** An entry's maintenance history, oldest first (#25 PO decision 3). */
  async history(kind: ReferenceKind, id: string): Promise<ReferenceHistoryItem[]> {
    if (!isValidUuid(id)) {
      throw new ReferenceListError(400, 'VALIDATION_FAILED', 'id must be a UUID');
    }
    const { table, historyColumn } = REFERENCE_LISTS[kind];
    const entryRes = await this.db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (entryRes.rows.length === 0) {
      throw new ReferenceListError(404, 'NOT_FOUND', 'Reference entry not found');
    }
    const res = await this.db.query(
      `SELECT h.version, h.action, h.changes, h.actor_id, u.username AS actor_username, h.recorded_at
       FROM reference_entry_history h
       LEFT JOIN users u ON u.id = h.actor_id
       WHERE h.${historyColumn} = $1
       ORDER BY h.version ASC`,
      [id]
    );
    return res.rows.map((row: any) => ({
      version: row.version,
      action: row.action,
      changes: row.changes,
      actor_id: row.actor_id,
      actor_username: row.actor_username ?? null,
      recorded_at: new Date(row.recorded_at).toISOString(),
    }));
  }
}
