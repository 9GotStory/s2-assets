import type { QuantityRefusal } from './base-quantity.ts';
import { isValidUuid } from './capability.service.ts';
import { formatDecimal, parseDecimal } from './exact-decimal.ts';
import { ValidationError } from './validation-error.ts';

// F010-T3 (#234): what a Draft line of a stock record checks as it is typed, shared by the Opening Balance (T2) and the
// Material Receipt (T3) (#231 Q9, Q25, Numbers). Every quantity and price is a decimal string, never floating point
// (#175 P1).

// Why Feature 008's quantity normalization refuses a quantity, as a confirm names it (#177 decisions). An unknown Unit
// or factor cannot reach it: a Stock Material keeps every Unit it ever had, and only an Inactive one lacks a factor.
export const QUANTITY_REFUSALS: Record<QuantityRefusal, string> = {
  UNKNOWN_UNIT: 'names a Unit its Stock Material does not have',
  UNKNOWN_CONVERSION_FACTOR: 'names a Unit without a Conversion Factor',
  NOT_A_DECIMAL: 'must be a decimal number',
  TOO_MANY_DECIMAL_PLACES: 'must have at most four decimal places',
  OUT_OF_RANGE: 'is too large',
  NOT_GREATER_THAN_ZERO: 'must be greater than 0',
  FRACTION_IN_WHOLE_NUMBER_UNIT: 'must be a whole number in its Unit',
  BASE_QUANTITY_TOO_MANY_DECIMAL_PLACES: 'gives a Base Quantity with more than four decimal places',
  BASE_QUANTITY_OUT_OF_RANGE: 'gives a Base Quantity that is too large',
  BASE_QUANTITY_NOT_WHOLE: 'gives a Base Quantity that is not whole, as its Base Unit counts in whole numbers',
};

// A Stock Material and Unit pair as one key: a stock record holds each pair once (Q9), and a Material Receipt's voided
// line keeps its own (#237 start decision 1).
export const pairKey = (line: { stock_material_id: string; unit_id: string }): string => `${line.stock_material_id} ${line.unit_id}`;

/**
 * A quantity present on a Draft line, checked as it is typed: greater than 0, at most four decimal places, never
 * rounded (Q25). PostgreSQL stores it as a number, and the reads give it without trailing zeros.
 */
export const draftQuantityOf = (value: string, field: string): string => {
  const parsed = parseDecimal(value);
  if (!parsed.ok) {
    throw new ValidationError(`${field} ${QUANTITY_REFUSALS[parsed.reason]}`);
  }
  if (parsed.scaled <= 0n) {
    throw new ValidationError(`${field} ${QUANTITY_REFUSALS.NOT_GREATER_THAN_ZERO}`);
  }
  return value;
};

/**
 * F010-T6 (#237): a decimal string already checked, written as PostgreSQL reads it back, so a correction compares equal
 * values as equal. F010-T7 (#238): the Opening Balance correction uses it too.
 */
export const asStored = (value: string): string => formatDecimal((parseDecimal(value) as { scaled: bigint }).scaled);

/** A UUID, in lower case. */
export const uuidOf = (value: string, field: string): string => {
  if (!isValidUuid(value)) {
    throw new ValidationError(`${field} must be a valid UUID`);
  }
  return value.trim().toLowerCase();
};

/** A UUID that is given, in lower case, or none. */
export const uuidOrNull = (value: string | null | undefined, field: string): string | null => (value === undefined || value === null ? null : uuidOf(value, field));
