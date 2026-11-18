import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { ReasonField } from './OutstandingItemFields';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { CORRECTION_LABELS, bangkokToday } from './assignmentFacts';
import { VOIDED_LABEL } from './loanFacts';
import {
  NOT_RETIRED_LABEL,
  RETIREMENT_DATE_LABEL,
  RETIREMENT_METHOD_LABEL,
  RETIREMENT_METHOD_LABELS,
  RETIREMENT_METHODS,
  RETIREMENT_REFERENCE_LABEL,
  type Retirement,
  type RetirementMethod,
} from './retirementFacts';

export interface RetirementCorrectionFormProps {
  retirement: Retirement;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Asset and returns the Retirement's version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

const correctionUrl = (retirement: Retirement) => `/retirements/${retirement.id}/corrections`;

const STALE_MESSAGE = 'มีการแก้ไขรายการจำหน่ายนี้หลังจากเปิดฟอร์ม กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง';

// The version a correction form was opened against: a later read never rebases it silently.
const useExpectedVersion = (retirement: Retirement, onRefresh: () => Promise<number | null>) => {
  const [expectedVersion, setExpectedVersion] = useState(retirement.version);
  const refresh = async () => {
    const latest = await onRefresh();
    if (latest === null) {
      return false;
    }
    setExpectedVersion(latest);
    return true;
  };
  return { expectedVersion, refresh };
};

/**
 * "ยกเลิกรายการ (บันทึกผิด)": a Retirement that never happened (F007-T5, #154 Q9). It stays shown, struck
 * through, and the Asset is no longer Retired; no Verification Round takes it back by itself (Q18).
 */
export const RetirementVoidForm: React.FC<RetirementCorrectionFormProps> = ({ retirement, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  const [reason, setReason] = useState('');
  const { expectedVersion, refresh } = useExpectedVersion(retirement, onRefresh);
  return (
    <LoanSaveForm
      idPrefix="retirement-void"
      heading={CORRECTION_LABELS.VOIDED}
      saveUrl={correctionUrl(retirement)}
      csrfToken={csrfToken}
      requestError={() => (reason.trim() === '' ? 'กรุณาระบุเหตุผลที่ยกเลิกรายการ' : null)}
      requestBody={() => ({ expected_version: expectedVersion, action: 'VOID', reason })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขรายการจำหน่าย"
      refusedMessage="ไม่สามารถยกเลิกรายการได้"
      staleMessage={STALE_MESSAGE}
      onSaved={onRecorded}
      onRefresh={refresh}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            รายการจำหน่ายนี้จะยังแสดงแบบขีดฆ่าเป็น “{VOIDED_LABEL}” ครุภัณฑ์จะกลับเป็น “{NOT_RETIRED_LABEL}” และไม่ถูกเพิ่มกลับเข้ารอบตรวจที่เปิดอยู่เอง
          </p>
          <ReasonField idPrefix="retirement-void" label="เหตุผลที่ยกเลิก" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

// The fields of a Retirement as the form holds them: text, with '' for none.
type Draft = Record<'retirement_date' | 'retirement_method' | 'retirement_reference' | 'note', string>;

const draftOf = (retirement: Retirement): Draft => ({
  retirement_date: retirement.retirement_date,
  retirement_method: retirement.retirement_method,
  retirement_reference: retirement.retirement_reference ?? '',
  note: retirement.note ?? '',
});

// What an amendment names: only the fields that differ from the Retirement as it stands, text compared trimmed as
// the server stores it, so that a field the user did not touch is never sent.
const changesOf = (stored: Draft, draft: Draft): Record<string, string | null> =>
  Object.fromEntries(
    (Object.keys(stored) as (keyof Draft)[]).filter((field) => stored[field].trim() !== draft[field].trim()).map((field) => [field, draft[field].trim() || null])
  );

/**
 * "แก้ไขรายการที่บันทึกผิด": corrects a Retirement's Retirement Date, Retirement Method, Retirement Reference or
 * note, with a reason (F007-T5, #154 Q9, P2). Its Asset is never offered: a Retirement of the wrong Asset is voided
 * and recorded again. The server decides every rule again.
 */
export const RetirementAmendForm: React.FC<RetirementCorrectionFormProps> = ({ retirement, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  const [changedFields, setChangedFields] = useState<Partial<Draft>>({});
  const [reason, setReason] = useState('');
  const { expectedVersion, refresh } = useExpectedVersion(retirement, onRefresh);

  const stored = draftOf(retirement);
  const draft: Draft = { ...stored, ...changedFields };
  const set = (field: keyof Draft) => (value: string) => setChangedFields((current) => ({ ...current, [field]: value }));

  const requestError = (): string | null => {
    if (reason.trim() === '') {
      return 'กรุณาระบุเหตุผลที่แก้ไขรายการ';
    }
    if (draft.retirement_date === '') {
      return 'กรุณาเลือกวันที่จำหน่าย';
    }
    if (draft.retirement_date > bangkokToday()) {
      return 'วันที่จำหน่ายต้องไม่เกินวันนี้';
    }
    return Object.keys(changesOf(stored, draft)).length === 0 ? 'ยังไม่มีค่าที่แก้ไข' : null;
  };

  return (
    <LoanSaveForm
      idPrefix="retirement-amend"
      heading={CORRECTION_LABELS.AMENDED}
      saveUrl={correctionUrl(retirement)}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={() => ({ expected_version: expectedVersion, action: 'AMEND', reason, changes: changesOf(stored, draft) })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขรายการจำหน่าย"
      refusedMessage="ไม่สามารถแก้ไขรายการได้"
      staleMessage={STALE_MESSAGE}
      onSaved={onRecorded}
      onRefresh={refresh}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div style={fieldStyle}>
              <label htmlFor="retirement-amend-retirement_date" style={fieldLabelStyle}>
                {RETIREMENT_DATE_LABEL}
              </label>
              <input
                id="retirement-amend-retirement_date"
                type="date"
                value={draft.retirement_date}
                max={bangkokToday()}
                onChange={(e) => set('retirement_date')(e.target.value)}
                style={fieldInputStyle}
              />
            </div>
            <div style={fieldStyle}>
              <label htmlFor="retirement-amend-retirement_method" style={fieldLabelStyle}>
                {RETIREMENT_METHOD_LABEL}
              </label>
              <select
                id="retirement-amend-retirement_method"
                value={draft.retirement_method}
                onChange={(e) => set('retirement_method')(e.target.value as RetirementMethod)}
                style={fieldInputStyle}
              >
                {RETIREMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {RETIREMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={fieldStyle}>
            <label htmlFor="retirement-amend-retirement_reference" style={fieldLabelStyle}>
              {RETIREMENT_REFERENCE_LABEL} (ไม่บังคับ)
            </label>
            <input
              id="retirement-amend-retirement_reference"
              type="text"
              value={draft.retirement_reference}
              maxLength={500}
              onChange={(e) => set('retirement_reference')(e.target.value)}
              style={fieldInputStyle}
            />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="retirement-amend-note" style={fieldLabelStyle}>
              หมายเหตุ (ไม่บังคับ)
            </label>
            <textarea id="retirement-amend-note" value={draft.note} maxLength={2000} rows={3} onChange={(e) => set('note')(e.target.value)} style={fieldInputStyle} />
          </div>
          <ReasonField idPrefix="retirement-amend" label="เหตุผลที่แก้ไข" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
