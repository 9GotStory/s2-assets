import pg from 'pg';
import { REMARK_MAX_LENGTH, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { commitOnce } from './retryable-write.ts';
import { unitNamesOf, unselectableUnitsAmong } from './unit.service.ts';
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
  base_unit: { unit_id: string; whole_number_only?: boolean };
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
  base_unit: { unit_id: string; whole_number_only: boolean };
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
  if (!isValidUuid(input.base_unit.unit_id)) {
    throw new ValidationError('base_unit.unit_id must be a valid UUID');
  }
  return {
    name,
    model: normalizeLine(input.model, 'model', MODEL_MAX_LENGTH),
    specification: normalizeText(input.specification, 'specification', SPECIFICATION_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', REMARK_MAX_LENGTH, ''),
    base_unit: { unit_id: input.base_unit.unit_id.trim().toLowerCase(), whole_number_only: input.base_unit.whole_number_only ?? true },
  };
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
      const { unit_id: unitId, whole_number_only: wholeNumberOnly } = facts.base_unit;
      // The Unit is locked FOR SHARE before it is checked, so making it Inactive waits for this write or is seen by it.
      if ((await unselectableUnitsAmong(client, [unitId])).length > 0) {
        throw new ValidationError('base_unit.unit_id must name an active Unit of the list');
      }
      const unitName = (await unitNamesOf(client, [unitId])).get(unitId);

      const res = await client.query(
        `INSERT INTO stock_materials (name, model, specification, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, version`,
        [facts.name, facts.model, facts.specification, facts.note, actorId]
      );
      const { id, version } = res.rows[0];
      await client.query(
        `INSERT INTO stock_material_units (stock_material_id, unit_id, is_base, conversion_factor, whole_number_only) VALUES ($1, $2, true, 1, $3)`,
        [id, unitId, wholeNumberOnly]
      );

      // The values created, the Unit under the name it has now (#175 P6).
      const changes: { field: string; before: null; after: unknown }[] = RECORDED_FIELDS.filter((field) => facts[field] !== null).map((field) => ({ field, before: null, after: facts[field] }));
      changes.push({ field: 'units', before: null, after: [{ unit_id: unitId, name: unitName, is_base: true, conversion_factor: '1', whole_number_only: wholeNumberOnly, is_active: true }] });
      await client.query(
        `INSERT INTO stock_material_history (stock_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'CREATED', $3::jsonb, $4)`,
        [id, version, JSON.stringify(changes), actorId]
      );
      return { stock_material_id: id, version };
    });
  }
}
