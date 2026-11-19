import pg from 'pg';
import { REMARK_MAX_LENGTH, normalizeLine, normalizeText } from './assignment.service.ts';
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
  // The Base Unit first, then the Alternate Units as requested.
  units: UnitSetting[];
}

// The fields a history entry lists, in its order, each only when it has a value.
const RECORDED_FIELDS = ['name', 'model', 'specification', 'note'] as const;

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

      const res = await client.query(
        `INSERT INTO stock_materials (name, model, specification, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, version`,
        [facts.name, facts.model, facts.specification, facts.note, actorId]
      );
      const { id, version } = res.rows[0];
      await writeUnits(client, id, facts.units, new Set());

      // The values created, the Units under the names they have now (#175 P6).
      const changes: { field: string; before: null; after: unknown }[] = RECORDED_FIELDS.filter((field) => facts[field] !== null).map((field) => ({ field, before: null, after: facts[field] }));
      changes.push({ field: 'units', before: null, after: (await stockMaterialUnitsOf(client, id)).map(recordedUnit) });
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'CREATED', $3::jsonb, $4)`,
        [id, version, JSON.stringify(changes), actorId]
      );
      return { stock_material_id: id, version };
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
      const kept = new Set(units.map(({ unit_id }) => unit_id));
      const dropped = before.find(({ unit_id }) => !kept.has(unit_id));
      if (dropped) {
        throw new ValidationError(`alternate_units must keep the Unit ${dropped.unit_id}: a Unit of a Stock Material is never removed, only made Inactive`);
      }
      if (units.length === before.length && units.every((unit) => sameSetting(stored.get(unit.unit_id)!, unit))) {
        throw new ValidationError('This Units write changes nothing');
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
