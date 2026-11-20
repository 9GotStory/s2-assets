import React from 'react';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { BASE_UNIT_LABEL, MINIMUM_STOCK_LABEL } from './materialFacts';

export interface MinimumStockFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  // The Base Unit's name, or empty while none is chosen.
  baseName: string;
  // A line under the field, such as the Minimum Stock the Base Unit had before.
  hint?: React.ReactNode;
}

/**
 * จำนวนขั้นต่ำ in the Base Unit (F008-T6, #182): optional, blank for none, which the server checks (#175 MC-20, P3).
 * Shown by the Stock Material form, the editor of other details and, when the Base Unit changes, the Units editor.
 */
export const MinimumStockField: React.FC<MinimumStockFieldProps> = ({ id, value, onChange, baseName, hint }) => (
  <div style={{ marginBottom: '0.75rem' }}>
    <label htmlFor={id} style={fieldLabelStyle}>
      {MINIMUM_STOCK_LABEL} (ไม่บังคับ)
    </label>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input id={id} type="text" inputMode="decimal" value={value} maxLength={30} onChange={(e) => onChange(e.target.value)} style={{ ...fieldInputStyle, width: '10rem' }} />
      <span>{baseName || BASE_UNIT_LABEL}</span>
    </div>
    {hint && <div style={{ marginTop: '0.25rem', fontSize: '0.8125rem', color: '#6b7280' }}>{hint}</div>}
  </div>
);
