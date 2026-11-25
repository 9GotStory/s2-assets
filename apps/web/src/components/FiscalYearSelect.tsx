import React from 'react';
import { fieldInputStyle } from './ReferenceContextFields';
import { FISCAL_YEAR_LABEL } from './verificationFacts';

/**
 * F010-T4 (#235): a list's ปีงบประมาณ filter, ทั้งหมด and each Fiscal Year that has a record, newest first (#235 start
 * decision 2). A year asked for from a link that no record has joins them, so the select shows the filter in force and
 * ทั้งหมด takes it away.
 */
export const FiscalYearSelect: React.FC<{ id: string; value: string; offered: number[]; onChange: (fiscalYear: string) => void }> = ({ id, value, offered, onChange }) => {
  const years = value === '' || offered.includes(Number(value)) ? offered : [...offered, Number(value)].sort((a, b) => b - a);
  return (
    <>
      <label htmlFor={id} style={{ alignSelf: 'center', fontSize: '0.875rem', color: '#374151' }}>
        {FISCAL_YEAR_LABEL}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...fieldInputStyle, width: 'auto', flex: '0 1 8rem' }}>
        <option value="">ทั้งหมด</option>
        {years.map((year) => (
          <option key={year} value={String(year)}>
            {year}
          </option>
        ))}
      </select>
    </>
  );
};
