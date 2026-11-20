import React, { useState } from 'react';
import { Link } from 'react-router';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday } from './assignmentFacts';
import type { RepairKind } from './repairFacts';
import { NOT_RETURNED_LABEL, ON_LOAN_LABEL } from './loanFacts';
import { RECORD_REPAIR_OUTCOME_LABEL, UNDER_REPAIR_LABELS } from './repairFacts';
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
  csrfToken: string;
  onRetired: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

// What keeps an Asset from a Retirement until it is resolved as it really ended (DR-14, DR-15, DR-16).
export type RetirementBlocker = { reason: 'ON_LOAN'; loan_id: string } | { reason: 'UNDER_REPAIR'; repair_record_id: string; repair_kind: RepairKind };

const linkStyle: React.CSSProperties = { color: '#2563eb', textDecoration: 'underline' };

// Why the Asset cannot be retired now, with a link to the Loan or the Repair Record that keeps it (#154 Q3, Q22).
// The section says it before the form opens, and a refused save says the same.
export const RetirementBlockedText: React.FC<{ blocker: RetirementBlocker; linkId?: string }> = ({ blocker, linkId }) =>
  blocker.reason === 'ON_LOAN' ? (
    <>
      จำหน่ายไม่ได้ เพราะครุภัณฑ์นี้{ON_LOAN_LABEL} ต้องบันทึกการคืนหรือ{NOT_RETURNED_LABEL}ก่อน{' '}
      <Link to={`/loans/${blocker.loan_id}`} id={linkId} style={linkStyle}>
        ดูการยืม
      </Link>
    </>
  ) : (
    <>
      จำหน่ายไม่ได้ เพราะครุภัณฑ์นี้{UNDER_REPAIR_LABELS[blocker.repair_kind]} ต้อง{RECORD_REPAIR_OUTCOME_LABEL}ก่อน{' '}
      <Link to={`/repairs/${blocker.repair_record_id}`} id={linkId} style={linkStyle}>
        ดูรายการซ่อม
      </Link>
    </>
  );

// A refused Retirement names what keeps the Asset (#154 Q3, P2).
const RefusedRetirement: React.FC<{ asset: RetirementRefusal }> = ({ asset }) =>
  asset.reason === 'ALREADY_RETIRED' ? <>จำหน่ายไม่ได้ เพราะครุภัณฑ์นี้{RETIRED_LABEL}</> : <RetirementBlockedText blocker={asset} />;

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
