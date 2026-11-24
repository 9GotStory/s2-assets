import pg from 'pg';
import { normalizeLine, normalizeText } from './assignment.service.ts';
import { comparedName } from './compared-name.ts';
import { CATALOG_LISTS, type CatalogListKind, type NamedListEntry } from './catalog-list-entries.ts';
import { commitOnce } from './retryable-write.ts';
import { materialReceiptUsageOf } from './material-receipt-read.service.ts';
import { stockMaterialUsageOf } from './stock-material-read.service.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

// F008-T1, T4 (#176, #179, #175 P7): the longest name of a Unit, a Brand or a Material Category.
export const CATALOG_LIST_NAME_MAX_LENGTH = 200;

// F010-T1 (#232, #231 P7): the longest note of a Source Party.
export const SOURCE_PARTY_NOTE_MAX_LENGTH = 2000;

// One entry of a list: the Unit, Brand, Material Category, Source Party or Source Type list. Only a Source Party holds a
// note (F010-T1, #232 decision 1).
export interface CatalogListEntry {
  id: string;
  name: string;
  note?: string | null;
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

// F008-T8 (#183): one maintenance change of an entry, CREATED or CHANGED, at the entry version it produced, with each
// changed field's before and after, as in Feature 002's Reference Lists (#175 P6).
export interface CatalogListHistoryEntry {
  version: number;
  action: 'CREATED' | 'CHANGED';
  changes: Record<string, { before: string | boolean | null; after: string | boolean | null }>;
  actor_id: string;
  actor_username: string;
  recorded_at: string;
}

// One entry as the list shows it (F008-T8, #175 P5): how many Stock Materials use it, and its history, oldest first.
export interface CatalogListItem extends CatalogListEntry {
  usage_count: number;
  history: CatalogListHistoryEntry[];
}

// The columns of an entry of the list `kind`: a Source Party's note too.
const entryColumnsOf = (kind: CatalogListKind): string => (kind === 'source-party' ? 'id, name, note, is_active, version' : 'id, name, is_active, version');

const isUniqueViolation = (err: any) => err?.code === '23505';

// The name a write gives an entry, once validated (#175 P7).
const entryNameOf = (rawName: string): string => {
  const name = normalizeLine(rawName, 'name', CATALOG_LIST_NAME_MAX_LENGTH);
  if (name === null) {
    throw new ValidationError('name must not be blank');
  }
  return name;
};

// The note a write gives a Source Party, once validated: none when blank (#231 P7).
const sourcePartyNoteOf = (rawNote: string | null | undefined): string | null => normalizeText(rawNote, 'note', SOURCE_PARTY_NOTE_MAX_LENGTH, '');

/**
 * Locks the entry `id` of the list `kind` FOR SHARE, so a concurrent Inactive waits for the caller's write, as
 * findUnassignableEntry does for the Reference Lists (#175, Concurrency), and answers it with its name now, or null
 * when it is not on the list or Inactive (Q21). It locks an Inactive entry too, so that a reactivation under way is
 * waited for and seen (F008-T8): a lock in the WHERE clause would pass over a row whose stored version does not match.
 */
export async function selectableCatalogListEntry(client: pg.PoolClient, kind: CatalogListKind, id: string): Promise<NamedListEntry | null> {
  const res = await client.query(`SELECT id, name, is_active FROM ${CATALOG_LISTS[kind].table} WHERE id = $1 FOR SHARE`, [id]);
  return res.rows[0]?.is_active ? { id: res.rows[0].id, name: res.rows[0].name } : null;
}

/**
 * The entry `id` of the list `kind` under its name now, Inactive or not, for a history entry to record (#175 P6),
 * locked FOR SHARE so that a concurrent rename waits for the caller's write or is seen by it.
 */
export async function catalogListEntryOf(client: pg.PoolClient, kind: CatalogListKind, id: string): Promise<NamedListEntry> {
  const res = await client.query(`SELECT id, name FROM ${CATALOG_LISTS[kind].table} WHERE id = $1 FOR SHARE`, [id]);
  return res.rows[0];
}

/**
 * F010-T3 (#234): the entry `id` of the list `kind` with its name now and whether it is active, locked FOR SHARE so
 * that an Inactive, a reactivation or a rename waits for the caller's write or is seen by it, as a Material Receipt
 * confirm reads its Source Party and Source Type (#231 P4, Q24). A foreign key holds `id` on the list, which deletes
 * nothing.
 */
export async function lockedCatalogListEntry(client: pg.PoolClient, kind: CatalogListKind, id: string): Promise<NamedListEntry & { is_active: boolean }> {
  const res = await client.query(`SELECT id, name, is_active FROM ${CATALOG_LISTS[kind].table} WHERE id = $1 FOR SHARE`, [id]);
  return res.rows[0];
}

// Locks each named Unit FOR SHARE, so a concurrent Inactive or reactivation waits for the caller's write, as
// selectableCatalogListEntry does, and answers the ids not on the list or Inactive, in the order given.
export async function unselectableUnitsAmong(client: pg.PoolClient, unitIds: string[]): Promise<string[]> {
  const unselectable: string[] = [];
  for (const id of unitIds) {
    const res = await client.query('SELECT is_active FROM units WHERE id = $1 FOR SHARE', [id]);
    if (!res.rows[0]?.is_active) {
      unselectable.push(id);
    }
  }
  return unselectable;
}

/**
 * The lists of the Stock Material catalog, following the Reference List pattern of Feature 002 (#175 P5): the shared
 * Unit list (หน่วยนับ, F008-T1), and the Brand (ยี่ห้อ) and Material Category (หมวดวัสดุ) lists (F008-T4). A Supply
 * Officer adds, renames, makes Inactive and reactivates entries (F008-T8); nothing is deleted.
 */
export class CatalogListService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** Every entry of the list, Inactive ones included, by name, with how many Stock Materials use it and its history. */
  async list(kind: CatalogListKind): Promise<CatalogListItem[]> {
    const { table, history, column } = CATALOG_LISTS[kind];
    const res = await this.db.query(`SELECT ${entryColumnsOf(kind)} FROM ${table} ORDER BY lower(name) ASC, id ASC`);
    const usage = await this.usageOf(kind);
    const historyRes = await this.db.query(
      `SELECT h.${column} AS entry_id, h.version, h.action, h.changes, h.actor_id, u.username AS actor_username, h.recorded_at
       FROM ${history} h
       JOIN users u ON u.id = h.actor_id
       ORDER BY h.version ASC`
    );
    const histories = new Map<string, CatalogListHistoryEntry[]>();
    for (const { entry_id: entryId, recorded_at: recordedAt, ...change } of historyRes.rows) {
      histories.set(entryId, [...(histories.get(entryId) ?? []), { ...change, recorded_at: new Date(recordedAt).toISOString() }]);
    }
    // An entry is added with its history in one transaction, so every entry read has one.
    return res.rows.map((entry: CatalogListEntry) => ({ ...entry, usage_count: usage.get(entry.id) ?? 0, history: histories.get(entry.id)! }));
  }

  /** Adds an entry named `input.name`; a Source Party takes `input.note` too (F010-T1, #232 decision 1). */
  async add(actorId: string, kind: CatalogListKind, input: { name: string; note?: string | null }, { retryToken }: { retryToken: string }): Promise<CatalogListEntry> {
    const { table, history, column } = CATALOG_LISTS[kind];
    const name = entryNameOf(input.name);
    const noted = kind === 'source-party';
    const note = noted ? sourcePartyNoteOf(input.note) : null;
    const payload = noted ? { name, note } : { name };
    try {
      return await commitOnce(this.db, { actorId, operation: `${kind}:create`, retryToken, payload, explicitContinuation: false }, async (client) => {
        const res = noted
          ? await client.query(`INSERT INTO ${table} (name, note, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING ${entryColumnsOf(kind)}`, [name, note, actorId])
          : await client.query(`INSERT INTO ${table} (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING ${entryColumnsOf(kind)}`, [name, actorId]);
        const entry: CatalogListEntry = res.rows[0];
        const changes = {
          name: { before: null, after: entry.name },
          ...(noted ? { note: { before: null, after: entry.note } } : {}),
          is_active: { before: null, after: entry.is_active },
        };
        await client.query(`INSERT INTO ${history} (${column}, version, action, changes, actor_id) VALUES ($1, $2, 'CREATED', $3, $4)`, [
          entry.id,
          entry.version,
          JSON.stringify(changes),
          actorId,
        ]);
        return entry;
      });
    } catch (err) {
      throw await this.nameTakenOr(err, kind, name);
    }
  }

  /**
   * F008-T8 (#183): renames the entry `id` to normalize its spelling, at the version the request read (#175 Q19, Q23).
   * Every Stock Material using it shows the new name; their history keeps the name as it was then (P6), and the
   * entry's own history keeps the old name and the new.
   */
  async rename(actorId: string, kind: CatalogListKind, id: string, input: { expected_version: number; name: string }, { retryToken }: { retryToken: string }): Promise<CatalogListEntry> {
    const name = entryNameOf(input.name);
    const payload = { id, expected_version: input.expected_version, name };
    try {
      return await commitOnce(this.db, { actorId, operation: `${kind}:rename`, retryToken, payload, explicitContinuation: false }, async (client) => {
        const stored = await this.lockedEntry(client, kind, id, input.expected_version);
        // #183 decision 2: a rename to the very same name is refused; one of case or spaces alone is a rename.
        if (name === stored.name) {
          throw new ValidationError('This rename changes nothing');
        }
        return this.change(client, kind, actorId, id, { name: { before: stored.name, after: name } }, { name, is_active: stored.is_active });
      });
    } catch (err) {
      throw await this.nameTakenOr(err, kind, name);
    }
  }

  /**
   * F010-T1 (#232 decision 1): changes the note of the Source Party `id` (แก้ไขหมายเหตุ), at the version the request
   * read; a blank note clears it. Its history keeps the old note and the new; a note that does not change is refused,
   * as a rename to the same name is (#183 decision 2).
   */
  async changeNote(actorId: string, id: string, input: { expected_version: number; note: string | null }, { retryToken }: { retryToken: string }): Promise<CatalogListEntry> {
    const note = sourcePartyNoteOf(input.note);
    const payload = { id, expected_version: input.expected_version, note };
    return commitOnce(this.db, { actorId, operation: 'source-party:note', retryToken, payload, explicitContinuation: false }, async (client) => {
      const stored = await this.lockedEntry(client, 'source-party', id, input.expected_version);
      if (note === stored.note) {
        throw new ValidationError('This note change changes nothing');
      }
      return this.change(client, 'source-party', actorId, id, { note: { before: stored.note ?? null, after: note } }, { name: stored.name, note, is_active: stored.is_active });
    });
  }

  /** F008-T8 (#183): makes the entry `id` Inactive (หยุดใช้): it stays on every Stock Material using it, but is no longer offered (#175 Q21). */
  async inactivate(actorId: string, kind: CatalogListKind, id: string, input: { expected_version: number }, options: { retryToken: string }): Promise<CatalogListEntry> {
    return this.changeStatus(actorId, kind, id, false, input.expected_version, options.retryToken);
  }

  /** F008-T8 (#183): reactivates an Inactive entry (เปิดใช้อีกครั้ง) as the same entry (#175 Q20). */
  async reactivate(actorId: string, kind: CatalogListKind, id: string, input: { expected_version: number }, options: { retryToken: string }): Promise<CatalogListEntry> {
    return this.changeStatus(actorId, kind, id, true, input.expected_version, options.retryToken);
  }

  // Makes the entry active or Inactive at the version the request read, with a history entry of the change; nothing is
  // deleted, merged or aliased (#175 MC-12, Q4). One already so is refused (#183 decision 2).
  private async changeStatus(actorId: string, kind: CatalogListKind, id: string, isActive: boolean, expectedVersion: number, retryToken: string): Promise<CatalogListEntry> {
    const operation = `${kind}:${isActive ? 'reactivate' : 'inactivate'}`;
    return commitOnce(this.db, { actorId, operation, retryToken, payload: { id, expected_version: expectedVersion }, explicitContinuation: false }, async (client) => {
      const stored = await this.lockedEntry(client, kind, id, expectedVersion);
      if (stored.is_active === isActive) {
        throw new ValidationError(`The ${CATALOG_LISTS[kind].concept} is already ${isActive ? 'active' : 'Inactive'}`);
      }
      return this.change(client, kind, actorId, id, { is_active: { before: stored.is_active, after: isActive } }, { name: stored.name, is_active: isActive });
    });
  }

  // Locks the entry `id` of the list `kind` FOR UPDATE and answers it as stored, refusing a version other than the
  // one the request read (#175 Q23).
  private async lockedEntry(client: pg.PoolClient, kind: CatalogListKind, id: string, expectedVersion: number): Promise<CatalogListEntry> {
    const { table, concept } = CATALOG_LISTS[kind];
    const res = await client.query(`SELECT ${entryColumnsOf(kind)} FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (res.rows.length === 0) {
      throw new NotFoundError(`${concept} not found`);
    }
    const stored: CatalogListEntry = res.rows[0];
    if (stored.version !== expectedVersion) {
      throw new StaleBeforeConflictError(`The ${concept} changed since it was read`, { version: stored.version }, { version: expectedVersion });
    }
    return stored;
  }

  // Writes the entry `id` with `values` at its next version, and its history entry of what changed; a Source Party's
  // note too when `values` has one.
  private async change(
    client: pg.PoolClient,
    kind: CatalogListKind,
    actorId: string,
    id: string,
    changes: Record<string, { before: string | boolean | null; after: string | boolean | null }>,
    values: { name: string; note?: string | null; is_active: boolean }
  ): Promise<CatalogListEntry> {
    const { table, history, column } = CATALOG_LISTS[kind];
    const res =
      values.note === undefined
        ? await client.query(
            `UPDATE ${table} SET name = $2, is_active = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING ${entryColumnsOf(kind)}`,
            [id, values.name, values.is_active, actorId]
          )
        : await client.query(
            `UPDATE ${table} SET name = $2, note = $5, is_active = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING ${entryColumnsOf(kind)}`,
            [id, values.name, values.is_active, actorId, values.note]
          );
    const entry: CatalogListEntry = res.rows[0];
    await client.query(`INSERT INTO ${history} (${column}, version, action, changes, actor_id) VALUES ($1, $2, 'CHANGED', $3, $4)`, [
      entry.id,
      entry.version,
      JSON.stringify(changes),
      actorId,
    ]);
    return entry;
  }

  // How many records name each entry of the list `kind`, by its id: Stock Materials for the lists of the catalog, and
  // Material Receipts, Drafts included, for a Source Party or a Source Type (#231 Model; #234 start decision 4).
  private async usageOf(kind: CatalogListKind): Promise<Map<string, number>> {
    return kind === 'source-party' || kind === 'source-type' ? materialReceiptUsageOf(this.db, kind) : stockMaterialUsageOf(this.db, kind);
  }

  // The answer to a write the unique index refused, naming the entry that holds the name (Q20), or `err` itself.
  private async nameTakenOr(err: unknown, kind: CatalogListKind, name: string): Promise<unknown> {
    if (!isUniqueViolation(err)) {
      return err;
    }
    const { table, concept } = CATALOG_LISTS[kind];
    // The unique index answered after the entry holding the name committed, so it can be read now.
    const taken = await this.db.query(`SELECT ${entryColumnsOf(kind)} FROM ${table} WHERE ${comparedName('name')} = ${comparedName('$1')}`, [name]);
    return new CatalogListNameTakenError(concept, taken.rows[0]);
  }
}
