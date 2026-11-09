import React from 'react';
import { REFERENCE_DIMENSIONS } from './ReferenceContextFields';
import {
  CORRECTION_LABELS,
  KIND_LABELS,
  changeText,
  conflictText,
  dimensionLabel,
  thaiDate,
  type AssignmentCorrection,
  type AssignmentChange,
  type AssignmentCorrectionField,
  type AssignmentDimension,
  type AssignmentEvent,
} from './assignmentFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});
const THAI_RECORDED_DATE = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });

const FIELD_LABELS: Record<string, string> = {
  effective_date: 'วันที่มีผล',
  document_reference: 'เอกสารอ้างอิง',
  remark: 'หมายเหตุ',
};

const isDimensionField = (field: AssignmentCorrectionField): field is Extract<AssignmentCorrectionField, { field: AssignmentDimension }> =>
  REFERENCE_DIMENSIONS.some(({ entryField }) => entryField === field.field);

// One changed field of a correction, as "before แก้เป็น after".
const correctedFieldText = (kind: AssignmentEvent['kind'], field: AssignmentCorrectionField): string => {
  if (isDimensionField(field)) {
    const text = (change: Pick<AssignmentChange, 'prior' | 'new'> | null) => (change ? changeText(kind, change) : 'ไม่มีในรายการนี้');
    return `${dimensionLabel(field.field)}: ${text(field.before)} แก้เป็น ${text(field.after)}`;
  }
  if (field.field === 'effective_date') {
    const text = (date: string | null) => (date ? thaiDate(date) : 'ไม่ทราบวันที่');
    return `${FIELD_LABELS.effective_date}: ${text(field.before)} แก้เป็น ${text(field.after)}`;
  }
  return `${FIELD_LABELS[field.field]}: ${field.before ?? 'ไม่ระบุ'} แก้เป็น ${field.after ?? 'ไม่ระบุ'}`;
};

const CorrectionItem: React.FC<{ kind: AssignmentEvent['kind']; correction: AssignmentCorrection }> = ({ kind, correction }) => (
  <li style={{ marginTop: '0.375rem' }}>
    <div style={{ fontWeight: 600 }}>{CORRECTION_LABELS[correction.action]}</div>
    <div style={{ color: '#4b5563' }}>
      บันทึกเมื่อ <time dateTime={correction.recorded_at}>{THAI_DATE_TIME.format(new Date(correction.recorded_at))}</time> โดย{' '}
      {correction.recorded_by_username ?? correction.recorded_by}
    </div>
    <div style={{ whiteSpace: 'pre-wrap' }}>เหตุผล: {correction.reason}</div>
    {correction.changes.length > 0 && (
      <ul style={{ margin: '0.125rem 0 0 0', paddingLeft: '1.25rem' }}>
        {correction.changes.map((field) => (
          <li key={field.field}>{correctedFieldText(kind, field)}</li>
        ))}
      </ul>
    )}
  </li>
);

export interface AssignmentFactItemProps {
  event: AssignmentEvent;
  // The correction actions on offer for this fact.
  actions?: React.ReactNode;
  // A correction form open on this fact.
  children?: React.ReactNode;
}

/** One fact of the assignment timeline, with its corrections; a voided fact stays, struck through (MR-07). */
export const AssignmentFactItem: React.FC<AssignmentFactItemProps> = ({ event, actions, children }) => (
  <li
    data-testid={`assignment-event-${event.id}`}
    style={{
      border: '1px solid #e5e7eb',
      borderRadius: '6px',
      padding: '0.75rem 1rem',
      marginBottom: '0.5rem',
      fontSize: '0.875rem',
      color: '#374151',
    }}
  >
    {event.is_voided && (
      <div data-testid={`assignment-voided-${event.id}`} style={{ fontWeight: 600, color: '#b91c1c' }}>
        ยกเลิกแล้ว
      </div>
    )}
    <div data-testid={`assignment-fact-${event.id}`} style={event.is_voided ? { textDecoration: 'line-through', color: '#6b7280' } : undefined}>
      <div style={{ fontWeight: 600, color: event.is_voided ? '#6b7280' : '#111827' }}>
        {KIND_LABELS[event.kind]}
        {event.provenance === 'CARRIED_OVER_F002' && (
          <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', fontWeight: 400, color: '#92400e' }}>ยกมาจากทะเบียนเดิม</span>
        )}
      </div>
      <div>
        วันที่มีผล:{' '}
        {event.effective_date ? (
          <time dateTime={event.effective_date}>{thaiDate(event.effective_date)}</time>
        ) : (
          `ไม่ทราบวันที่ (บันทึกเมื่อ ${THAI_RECORDED_DATE.format(new Date(event.recorded_at))})`
        )}
      </div>
      <div style={event.is_voided ? undefined : { color: '#4b5563' }}>
        วันที่บันทึก: <time dateTime={event.recorded_at}>{THAI_DATE_TIME.format(new Date(event.recorded_at))}</time> โดย{' '}
        {event.recorded_by_username ?? event.recorded_by}
      </div>
      <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem' }}>
        {event.changes.map((change) => (
          <li key={change.dimension}>
            {dimensionLabel(change.dimension)}: {changeText(event.kind, change)}
            {change.conflict && (
              <div
                data-testid={`assignment-conflict-${event.id}-${change.dimension}`}
                style={{ marginTop: '0.125rem', fontSize: '0.8125rem', fontWeight: 600, color: '#92400e' }}
              >
                ขัดแย้ง: {conflictText(change.prior, change.conflict.value_just_before)}
              </div>
            )}
          </li>
        ))}
      </ul>
      {event.document_reference && <div>เอกสารอ้างอิง: {event.document_reference}</div>}
      {event.remark && <div style={{ whiteSpace: 'pre-wrap' }}>หมายเหตุ: {event.remark}</div>}
    </div>
    {event.corrections.length > 0 && (
      <ul
        data-testid={`assignment-corrections-${event.id}`}
        style={{ listStyle: 'none', margin: '0.5rem 0 0 0', padding: '0.25rem 0 0 0.75rem', borderLeft: '2px solid #e5e7eb' }}
      >
        {event.corrections.map((correction) => (
          <CorrectionItem key={correction.id} kind={event.kind} correction={correction} />
        ))}
      </ul>
    )}
    {actions}
    {children}
  </li>
);
