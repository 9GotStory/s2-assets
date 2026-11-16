import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday, thaiDate } from './assignmentFacts';
import { CONDITION_LABELS, type LoanCondition } from './loanFacts';
import {
  RECORD_VERIFICATION_LABEL,
  RESULT_LABELS,
  VERIFICATION_DATE_LABEL,
  recordedByText,
  resultText,
  type OpenVerificationRound,
  type RecordedResult,
  type VerificationRevision,
} from './verificationFacts';

export interface VerificationRecordFormProps {
  assetId: string;
  round: OpenVerificationRound;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };
const choiceStyle: React.CSSProperties = { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.9375rem', border: 'none', padding: 0, margin: '0 0 0.75rem 0' };

// The result someone else recorded while this form was open (#125 AV-23, Q20).
const RecordedMeanwhile: React.FC<{ current: VerificationRevision }> = ({ current }) => (
  <>
    บันทึกไม่ได้ เพราะมีผลตรวจของครุภัณฑ์นี้ในรอบนี้แล้ว: {resultText(current.result, current.condition)} {VERIFICATION_DATE_LABEL}{' '}
    <time dateTime={current.verification_date}>{thaiDate(current.verification_date)}</time> บันทึกโดย {recordedByText(current)} กรุณาโหลดหน้าใหม่
  </>
);

/**
 * "บันทึกผลตรวจ": records an Asset's first result in the open Round, Found with its Condition or Not Found
 * (F006-T2, #125 Q6, Q8). No photo or location is asked for (AV-10, AV-11); the server derives the Loan and
 * Repair context and the assignment it compares with, and decides again everything this form checks.
 */
export const VerificationRecordForm: React.FC<VerificationRecordFormProps> = ({ assetId, round, csrfToken, onRecorded, onPermissionRevoked }) => {
  const [result, setResult] = useState<RecordedResult | ''>('');
  const [condition, setCondition] = useState<LoanCondition | ''>('');
  const [verificationDate, setVerificationDate] = useState(bangkokToday);
  const [note, setNote] = useState('');

  const requestError = (): string | null => {
    if (result === '') {
      return `กรุณาเลือก ${RESULT_LABELS.FOUND} หรือ ${RESULT_LABELS.NOT_FOUND}`;
    }
    if (result === 'FOUND' && condition === '') {
      return 'กรุณาเลือกสภาพ ปกติ หรือ ชำรุด';
    }
    if (verificationDate === '') {
      return `กรุณาเลือก${VERIFICATION_DATE_LABEL}`;
    }
    if (verificationDate < round.start_date) {
      return `${VERIFICATION_DATE_LABEL}ต้องไม่ก่อนวันที่เริ่มตรวจของรอบ (${thaiDate(round.start_date)})`;
    }
    if (verificationDate > bangkokToday()) {
      return `${VERIFICATION_DATE_LABEL}ต้องไม่เกินวันนี้`;
    }
    return null;
  };

  const requestBody = () => ({
    result,
    condition: result === 'FOUND' ? condition : null,
    verification_date: verificationDate,
    note: note.trim() || null,
  });

  return (
    <LoanSaveForm
      idPrefix="verification-record"
      heading={RECORD_VERIFICATION_LABEL}
      saveUrl={`/verification-rounds/${round.id}/assets/${assetId}/verifications`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => {
        if (body?.code === 'ASSET_ALREADY_VERIFIED') {
          return <RecordedMeanwhile current={body.current as VerificationRevision} />;
        }
        if (body?.code === 'VERIFICATION_ROUND_NOT_OPEN') {
          return <>บันทึกไม่ได้ เพราะรอบตรวจนี้ไม่ได้เปิดอยู่แล้ว กรุณาโหลดหน้าใหม่</>;
        }
        return body?.code === 'ASSET_NOT_IN_VERIFICATION_SCOPE' ? <>บันทึกไม่ได้ เพราะครุภัณฑ์นี้ไม่อยู่ในรอบตรวจ</> : null;
      }}
      forbiddenMessage="คุณไม่มีสิทธิ์บันทึกผลตรวจ"
      refusedMessage="ไม่สามารถบันทึกผลตรวจได้"
      onSaved={onRecorded}
      onCancel={() => {
        setResult('');
        setCondition('');
        setVerificationDate(bangkokToday());
        setNote('');
      }}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <fieldset role="radiogroup" aria-label="ผลตรวจ" style={choiceStyle}>
            {(['FOUND', 'NOT_FOUND'] as const).map((value) => (
              <label key={value} style={{ padding: '0.25rem 0' }}>
                <input type="radio" id={`verification-record-result-${value}`} name="verification-record-result" checked={result === value} onChange={() => setResult(value)} />{' '}
                {RESULT_LABELS[value]}
              </label>
            ))}
          </fieldset>
          {result === 'FOUND' && (
            <fieldset role="radiogroup" aria-label="สภาพ" style={choiceStyle}>
              <legend style={{ ...fieldLabelStyle, marginBottom: '0.25rem' }}>สภาพ</legend>
              {(['NORMAL', 'DAMAGED'] as const).map((value) => (
                <label key={value} style={{ padding: '0.25rem 0' }}>
                  <input type="radio" id={`verification-record-condition-${value}`} name="verification-record-condition" checked={condition === value} onChange={() => setCondition(value)} />{' '}
                  {CONDITION_LABELS[value]}
                </label>
              ))}
            </fieldset>
          )}
          <div style={fieldStyle}>
            <label htmlFor="verification-record-verification_date" style={fieldLabelStyle}>
              {VERIFICATION_DATE_LABEL}
            </label>
            <input
              id="verification-record-verification_date"
              type="date"
              value={verificationDate}
              min={round.start_date}
              max={bangkokToday()}
              onChange={(e) => setVerificationDate(e.target.value)}
              style={{ ...fieldInputStyle, maxWidth: '12rem' }}
            />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="verification-record-note" style={fieldLabelStyle}>
              หมายเหตุ (ไม่บังคับ)
            </label>
            <textarea id="verification-record-note" value={note} maxLength={2000} rows={2} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
