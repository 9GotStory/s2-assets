import React from 'react';
import { entryLabel, type ReferenceEntry } from './ReferenceContextFields';
import { CORRECTION_LABELS, thaiDate } from './assignmentFacts';
import {
  CONDITION_LABELS,
  DUE_DATE_EXTENSION_LABEL,
  NOT_RETURNED_LABEL,
  assetLabel,
  type Loan,
  type LoanCondition,
  type LoanCorrection,
  type LoanCorrectionField,
  type LoanCorrectionTarget,
} from './loanFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const FIELD_LABELS: Record<string, string> = {
  borrower_kind: 'ประเภทผู้ยืม',
  borrower_person_id: 'ผู้ยืม',
  borrower_contact_name: 'ชื่อผู้ติดต่อ',
  borrower_organization_name: 'ชื่อหน่วยงาน',
  borrower_phone: 'เบอร์โทร',
  loan_date: 'วันที่ยืม',
  authorizer_person_id: 'ผู้อนุญาต',
  document_reference: 'เอกสารอ้างอิง',
  remark: 'หมายเหตุ',
  due_date: 'กำหนดคืนที่บันทึกครั้งแรก',
  condition: 'สภาพ',
  condition_note: 'บันทึกสภาพ',
  return_date: 'วันที่คืน',
  not_returned_date: 'วันที่ทราบ',
  reason: 'เหตุผลที่ไม่ได้รับคืน',
};

const DATE_FIELDS = new Set(['loan_date', 'due_date', 'return_date', 'not_returned_date']);

const BORROWER_KIND_LABELS: Record<string, string> = { INTERNAL: 'ผู้ยืมภายใน', EXTERNAL: 'ผู้ยืมภายนอก' };

// The fact a correction names, as the Loan page calls it.
export const correctionTargetText = (loan: Loan, target: LoanCorrectionTarget): string => {
  if (target.kind === 'LOAN') {
    return 'การยืม';
  }
  const item = loan.items.find(
    (candidate) =>
      candidate.id === target.id ||
      candidate.loan_return?.id === target.id ||
      candidate.not_returned?.id === target.id ||
      candidate.voided_endings.some(({ id }) => id === target.id) ||
      candidate.due_date_extensions.some(({ id }) => id === target.id)
  );
  const asset = item ? assetLabel(item.asset) : '';
  const prefix = { LOAN_ITEM: 'รายการ', LOAN_RETURN: 'การคืน', NOT_RETURNED: NOT_RETURNED_LABEL, DUE_DATE_EXTENSION: DUE_DATE_EXTENSION_LABEL }[target.kind];
  return `${prefix}: ${asset}`;
};

const valueText = (field: string, value: string | ReferenceEntry | null): string => {
  if (value === null) {
    return 'ไม่ระบุ';
  }
  if (typeof value !== 'string') {
    return entryLabel(value);
  }
  if (DATE_FIELDS.has(field)) {
    return thaiDate(value);
  }
  if (field === 'condition') {
    return CONDITION_LABELS[value as LoanCondition];
  }
  return field === 'borrower_kind' ? BORROWER_KIND_LABELS[value] : value;
};

// One changed field, as "before แก้เป็น after". The phone number's change shows neither value (#74 Q24).
const changeText = (change: LoanCorrectionField): string => {
  const label = FIELD_LABELS[change.field] ?? change.field;
  if (!('before' in change)) {
    return `${label}: มีการเปลี่ยนแปลง`;
  }
  return `${label}: ${valueText(change.field, change.before)} แก้เป็น ${valueText(change.field, change.after)}`;
};

/** The Loan's corrections, oldest first, each with its fact, reason, who, when, and before and after. */
export const LoanCorrectionList: React.FC<{ loan: Loan; corrections: LoanCorrection[] }> = ({ loan, corrections }) => (
  <section aria-labelledby="loan-corrections-heading" style={{ marginTop: '1.5rem' }}>
    <h2 id="loan-corrections-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '0.75rem', color: '#374151' }}>
      การแก้ไขรายการที่บันทึกผิด
    </h2>
    <ol id="loan-corrections" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {corrections.map((correction) => (
        <li key={correction.id} data-testid="loan-correction" style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
          <div style={{ fontWeight: 600 }}>
            {CORRECTION_LABELS[correction.action]}: {correctionTargetText(loan, correction.target)}
          </div>
          <div style={{ color: '#4b5563' }}>
            บันทึกเมื่อ <time dateTime={correction.recorded_at}>{THAI_DATE_TIME.format(new Date(correction.recorded_at))}</time> โดย{' '}
            {correction.recorded_by_username ?? correction.recorded_by}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>เหตุผล: {correction.reason}</div>
          {correction.changes.length > 0 && (
            <ul style={{ margin: '0.125rem 0 0 0', paddingLeft: '1.25rem' }}>
              {correction.changes.map((change) => (
                <li key={change.field}>{changeText(change)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  </section>
);
