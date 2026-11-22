import pg from 'pg';
import { REMARK_MAX_LENGTH, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { CATALOG_LISTS, type CatalogListKind, type NamedListEntry } from './catalog-list-entries.ts';
import { catalogListEntryOf, selectableCatalogListEntry, unselectableUnitsAmong } from './catalog-list.service.ts';
import { requestableMaterialsAskedIn } from './requestable-material-request-units.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { duplicateCandidatesOf, stockMaterialUnitsOf, type DuplicateCandidates, type StockMaterialHistoryChange, type StockMaterialHistoryKind, type StockMaterialUnit } from './stock-material-read.service.ts';
import { baseUnitAmountOf, normalizeUnitSet, unitFieldOf, type AlternateUnitInput, type BaseUnitInput, type UnitSetting } from './stock-material-units.ts';
import { ValidationError } from './validation-error.ts';

// #175 P7: the longest name, Model and Specification; the note takes REMARK_MAX_LENGTH.
export const STOCK_MATERIAL_NAME_MAX_LENGTH = 200;
export const MODEL_MAX_LENGTH = 200;
export const SPECIFICATION_MAX_LENGTH = 500;

export interface CreateStockMaterialInput {
  name: string;
  model?: string | null;
  specification?: string | null;
  note?: string | null;
  // F008-T4 (#179): its Brand and its Material Category, each an active entry of its list, or none (#175 Q2).
  brand_id?: string | null;
  material_category_id?: string | null;
  // The Unit the Stock Material is counted in (MC-04), whole-number-only unless told otherwise (Q6).
  base_unit: BaseUnitInput;
  // F008-T3 (#178): the other Units it is counted in, each active with its Conversion Factor (MC-05, Q5).
  alternate_units?: Omit<AlternateUnitInput, 'is_active'>[];
  // F008-T6 (#182 decision 1): in the Base Unit, a decimal string, or none (#175 MC-20).
  minimum_stock?: string | null;
  // F008-T5 (#181): "เป็นคนละรายการ", confirming the Duplicate Candidates its warning listed (#175 P4).
  explicit_continuation?: boolean;
}

// F008-T3 (#178, #175 P2): the whole Unit set a Units write leaves, at the version the request read.
export interface ReplaceUnitsInput {
  expected_version: number;
  base_unit: BaseUnitInput;
  alternate_units: AlternateUnitInput[];
  // F008-T6 (#182 decision 2): the Minimum Stock in the new Base Unit, null for none, stated only when the Base Unit
  // changes, as each active Alternate Unit's factor is (P2).
  minimum_stock?: string | null;
}

// F008-T4 (#179, #175 Q11): the other details a write changes without a reason, each stated, null for none.
export interface ChangeDetailsInput {
  expected_version: number;
  material_category_id: string | null;
  note: string | null;
  // F008-T6 (#182): in the Base Unit, a decimal string (#175 MC-20, P1).
  minimum_stock: string | null;
}

// F008-T5 (#181, #175 Q11): a Material Correction: the Stock Material's name, Brand, Model and Specification as they
// should have been recorded, each stated, null for none, with the reason, at the version the request read.
export interface CorrectStockMaterialInput {
  expected_version: number;
  name: string;
  brand_id: string | null;
  model: string | null;
  specification: string | null;
  reason: string;
  // "เป็นคนละรายการ", confirming the Duplicate Candidates its warning listed (#175 P4).
  explicit_continuation?: boolean;
}

// F008-T7 (#180, #175 Q13): making a Stock Material Inactive, with an optional note, at the version the request read.
export interface InactivateStockMaterialInput {
  expected_version: number;
  note?: string | null;
}

// F008-T7 (#180): reactivating an Inactive Stock Material, at the version the request read.
export interface ReactivateStockMaterialInput {
  expected_version: number;
}

// F008-T7 (#180): what making a Stock Material Inactive and reactivating it each write, under its own retry operation.
interface StatusChange {
  isActive: boolean;
  operation: string;
  kind: StockMaterialHistoryKind;
  // The refusal of a Stock Material already so.
  alreadySo: string;
}

const STATUS_CHANGES = Object.freeze({
  inactivate: { isActive: false, operation: 'stock-material:inactivate', kind: 'INACTIVATED', alreadySo: 'The Stock Material is already Inactive' },
  reactivate: { isActive: true, operation: 'stock-material:reactivate', kind: 'REACTIVATED', alreadySo: 'The Stock Material is already active' },
} as const);

// What a Stock Material write answers: the Stock Material it wrote and the version a later write must expect.
export interface StockMaterialVersion {
  stock_material_id: string;
  version: number;
}

/** F008-T5 (#181): Duplicate Candidates a write did not confirm (#175 P4), answered in Feature 002's contract. */
export class DuplicateCandidatesFoundError extends Error {
  statusCode = 409;
  code = 'DUPLICATE_CANDIDATES_FOUND';
  found: DuplicateCandidates;

  constructor(found: DuplicateCandidates) {
    super('Stock Materials with a similar name exist: confirm with explicit_continuation that this is a different one');
    this.name = 'DuplicateCandidatesFoundError';
    this.found = found;
  }
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface StockMaterialFacts {
  name: string;
  model: string | null;
  specification: string | null;
  note: string | null;
  brand_id: string | null;
  material_category_id: string | null;
  // The Base Unit first, then the Alternate Units as requested.
  units: UnitSetting[];
  minimum_stock: string | null;
}

// The entry of a list that a request names in `field`, or null when it names none.
const entryIdOf = (value: string | null | undefined, field: string): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isValidUuid(value)) {
    throw new ValidationError(`${field} must be a valid UUID`);
  }
  return value.trim().toLowerCase();
};

/**
 * F008-T5 (#181): takes the lock that orders every write of a Stock Material's name, so that of two writes of similar
 * names the second sees the first (#181 decision 1, comment 7008407333), then refuses the Duplicate Candidates of
 * `name`, but the Stock Material `excludedId`, unless the request confirmed them (#175 MC-17, P4). A request that
 * cannot be saved for its own fault is refused before, so a confirmation is asked only for one that can be.
 */
const checkDuplicateCandidates = async (client: pg.PoolClient, name: string, excludedId: string | null, confirmed: boolean): Promise<void> => {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('stock-material:identity'))`);
  if (confirmed) {
    return;
  }
  const found = await duplicateCandidatesOf(client, name, excludedId);
  if (found.total_count > 0) {
    throw new DuplicateCandidatesFoundError(found);
  }
};

// Locks the entry `id` of the list `kind` FOR SHARE, so making it Inactive waits for this write or is seen by it, and
// answers it under its name now; refuses one that is not an active entry of the list (#175 Q21), naming its field.
const chosenEntry = async (client: pg.PoolClient, kind: CatalogListKind, id: string | null): Promise<NamedListEntry | null> => {
  if (id === null) {
    return null;
  }
  const entry = await selectableCatalogListEntry(client, kind, id);
  if (entry === null) {
    const { column, concept } = CATALOG_LISTS[kind];
    throw new ValidationError(`${column} must name an active ${concept} of the list`);
  }
  return entry;
};

// What tells a Stock Material apart, as a create or a Material Correction states it (#175 Q2, Q11), once validated.
// #175 P7: the name and the Model are one line each; the Specification is free text, keeping tab and line breaks
// inside it (CODING_STANDARDS, "A text field's kind decides its control characters"), as the note does.
const normalizeIdentity = (input: Pick<CreateStockMaterialInput, 'name' | 'brand_id' | 'model' | 'specification'>) => {
  const name = normalizeLine(input.name, 'name', STOCK_MATERIAL_NAME_MAX_LENGTH);
  if (name === null) {
    throw new ValidationError('name must not be blank');
  }
  return {
    name,
    brand_id: entryIdOf(input.brand_id, 'brand_id'),
    model: normalizeLine(input.model, 'model', MODEL_MAX_LENGTH),
    specification: normalizeText(input.specification, 'specification', SPECIFICATION_MAX_LENGTH, ''),
  };
};

const normalizeFacts = (input: CreateStockMaterialInput): StockMaterialFacts => {
  const units = normalizeUnitSet(input.base_unit, (input.alternate_units ?? []).map((alternate) => ({ ...alternate, is_active: true })));
  return {
    ...normalizeIdentity(input),
    note: normalizeText(input.note, 'note', REMARK_MAX_LENGTH, ''),
    material_category_id: entryIdOf(input.material_category_id, 'material_category_id'),
    units,
    // In the Base Unit the request names, whose whole-number rule it states.
    minimum_stock: minimumStockOf(input.minimum_stock, units[0].whole_number_only),
  };
};

// The Minimum Stock as a request states it, refused as the other amounts of the Base Unit are; whether it must be
// whole is decided against the Base Unit it is counted in (#175 P3).
const minimumStockOf = (text: string | null | undefined, baseIsWhole: boolean): string | null =>
  text === undefined || text === null ? null : baseUnitAmountOf(text, 'minimum_stock', baseIsWhole);

/**
 * The Minimum Stock a Units write leaves, or the refusal (#175 MC-20, P3; #182 decision 2). It counts the Base Unit:
 * another Base Unit takes it again as `stated`, so that 10 รีม never becomes 10 กล่อง, and needs it stated while there
 * is one; the same Base Unit keeps it, refusing a `stated` one, and may become whole-number-only only while it is
 * whole. `stored` is read under the Stock Material's lock, which a details write takes to change it.
 */
const minimumStockAfterUnitsWrite = (stored: string | null, stated: string | null | undefined, baseUnitChanges: boolean, baseIsWhole: boolean): string | null => {
  if (baseUnitChanges) {
    if (stated === undefined && stored !== null) {
      throw new ValidationError(`minimum_stock must be stated again in the new Base Unit, as the Minimum Stock ${stored} counts the old one`);
    }
    return stated ?? null;
  }
  if (stated !== undefined) {
    throw new ValidationError('minimum_stock changes through other details unless the Base Unit changes');
  }
  // Without trailing zeros, as the reads give it, a fraction is written with a point.
  if (baseIsWhole && stored?.includes('.')) {
    throw new ValidationError(`base_unit.whole_number_only cannot be set while the Minimum Stock ${stored} has a fraction`);
  }
  return stored;
};

// Whether the Base Unit of the Stock Material is whole-number-only, as a write reads it under the Stock Material's lock,
// which a Units write takes to change it.
const baseUnitIsWhole = async (client: pg.PoolClient, stockMaterialId: string): Promise<boolean> => {
  const res = await client.query('SELECT whole_number_only FROM stock_material_units WHERE stock_material_id = $1 AND is_base', [stockMaterialId]);
  return res.rows[0].whole_number_only;
};

// A Unit of a Stock Material as a history entry records it: its setting under the Unit's name then (#175 P6).
const recordedUnit = ({ unit_is_active: _listEntryIsActive, ...unit }: StockMaterialUnit) => unit;

// Whether a Unit's stored setting is the one requested; both give the factor without trailing zeros.
const sameSetting = (stored: StockMaterialUnit, requested: UnitSetting): boolean =>
  stored.is_base === requested.is_base &&
  stored.conversion_factor === requested.conversion_factor &&
  stored.whole_number_only === requested.whole_number_only &&
  stored.is_active === requested.is_active;

// Locks each Unit of `units` that `isNewChoice` picks FOR SHARE, so making it Inactive waits for this write or is
// seen by it, and refuses the first that is not an active Unit of the list (#175 Q21), naming its field.
const assertSelectable = async (client: pg.PoolClient, units: UnitSetting[], isNewChoice: (unit: UnitSetting) => boolean): Promise<void> => {
  const chosen = units.filter(isNewChoice).map(({ unit_id }) => unit_id);
  const [unselectable] = await unselectableUnitsAmong(client, chosen);
  if (unselectable !== undefined) {
    const field = unitFieldOf(units.findIndex(({ unit_id }) => unit_id === unselectable));
    throw new ValidationError(`${field}.unit_id must name an active Unit of the list`);
  }
};

// Writes each Unit of `units` for the Stock Material, the Alternate Units first, so that an old Base Unit gives up
// its place before the new one takes it (one Base Unit per Stock Material, MC-04).
const writeUnits = async (client: pg.PoolClient, stockMaterialId: string, units: UnitSetting[], stored: ReadonlySet<string>): Promise<void> => {
  for (const unit of [...units].sort((a, b) => Number(a.is_base) - Number(b.is_base))) {
    const values = [stockMaterialId, unit.unit_id, unit.is_base, unit.conversion_factor, unit.whole_number_only, unit.is_active];
    await client.query(
      stored.has(unit.unit_id)
        ? `UPDATE stock_material_units SET is_base = $3, conversion_factor = $4, whole_number_only = $5, is_active = $6
           WHERE stock_material_id = $1 AND unit_id = $2`
        : `INSERT INTO stock_material_units (stock_material_id, unit_id, is_base, conversion_factor, whole_number_only, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)`,
      values
    );
  }
};

/**
 * F008-T1 (#176): the Stock Material catalog's writes. A Stock Material is its own record under a Stable ID (MC-02),
 * counted in one Base Unit (MC-04), and every change appends to its history (#175 Q18). The reads are in
 * stock-material-read.service.ts.
 */
export class StockMaterialService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  async create(actorId: string, input: CreateStockMaterialInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const facts = normalizeFacts(input);
    const confirmed = input.explicit_continuation === true;
    return commitOnce(this.db, { actorId, operation: 'stock-material:create', retryToken, payload: { version: 1, ...facts }, explicitContinuation: confirmed }, async (client) => {
      // Every Unit of a new Stock Material is a new choice.
      await assertSelectable(client, facts.units, () => true);
      const brand = await chosenEntry(client, 'brand', facts.brand_id);
      const materialCategory = await chosenEntry(client, 'material-category', facts.material_category_id);
      await checkDuplicateCandidates(client, facts.name, null, confirmed);

      const res = await client.query(
        `INSERT INTO stock_materials (name, model, specification, note, brand_id, material_category_id, minimum_stock, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, version`,
        [facts.name, facts.model, facts.specification, facts.note, facts.brand_id, facts.material_category_id, facts.minimum_stock, actorId]
      );
      const { id, version } = res.rows[0];
      await writeUnits(client, id, facts.units, new Set());

      // The values created, each only when it has one, the Brand, the Material Category and the Units under the names
      // they have now (#175 P6).
      const recorded = {
        name: facts.name,
        brand,
        model: facts.model,
        specification: facts.specification,
        material_category: materialCategory,
        note: facts.note,
        minimum_stock: facts.minimum_stock,
      };
      const changes: StockMaterialHistoryChange[] = Object.entries(recorded)
        .filter(([, value]) => value !== null)
        .map(([field, after]) => ({ field, before: null, after }));
      changes.push({ field: 'units', before: null, after: (await stockMaterialUnitsOf(client, id)).map(recordedUnit) });
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'CREATED', $3::jsonb, $4)`,
        [id, version, JSON.stringify(changes), actorId]
      );
      return { stock_material_id: id, version };
    });
  }

  /**
   * F008-T5 (#181): a Material Correction (แก้ไขรายการที่บันทึกผิด): fixes the name, Brand, Model or Specification of a
   * Stock Material recorded wrong, which stays the same thing, with a reason and a history entry of each value before
   * and after (#175 MC-03, MC-11, MC-18, Q11). It is checked for Duplicate Candidates, leaving out the Stock Material
   * itself, whether or not it changes the name (#181 decision 2). A Brand kept as it was may be Inactive by now; a new
   * one must be active (Q21).
   */
  async correct(actorId: string, stockMaterialId: string, input: CorrectStockMaterialInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const expectedVersion = input.expected_version;
    const identity = normalizeIdentity(input);
    const reason = normalizeText(input.reason, 'reason', REMARK_MAX_LENGTH, '');
    if (reason === null) {
      throw new ValidationError('reason must not be blank');
    }
    const confirmed = input.explicit_continuation === true;
    const payload = { stock_material_id: stockMaterialId, expected_version: expectedVersion, ...identity, reason };
    return commitOnce(this.db, { actorId, operation: 'stock-material:correct', retryToken, payload, explicitContinuation: confirmed }, async (client) => {
      const res = await client.query('SELECT version, name, brand_id, model, specification FROM stock_materials WHERE id = $1 FOR UPDATE', [stockMaterialId]);
      if (res.rows.length === 0) {
        throw new NotFoundError('Stock Material not found');
      }
      const stored = res.rows[0];
      if (stored.version !== expectedVersion) {
        throw new StaleBeforeConflictError('The Stock Material changed since it was read', { version: stored.version }, { version: expectedVersion });
      }
      const changed = (Object.keys(identity) as (keyof typeof identity)[]).filter((field) => identity[field] !== stored[field]);
      if (changed.length === 0) {
        throw new ValidationError('This Material Correction changes nothing');
      }

      // What changed, in the order the page shows it, the Brand under its name now on either side (#175 P6).
      const changes: StockMaterialHistoryChange[] = [];
      for (const field of changed) {
        if (field === 'brand_id') {
          changes.push({
            field: 'brand',
            before: stored.brand_id === null ? null : await catalogListEntryOf(client, 'brand', stored.brand_id),
            after: await chosenEntry(client, 'brand', identity.brand_id),
          });
        } else {
          changes.push({ field, before: stored[field], after: identity[field] });
        }
      }
      await checkDuplicateCandidates(client, identity.name, stockMaterialId, confirmed);

      const updated = await client.query(
        'UPDATE stock_materials SET name = $2, brand_id = $3, model = $4, specification = $5, version = version + 1 WHERE id = $1 RETURNING version',
        [stockMaterialId, identity.name, identity.brand_id, identity.model, identity.specification]
      );
      const { version } = updated.rows[0];
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, reason, recorded_by) VALUES ($1, $2, 'CORRECTED', $3::jsonb, $4, $5)`,
        [stockMaterialId, version, JSON.stringify(changes), reason, actorId]
      );
      return { stock_material_id: stockMaterialId, version };
    });
  }

  /**
   * F008-T4 (#179): changes the Stock Material's Material Category and note, without a reason but with a history entry
   * of what changed (#175 Q11, MC-26). A Material Category kept as it was may be Inactive by now; a new one must be
   * active (Q21). F008-T6 (#182): and its Minimum Stock, which moves no stock (MC-20).
   */
  async changeDetails(actorId: string, stockMaterialId: string, input: ChangeDetailsInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const expectedVersion = input.expected_version;
    const details = {
      material_category_id: entryIdOf(input.material_category_id, 'material_category_id'),
      note: normalizeText(input.note, 'note', REMARK_MAX_LENGTH, ''),
      // Its whole-number rule waits for the Base Unit, read under the lock.
      minimum_stock: minimumStockOf(input.minimum_stock, false),
    };
    const payload = { stock_material_id: stockMaterialId, expected_version: expectedVersion, ...details };
    return commitOnce(this.db, { actorId, operation: 'stock-material:details', retryToken, payload, explicitContinuation: false }, async (client) => {
      const res = await client.query(
        'SELECT version, material_category_id, note, trim_scale(minimum_stock)::text AS minimum_stock FROM stock_materials WHERE id = $1 FOR UPDATE',
        [stockMaterialId]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError('Stock Material not found');
      }
      const stored = res.rows[0];
      if (stored.version !== expectedVersion) {
        throw new StaleBeforeConflictError('The Stock Material changed since it was read', { version: stored.version }, { version: expectedVersion });
      }
      const categoryChanged = details.material_category_id !== stored.material_category_id;
      if (!categoryChanged && details.note === stored.note && details.minimum_stock === stored.minimum_stock) {
        throw new ValidationError('This details write changes nothing');
      }
      // Checked again, now against the Base Unit as the lock leaves it (P3).
      minimumStockOf(details.minimum_stock, await baseUnitIsWhole(client, stockMaterialId));

      // What changed, the Material Category under its name now on either side (#175 P6).
      const changes: StockMaterialHistoryChange[] = [];
      if (categoryChanged) {
        changes.push({
          field: 'material_category',
          before: stored.material_category_id === null ? null : await catalogListEntryOf(client, 'material-category', stored.material_category_id),
          after: await chosenEntry(client, 'material-category', details.material_category_id),
        });
      }
      if (details.note !== stored.note) {
        changes.push({ field: 'note', before: stored.note, after: details.note });
      }
      if (details.minimum_stock !== stored.minimum_stock) {
        changes.push({ field: 'minimum_stock', before: stored.minimum_stock, after: details.minimum_stock });
      }

      const updated = await client.query(
        'UPDATE stock_materials SET material_category_id = $2, note = $3, minimum_stock = $4, version = version + 1 WHERE id = $1 RETURNING version',
        [stockMaterialId, details.material_category_id, details.note, details.minimum_stock]
      );
      const { version } = updated.rows[0];
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'DETAILS_CHANGED', $3::jsonb, $4)`,
        [stockMaterialId, version, JSON.stringify(changes), actorId]
      );
      return { stock_material_id: stockMaterialId, version };
    });
  }

  /**
   * F008-T3 (#178): replaces the Stock Material's whole Unit set (#175 P2): a factor or a whole-number rule changed,
   * an Alternate Unit added, made Inactive or reactivated, or another Base Unit. No Unit is removed, and the Base
   * Unit stays changeable in Feature 008 (MC-21, Q9). F008-T6 (#182): another Base Unit takes the Minimum Stock again.
   */
  async replaceUnits(actorId: string, stockMaterialId: string, input: ReplaceUnitsInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const expectedVersion = input.expected_version;
    const units = normalizeUnitSet(input.base_unit, input.alternate_units);
    // Left out, it is not stated; in the Base Unit the request names, whose whole-number rule it states.
    const minimumStock = input.minimum_stock === undefined ? undefined : minimumStockOf(input.minimum_stock, units[0].whole_number_only);
    const payload = { stock_material_id: stockMaterialId, expected_version: expectedVersion, units, minimum_stock: minimumStock };
    return commitOnce(this.db, { actorId, operation: 'stock-material:units', retryToken, payload, explicitContinuation: false }, async (client) => {
      const res = await client.query('SELECT version, trim_scale(minimum_stock)::text AS minimum_stock FROM stock_materials WHERE id = $1 FOR UPDATE', [
        stockMaterialId,
      ]);
      if (res.rows.length === 0) {
        throw new NotFoundError('Stock Material not found');
      }
      const { version, minimum_stock: storedMinimumStock } = res.rows[0];
      if (version !== expectedVersion) {
        throw new StaleBeforeConflictError('The Stock Material changed since it was read', { version }, { version: expectedVersion });
      }

      // Each Unit kept is locked before its name is read, so a rename is recorded on both sides or neither; a Unit added
      // is locked as a new choice below (#183 carry-over from #179).
      const before = await stockMaterialUnitsOf(client, stockMaterialId, { locked: true });
      const stored = new Map(before.map((unit) => [unit.unit_id, unit]));
      const requested = new Set(units.map(({ unit_id }) => unit_id));
      const dropped = before.find(({ unit_id }) => !requested.has(unit_id));
      if (dropped) {
        throw new ValidationError(`alternate_units must keep the Unit ${dropped.unit_id}: a Unit of a Stock Material is never removed, only made Inactive`);
      }
      const baseUnitChanges = !stored.get(units[0].unit_id)?.is_base;
      const minimumStockAfter = minimumStockAfterUnitsWrite(storedMinimumStock, minimumStock, baseUnitChanges, units[0].whole_number_only);
      if (units.length === before.length && units.every((unit) => sameSetting(stored.get(unit.unit_id)!, unit))) {
        throw new ValidationError('This Units write changes nothing');
      }
      // A factor goes unknown only with the Base Unit it converted to; one still true is never discarded (#178
      // decision 1, comment 6999893572).
      if (!baseUnitChanges) {
        const blanked = units.findIndex((unit) => unit.conversion_factor === null && (stored.get(unit.unit_id)?.conversion_factor ?? null) !== null);
        if (blanked !== -1) {
          throw new ValidationError(`${unitFieldOf(blanked)}.conversion_factor must stay known: only a Base Unit change leaves a factor unknown`);
        }
      }
      // F009-T3 (#205): an Alternate Unit that a current Compatible Stock Material is asked for in stays active, so one
      // Request Unit stays one of that Unit of the Stock Material; the Supply Officer ends the compatibility first (#202
      // Q15, ADR 0002). Read after the lock above, which adding or ending one waits for.
      const askedIn = await requestableMaterialsAskedIn(
        client,
        stockMaterialId,
        units.filter((unit) => !unit.is_active).map(({ unit_id }) => unit_id)
      );
      const keptActiveIndex = units.findIndex((unit) => askedIn.has(unit.unit_id));
      if (keptActiveIndex !== -1) {
        const names = askedIn.get(units[keptActiveIndex].unit_id)!.map((name) => JSON.stringify(name)).join(', ');
        throw new ValidationError(
          `${unitFieldOf(keptActiveIndex)}.is_active must stay true: the Unit is the Request Unit of the Requestable Materials ${names}, for which this Stock Material is a current Compatible Stock Material; end that compatibility first`
        );
      }
      // A Unit new to the Stock Material, a new Base Unit and a reactivated Alternate Unit are new choices; a Unit kept
      // as it was may keep an Inactive list entry (#175 Q21).
      await assertSelectable(client, units, (unit) => {
        const was = stored.get(unit.unit_id);
        return was === undefined || (unit.is_base && !was.is_base) || (unit.is_active && !was.is_active);
      });

      await writeUnits(client, stockMaterialId, units, new Set(stored.keys()));
      const updated = await client.query('UPDATE stock_materials SET minimum_stock = $2, version = version + 1 WHERE id = $1 RETURNING version', [
        stockMaterialId,
        minimumStockAfter,
      ]);
      const after = await stockMaterialUnitsOf(client, stockMaterialId);
      const changes: StockMaterialHistoryChange[] = [{ field: 'units', before: before.map(recordedUnit), after: after.map(recordedUnit) }];
      // A Minimum Stock stated again counts another Base Unit, even with the same number.
      if (baseUnitChanges && (storedMinimumStock !== null || minimumStockAfter !== null)) {
        changes.push({ field: 'minimum_stock', before: storedMinimumStock, after: minimumStockAfter });
      }
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'UNITS_CHANGED', $3::jsonb, $4)`,
        [stockMaterialId, updated.rows[0].version, JSON.stringify(changes), actorId]
      );
      return { stock_material_id: stockMaterialId, version: updated.rows[0].version };
    });
  }

  /**
   * F008-T7 (#180): makes the Stock Material Inactive (หยุดใช้), even while it holds stock, with an optional note; it
   * changes nothing else and deletes nothing (#175 MC-14, Q13).
   */
  async inactivate(actorId: string, stockMaterialId: string, input: InactivateStockMaterialInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const note = normalizeText(input.note, 'note', REMARK_MAX_LENGTH, '');
    return this.changeStatus(actorId, stockMaterialId, STATUS_CHANGES.inactivate, { expectedVersion: input.expected_version, note, retryToken });
  }

  /** F008-T7 (#180): reactivates an Inactive Stock Material (เปิดใช้อีกครั้ง) as the same record (#175 MC-14, Q13). */
  async reactivate(actorId: string, stockMaterialId: string, input: ReactivateStockMaterialInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    return this.changeStatus(actorId, stockMaterialId, STATUS_CHANGES.reactivate, { expectedVersion: input.expected_version, note: null, retryToken });
  }

  // Makes the Stock Material active or Inactive at the version the request read, with a history entry of the change
  // and the Inactive note. One already so is refused, as the other writes refuse a change of nothing (#180 decision 1,
  // comment 7012878899).
  private async changeStatus(
    actorId: string,
    stockMaterialId: string,
    { isActive, operation, kind, alreadySo }: StatusChange,
    { expectedVersion, note, retryToken }: { expectedVersion: number; note: string | null; retryToken: string }
  ): Promise<StockMaterialVersion> {
    const payload = { stock_material_id: stockMaterialId, expected_version: expectedVersion, note };
    return commitOnce(this.db, { actorId, operation, retryToken, payload, explicitContinuation: false }, async (client) => {
      const res = await client.query('SELECT version, is_active FROM stock_materials WHERE id = $1 FOR UPDATE', [stockMaterialId]);
      if (res.rows.length === 0) {
        throw new NotFoundError('Stock Material not found');
      }
      const stored = res.rows[0];
      if (stored.version !== expectedVersion) {
        throw new StaleBeforeConflictError('The Stock Material changed since it was read', { version: stored.version }, { version: expectedVersion });
      }
      if (stored.is_active === isActive) {
        throw new ValidationError(alreadySo);
      }

      const updated = await client.query('UPDATE stock_materials SET is_active = $2, version = version + 1 WHERE id = $1 RETURNING version', [stockMaterialId, isActive]);
      const { version } = updated.rows[0];
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, note, recorded_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [stockMaterialId, version, kind, JSON.stringify([{ field: 'is_active', before: !isActive, after: isActive }]), note, actorId]
      );
      return { stock_material_id: stockMaterialId, version };
    });
  }
}
