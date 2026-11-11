import React from 'react';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday } from './assignmentFacts';
import { NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL, OUTCOME_DATE_LABEL, REPAIR_OUTCOME_LABEL, REPAIR_OUTCOME_LABELS, type RepairKind, type RepairOutcomeValue } from './repairFacts';

// A Repair Outcome as a form holds it. '' is no outcome chosen yet, because a default could hide a failure.
export interface RepairOutcomeDraft {
  outcome: RepairOutcomeValue | '';
  outcomeDate: string;
  nextRecommendedMaintenanceDate: string;
  documentReference: string;
  note: string;
}

export const emptyRepairOutcomeDraft = (): RepairOutcomeDraft => ({
  outcome: '',
  outcomeDate: bangkokToday(),
  nextRecommendedMaintenanceDate: '',
  documentReference: '',
  note: '',
});

// Why the outcome cannot be sent, or null when it can. The server decides again (#98 Q4, Q7).
export const repairOutcomeDraftError = (draft: RepairOutcomeDraft, startDate: string): string | null => {
  if (draft.outcome === '') {
    return 'กรุณาเลือกผลการซ่อม';
  }
  if (draft.outcomeDate === '') {
    return 'กรุณาเลือกวันที่ได้ผล';
  }
  if (draft.outcomeDate > bangkokToday()) {
    return 'วันที่ได้ผลต้องไม่เกินวันนี้';
  }
  if (startDate !== '' && draft.outcomeDate < startDate) {
    return 'วันที่ได้ผลต้องไม่ก่อนวันที่ส่งซ่อม';
  }
  return draft.nextRecommendedMaintenanceDate !== '' && draft.nextRecommendedMaintenanceDate <= draft.outcomeDate
    ? 'วันที่แนะนำบำรุงรักษาครั้งถัดไปต้องหลังวันที่ได้ผล'
    : null;
};

export const repairOutcomePayload = (draft: RepairOutcomeDraft) => ({
  outcome: draft.outcome,
  outcome_date: draft.outcomeDate,
  next_recommended_maintenance_date: draft.nextRecommendedMaintenanceDate || null,
  document_reference: draft.documentReference.trim() || null,
  note: draft.note.trim() || null,
});

export interface RepairOutcomeFieldsProps {
  idPrefix: string;
  // The record's kind names the outcome; before one is chosen, the ซ่อม names stand.
  repairKind: RepairKind | '';
  startDate: string;
  draft: RepairOutcomeDraft;
  onChange: (draft: RepairOutcomeDraft) => void;
  // Shown under the Outcome Date, such as where the Asset goes back to on it.
  children?: React.ReactNode;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

/** The fields of a Repair Outcome (F005-T2): the outcome, its date and what is noted with it. */
export const RepairOutcomeFields: React.FC<RepairOutcomeFieldsProps> = ({ idPrefix, repairKind, startDate, draft, onChange, children }) => {
  const labels = REPAIR_OUTCOME_LABELS[repairKind === '' ? 'REPAIR' : repairKind];
  return (
    <>
      <div role="radiogroup" aria-label={REPAIR_OUTCOME_LABEL} style={{ ...fieldStyle, display: 'flex', gap: '1.5rem', fontSize: '0.875rem' }}>
        {(['USABLE', 'NOT_USABLE'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              id={`${idPrefix}-outcome-${value}`}
              name={`${idPrefix}-outcome`}
              checked={draft.outcome === value}
              onChange={() => onChange({ ...draft, outcome: value })}
            />{' '}
            {labels[value]}
          </label>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-outcome_date`} style={fieldLabelStyle}>
            {OUTCOME_DATE_LABEL}
          </label>
          <input
            id={`${idPrefix}-outcome_date`}
            type="date"
            value={draft.outcomeDate}
            min={startDate || undefined}
            max={bangkokToday()}
            onChange={(e) => onChange({ ...draft, outcomeDate: e.target.value })}
            style={fieldInputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-next_recommended_maintenance_date`} style={fieldLabelStyle}>
            {NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL} (ไม่บังคับ)
          </label>
          <input
            id={`${idPrefix}-next_recommended_maintenance_date`}
            type="date"
            value={draft.nextRecommendedMaintenanceDate}
            onChange={(e) => onChange({ ...draft, nextRecommendedMaintenanceDate: e.target.value })}
            style={fieldInputStyle}
          />
        </div>
      </div>

      {children}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-outcome_document_reference`} style={fieldLabelStyle}>
            เอกสารอ้างอิงของผล (ไม่บังคับ)
          </label>
          <input
            id={`${idPrefix}-outcome_document_reference`}
            type="text"
            value={draft.documentReference}
            maxLength={500}
            onChange={(e) => onChange({ ...draft, documentReference: e.target.value })}
            placeholder="เช่น เลขที่ใบแจ้งหนี้"
            style={fieldInputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-outcome_note`} style={fieldLabelStyle}>
            หมายเหตุของผล (ไม่บังคับ)
          </label>
          <textarea
            id={`${idPrefix}-outcome_note`}
            value={draft.note}
            maxLength={2000}
            rows={2}
            onChange={(e) => onChange({ ...draft, note: e.target.value })}
            style={fieldInputStyle}
          />
        </div>
      </div>
    </>
  );
};
