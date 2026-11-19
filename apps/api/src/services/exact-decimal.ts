// Exact decimal arithmetic for quantities, Conversion Factors and Minimum Stock (#175 P1): a value is a
// BigInt counting ten-thousandths, so that NUMERIC(18, 4) holds every value exactly and nothing is ever a
// floating-point number or rounded (MC-23).

export const DECIMAL_PLACES = 4;
export const SCALE = 10n ** BigInt(DECIMAL_PLACES);

// NUMERIC(18, 4) keeps 14 digits before the point: a value's size stays below 10^14.
const LIMIT = 10n ** 14n * SCALE;

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

export type DecimalRefusal = 'NOT_A_DECIMAL' | 'TOO_MANY_DECIMAL_PLACES' | 'OUT_OF_RANGE';

export type ParsedDecimal = { ok: true; scaled: bigint } | { ok: false; reason: DecimalRefusal };

// Whether NUMERIC(18, 4) holds a count of ten-thousandths.
export const withinRange = (scaled: bigint): boolean => scaled < LIMIT && scaled > -LIMIT;

// Whether a count of ten-thousandths is a whole number, for the Whole-number Unit rules (MC-23, #175 P3).
export const isWhole = (scaled: bigint): boolean => scaled % SCALE === 0n;

// A decimal string such as "12", "0.5" or "-3.25", as a count of ten-thousandths. A string written with
// more than four decimal places is refused, even when the extra places are zeros (#177).
export const parseDecimal = (text: string): ParsedDecimal => {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    return { ok: false, reason: 'NOT_A_DECIMAL' };
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > DECIMAL_PLACES) {
    return { ok: false, reason: 'TOO_MANY_DECIMAL_PLACES' };
  }
  const magnitude = BigInt(whole) * SCALE + BigInt(fraction.padEnd(DECIMAL_PLACES, '0'));
  if (!withinRange(magnitude)) {
    return { ok: false, reason: 'OUT_OF_RANGE' };
  }
  return { ok: true, scaled: sign === '-' ? -magnitude : magnitude };
};

// A count of ten-thousandths as a decimal string without trailing zeros, as the reads give it ("2.5", "10").
export const formatDecimal = (scaled: bigint): string => {
  const sign = scaled < 0n ? '-' : '';
  const magnitude = scaled < 0n ? -scaled : scaled;
  const whole = (magnitude / SCALE).toString();
  const fraction = (magnitude % SCALE).toString().padStart(DECIMAL_PLACES, '0').replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
};
