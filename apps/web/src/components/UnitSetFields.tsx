import React from 'react';
import { fieldInputStyle } from './ReferenceContextFields';
import {
  ADD_ALTERNATE_UNIT_LABEL,
  ALTERNATE_UNIT_LABEL,
  BASE_UNIT_LABEL,
  CONVERSION_FACTOR_LABEL,
  INACTIVE_LABEL,
  WHOLE_NUMBER_UNIT_LABEL,
  type StockMaterialUnit,
  type UnitEntry,
} from './materialFacts';

// One Alternate Unit as the form holds it (F008-T3, #178).
export interface AlternateUnitRow {
  // Names the row for React while its Unit is still unchosen.
  key: string;
  // Empty until a Unit is chosen.
  unit_id: string;
  // Empty when the factor is not entered or unknown.
  conversion_factor: string;
  whole_number_only: boolean;
  is_active: boolean;
}

// A Stock Material's Unit set as the form holds it: the Base Unit and the Alternate Units (#175 P2).
export interface UnitSetValue {
  base_unit_id: string;
  base_whole_number_only: boolean;
  alternates: AlternateUnitRow[];
}

// A new active Alternate Unit row, whole-number-only (#175 Q6), its factor still to be entered.
export const newAlternateRow = (unitId = ''): AlternateUnitRow => ({ key: unitId || crypto.randomUUID(), unit_id: unitId, conversion_factor: '', whole_number_only: true, is_active: true });

// A Unit's name on the list, or empty while none is chosen.
export const unitNameOf = (units: UnitEntry[], unitId: string): string => units.find((unit) => unit.id === unitId)?.name ?? '';

export const emptyUnitSet = (): UnitSetValue => ({ base_unit_id: '', base_whole_number_only: true, alternates: [] });

// The set a Stock Material has, as the Units editor starts from it.
export const unitSetOf = (units: StockMaterialUnit[]): UnitSetValue => {
  const base = units.find((unit) => unit.is_base);
  return {
    base_unit_id: base?.unit_id ?? '',
    base_whole_number_only: base?.whole_number_only ?? true,
    alternates: units
      .filter((unit) => !unit.is_base)
      .map((unit) => ({ key: unit.unit_id, unit_id: unit.unit_id, conversion_factor: unit.conversion_factor ?? '', whole_number_only: unit.whole_number_only, is_active: unit.is_active })),
  };
};

/**
 * The set with `unitId` as its Base Unit. Every Conversion Factor is cleared, since each converted to the old Base
 * Unit (#175 P2). An Alternate Unit chosen as the Base Unit leaves the Alternate Units; when `kept` holds the Units
 * the Stock Material already has, the old Base Unit stays as an Alternate Unit, to get a factor or be made Inactive.
 */
export const withBaseUnit = (value: UnitSetValue, unitId: string, kept: ReadonlySet<string> | null): UnitSetValue => {
  if (unitId === value.base_unit_id) {
    return value;
  }
  const promoted = value.alternates.find((row) => row.unit_id === unitId);
  const oldBase = kept && value.base_unit_id !== '' ? [{ ...newAlternateRow(value.base_unit_id), whole_number_only: value.base_whole_number_only }] : [];
  return {
    base_unit_id: unitId,
    base_whole_number_only: promoted?.whole_number_only ?? value.base_whole_number_only,
    alternates: [...oldBase, ...value.alternates.filter((row) => row.unit_id !== unitId)].map((row) => ({ ...row, conversion_factor: '' })),
  };
};

// Why the set cannot be sent, or null; the server decides again.
export const unitSetError = (value: UnitSetValue, units: UnitEntry[]): string | null => {
  if (value.base_unit_id === '') {
    return `กรุณาเลือก${BASE_UNIT_LABEL}`;
  }
  for (const row of value.alternates) {
    if (row.unit_id === '') {
      return `กรุณาเลือก${ALTERNATE_UNIT_LABEL}ทุกแถว หรือนำแถวที่ไม่ใช้ออก`;
    }
    if (row.is_active && row.conversion_factor.trim() === '') {
      return `กรุณากรอก${CONVERSION_FACTOR_LABEL}ของ ${unitNameOf(units, row.unit_id)}`;
    }
  }
  return null;
};

// An Alternate Unit as a request carries it: an unknown factor as null.
export const alternateRequestOf = (row: AlternateUnitRow) => ({
  unit_id: row.unit_id,
  conversion_factor: row.conversion_factor.trim() === '' ? null : row.conversion_factor.trim(),
  whole_number_only: row.whole_number_only,
  is_active: row.is_active,
});

const smallButtonStyle: React.CSSProperties = { padding: '0.375rem 0.75rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.8125rem' };
const checkLabelStyle: React.CSSProperties = { fontSize: '0.8125rem', color: '#111827', whiteSpace: 'nowrap' };

export interface UnitSetFieldsProps {
  // Names the fields: `${idPrefix}-base-unit`, `${idPrefix}-alternate-0-factor`, and so on.
  idPrefix: string;
  value: UnitSetValue;
  onChange: (value: UnitSetValue) => void;
  // The Unit list, Inactive entries included.
  units: UnitEntry[];
  // The Units the Stock Material already has, which are never removed, only made Inactive; null on a new one.
  kept: ReadonlySet<string> | null;
  // A field for adding a Unit to the list, shown under the Base Unit.
  unitAdder?: React.ReactNode;
  // F010-T5 (#236): why the Base Unit cannot change, shown under it, which is then not chosen; none while it can.
  baseUnitLocked?: string;
}

/**
 * The Unit fields of the Stock Material form and of the Units editor (F008-T3, #178): หน่วยนับหลัก, and each
 * หน่วยนับอื่น with its อัตราแปลง as "1 กล่อง = 5 รีม", each with นับเป็นจำนวนเต็มเท่านั้น (#175 Q5, Q6, P2).
 */
export const UnitSetFields: React.FC<UnitSetFieldsProps> = ({ idPrefix, value, onChange, units, kept, unitAdder, baseUnitLocked }) => {
  const nameOf = (unitId: string) => unitNameOf(units, unitId);
  const baseName = nameOf(value.base_unit_id);
  // A new choice is an active Unit of the list (#175 Q21); a Unit the set has already stays offered as itself.
  const activeUnits = units.filter((unit) => unit.is_active);
  const baseOptions = value.base_unit_id !== '' && !activeUnits.some((unit) => unit.id === value.base_unit_id) ? [...activeUnits, ...units.filter((unit) => unit.id === value.base_unit_id)] : activeUnits;
  const setRow = (index: number, change: Partial<AlternateUnitRow>) =>
    onChange({ ...value, alternates: value.alternates.map((row, i) => (i === index ? { ...row, ...change } : row)) });

  return (
    <>
      <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.75rem', margin: '0 0 0.75rem 0', minWidth: 0 }}>
        <legend style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>{BASE_UNIT_LABEL}</legend>
        <label htmlFor={`${idPrefix}-base-unit`} style={{ position: 'absolute', left: '-9999px' }}>
          {BASE_UNIT_LABEL}
        </label>
        <select
          id={`${idPrefix}-base-unit`}
          value={value.base_unit_id}
          disabled={baseUnitLocked !== undefined}
          aria-describedby={baseUnitLocked === undefined ? undefined : `${idPrefix}-base-unit-locked`}
          onChange={(e) => onChange(withBaseUnit(value, e.target.value, kept))}
          style={fieldInputStyle}
        >
          <option value="">-- เลือก{BASE_UNIT_LABEL} --</option>
          {baseOptions.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
        {baseUnitLocked !== undefined && (
          <p id={`${idPrefix}-base-unit-locked`} style={{ margin: '0.5rem 0 0 0', fontSize: '0.8125rem', color: '#6b7280' }}>
            {baseUnitLocked}
          </p>
        )}
        {unitAdder}
        <label style={{ display: 'block', marginTop: '0.75rem', fontSize: '0.875rem', color: '#111827' }}>
          <input
            id={`${idPrefix}-base-unit-whole`}
            type="checkbox"
            checked={value.base_whole_number_only}
            onChange={(e) => onChange({ ...value, base_whole_number_only: e.target.checked })}
          />{' '}
          {WHOLE_NUMBER_UNIT_LABEL}
        </label>
      </fieldset>

      <fieldset id={`${idPrefix}-alternates`} style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.75rem', margin: '0 0 0.75rem 0', minWidth: 0 }}>
        <legend style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>{ALTERNATE_UNIT_LABEL} (ไม่บังคับ)</legend>
        {value.alternates.length === 0 && <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', color: '#6b7280' }}>ยังไม่มี{ALTERNATE_UNIT_LABEL}</p>}
        {value.alternates.map((row, index) => {
          const isKept = kept?.has(row.unit_id) === true;
          const taken = new Set([value.base_unit_id, ...value.alternates.filter((_, i) => i !== index).map((other) => other.unit_id)]);
          const options = activeUnits.filter((unit) => !taken.has(unit.id));
          const rowId = `${idPrefix}-alternate-${index}`;
          return (
            <div key={row.key} data-testid={rowId} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', borderTop: index === 0 ? 'none' : '1px solid #f3f4f6' }}>
              <span>1</span>
              {isKept ? (
                <span id={`${rowId}-unit`} style={{ fontWeight: 600 }}>
                  {nameOf(row.unit_id)}
                </span>
              ) : (
                <>
                  <label htmlFor={`${rowId}-unit`} style={{ position: 'absolute', left: '-9999px' }}>
                    {ALTERNATE_UNIT_LABEL} แถวที่ {index + 1}
                  </label>
                  <select id={`${rowId}-unit`} value={row.unit_id} onChange={(e) => setRow(index, { unit_id: e.target.value })} style={{ ...fieldInputStyle, width: 'auto', flex: '0 1 10rem' }}>
                    <option value="">-- เลือก{ALTERNATE_UNIT_LABEL} --</option>
                    {[...options, ...units.filter((unit) => unit.id === row.unit_id && !unit.is_active)].map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <span>=</span>
              <label htmlFor={`${rowId}-factor`} style={{ position: 'absolute', left: '-9999px' }}>
                {CONVERSION_FACTOR_LABEL} {nameOf(row.unit_id)}
              </label>
              <input
                id={`${rowId}-factor`}
                type="text"
                inputMode="decimal"
                value={row.conversion_factor}
                placeholder={CONVERSION_FACTOR_LABEL}
                onChange={(e) => setRow(index, { conversion_factor: e.target.value })}
                style={{ ...fieldInputStyle, width: '7rem' }}
              />
              <span>{baseName || BASE_UNIT_LABEL}</span>
              <label style={checkLabelStyle}>
                <input id={`${rowId}-whole`} type="checkbox" checked={row.whole_number_only} onChange={(e) => setRow(index, { whole_number_only: e.target.checked })} /> {WHOLE_NUMBER_UNIT_LABEL}
              </label>
              {isKept ? (
                <label style={checkLabelStyle}>
                  <input id={`${rowId}-inactive`} type="checkbox" checked={!row.is_active} onChange={(e) => setRow(index, { is_active: !e.target.checked })} /> {INACTIVE_LABEL}
                </label>
              ) : (
                <button type="button" id={`${rowId}-remove`} onClick={() => onChange({ ...value, alternates: value.alternates.filter((_, i) => i !== index) })} style={smallButtonStyle}>
                  นำออก
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          id={`${idPrefix}-add-alternate`}
          onClick={() => onChange({ ...value, alternates: [...value.alternates, newAlternateRow()] })}
          style={{ ...smallButtonStyle, marginTop: '0.5rem' }}
        >
          {ADD_ALTERNATE_UNIT_LABEL}
        </button>
      </fieldset>
    </>
  );
};
