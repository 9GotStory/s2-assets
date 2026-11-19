import pg from 'pg';
import { REMARK_MAX_LENGTH, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { CATALOG_LISTS, type CatalogListKind } from './catalog-list-entries.ts';
import { catalogListEntryOf, selectableCatalogListEntry } from './catalog-list.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { stockMaterialUnitsOf, type StockMaterialUnit } from './stock-material-read.service.ts';
import { normalizeUnitSet, unitFieldOf, type AlternateUnitInput, type BaseUnitInput, type UnitSetting } from './stock-material-units.ts';
import { unselectableUnitsAmong } from './unit.service.ts';
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
}

// F008-T3 (#178, #175 P2): the whole Unit set a Units write leaves, at the version the request read.
export interface ReplaceUnitsInput {
  expected_version: number;
  base_unit: BaseUnitInput;
  alternate_units: AlternateUnitInput[];
}

// F008-T4 (#179, #175 Q11): the other details a write changes without a reason, each stated, null for none.
export interface ChangeDetailsInput {
  expected_version: number;
  material_category_id: string | null;
  note: string | null;
}

// What a Stock Material write answers: the Stock Material it wrote and the version a later write must expect.
export interface StockMaterialVersion {
  stock_material_id: string;
  version: number;
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
}

// An entry of the Brand or the Material Category list as a history entry records it: under its name then (#175 P6).
export interface RecordedEntry {
  id: string;
  name: string;
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

// Locks the entry `id` of the list `kind` FOR SHARE, so making it Inactive waits for this write or is seen by it, and
// answers it under its name now; refuses one that is not an active entry of the list (#175 Q21), naming its field.
const chosenEntry = async (client: pg.PoolClient, kind: CatalogListKind, id: string | null): Promise<RecordedEntry | null> => {
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

// #175 P7: the name and the Model are one line each; the Specification and the note are free text, keeping tab and
// line breaks inside them (CODING_STANDARDS, "A text field's kind decides its control characters").
const normalizeFacts = (input: CreateStockMaterialInput): StockMaterialFacts => {
  const name = normalizeLine(input.name, 'name', STOCK_MATERIAL_NAME_MAX_LENGTH);
  if (name === null) {
    throw new ValidationError('name must not be blank');
  }
  return {
    name,
    model: normalizeLine(input.model, 'model', MODEL_MAX_LENGTH),
    specification: normalizeText(input.specification, 'specification', SPECIFICATION_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', REMARK_MAX_LENGTH, ''),
    brand_id: entryIdOf(input.brand_id, 'brand_id'),
    material_category_id: entryIdOf(input.material_category_id, 'material_category_id'),
    units: normalizeUnitSet(input.base_unit, (input.alternate_units ?? []).map((alternate) => ({ ...alternate, is_active: true }))),
  };
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
    return commitOnce(this.db, { actorId, operation: 'stock-material:create', retryToken, payload: { version: 1, ...facts }, explicitContinuation: false }, async (client) => {
      // Every Unit of a new Stock Material is a new choice.
      await assertSelectable(client, facts.units, () => true);
      const brand = await chosenEntry(client, 'brand', facts.brand_id);
      const materialCategory = await chosenEntry(client, 'material-category', facts.material_category_id);

      const res = await client.query(
        `INSERT INTO stock_materials (name, model, specification, note, brand_id, material_category_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, version`,
        [facts.name, facts.model, facts.specification, facts.note, facts.brand_id, facts.material_category_id, actorId]
      );
      const { id, version } = res.rows[0];
      await writeUnits(client, id, facts.units, new Set());

      // The values created, each only when it has one, the Brand, the Material Category and the Units under the names
      // they have now (#175 P6).
      const recorded = { name: facts.name, brand, model: facts.model, specification: facts.specification, material_category: materialCategory, note: facts.note };
      const changes: { field: string; before: null; after: unknown }[] = Object.entries(recorded)
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
   * F008-T4 (#179): changes the Stock Material's Material Category and note, without a reason but with a history entry
   * of what changed (#175 Q11, MC-26). A Material Category kept as it was may be Inactive by now; a new one must be
   * active (Q21).
   */
  async changeDetails(actorId: string, stockMaterialId: string, input: ChangeDetailsInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const expectedVersion = input.expected_version;
    const details = {
      material_category_id: entryIdOf(input.material_category_id, 'material_category_id'),
      note: normalizeText(input.note, 'note', REMARK_MAX_LENGTH, ''),
    };
    const payload = { stock_material_id: stockMaterialId, expected_version: expectedVersion, ...details };
    return commitOnce(this.db, { actorId, operation: 'stock-material:details', retryToken, payload, explicitContinuation: false }, async (client) => {
      const res = await client.query('SELECT version, material_category_id, note FROM stock_materials WHERE id = $1 FOR UPDATE', [stockMaterialId]);
      if (res.rows.length === 0) {
        throw new NotFoundError('Stock Material not found');
      }
      const stored = res.rows[0];
      if (stored.version !== expectedVersion) {
        throw new StaleBeforeConflictError('The Stock Material changed since it was read', { version: stored.version }, { version: expectedVersion });
      }
      const categoryChanged = details.material_category_id !== stored.material_category_id;
      if (!categoryChanged && details.note === stored.note) {
        throw new ValidationError('This details write changes nothing');
      }

      // What changed, the Material Category under its name now on either side (#175 P6).
      const changes: { field: string; before: unknown; after: unknown }[] = [];
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

      const updated = await client.query(
        'UPDATE stock_materials SET material_category_id = $2, note = $3, version = version + 1 WHERE id = $1 RETURNING version',
        [stockMaterialId, details.material_category_id, details.note]
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
   * Unit stays changeable in Feature 008 (MC-21, Q9).
   */
  async replaceUnits(actorId: string, stockMaterialId: string, input: ReplaceUnitsInput, { retryToken }: { retryToken: string }): Promise<StockMaterialVersion> {
    const expectedVersion = input.expected_version;
    const units = normalizeUnitSet(input.base_unit, input.alternate_units);
    const payload = { stock_material_id: stockMaterialId, expected_version: expectedVersion, units };
    return commitOnce(this.db, { actorId, operation: 'stock-material:units', retryToken, payload, explicitContinuation: false }, async (client) => {
      const res = await client.query('SELECT version FROM stock_materials WHERE id = $1 FOR UPDATE', [stockMaterialId]);
      if (res.rows.length === 0) {
        throw new NotFoundError('Stock Material not found');
      }
      const { version } = res.rows[0];
      if (version !== expectedVersion) {
        throw new StaleBeforeConflictError('The Stock Material changed since it was read', { version }, { version: expectedVersion });
      }

      const before = await stockMaterialUnitsOf(client, stockMaterialId);
      const stored = new Map(before.map((unit) => [unit.unit_id, unit]));
      const requested = new Set(units.map(({ unit_id }) => unit_id));
      const dropped = before.find(({ unit_id }) => !requested.has(unit_id));
      if (dropped) {
        throw new ValidationError(`alternate_units must keep the Unit ${dropped.unit_id}: a Unit of a Stock Material is never removed, only made Inactive`);
      }
      if (units.length === before.length && units.every((unit) => sameSetting(stored.get(unit.unit_id)!, unit))) {
        throw new ValidationError('This Units write changes nothing');
      }
      // A factor goes unknown only with the Base Unit it converted to; one still true is never discarded (#178
      // decision 1, comment 6999893572).
      if (stored.get(units[0].unit_id)?.is_base) {
        const blanked = units.findIndex((unit) => unit.conversion_factor === null && (stored.get(unit.unit_id)?.conversion_factor ?? null) !== null);
        if (blanked !== -1) {
          throw new ValidationError(`${unitFieldOf(blanked)}.conversion_factor must stay known: only a Base Unit change leaves a factor unknown`);
        }
      }
      // A Unit new to the Stock Material, a new Base Unit and a reactivated Alternate Unit are new choices; a Unit kept
      // as it was may keep an Inactive list entry (#175 Q21).
      await assertSelectable(client, units, (unit) => {
        const was = stored.get(unit.unit_id);
        return was === undefined || (unit.is_base && !was.is_base) || (unit.is_active && !was.is_active);
      });

      await writeUnits(client, stockMaterialId, units, new Set(stored.keys()));
      const updated = await client.query('UPDATE stock_materials SET version = version + 1 WHERE id = $1 RETURNING version', [stockMaterialId]);
      const after = await stockMaterialUnitsOf(client, stockMaterialId);
      const changes = [{ field: 'units', before: before.map(recordedUnit), after: after.map(recordedUnit) }];
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'UNITS_CHANGED', $3::jsonb, $4)`,
        [stockMaterialId, updated.rows[0].version, JSON.stringify(changes), actorId]
      );
      return { stock_material_id: stockMaterialId, version: updated.rows[0].version };
    });
  }
}
