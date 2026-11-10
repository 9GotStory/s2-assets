import React from 'react';
import { OverdueBadge } from './LoanBadges';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { thaiDate } from './assignmentFacts';
import { NOT_OUTSTANDING_LABELS, assetLabel, type LoanItem, type RefusedOutstandingItem } from './loanFacts';

// The fields that the writes for Outstanding items share (F004-T5): a Due Date Extension and Not Returned.

export interface OutstandingItemPickerProps {
  idPrefix: string;
  // The Loan's Outstanding items: an item that has ended cannot be chosen.
  items: LoanItem[];
  selected: Record<string, boolean>;
  onChange: (itemId: string, isSelected: boolean) => void;
}

export const OutstandingItemPicker: React.FC<OutstandingItemPickerProps> = ({ idPrefix, items, selected, onChange }) => (
  <fieldset style={{ border: 'none', padding: 0, margin: '0 0 0.75rem 0' }}>
    <legend style={fieldLabelStyle}>รายการที่ยังไม่คืน</legend>
    {items.map((item) => (
      <label key={item.id} data-testid={`${idPrefix}-item`} style={{ display: 'block', padding: '0.375rem 0', fontSize: '0.875rem', color: '#374151' }}>
        <input type="checkbox" id={`${idPrefix}-select-${item.id}`} checked={selected[item.id] === true} onChange={(e) => onChange(item.id, e.target.checked)} />{' '}
        <span style={{ fontWeight: 600 }}>{assetLabel(item.asset)}</span> · กำหนดคืน: <time dateTime={item.due_date}>{thaiDate(item.due_date)}</time>
        {item.is_overdue && <OverdueBadge testId={`${idPrefix}-item-overdue`} />}
      </label>
    ))}
  </fieldset>
);

export interface ReasonFieldProps {
  idPrefix: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}

// A reason is free text of at most 2000 characters, as the server bounds it.
export const ReasonField: React.FC<ReasonFieldProps> = ({ idPrefix, label, value, onChange }) => (
  <div style={{ marginBottom: '0.75rem' }}>
    <label htmlFor={`${idPrefix}-reason`} style={fieldLabelStyle}>
      {label}
    </label>
    <textarea id={`${idPrefix}-reason`} value={value} maxLength={2000} rows={2} onChange={(e) => onChange(e.target.value)} style={fieldInputStyle} />
  </div>
);

// What a refusal naming items that are not Outstanding shows.
export const RefusedOutstandingItems: React.FC<{ heading: string; items: RefusedOutstandingItem[] }> = ({ heading, items }) => (
  <>
    {heading}
    <ul style={{ margin: '0.5rem 0 0 1.25rem', padding: 0 }}>
      {items.map((item) => (
        <li key={item.loan_item_id}>
          {item.name ?? item.asset_number ?? item.loan_item_id}: {NOT_OUTSTANDING_LABELS[item.reason]}
        </li>
      ))}
    </ul>
  </>
);
