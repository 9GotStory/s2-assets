import React from 'react';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import {
  fieldInputStyle,
  fieldLabelStyle,
  hasReferenceValues,
  referenceContextPayload,
  type ReferenceContextValues,
} from './ReferenceContextFields';
import { bangkokToday, effectiveDateError } from './assignmentFacts';

// F003-T1 (#51): the Initial Assignment a registration records with its dimension values, and the
// facts it carries besides them: an Effective Date, a document reference and a remark (#50 Q5, Q11, Q17).

// An Effective Date (วันที่มีผล): a date, or unknown (ไม่ทราบ).
export interface EffectiveDateChoice {
  date: string;
  unknown: boolean;
}

// What the user entered. A null effectiveDate means no date was chosen yet, so it follows the
// registration's default.
export interface InitialAssignmentDraft extends AssignmentNotes {
  effectiveDate: EffectiveDateChoice | null;
}

export const EMPTY_INITIAL_ASSIGNMENT: InitialAssignmentDraft = { effectiveDate: null, documentReference: '', remark: '' };

// #50 Q11: "ไม่ทราบ" for a legacy registration, so no date is invented; the registration date otherwise.
export const effectiveDateOf = (draft: InitialAssignmentDraft, isLegacy: boolean): EffectiveDateChoice =>
  draft.effectiveDate ?? (isLegacy ? { date: '', unknown: true } : { date: bangkokToday(), unknown: false });

// Why a registration with these dimension values cannot be sent, or null when it can.
export const initialAssignmentError = (
  values: ReferenceContextValues,
  draft: InitialAssignmentDraft,
  isLegacy: boolean
): string | null => {
  const effectiveDate = effectiveDateOf(draft, isLegacy);
  if (!hasReferenceValues(values) || effectiveDate.unknown) {
    return null;
  }
  return effectiveDateError(effectiveDate.date, 'กรุณาระบุวันที่มีผล หรือเลือก “ไม่ทราบ”');
};

// What a registration sends for its Initial Assignment: the values with their facts, or nothing
// when no dimension is filled (AR-06).
export const initialAssignmentPayload = (
  values: ReferenceContextValues,
  draft: InitialAssignmentDraft,
  isLegacy: boolean
): Record<string, string | null> => {
  if (!hasReferenceValues(values)) {
    return {};
  }
  const effectiveDate = effectiveDateOf(draft, isLegacy);
  return {
    ...referenceContextPayload(values),
    effective_date: effectiveDate.unknown ? null : effectiveDate.date,
    ...assignmentNotesPayload(draft),
  };
};

export interface InitialAssignmentFieldsProps {
  idPrefix: string;
  draft: InitialAssignmentDraft;
  // Whether the registration is legacy, which sets the default Effective Date.
  isLegacy: boolean;
  onChange: (draft: InitialAssignmentDraft) => void;
}

/**
 * The Initial Assignment's Effective Date (a date or "ไม่ทราบ"), document reference and remark,
 * shown once a dimension is filled.
 */
export const InitialAssignmentFields: React.FC<InitialAssignmentFieldsProps> = ({ idPrefix, draft, isLegacy, onChange }) => {
  const effectiveDate = effectiveDateOf(draft, isLegacy);
  return (
    <div
      id={`${idPrefix}-initial-assignment`}
      style={{ borderTop: '1px solid #e5e7eb', paddingTop: '0.75rem', marginTop: '0.25rem' }}
    >
      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', fontWeight: 600, color: '#374151' }}>กำหนดครั้งแรก</p>
      <label htmlFor={`${idPrefix}-effective_date`} style={fieldLabelStyle}>
        วันที่มีผล
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.25rem' }}>
        <input
          id={`${idPrefix}-effective_date`}
          type="date"
          value={effectiveDate.unknown ? '' : effectiveDate.date}
          max={bangkokToday()}
          disabled={effectiveDate.unknown}
          onChange={(e) => onChange({ ...draft, effectiveDate: { date: e.target.value, unknown: false } })}
          style={{ ...fieldInputStyle, width: 'auto' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: '#374151' }}>
          <input
            id={`${idPrefix}-effective_date_unknown`}
            type="checkbox"
            checked={effectiveDate.unknown}
            onChange={(e) =>
              onChange({
                ...draft,
                effectiveDate: e.target.checked
                  ? { date: effectiveDate.date, unknown: true }
                  : { date: effectiveDate.date || bangkokToday(), unknown: false },
              })
            }
          />
          ไม่ทราบ
        </label>
      </div>
      <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.75rem', color: '#6b7280' }}>
        วันที่ค่าเหล่านี้เริ่มเป็นจริง ไม่เกินวันนี้ ข้อมูลตกทอดเริ่มที่ “ไม่ทราบ” เพื่อไม่สร้างวันที่ขึ้นเอง
      </p>
      <AssignmentNoteFields idPrefix={idPrefix} notes={draft} onChange={(notes) => onChange({ ...draft, ...notes })} />
    </div>
  );
};
