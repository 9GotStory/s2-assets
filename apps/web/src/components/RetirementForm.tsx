import React, { useState } from 'react';
import { Link } from 'react-router';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday } from './assignmentFacts';
import { ON_LOAN_LABEL } from './loanFacts';
import { UNDER_REPAIR_LABELS } from './repairFacts';
import {
  RETIRED_LABEL,
  RETIREMENT_DATE_LABEL,
  RETIREMENT_LABEL,
  RETIREMENT_METHOD_LABEL,
  RETIREMENT_METHOD_LABELS,
  RETIREMENT_METHODS,
  RETIREMENT_REFERENCE_LABEL,
  type RetirementMethod,
  type RetirementRefusal,
} from './retirementFacts';

export interface RetirementFormProps {
  assetId: string;
  csrfToken: string | null;
  onRetired: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

// A refused Retirement names what keeps the Asset, with a link to it (#154 Q3, Q22).
export const RefusedRetirement: React.FC<{ asset: RetirementRefusal }> = ({ asset }) => {
  if (asset.reason === 'ALREADY_RETIRED') {
    return <>จำหน่ายไม่ได้ เพราะครุภัณฑ์นี้{RETIRED_LABEL}</>;
  }
  if (asset.reason === 'ON_LOAN') {
    return (
      <>
        จำหน่ายไม่ได้ เพราะ{ON_LOAN_LABEL} ต้องบันทึกการคืนหรือปิดโดยไม่ได้รับคืนก่อน <Link to={`/loans/${asset.loan_id}`}>ดูการยืม</Link>
      </>
    );
  }
  return (
    <>
      จำหน่ายไม่ได้ เพราะ{UNDER_REPAIR_LABELS[asset.repair_kind]} ต้องบันทึกผลการซ่อมก่อน <Link to={`/repairs/${asset.repair_record_id}`}>ดูรายการซ่อม</Link>
    </>
  );
};

/**
 * "จำหน่าย": records that the Asset left use for good, after its external disposal process finished
 * (F007-T1, #154 Q1–Q5, Q15). The server decides again everything this form checks.
 */
export const RetirementForm: React.FC<RetirementFormProps> = ({ assetId, csrfToken, onRetired, onCancel, onPermissionRevoked }) => {
  const [retirementDate, setRetirementDate] = useState(bangkokToday);
  const [retirementMethod, setRetirementMethod] = useState<RetirementMethod | ''>('');
  const [retirementReference, setRetirementReference] = useState('');
  const [note, setNote] = useState('');

  const requestError = (): string | null => {
    if (retirementDate === '') {
      return 'กรุณาเลือกวันที่จำหน่าย';
    }
    if (retirementDate > bangkokToday()) {
      return 'วันที่จำหน่ายต้องไม่เกินวันนี้';
    }
    return retirementMethod === '' ? 'กรุณาเลือกวิธีจำหน่าย' : null;
  };

  const requestBody = () => ({
    retirement_date: retirementDate,
    retirement_method: retirementMethod,
    retirement_reference: retirementReference.trim() || null,
    note: note.trim() || null,
  });

  return (
    <LoanSaveForm
      idPrefix="retirement"
      heading={RETIREMENT_LABEL}
      saveUrl={`/assets/${assetId}/retirements`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => (body?.code === 'RETIREMENT_REFUSED' ? <RefusedRetirement asset={body.asset as RetirementRefusal} /> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์บันทึกการจำหน่าย"
      refusedMessage="ไม่สามารถบันทึกการจำหน่ายได้"
      onSaved={onRetired}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div style={fieldStyle}>
              <label htmlFor="retirement-retirement_date" style={fieldLabelStyle}>
                {RETIREMENT_DATE_LABEL}
              </label>
              <input
                id="retirement-retirement_date"
                type="date"
                value={retirementDate}
                max={bangkokToday()}
                onChange={(e) => setRetirementDate(e.target.value)}
                style={fieldInputStyle}
              />
            </div>
            <div style={fieldStyle}>
              <label htmlFor="retirement-retirement_method" style={fieldLabelStyle}>
                {RETIREMENT_METHOD_LABEL}
              </label>
              <select
                id="retirement-retirement_method"
                value={retirementMethod}
                onChange={(e) => setRetirementMethod(e.target.value as RetirementMethod | '')}
                style={fieldInputStyle}
              >
                <option value="">— เลือกวิธีจำหน่าย —</option>
                {RETIREMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {RETIREMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={fieldStyle}>
            <label htmlFor="retirement-retirement_reference" style={fieldLabelStyle}>
              {RETIREMENT_REFERENCE_LABEL} (ไม่บังคับ)
            </label>
            <input
              id="retirement-retirement_reference"
              type="text"
              value={retirementReference}
              maxLength={500}
              onChange={(e) => setRetirementReference(e.target.value)}
              placeholder="เช่น เลขที่และวันที่ของคำสั่งจำหน่าย"
              style={fieldInputStyle}
            />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="retirement-note" style={fieldLabelStyle}>
              หมายเหตุ (ไม่บังคับ)
            </label>
            <textarea id="retirement-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
