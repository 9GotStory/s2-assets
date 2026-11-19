import { formatDecimal, isWhole, parseDecimal, SCALE, withinRange, type DecimalRefusal } from './exact-decimal.ts';
import type { StockMaterialUnit } from './stock-material-read.service.ts';

// The normalize function of #175 (Q8): a quantity in any Unit of a Stock Material becomes its Base Quantity
// with the Conversion Snapshot it used (MC-06, MC-07, MC-08, MC-09), or is refused. Features 010 to 014 call
// it for every stock-affecting transaction; nothing calls it over HTTP in Feature 008.

// One Unit of a Stock Material, as its read gives it.
export type QuantityUnit = Pick<StockMaterialUnit, 'unit_id' | 'is_base' | 'conversion_factor' | 'whole_number_only' | 'is_active'>;

// The Conversion Factor a quantity used, kept with it so that a later change never alters its Base Quantity.
export interface ConversionSnapshot {
  unit_id: string;
  base_unit_id: string;
  conversion_factor: string;
}

export interface NormalizedQuantity {
  ok: true;
  original_quantity: string;
  original_unit_id: string;
  conversion_snapshot: ConversionSnapshot;
  base_quantity: string;
  // Whether a transaction may use an Inactive Unit is each later feature's to decide (#175).
  original_unit_is_active: boolean;
}

export type QuantityRefusal =
  | 'UNKNOWN_UNIT'
  // An Inactive Alternate Unit whose factor is unknown (F008-T3, #178).
  | 'UNKNOWN_CONVERSION_FACTOR'
  | DecimalRefusal
  | 'NOT_GREATER_THAN_ZERO'
  | 'FRACTION_IN_WHOLE_NUMBER_UNIT'
  | 'BASE_QUANTITY_TOO_MANY_DECIMAL_PLACES'
  | 'BASE_QUANTITY_OUT_OF_RANGE'
  | 'BASE_QUANTITY_NOT_WHOLE';

export type NormalizeResult = NormalizedQuantity | { ok: false; reason: QuantityRefusal };

// A known Conversion Factor as the database holds it; one that does not parse is a defect, not a refusal.
const storedFactor = (unitId: string, stored: string): bigint => {
  const factor = parseDecimal(stored);
  if (!factor.ok) {
    throw new Error(`Unit ${unitId} has the Conversion Factor ${stored}`);
  }
  return factor.scaled;
};

export const normalizeQuantity = (units: readonly QuantityUnit[], unitId: string, quantity: string): NormalizeResult => {
  const baseUnits = units.filter((unit) => unit.is_base);
  if (baseUnits.length !== 1) {
    throw new Error(`a Stock Material has one Base Unit, not ${baseUnits.length}`);
  }
  const [baseUnit] = baseUnits;
  const unit = units.find((candidate) => candidate.unit_id === unitId);
  if (!unit) {
    return { ok: false, reason: 'UNKNOWN_UNIT' };
  }
  if (unit.conversion_factor === null) {
    return { ok: false, reason: 'UNKNOWN_CONVERSION_FACTOR' };
  }
  const parsed = parseDecimal(quantity);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.scaled <= 0n) {
    return { ok: false, reason: 'NOT_GREATER_THAN_ZERO' };
  }
  if (unit.whole_number_only && !isWhole(parsed.scaled)) {
    return { ok: false, reason: 'FRACTION_IN_WHOLE_NUMBER_UNIT' };
  }
  const factor = storedFactor(unit.unit_id, unit.conversion_factor);
  // Two counts of ten-thousandths multiply into hundred-millionths; the Base Quantity keeps four places.
  const product = parsed.scaled * factor;
  if (product % SCALE !== 0n) {
    return { ok: false, reason: 'BASE_QUANTITY_TOO_MANY_DECIMAL_PLACES' };
  }
  const baseQuantity = product / SCALE;
  if (!withinRange(baseQuantity)) {
    return { ok: false, reason: 'BASE_QUANTITY_OUT_OF_RANGE' };
  }
  if (baseUnit.whole_number_only && !isWhole(baseQuantity)) {
    return { ok: false, reason: 'BASE_QUANTITY_NOT_WHOLE' };
  }
  return {
    ok: true,
    original_quantity: formatDecimal(parsed.scaled),
    original_unit_id: unit.unit_id,
    conversion_snapshot: { unit_id: unit.unit_id, base_unit_id: baseUnit.unit_id, conversion_factor: formatDecimal(factor) },
    base_quantity: formatDecimal(baseQuantity),
    original_unit_is_active: unit.is_active,
  };
};
