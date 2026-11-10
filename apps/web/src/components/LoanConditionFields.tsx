import React from 'react';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { CONDITION_LABELS, type LoanCondition } from './loanFacts';

const CONDITIONS = Object.keys(CONDITION_LABELS) as LoanCondition[];

export interface LoanConditionFieldsProps<C extends LoanCondition | ''> {
  // Names the fields: `${idPrefix}-condition-${itemId}` and `${idPrefix}-condition-note-${itemId}`.
  idPrefix: string;
  itemId: string;
  assetLabel: string;
  // '' is no Condition chosen yet, for a form that offers none.
  condition: C;
  note: string;
  // Whether the choice starts empty, as at a Loan Return (#74 Q10).
  offerNone?: boolean;
  onChange: (change: { condition?: C; note?: string }) => void;
  // Shown under the Condition.
  children?: React.ReactNode;
}

/** One item's Condition and its optional note. */
export const LoanConditionFields = <C extends LoanCondition | ''>({ idPrefix, itemId, assetLabel, condition, note, offerNone = false, onChange, children }: LoanConditionFieldsProps<C>) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
    <div>
      <label htmlFor={`${idPrefix}-condition-${itemId}`} style={fieldLabelStyle}>
        สภาพ: {assetLabel}
      </label>
      <select
        id={`${idPrefix}-condition-${itemId}`}
        value={condition}
        onChange={(e) => onChange({ condition: e.target.value as C })}
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
