import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from './LoanSaveForm';
import { fetchReferenceList, fieldInputStyle, fieldLabelStyle, type ReferenceEntry } from './ReferenceContextFields';
import { bangkokToday, thaiDate } from './assignmentFacts';
import { CONDITION_LABELS, type LoanCondition } from './loanFacts';
import { RetiredReason } from './RetiredReason';
import {
  DISCREPANCY_LABEL,
  DISCREPANCY_LABELS,
  OBSERVED_LOCATION_LABEL,
  RECORD_VERIFICATION_LABEL,
  RESULT_LABELS,
  REVERIFICATION_LABEL,
  VERIFICATION_DATE_LABEL,
  latestResultText,
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
  // A Re-verification names the current revision it saw (F006-T4); a first result names none.
  expectedRevisionId?: string;
  onRecorded: () => Promise<void>;
  // Closes a Re-verification form; a first-result form clears instead.
  onClose?: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };
const choiceStyle: React.CSSProperties = { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.9375rem', border: 'none', padding: 0, margin: '0 0 0.75rem 0' };
const flagStyle: React.CSSProperties = { display: 'block', padding: '0.25rem 0', fontSize: '0.9375rem' };

// The result someone else recorded while this form was open (#125 AV-23, Q20).
const RecordedMeanwhile: React.FC<{ current: VerificationRevision }> = ({ current }) => (
  <>
    บันทึกไม่ได้ เพราะมีผลตรวจของครุภัณฑ์นี้ในรอบนี้แล้ว: {resultText(current.result, current.condition)} {VERIFICATION_DATE_LABEL}{' '}
    <time dateTime={current.verification_date}>{thaiDate(current.verification_date)}</time> บันทึกโดย {recordedByText(current)} กรุณาโหลดหน้าใหม่
  </>
);

/**
 * "บันทึกผลตรวจ": records an Asset's first result in the open Round, Found with its Condition or Not Found
 * (F006-T2, #125 Q6, Q8). When Found, it takes the Observed Location from the Location Reference List, left out
 * when it matched, and the two Discrepancies Verification Staff tick (F006-T3, Q7). No photo or GPS location is
 * asked for (AV-10, AV-11); the server derives the Loan and Repair context, the assignment it compares with and
 * the Discrepancies that follow, and decides again everything this form checks. As "ตรวจซ้ำ" it opens empty, with
 * nothing carried over, and records a Re-verification over the current revision it saw (F006-T4, #125 Q20).
 */
export const VerificationRecordForm: React.FC<VerificationRecordFormProps> = ({ assetId, round, csrfToken, expectedRevisionId, onRecorded, onClose, onPermissionRevoked }) => {
  const [result, setResult] = useState<RecordedResult | ''>('');
  const [condition, setCondition] = useState<LoanCondition | ''>('');
  const [verificationDate, setVerificationDate] = useState(bangkokToday);
  const [note, setNote] = useState('');
  const [observedLocationId, setObservedLocationId] = useState('');
  const [labelMissingOrDamaged, setLabelMissingOrDamaged] = useState(false);
  const [dataMismatch, setDataMismatch] = useState(false);
  const [dataMismatchNote, setDataMismatchNote] = useState('');
  // The active Locations, the ones a result may name (#125 Q7).
  const locations = useQuery<ReferenceEntry[], Error>({
    queryKey: ['verification-observed-locations'],
    queryFn: async ({ signal }) => {
      const list = await fetchReferenceList('locations', false, signal);
      if (!list.ok) {
        throw new Error(`HTTP ${list.status}`);
      }
      return list.items;
    },
  });
  const found = result === 'FOUND';

  const requestError = (): string | null => {
    if (result === '') {
      return `กรุณาเลือก ${RESULT_LABELS.FOUND} หรือ ${RESULT_LABELS.NOT_FOUND}`;
    }
    if (found && condition === '') {
      return 'กรุณาเลือกสภาพ ปกติ หรือ ชำรุด';
    }
    if (found && dataMismatch && dataMismatchNote.trim() === '') {
      return `กรุณาระบุว่า${DISCREPANCY_LABELS.DATA_MISMATCH}อย่างไร`;
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
    condition: found ? condition : null,
    observed_location_id: found && observedLocationId ? observedLocationId : null,
    label_missing_or_damaged: found && labelMissingOrDamaged,
    data_mismatch: found && dataMismatch,
    data_mismatch_note: found && dataMismatch ? dataMismatchNote.trim() : null,
    verification_date: verificationDate,
    note: note.trim() || null,
    ...(expectedRevisionId ? { expected_revision_id: expectedRevisionId } : {}),
  });

  return (
    <LoanSaveForm
      idPrefix="verification-record"
      heading={expectedRevisionId ? REVERIFICATION_LABEL : RECORD_VERIFICATION_LABEL}
      saveUrl={`/verification-rounds/${round.id}/assets/${assetId}/verifications`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => {
        if (body?.code === 'ASSET_ALREADY_VERIFIED') {
          return <RecordedMeanwhile current={body.current as VerificationRevision} />;
        }
        if (body?.code === 'VERIFICATION_RESULT_CHANGED') {
          // A newer result, or none after a void (#125 Q20).
          return <>บันทึกไม่ได้ เพราะผลตรวจล่าสุดของครุภัณฑ์นี้เปลี่ยนไปแล้ว: {latestResultText(body.current ?? null)} กรุณาโหลดหน้าใหม่</>;
        }
        if (body?.code === 'VERIFICATION_ROUND_NOT_OPEN') {
          return <>บันทึกไม่ได้ เพราะรอบตรวจนี้ไม่ได้เปิดอยู่แล้ว กรุณาโหลดหน้าใหม่</>;
        }
        if (body?.code === 'ASSET_RETIRED') {
          // Retired since the form opened (F007-T4, #154 Q12).
          return (
            <>
              บันทึกไม่ได้ เพราะครุภัณฑ์นี้<RetiredReason assetId={body.asset.asset_id} />
            </>
          );
        }
        return body?.code === 'ASSET_NOT_IN_VERIFICATION_SCOPE' ? <>บันทึกไม่ได้ เพราะครุภัณฑ์นี้ไม่อยู่ในรอบตรวจ</> : null;
      }}
      forbiddenMessage="คุณไม่มีสิทธิ์บันทึกผลตรวจ"
      refusedMessage="ไม่สามารถบันทึกผลตรวจได้"
      onSaved={onRecorded}
      onCancel={() => {
        if (onClose) {
          onClose();
          return;
        }
        setResult('');
        setCondition('');
        setVerificationDate(bangkokToday());
        setNote('');
        setObservedLocationId('');
        setLabelMissingOrDamaged(false);
        setDataMismatch(false);
        setDataMismatchNote('');
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
          {found && (
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
          {found && (
            <>
              <div style={fieldStyle}>
                <label htmlFor="verification-record-observed_location_id" style={fieldLabelStyle}>
                  {OBSERVED_LOCATION_LABEL}
                </label>
                <select
                  id="verification-record-observed_location_id"
                  value={observedLocationId}
                  onChange={(e) => setObservedLocationId(e.target.value)}
                  style={fieldInputStyle}
                >
                  <option value="">ตรงกับทะเบียน (ไม่ต้องระบุ)</option>
                  {(locations.data ?? []).map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                {locations.isError && (
                  <div role="alert" data-testid="verification-record-locations-error" style={{ color: '#b91c1c', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                    ไม่สามารถโหลดรายการสถานที่ได้ บันทึกโดยไม่ระบุ{OBSERVED_LOCATION_LABEL}ได้
                  </div>
                )}
              </div>
              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 0.75rem 0' }}>
                <legend style={{ ...fieldLabelStyle, marginBottom: '0.25rem' }}>{DISCREPANCY_LABEL}ที่พบ (ติ๊กเมื่อมี)</legend>
                <label style={flagStyle}>
                  <input
                    type="checkbox"
                    id="verification-record-label_missing_or_damaged"
                    checked={labelMissingOrDamaged}
                    onChange={(e) => setLabelMissingOrDamaged(e.target.checked)}
                  />{' '}
                  {DISCREPANCY_LABELS.LABEL_MISSING_OR_DAMAGED}
                </label>
                <label style={flagStyle}>
                  <input type="checkbox" id="verification-record-data_mismatch" checked={dataMismatch} onChange={(e) => setDataMismatch(e.target.checked)} />{' '}
                  {DISCREPANCY_LABELS.DATA_MISMATCH}
                </label>
                {dataMismatch && (
                  <div style={{ marginTop: '0.25rem' }}>
                    <label htmlFor="verification-record-data_mismatch_note" style={fieldLabelStyle}>
                      ไม่ตรงอย่างไร (บังคับ)
                    </label>
                    <textarea
                      id="verification-record-data_mismatch_note"
                      value={dataMismatchNote}
                      maxLength={2000}
                      rows={2}
                      onChange={(e) => setDataMismatchNote(e.target.value)}
                      style={fieldInputStyle}
                    />
                  </div>
                )}
              </fieldset>
            </>
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
