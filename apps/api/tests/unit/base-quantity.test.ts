import { describe, it, expect } from 'vitest';
import { normalizeQuantity, type QuantityUnit } from '../../src/services/base-quantity.ts';

// Seam D of #175: the normalize function, through its export. Every expected value is worked out by hand
// in the comment beside it, not by the code's arithmetic.

const REAM = 'a0000000-0000-4000-8000-0000000000a1';
const BOX = 'a0000000-0000-4000-8000-0000000000a2';

// รีม counted whole, and กล่อง of 5 รีม (1 กล่อง = 5 รีม).
const paperUnits: QuantityUnit[] = [
  { unit_id: REAM, is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true },
  { unit_id: BOX, is_base: false, conversion_factor: '5', whole_number_only: true, is_active: true },
];

const LITRE = 'a0000000-0000-4000-8000-0000000000b1';
const GALLON = 'a0000000-0000-4000-8000-0000000000b2';
const BUCKET = 'a0000000-0000-4000-8000-0000000000b3';
const BOTTLE = 'a0000000-0000-4000-8000-0000000000b4';

// ลิตร taking fractions; แกลลอน of 3.7854 ลิตร and ขวด of 0.3333 ลิตร taking fractions; ถัง of 20 ลิตร counted whole.
const fluidUnits: QuantityUnit[] = [
  { unit_id: LITRE, is_base: true, conversion_factor: '1', whole_number_only: false, is_active: true },
  { unit_id: GALLON, is_base: false, conversion_factor: '3.7854', whole_number_only: false, is_active: true },
  { unit_id: BUCKET, is_base: false, conversion_factor: '20', whole_number_only: true, is_active: true },
  { unit_id: BOTTLE, is_base: false, conversion_factor: '0.3333', whole_number_only: false, is_active: true },
];

const SHEET = 'a0000000-0000-4000-8000-0000000000c1';
const PACK = 'a0000000-0000-4000-8000-0000000000c2';
const OLD_PACK = 'a0000000-0000-4000-8000-0000000000c3';

// แผ่น counted whole; ห่อ of 5 แผ่น taking fractions; an Inactive ห่อ of 10 แผ่น.
const sheetUnits: QuantityUnit[] = [
  { unit_id: SHEET, is_base: true, conversion_factor: '1', whole_number_only: true, is_active: true },
  { unit_id: PACK, is_base: false, conversion_factor: '5', whole_number_only: false, is_active: true },
  { unit_id: OLD_PACK, is_base: false, conversion_factor: '10', whole_number_only: true, is_active: false },
];

describe('normalizeQuantity (F008-T2, #177)', () => {
  it('keeps a quantity in the Base Unit as its Base Quantity, with the factor 1 in the Conversion Snapshot', () => {
    expect(normalizeQuantity(paperUnits, REAM, '7')).toEqual({
      ok: true,
      original_quantity: '7',
      original_unit_id: REAM,
      conversion_snapshot: { unit_id: REAM, base_unit_id: REAM, conversion_factor: '1' },
      base_quantity: '7',
      original_unit_is_active: true,
    });
  });

  it('turns a quantity in an Alternate Unit into Base Units at its Conversion Factor, kept in the snapshot', () => {
    // 3 กล่อง × 5 รีม = 15 รีม.
    expect(normalizeQuantity(paperUnits, BOX, '3')).toEqual({
      ok: true,
      original_quantity: '3',
      original_unit_id: BOX,
      conversion_snapshot: { unit_id: BOX, base_unit_id: REAM, conversion_factor: '5' },
      base_quantity: '15',
      original_unit_is_active: true,
    });
  });

  it('multiplies a fractional quantity by a fractional Conversion Factor exactly', () => {
    // 2.5 แกลลอน × 3.7854 ลิตร = 7.5708 + 1.8927 = 9.4635 ลิตร.
    expect(normalizeQuantity(fluidUnits, GALLON, '2.5')).toMatchObject({
      ok: true,
      original_quantity: '2.5',
      conversion_snapshot: { unit_id: GALLON, base_unit_id: LITRE, conversion_factor: '3.7854' },
      base_quantity: '9.4635',
    });
  });

  it('refuses a Unit the Stock Material does not have', () => {
    expect(normalizeQuantity(paperUnits, LITRE, '1')).toEqual({ ok: false, reason: 'UNKNOWN_UNIT' });
  });

  it('refuses a quantity that is not a plain decimal string', () => {
    expect(normalizeQuantity(fluidUnits, LITRE, '1e3')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, '.5')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, '5.')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, '+5')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, ' 5')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, '1,000')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, '๕')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
    expect(normalizeQuantity(fluidUnits, LITRE, '')).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
  });

  it('refuses a quantity of zero or less', () => {
    expect(normalizeQuantity(paperUnits, REAM, '0')).toEqual({ ok: false, reason: 'NOT_GREATER_THAN_ZERO' });
    expect(normalizeQuantity(paperUnits, REAM, '-2')).toEqual({ ok: false, reason: 'NOT_GREATER_THAN_ZERO' });
  });

  it('refuses a quantity written with more than four decimal places instead of rounding it', () => {
    expect(normalizeQuantity(fluidUnits, LITRE, '1.00005')).toEqual({ ok: false, reason: 'TOO_MANY_DECIMAL_PLACES' });
    // The fifth place is a zero, but it is still written: the limit is on what is entered (#177).
    expect(normalizeQuantity(fluidUnits, LITRE, '1.50000')).toEqual({ ok: false, reason: 'TOO_MANY_DECIMAL_PLACES' });
  });

  it('takes a quantity with exactly four decimal places', () => {
    expect(normalizeQuantity(fluidUnits, LITRE, '0.0001')).toMatchObject({ ok: true, original_quantity: '0.0001', base_quantity: '0.0001' });
  });

  it('refuses a quantity beyond NUMERIC(18,4) and takes the largest it holds', () => {
    // NUMERIC(18,4) holds 14 digits before the point: 99999999999999.9999 at most.
    expect(normalizeQuantity(fluidUnits, LITRE, '99999999999999.9999')).toMatchObject({ ok: true, base_quantity: '99999999999999.9999' });
    expect(normalizeQuantity(fluidUnits, LITRE, '100000000000000')).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
  });

  it('refuses a fraction in a whole-number-only Alternate Unit', () => {
    // 1.5 ถัง × 20 ลิตร = 30 ลิตร would fit the Base Unit; only the ถัง's own rule refuses it.
    expect(normalizeQuantity(fluidUnits, BUCKET, '1.5')).toEqual({ ok: false, reason: 'FRACTION_IN_WHOLE_NUMBER_UNIT' });
    expect(normalizeQuantity(fluidUnits, BUCKET, '2')).toMatchObject({ ok: true, base_quantity: '40' });
  });

  it('refuses a fraction in a whole-number-only Base Unit', () => {
    expect(normalizeQuantity(paperUnits, REAM, '2.5')).toEqual({ ok: false, reason: 'FRACTION_IN_WHOLE_NUMBER_UNIT' });
  });

  it('refuses a Base Quantity that is not whole when the Base Unit is whole-number-only', () => {
    // 0.5 ห่อ × 5 แผ่น = 2.5 แผ่น; the ห่อ takes fractions, the แผ่น does not.
    expect(normalizeQuantity(sheetUnits, PACK, '0.5')).toEqual({ ok: false, reason: 'BASE_QUANTITY_NOT_WHOLE' });
    // 0.4 ห่อ × 5 แผ่น = 2 แผ่น.
    expect(normalizeQuantity(sheetUnits, PACK, '0.4')).toMatchObject({ ok: true, original_quantity: '0.4', base_quantity: '2' });
  });

  it('refuses a Base Quantity that needs more than four decimal places instead of rounding it', () => {
    // 0.5 ขวด × 0.3333 ลิตร = 0.16665 ลิตร, five places.
    expect(normalizeQuantity(fluidUnits, BOTTLE, '0.5')).toEqual({ ok: false, reason: 'BASE_QUANTITY_TOO_MANY_DECIMAL_PLACES' });
    // 3 ขวด × 0.3333 ลิตร = 0.9999 ลิตร.
    expect(normalizeQuantity(fluidUnits, BOTTLE, '3')).toMatchObject({ ok: true, base_quantity: '0.9999' });
  });

  it('refuses a Base Quantity beyond NUMERIC(18,4)', () => {
    // 20000000000000 กล่อง × 5 = 100000000000000 รีม, one past the largest; 19999999999999 × 5 = 99999999999995.
    expect(normalizeQuantity(paperUnits, BOX, '20000000000000')).toEqual({ ok: false, reason: 'BASE_QUANTITY_OUT_OF_RANGE' });
    expect(normalizeQuantity(paperUnits, BOX, '19999999999999')).toMatchObject({ ok: true, base_quantity: '99999999999995' });
  });

  it('treats a Unit set without exactly one Base Unit, or an unreadable stored factor, as a defect, not a refusal', () => {
    const alternatesOnly = paperUnits.filter((unit) => !unit.is_base);
    expect(() => normalizeQuantity(alternatesOnly, BOX, '1')).toThrow(/one Base Unit, not 0/);
    const twoBaseUnits = [...paperUnits, { ...paperUnits[0], unit_id: SHEET }];
    expect(() => normalizeQuantity(twoBaseUnits, BOX, '1')).toThrow(/one Base Unit, not 2/);
    const unreadableFactor = [paperUnits[0], { ...paperUnits[1], conversion_factor: '5.00000' }];
    expect(() => normalizeQuantity(unreadableFactor, BOX, '1')).toThrow(/Conversion Factor 5\.00000/);
  });

  it('reports an Inactive Unit without deciding about it', () => {
    // 2 ห่อ × 10 แผ่น = 20 แผ่น.
    expect(normalizeQuantity(sheetUnits, OLD_PACK, '2')).toEqual({
      ok: true,
      original_quantity: '2',
      original_unit_id: OLD_PACK,
      conversion_snapshot: { unit_id: OLD_PACK, base_unit_id: SHEET, conversion_factor: '10' },
      base_quantity: '20',
      original_unit_is_active: false,
    });
  });
});
