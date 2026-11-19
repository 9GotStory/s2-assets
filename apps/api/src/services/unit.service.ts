import pg from 'pg';
import { normalizeLine } from './assignment.service.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

// F008-T1 (#176, #175 P7): the longest Unit name.
export const UNIT_NAME_MAX_LENGTH = 200;

// A Unit name as the list compares names: ignoring case and repeated spaces (#175 Q20). The unique index of
// 0025_material_catalog is on this same expression.
const comparedName = (expression: string) => `lower(regexp_replace(btrim(${expression}), ' +', ' ', 'g'))`;

// One entry of the shared Unit list (หน่วยนับ).
export interface UnitEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

/** A name the list already holds, Inactive entries included; the answer names that entry so it can be reactivated (Q20). */
export class UnitNameTakenError extends Error {
  statusCode = 409;
  code = 'DUPLICATE_NAME';
  entry: UnitEntry;

  constructor(entry: UnitEntry) {
    super('A Unit with this name is already in the list');
    this.name = 'UnitNameTakenError';
    this.entry = entry;
  }
}

const ENTRY_COLUMNS = 'id, name, is_active, version';

const isUniqueViolation = (err: any) => err?.code === '23505';

// Locks each named Unit FOR SHARE, so a concurrent Inactive waits for the caller's write, as findUnassignableEntry
// does for the Reference Lists (#175, Concurrency), and answers the ids not on the list or Inactive, in the order given.
export async function unselectableUnitsAmong(client: pg.PoolClient, unitIds: string[]): Promise<string[]> {
  const unselectable: string[] = [];
  for (const id of unitIds) {
    const res = await client.query('SELECT 1 FROM units WHERE id = $1 AND is_active FOR SHARE', [id]);
    if (res.rows.length === 0) {
      unselectable.push(id);
    }
  }
  return unselectable;
}

/**
 * F008-T1 (#176): the shared Unit list, following the Reference List pattern of Feature 002 (#175 P5): a Supply
 * Officer adds entries; nothing is deleted. Renaming and Inactive come with F008-T8.
 */
export class UnitService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** Every entry, Inactive ones included, by name. */
  async list(): Promise<UnitEntry[]> {
    const res = await this.db.query(`SELECT ${ENTRY_COLUMNS} FROM units ORDER BY lower(name) ASC, id ASC`);
    return res.rows;
  }

  async add(actorId: string, rawName: string, { retryToken }: { retryToken: string }): Promise<UnitEntry> {
    const name = normalizeLine(rawName, 'name', UNIT_NAME_MAX_LENGTH);
    if (name === null) {
      throw new ValidationError('name must not be blank');
    }
    try {
      return await commitOnce(this.db, { actorId, operation: 'unit:create', retryToken, payload: { name }, explicitContinuation: false }, async (client) => {
        const res = await client.query(`INSERT INTO units (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING ${ENTRY_COLUMNS}`, [name, actorId]);
        const entry: UnitEntry = res.rows[0];
        await client.query(`INSERT INTO unit_history (unit_id, version, action, changes, actor_id) VALUES ($1, $2, 'CREATED', $3, $4)`, [
          entry.id,
          entry.version,
          JSON.stringify({ name: { before: null, after: entry.name }, is_active: { before: null, after: entry.is_active } }),
          actorId,
        ]);
        return entry;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // The unique index answered after the entry holding the name committed, so it can be read now.
      const taken = await this.db.query(`SELECT ${ENTRY_COLUMNS} FROM units WHERE ${comparedName('name')} = ${comparedName('$1')}`, [name]);
      throw new UnitNameTakenError(taken.rows[0]);
    }
  }
}
