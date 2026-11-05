import React from 'react';
import {
  fieldInputStyle,
  fieldLabelStyle,
  hasReferenceValues,
  referenceContextPayload,
  type ReferenceContextValues,
} from './ReferenceContextFields';

// F003-T1 (#51): the Initial Assignment a registration records with its dimension values, and the
// facts it carries besides them: an Effective Date, a document reference and a remark (#50 Q5, Q11, Q17).

const BANGKOK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Today's Asia/Bangkok date as YYYY-MM-DD: the latest Effective Date a fact may have (#50 Q2).
export const bangkokToday = (): string => {
  const parts = Object.fromEntries(BANGKOK_DATE.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

// An Effective Date (วันที่มีผล): a date, or unknown (ไม่ทราบ).
export interface EffectiveDateChoice {
  date: string;
  unknown: boolean;
}

// What the user entered. A null effectiveDate means no date was chosen yet, so it follows the
// registration's default.
export interface InitialAssignmentDraft {
  effectiveDate: EffectiveDateChoice | null;
  documentReference: string;
  remark: string;
}

export const EMPTY_INITIAL_ASSIGNMENT: InitialAssignmentDraft = { effectiveDate: null, documentReference: '', remark: '' };

// #50 Q11: "ไม่ทราบ" for a legacy registration, so no date is invented; the registration date otherwise.
const effectiveDateOf = (draft: InitialAssignmentDraft, isLegacy: boolean): EffectiveDateChoice =>
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate.date)) {
    return 'กรุณาระบุวันที่มีผล หรือเลือก “ไม่ทราบ”';
  }
  return effectiveDate.date > bangkokToday() ? 'วันที่มีผลต้องไม่เกินวันนี้' : null;
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
    document_reference: draft.documentReference.trim() || null,
    remark: draft.remark.trim() || null,
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div>
          <label htmlFor={`${idPrefix}-document_reference`} style={fieldLabelStyle}>
            เอกสารอ้างอิง (ไม่บังคับ)
          </label>
          <input
            id={`${idPrefix}-document_reference`}
            type="text"
            value={draft.documentReference}
            maxLength={500}
            onChange={(e) => onChange({ ...draft, documentReference: e.target.value })}
            placeholder="เช่น เลขที่บันทึกข้อความ"
            style={fieldInputStyle}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-assignment_remark`} style={fieldLabelStyle}>
            หมายเหตุ (ไม่บังคับ)
          </label>
          <textarea
            id={`${idPrefix}-assignment_remark`}
            value={draft.remark}
            maxLength={2000}
            rows={2}
            onChange={(e) => onChange({ ...draft, remark: e.target.value })}
            style={fieldInputStyle}
          />
        </div>
      </div>
    </div>
  );
};
