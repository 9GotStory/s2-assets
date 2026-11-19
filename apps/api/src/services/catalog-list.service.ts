import pg from 'pg';
import { normalizeLine } from './assignment.service.ts';
import { CATALOG_LISTS, type CatalogListKind } from './catalog-list-entries.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

// F008-T4 (#179, #175 P7): the longest Brand or Material Category name.
export const CATALOG_LIST_NAME_MAX_LENGTH = 200;

// A name as a list compares names: ignoring case and repeated spaces (#175 Q20). The unique indexes of
// 0027_brands_material_categories are on this same expression.
const comparedName = (expression: string) => `lower(regexp_replace(btrim(${expression}), ' +', ' ', 'g'))`;

// One entry of the Brand or the Material Category list.
export interface CatalogListEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

/** A name the list already holds, Inactive entries included; the answer names that entry so it can be reactivated (Q20). */
export class CatalogListNameTakenError extends Error {
  statusCode = 409;
  code = 'DUPLICATE_NAME';
  entry: CatalogListEntry;

  constructor(concept: string, entry: CatalogListEntry) {
    super(`A ${concept} with this name is already in the list`);
    this.name = 'CatalogListNameTakenError';
    this.entry = entry;
  }
}

const ENTRY_COLUMNS = 'id, name, is_active, version';

const isUniqueViolation = (err: any) => err?.code === '23505';

/**
 * Locks the entry `id` of the list `kind` FOR SHARE, so a concurrent Inactive waits for the caller's write, as
 * findUnassignableEntry does for the Reference Lists (#175, Concurrency), and answers it with its name now, or null
 * when it is not on the list or Inactive (Q21).
 */
export async function selectableCatalogListEntry(client: pg.PoolClient, kind: CatalogListKind, id: string): Promise<{ id: string; name: string } | null> {
  const res = await client.query(`SELECT id, name FROM ${CATALOG_LISTS[kind].table} WHERE id = $1 AND is_active FOR SHARE`, [id]);
  return res.rows[0] ?? null;
}

/** The entry `id` of the list `kind` under its name now, Inactive or not, for a history entry to record (#175 P6). */
export async function catalogListEntryOf(client: pg.PoolClient, kind: CatalogListKind, id: string): Promise<{ id: string; name: string }> {
  const res = await client.query(`SELECT id, name FROM ${CATALOG_LISTS[kind].table} WHERE id = $1`, [id]);
  return res.rows[0];
}

/**
 * F008-T4 (#179): the Brand (ยี่ห้อ) and Material Category (หมวดวัสดุ) lists, following the Unit list of F008-T1 and the
 * Reference List pattern of Feature 002 (#175 P5): a Supply Officer adds entries; nothing is deleted. Renaming and
 * Inactive come with F008-T8.
 */
export class CatalogListService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** Every entry of the list, Inactive ones included, by name. */
  async list(kind: CatalogListKind): Promise<CatalogListEntry[]> {
    const { table } = CATALOG_LISTS[kind];
    const res = await this.db.query(`SELECT ${ENTRY_COLUMNS} FROM ${table} ORDER BY lower(name) ASC, id ASC`);
    return res.rows;
  }

  async add(actorId: string, kind: CatalogListKind, rawName: string, { retryToken }: { retryToken: string }): Promise<CatalogListEntry> {
    const { table, history, column, concept } = CATALOG_LISTS[kind];
    const name = normalizeLine(rawName, 'name', CATALOG_LIST_NAME_MAX_LENGTH);
    if (name === null) {
      throw new ValidationError('name must not be blank');
    }
    try {
      return await commitOnce(this.db, { actorId, operation: `${kind}:create`, retryToken, payload: { name }, explicitContinuation: false }, async (client) => {
        const res = await client.query(`INSERT INTO ${table} (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING ${ENTRY_COLUMNS}`, [name, actorId]);
        const entry: CatalogListEntry = res.rows[0];
        await client.query(`INSERT INTO ${history} (${column}, version, action, changes, actor_id) VALUES ($1, $2, 'CREATED', $3, $4)`, [
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
      const taken = await this.db.query(`SELECT ${ENTRY_COLUMNS} FROM ${table} WHERE ${comparedName('name')} = ${comparedName('$1')}`, [name]);
      throw new CatalogListNameTakenError(concept, taken.rows[0]);
    }
  }
}
