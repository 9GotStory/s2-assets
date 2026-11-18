import React from 'react';
import { CORRECTION_LABELS, thaiDate } from './assignmentFacts';
import { RETIREMENT_DATE_LABEL, RETIREMENT_METHOD_LABEL, RETIREMENT_METHOD_LABELS, RETIREMENT_REFERENCE_LABEL, type RetirementCorrection, type RetirementMethod } from './retirementFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const FIELD_LABELS: Record<string, string> = {
  retirement_date: RETIREMENT_DATE_LABEL,
  retirement_method: RETIREMENT_METHOD_LABEL,
  retirement_reference: RETIREMENT_REFERENCE_LABEL,
  note: 'หมายเหตุ',
};

// A value as the section shows it.
const valueText = (field: string, value: string | null): string => {
  if (value === null) {
    return 'ไม่ระบุ';
  }
  if (field === 'retirement_date') {
    return thaiDate(value);
  }
  return field === 'retirement_method' ? RETIREMENT_METHOD_LABELS[value as RetirementMethod] : value;
};

/** A Retirement's corrections (F007-T5), oldest first, each with its reason, who, when, and before and after (DR-12). */
export const RetirementCorrectionList: React.FC<{ retirementId: string; corrections: RetirementCorrection[] }> = ({ retirementId, corrections }) => (
  <ol data-testid={`retirement-corrections-${retirementId}`} style={{ listStyle: 'none', margin: '0.5rem 0 0 0', padding: '0 0 0 0.75rem', borderLeft: '2px solid #e5e7eb' }}>
    {corrections.map((correction) => (
      <li key={correction.id} data-testid="retirement-correction" style={{ padding: '0.25rem 0' }}>
        <div style={{ fontWeight: 600 }}>{CORRECTION_LABELS[correction.action]}</div>
        <div style={{ color: '#6b7280' }}>
          บันทึกเมื่อ <time dateTime={correction.recorded_at}>{THAI_DATE_TIME.format(new Date(correction.recorded_at))}</time> โดย{' '}
          {correction.recorded_by_username ?? correction.recorded_by}
        </div>
        <div style={{ whiteSpace: 'pre-wrap' }}>เหตุผล: {correction.reason}</div>
        {correction.changes.length > 0 && (
          <ul style={{ margin: '0.125rem 0 0 0', paddingLeft: '1.25rem' }}>
            {correction.changes.map((change) => (
              <li key={change.field} style={{ whiteSpace: 'pre-wrap' }}>
                {FIELD_LABELS[change.field] ?? change.field}: {valueText(change.field, change.before)} แก้เป็น {valueText(change.field, change.after)}
              </li>
            ))}
          </ul>
        )}
      </li>
    ))}
  </ol>
);
