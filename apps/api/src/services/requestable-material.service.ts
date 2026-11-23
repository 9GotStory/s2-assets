import pg from 'pg';
import { normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { type NamedListEntry } from './catalog-list-entries.ts';
import { catalogListEntryOf, selectableCatalogListEntry } from './catalog-list.service.ts';
import { comparedName } from './compared-name.ts';
import { requestedItemsUse } from './material-request-uses.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { lockedStockMaterial, stockMaterialForCompatibility } from './stock-material-read.service.ts';
import { ValidationError } from './validation-error.ts';

// #202 P7: the longest name and description of a Requestable Material.
export const REQUESTABLE_MATERIAL_NAME_MAX_LENGTH = 200;
export const REQUESTABLE_MATERIAL_DESCRIPTION_MAX_LENGTH = 2000;

export interface CreateRequestableMaterialInput {
  name: string;
  // The Request Unit (หน่วยที่ขอ): an active Unit of the shared list (MRQ-28, Q15).
  request_unit_id: string;
  // Whole-number-only unless told otherwise (Q5).
  whole_number_only?: boolean;
  description?: string | null;
}

// What a Requestable Material write answers: the Requestable Material it wrote and the version a later write must expect.
export interface RequestableMaterialVersion {
  requestable_material_id: string;
  version: number;
}

// F009-T2 (#204): adding a Compatible Stock Material (วัสดุที่ใช้จ่ายได้) at the version of the Requestable Material the
// request read (#202 Q17).
export interface AddCompatibleStockMaterialInput {
  stock_material_id: string;
  expected_version: number;
}

// F009-T2 (#204): ending a Compatible Stock Material at the version of the Requestable Material the request read.
export interface EndCompatibleStockMaterialInput {
  expected_version: number;
}

// F009-T8 (#210): a Rename (เปลี่ยนชื่อ) of a Requestable Material, at the version the request read (#202 Q6, Q17).
export interface RenameInput {
  expected_version: number;
  name: string;
}

// F009-T8 (#210): the Other Details (ข้อมูลอื่น) of a Requestable Material as they should be, each stated, null for no
// description, at the version the request read (#202 Q17, P2).
export interface ChangeDetailsInput {
  expected_version: number;
  description: string | null;
  whole_number_only: boolean;
  request_unit_id: string;
}

// F009-T7 (#209): making a Requestable Material Inactive or reactivating it, at the version the request read (#202 Q17).
export interface StatusChangeInput {
  expected_version: number;
}

interface StatusChange {
  isActive: boolean;
  operation: string;
  kind: 'INACTIVATED' | 'REACTIVATED';
  // The refusal of a Requestable Material already so.
  alreadySo: string;
}

const STATUS_CHANGES = Object.freeze({
  inactivate: { isActive: false, operation: 'requestable-material:inactivate', kind: 'INACTIVATED', alreadySo: 'The Requestable Material is already Inactive' },
  reactivate: { isActive: true, operation: 'requestable-material:reactivate', kind: 'REACTIVATED', alreadySo: 'The Requestable Material is already active' },
} as const);

// A Requestable Material as the refusal of a name already used names it.
export interface RequestableMaterialEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

/** A name another Requestable Material holds, Inactive ones included; the answer names it so it can be reactivated (Q6). */
export class RequestableMaterialNameTakenError extends Error {
  statusCode = 409;
  code = 'DUPLICATE_NAME';
  entry: RequestableMaterialEntry;

  constructor(entry: RequestableMaterialEntry) {
    super('A Requestable Material with this name already exists');
    this.name = 'RequestableMaterialNameTakenError';
    this.entry = entry;
  }
}

// The refusal of the unique index on the compared name (0029_requestable_materials).
const isNameTaken = (err: any) => err?.constraint === 'requestable_materials_name_unique';

// A name as stored: one line (CODING_STANDARDS, "A text field's kind decides its control characters"), not blank.
const nameOf = (value: string): string => {
  const name = normalizeLine(value, 'name', REQUESTABLE_MATERIAL_NAME_MAX_LENGTH);
  if (name === null) {
    throw new ValidationError('name must not be blank');
  }
  return name;
};

// A Request Unit's id as stored.
const requestUnitIdOf = (value: unknown): string => {
  if (!isValidUuid(value)) {
    throw new ValidationError('request_unit_id must be a valid UUID');
  }
  return (value as string).trim().toLowerCase();
};

// A description as stored: free text, keeping tab and line breaks inside it; none when blank.
const descriptionOf = (value: string | null | undefined): string | null => normalizeText(value, 'description', REQUESTABLE_MATERIAL_DESCRIPTION_MAX_LENGTH, '');

// A request's facts once validated, before any lock. The retry fingerprint covers these.
const normalizeFacts = (input: CreateRequestableMaterialInput) => ({
  name: nameOf(input.name),
  request_unit_id: requestUnitIdOf(input.request_unit_id),
  whole_number_only: input.whole_number_only ?? true,
  description: descriptionOf(input.description),
});

// F009-T2 (#204): the Stock Material a Compatible Stock Material write names.
const stockMaterialIdOf = (value: unknown): string => {
  if (!isValidUuid(value)) {
    throw new ValidationError('stock_material_id must be a valid UUID');
  }
  return (value as string).trim().toLowerCase();
};

// A Requestable Material's fields as its row stores them.
interface StoredRequestableMaterial {
  name: string;
  request_unit_id: string;
  whole_number_only: boolean;
  description: string | null;
  is_active: boolean;
}

// Locks the Requestable Material `id` FOR UPDATE, so writes on it take turns, and checks that it is at the version the
// request read (#202 Q17): its fields, or the refusal.
const lockedAtVersion = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<StoredRequestableMaterial> => {
  const res = await client.query('SELECT version, name, request_unit_id, whole_number_only, description, is_active FROM requestable_materials WHERE id = $1 FOR UPDATE', [id]);
  if (res.rows.length === 0) {
    throw new NotFoundError('Requestable Material not found');
  }
  const stored = res.rows[0];
  if (stored.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Requestable Material changed since it was read', { version: stored.version }, { version: expectedVersion });
  }
  return stored;
};

// F009-T2 (#204): the pair of the Requestable Material and the Stock Material, read after the Requestable Material's
// lock, or null when it was never added.
const pairOf = async (client: pg.PoolClient, requestableMaterialId: string, stockMaterialId: string): Promise<{ is_current: boolean } | null> => {
  const res = await client.query('SELECT is_current FROM compatible_stock_materials WHERE requestable_material_id = $1 AND stock_material_id = $2', [
    requestableMaterialId,
    stockMaterialId,
  ]);
  return res.rows[0] ?? null;
};

// F009-T8 (#210): the Request Unit of the Requestable Material `id`, locked FOR UPDATE by the caller, changing from
// `fromUnitId` to `toUnitId` under P2, or the refusal: the new Unit active on the list (Q15), no Requested Item
// asking for it (P2, #210 start decision 3), and every current Compatible Stock Material having it among its active
// Units (ADR 0002). Answers both Units under their names now, for the history (#175 P6).
const requestUnitChange = async (client: pg.PoolClient, id: string, fromUnitId: string, toUnitId: string): Promise<{ before: NamedListEntry; after: NamedListEntry }> => {
  // Locks the new Unit FOR SHARE, so making it Inactive or renaming it waits for this write or is seen by it.
  const after = await selectableCatalogListEntry(client, 'unit', toUnitId);
  if (after === null) {
    throw new ValidationError('request_unit_id must name an active Unit of the list');
  }
  if (await requestedItemsUse(client, id)) {
    throw new ValidationError('request_unit_id cannot change while Requested Items use this Requestable Material');
  }
  // The Requestable Material's lock keeps its Compatible Stock Materials as they are. Each Stock Material is locked
  // FOR SHARE, in id order, so that a Units write waits for this write or is seen by it (#205 start decision 3).
  const current = await client.query('SELECT stock_material_id FROM compatible_stock_materials WHERE requestable_material_id = $1 AND is_current ORDER BY stock_material_id', [id]);
  const lacking: string[] = [];
  for (const { stock_material_id: stockMaterialId } of current.rows) {
    const stockMaterial = (await stockMaterialForCompatibility(client, stockMaterialId, toUnitId))!;
    if (!stockMaterial.handles_request_unit) {
      lacking.push(stockMaterial.name);
    }
  }
  if (lacking.length > 0) {
    const names = lacking
      .sort((a, b) => a.localeCompare(b, 'th'))
      .map((name) => JSON.stringify(name))
      .join(', ');
    throw new ValidationError(`request_unit_id names a Unit that is not an active Unit of the current Compatible Stock Materials ${names}; add it to their Units or end them first`);
  }
  return { before: await catalogListEntryOf(client, 'unit', fromUnitId), after };
};

// Moves the Requestable Material `id` to its next version with a history entry of `kind` listing `changes`, and
// answers that version.
const recordChange = async (
  client: pg.PoolClient,
  actorId: string,
  id: string,
  kind: string,
  changes: { field: string; before: unknown; after: unknown }[]
): Promise<RequestableMaterialVersion> => {
  const updated = await client.query('UPDATE requestable_materials SET version = version + 1 WHERE id = $1 RETURNING version', [id]);
  const { version } = updated.rows[0];
  await client.query(
    'INSERT INTO requestable_material_history (requestable_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [id, version, kind, JSON.stringify(changes), actorId]
  );
  return { requestable_material_id: id, version };
};

/**
 * F009-T1 (#203): the writes of the Requestable Materials (วัสดุสำหรับขอเบิก) that a Supply Officer keeps for Requesters
 * to ask for in the words of their work (#202 MRQ-01, Q5). Each is its own record under a Stable ID, and every change
 * appends to its history (Q17). The reads are in requestable-material-read.service.ts.
 */
export class RequestableMaterialService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  async create(actorId: string, input: CreateRequestableMaterialInput, { retryToken }: { retryToken: string }): Promise<RequestableMaterialVersion> {
    const facts = normalizeFacts(input);
    try {
      return await commitOnce(this.db, { actorId, operation: 'requestable-material:create', retryToken, payload: facts, explicitContinuation: false }, async (client) => {
        // Locks the Unit FOR SHARE, so making it Inactive or renaming it waits for this write or is seen by it, and
        // reads its name now for the history (#175 P6).
        const requestUnit = await selectableCatalogListEntry(client, 'unit', facts.request_unit_id);
        if (requestUnit === null) {
          throw new ValidationError('request_unit_id must name an active Unit of the list');
        }

        const res = await client.query(
          `INSERT INTO requestable_materials (name, request_unit_id, whole_number_only, description, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, version`,
          [facts.name, facts.request_unit_id, facts.whole_number_only, facts.description, actorId]
        );
        const { id, version } = res.rows[0];

        // The values created, the description only when it has one, the Request Unit under its name now.
        const recorded = { name: facts.name, request_unit: requestUnit, whole_number_only: facts.whole_number_only, description: facts.description };
        const changes = Object.entries(recorded)
          .filter(([, value]) => value !== null)
          .map(([field, after]) => ({ field, before: null, after }));
        await client.query(
          `INSERT INTO requestable_material_history (requestable_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'CREATED', $3::jsonb, $4)`,
          [id, version, JSON.stringify(changes), actorId]
        );
        return { requestable_material_id: id, version };
      });
    } catch (err) {
      throw await this.nameTakenOr(err, facts.name);
    }
  }

  /**
   * F009-T2 (#204): confirms the Stock Material `input.stock_material_id` as a Compatible Stock Material of the
   * Requestable Material `requestableMaterialId` (#202 MRQ-15, MRQ-26): an active Stock Material whose active Units
   * include the Request Unit (Q7, Q8, ADR 0002), not already current. A pair ended before becomes current again in its
   * own row (P1). The history records the Stock Material under its name now (#175 P6).
   */
  async addCompatibleStockMaterial(
    actorId: string,
    requestableMaterialId: string,
    input: AddCompatibleStockMaterialInput,
    { retryToken }: { retryToken: string }
  ): Promise<RequestableMaterialVersion> {
    const stockMaterialId = stockMaterialIdOf(input.stock_material_id);
    const payload = { requestable_material_id: requestableMaterialId, stock_material_id: stockMaterialId, expected_version: input.expected_version };
    return commitOnce(this.db, { actorId, operation: 'compatible-stock-material:add', retryToken, payload, explicitContinuation: false }, async (client) => {
      const { request_unit_id: requestUnitId } = await lockedAtVersion(client, requestableMaterialId, input.expected_version);
      const stockMaterial = await stockMaterialForCompatibility(client, stockMaterialId, requestUnitId);
      if (stockMaterial === null) {
        throw new ValidationError('stock_material_id must name a Stock Material');
      }
      if (!stockMaterial.is_active) {
        throw new ValidationError('stock_material_id names an Inactive Stock Material, which cannot become a Compatible Stock Material');
      }
      if (!stockMaterial.handles_request_unit) {
        throw new ValidationError('stock_material_id names a Stock Material whose active Units do not include the Request Unit');
      }
      const pair = await pairOf(client, requestableMaterialId, stockMaterialId);
      if (pair?.is_current) {
        throw new ValidationError('stock_material_id is already a current Compatible Stock Material');
      }
      await client.query(
        `INSERT INTO compatible_stock_materials (requestable_material_id, stock_material_id) VALUES ($1, $2)
         ON CONFLICT (requestable_material_id, stock_material_id) DO UPDATE SET is_current = true`,
        [requestableMaterialId, stockMaterialId]
      );
      const after = { id: stockMaterialId, name: stockMaterial.name };
      return recordChange(client, actorId, requestableMaterialId, 'COMPATIBLE_STOCK_MATERIAL_ADDED', [{ field: 'compatible_stock_material', before: null, after }]);
    });
  }

  /**
   * F009-T2 (#204): ends the current Compatible Stock Material `stockMaterialId` of the Requestable Material
   * `requestableMaterialId`, whatever the Stock Material's status: its row stays, not current, and can be added again
   * (#202 MRQ-30, Q8, P1). One already ended is refused (#204 start decision 1). The history records the Stock Material
   * under its name now (#175 P6).
   */
  async endCompatibleStockMaterial(
    actorId: string,
    requestableMaterialId: string,
    stockMaterialId: string,
    input: EndCompatibleStockMaterialInput,
    { retryToken }: { retryToken: string }
  ): Promise<RequestableMaterialVersion> {
    const payload = { requestable_material_id: requestableMaterialId, stock_material_id: stockMaterialId, expected_version: input.expected_version };
    return commitOnce(this.db, { actorId, operation: 'compatible-stock-material:end', retryToken, payload, explicitContinuation: false }, async (client) => {
      await lockedAtVersion(client, requestableMaterialId, input.expected_version);
      const pair = await pairOf(client, requestableMaterialId, stockMaterialId);
      if (pair === null) {
        throw new NotFoundError('Compatible Stock Material not found');
      }
      if (!pair.is_current) {
        throw new ValidationError('The Stock Material is not a current Compatible Stock Material');
      }
      // The pair's foreign key keeps the Stock Material.
      const stockMaterial = (await lockedStockMaterial(client, stockMaterialId))!;
      await client.query('UPDATE compatible_stock_materials SET is_current = false WHERE requestable_material_id = $1 AND stock_material_id = $2', [
        requestableMaterialId,
        stockMaterialId,
      ]);
      const before = { id: stockMaterialId, name: stockMaterial.name };
      return recordChange(client, actorId, requestableMaterialId, 'COMPATIBLE_STOCK_MATERIAL_ENDED', [{ field: 'compatible_stock_material', before, after: null }]);
    });
  }

  /**
   * F009-T8 (#210): renames the Requestable Material `requestableMaterialId` to fix its spelling, never its meaning: a
   * different meaning is a new Requestable Material (#202 Q6). The name keeps the create's rules, unique after
   * normalization with Inactive ones (P7), and the history keeps the old name and the new (Q17). The very same name
   * is refused; a change of case or spaces alone is a Rename (#183 decision 2).
   */
  async rename(actorId: string, requestableMaterialId: string, input: RenameInput, { retryToken }: { retryToken: string }): Promise<RequestableMaterialVersion> {
    const name = nameOf(input.name);
    const payload = { requestable_material_id: requestableMaterialId, expected_version: input.expected_version, name };
    try {
      return await commitOnce(this.db, { actorId, operation: 'requestable-material:rename', retryToken, payload, explicitContinuation: false }, async (client) => {
        const stored = await lockedAtVersion(client, requestableMaterialId, input.expected_version);
        if (stored.name === name) {
          throw new ValidationError('This Rename changes nothing');
        }
        await client.query('UPDATE requestable_materials SET name = $2 WHERE id = $1', [requestableMaterialId, name]);
        return recordChange(client, actorId, requestableMaterialId, 'RENAMED', [{ field: 'name', before: stored.name, after: name }]);
      });
    } catch (err) {
      throw await this.nameTakenOr(err, name);
    }
  }

  /**
   * F009-T8 (#210): changes the Other Details of the Requestable Material `requestableMaterialId` (แก้ไขข้อมูลอื่น): its
   * description and whole-number setting freely, and its Request Unit under P2. Requested Quantities already recorded
   * never change (#202 Q17). One history entry lists each field the write changed, before and after (#210 start
   * decision 1); a write that changes nothing is refused.
   */
  async changeDetails(actorId: string, requestableMaterialId: string, input: ChangeDetailsInput, { retryToken }: { retryToken: string }): Promise<RequestableMaterialVersion> {
    const details = {
      request_unit_id: requestUnitIdOf(input.request_unit_id),
      whole_number_only: input.whole_number_only,
      description: descriptionOf(input.description),
    };
    const payload = { requestable_material_id: requestableMaterialId, expected_version: input.expected_version, ...details };
    return commitOnce(this.db, { actorId, operation: 'requestable-material:details', retryToken, payload, explicitContinuation: false }, async (client) => {
      const stored = await lockedAtVersion(client, requestableMaterialId, input.expected_version);
      const changes: { field: string; before: unknown; after: unknown }[] = [];
      if (details.request_unit_id !== stored.request_unit_id) {
        changes.push({ field: 'request_unit', ...(await requestUnitChange(client, requestableMaterialId, stored.request_unit_id, details.request_unit_id)) });
      }
      if (details.whole_number_only !== stored.whole_number_only) {
        changes.push({ field: 'whole_number_only', before: stored.whole_number_only, after: details.whole_number_only });
      }
      if (details.description !== stored.description) {
        changes.push({ field: 'description', before: stored.description, after: details.description });
      }
      if (changes.length === 0) {
        throw new ValidationError('This Other Details change changes nothing');
      }
      await client.query('UPDATE requestable_materials SET request_unit_id = $2, whole_number_only = $3, description = $4 WHERE id = $1', [
        requestableMaterialId,
        details.request_unit_id,
        details.whole_number_only,
        details.description,
      ]);
      return recordChange(client, actorId, requestableMaterialId, 'DETAILS_CHANGED', changes);
    });
  }

  /**
   * F009-T7 (#209): makes the Requestable Material Inactive (หยุดใช้), so Requesters are no longer offered it, even
   * while Pending Requested Items use it; they stay Pending, and nothing else changes or is deleted (#202 MC-14, Q16).
   */
  async inactivate(actorId: string, requestableMaterialId: string, input: StatusChangeInput, { retryToken }: { retryToken: string }): Promise<RequestableMaterialVersion> {
    return this.changeStatus(actorId, requestableMaterialId, STATUS_CHANGES.inactivate, input.expected_version, retryToken);
  }

  /** F009-T7 (#209): reactivates an Inactive Requestable Material (เปิดใช้อีกครั้ง) as the same record (#202 MC-14, Q6). */
  async reactivate(actorId: string, requestableMaterialId: string, input: StatusChangeInput, { retryToken }: { retryToken: string }): Promise<RequestableMaterialVersion> {
    return this.changeStatus(actorId, requestableMaterialId, STATUS_CHANGES.reactivate, input.expected_version, retryToken);
  }

  // Makes the Requestable Material active or Inactive at the version the request read, with a history entry of the
  // change. One already so is refused (#209 acceptance criteria). It locks the row FOR UPDATE, so a Material Request
  // that locks it FOR SHARE waits for it and then reads its status (#206 review decision 2, comment 7090131450).
  private async changeStatus(
    actorId: string,
    requestableMaterialId: string,
    { isActive, operation, kind, alreadySo }: StatusChange,
    expectedVersion: number,
    retryToken: string
  ): Promise<RequestableMaterialVersion> {
    const payload = { requestable_material_id: requestableMaterialId, expected_version: expectedVersion };
    return commitOnce(this.db, { actorId, operation, retryToken, payload, explicitContinuation: false }, async (client) => {
      const stored = await lockedAtVersion(client, requestableMaterialId, expectedVersion);
      if (stored.is_active === isActive) {
        throw new ValidationError(alreadySo);
      }
      await client.query('UPDATE requestable_materials SET is_active = $2 WHERE id = $1', [requestableMaterialId, isActive]);
      return recordChange(client, actorId, requestableMaterialId, kind, [{ field: 'is_active', before: !isActive, after: isActive }]);
    });
  }

  // The answer to a write the unique index refused, naming the Requestable Material that holds the name (Q6), or `err`.
  private async nameTakenOr(err: unknown, name: string): Promise<unknown> {
    if (!isNameTaken(err)) {
      return err;
    }
    // The unique index answered after the Requestable Material holding the name committed, so it can be read now.
    const taken = await this.db.query(`SELECT id, name, is_active, version FROM requestable_materials WHERE ${comparedName('name')} = ${comparedName('$1')}`, [name]);
    return new RequestableMaterialNameTakenError(taken.rows[0]);
  }
}
