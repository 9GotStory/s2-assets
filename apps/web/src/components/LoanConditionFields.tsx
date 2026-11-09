import React from 'react';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { CONDITION_LABELS, type LoanCondition } from './loanFacts';

const CONDITIONS = Object.keys(CONDITION_LABELS) as LoanCondition[];

export interface LoanConditionFieldsProps {
  // Names the fields: `${idPrefix}-condition-${itemId}` and `${idPrefix}-condition-note-${itemId}`.
  idPrefix: string;
  itemId: string;
  assetName: string;
  // '' is no Condition chosen yet.
  condition: LoanCondition | '';
  note: string;
  // Whether the choice starts empty, as at a Loan Return (#74 Q10).
  offerNone?: boolean;
  onChange: (change: { condition?: LoanCondition | ''; note?: string }) => void;
  // Shown under the Condition.
  children?: React.ReactNode;
}

/** One item's Condition and its optional note. */
export const LoanConditionFields: React.FC<LoanConditionFieldsProps> = ({ idPrefix, itemId, assetName, condition, note, offerNone = false, onChange, children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
    <div>
      <label htmlFor={`${idPrefix}-condition-${itemId}`} style={fieldLabelStyle}>
        สภาพ: {assetName}
      </label>
      <select
        id={`${idPrefix}-condition-${itemId}`}
        value={condition}
        onChange={(e) => onChange({ condition: e.target.value as LoanCondition | '' })}
        style={fieldInputStyle}
      >
        {offerNone && <option value="">— เลือกสภาพ —</option>}
        {CONDITIONS.map((value) => (
          <option key={value} value={value}>
            {CONDITION_LABELS[value]}
          </option>
        ))}
      </select>
      {children}
    </div>
    <div>
      <label htmlFor={`${idPrefix}-condition-note-${itemId}`} style={fieldLabelStyle}>
        บันทึกสภาพ (ไม่บังคับ)
      </label>
      <input
        id={`${idPrefix}-condition-note-${itemId}`}
        type="text"
        value={note}
        maxLength={500}
        onChange={(e) => onChange({ note: e.target.value })}
        style={fieldInputStyle}
      />
    </div>
  </div>
);
