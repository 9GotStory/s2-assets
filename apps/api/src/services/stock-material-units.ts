import { isValidUuid } from './capability.service.ts';
import { formatDecimal, isWhole, parseDecimal, type DecimalRefusal } from './exact-decimal.ts';
import { ValidationError } from './validation-error.ts';

// F008-T3 (#178): the rules of a Stock Material's Unit set, checked before any lock (#175 MC-05, MC-23, Q5, Q6, P2,
// P3). The Base Unit converts at 1; each Alternate Unit converts straight to it.

// The most Alternate Units a request may carry.
export const ALTERNATE_UNITS_MAX = 100;

export interface BaseUnitInput {
  unit_id: string;
  whole_number_only?: boolean;
}

export interface AlternateUnitInput {
  unit_id: string;
  // A decimal string; an Inactive Alternate Unit may leave it unknown (#178 PO decision 1).
  conversion_factor?: string | null;
  whole_number_only?: boolean;
  is_active: boolean;
}

// One Unit of a Stock Material as a write sets it, its factor without trailing zeros as the reads give it.
export interface UnitSetting {
  unit_id: string;
  is_base: boolean;
  conversion_factor: string | null;
  whole_number_only: boolean;
  is_active: boolean;
}

// The field a Unit of a set came from: the set lists the Base Unit first, then the Alternate Units as requested.
export const unitFieldOf = (index: number): string => (index === 0 ? 'base_unit' : `alternate_units[${index - 1}]`);

const FACTOR_REFUSALS: Record<DecimalRefusal, string> = {
  NOT_A_DECIMAL: 'must be a decimal number such as "5" or "2.5"',
  TOO_MANY_DECIMAL_PLACES: 'must have at most four decimal places',
  OUT_OF_RANGE: 'is too large',
};

// A Conversion Factor as written, checked with T2's exact arithmetic (#177): never rounded.
const conversionFactorOf = (text: string, field: string, baseIsWhole: boolean): string => {
  const factor = parseDecimal(text);
  if (!factor.ok) {
    throw new ValidationError(`${field} ${FACTOR_REFUSALS[factor.reason]}`);
  }
  if (factor.scaled <= 0n) {
    throw new ValidationError(`${field} must be greater than 0`);
  }
  if (baseIsWhole && !isWhole(factor.scaled)) {
    throw new ValidationError(`${field} must be a whole number while the Base Unit is whole-number-only`);
  }
  return formatDecimal(factor.scaled);
};

/**
 * A Unit set as requested, the Base Unit first, or the refusal naming the field that breaks a rule: a Unit named
 * once, never the Base Unit as an Alternate Unit, a factor above 0 with at most four decimal places, known for every
 * active Alternate Unit, and whole while the Base Unit is whole-number-only (P3), an Inactive one's included.
 * Each Unit is whole-number-only unless told otherwise (Q6).
 */
export const normalizeUnitSet = (base: BaseUnitInput, alternates: readonly AlternateUnitInput[]): UnitSetting[] => {
  if (!isValidUuid(base.unit_id)) {
    throw new ValidationError('base_unit.unit_id must be a valid UUID');
  }
  const baseUnit: UnitSetting = {
    unit_id: base.unit_id.trim().toLowerCase(),
    is_base: true,
    conversion_factor: '1',
    whole_number_only: base.whole_number_only ?? true,
    is_active: true,
  };
  const units = [baseUnit];
  alternates.forEach((alternate, i) => {
    const field = unitFieldOf(i + 1);
    if (!isValidUuid(alternate.unit_id)) {
      throw new ValidationError(`${field}.unit_id must be a valid UUID`);
    }
    const unitId = alternate.unit_id.trim().toLowerCase();
    if (unitId === baseUnit.unit_id) {
      throw new ValidationError(`${field}.unit_id is the Base Unit, which cannot also be an Alternate Unit`);
    }
    if (units.some((unit) => unit.unit_id === unitId)) {
      throw new ValidationError(`${field}.unit_id names a Unit already in the set`);
    }
    const isActive = alternate.is_active;
    const text = alternate.conversion_factor ?? null;
    if (text === null && isActive) {
      throw new ValidationError(`${field}.conversion_factor is required for an active Alternate Unit`);
    }
    units.push({
      unit_id: unitId,
      is_base: false,
      conversion_factor: text === null ? null : conversionFactorOf(text, `${field}.conversion_factor`, baseUnit.whole_number_only),
      whole_number_only: alternate.whole_number_only ?? true,
      is_active: isActive,
    });
  });
  return units;
};
