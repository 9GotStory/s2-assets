import React from 'react';
import { Link } from 'react-router';
import { conflictBoxStyle } from './AssignmentConflictWarning';
import { thaiDate } from './assignmentFacts';
import { LOAN_CONFLICT_LABEL, type LoanConflict, type WarnedLoanConflict } from './loanFacts';

// The other item's period: from its Loan Date to its ending, or still open.
const periodText = ({ loan_date: loanDate, ending_date: endingDate }: LoanConflict): string =>
  `${thaiDate(loanDate)} – ${endingDate ? thaiDate(endingDate) : 'ยังไม่สิ้นสุด'}`;

const actionStyle: React.CSSProperties = {
  padding: '0.375rem 0.75rem',
  borderRadius: '4px',
  fontSize: '0.8125rem',
  fontWeight: 600,
  cursor: 'pointer',
};

/**
 * F004-T7 (#81): the Loan Conflicts of one LoanItem, each with the other Loan. The mark goes away by
 * itself once a correction removes the overlap (#74 Q20).
 */
export const LoanConflictMarks: React.FC<{ conflicts: LoanConflict[]; testId: string }> = ({ conflicts, testId }) =>
  conflicts.length > 0 && (
    <ul data-testid={testId} style={{ margin: '0.25rem 0', paddingLeft: '1.25rem', color: '#92400e', fontWeight: 500 }}>
      {conflicts.map((conflict) => (
        <li key={conflict.loan_item_id} data-testid={`${testId}-${conflict.loan_item_id}`}>
          {LOAN_CONFLICT_LABEL}กับการยืม {periodText(conflict)}{' '}
          <Link to={`/loans/${conflict.loan_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
            ดูการยืม
          </Link>
        </li>
      ))}
    </ul>
  );

export interface LoanConflictWarningProps {
  conflicts: WarnedLoanConflict[];
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * F004-T7 (#81): the Loan Conflicts a save would create. Nothing is saved until the user confirms
 * them, and both Loans are then kept and marked (#74 Q20, Q25).
 */
export const LoanConflictWarning: React.FC<LoanConflictWarningProps> = ({ conflicts, onConfirm, onBack }) => (
  <div role="alert" data-testid="loan-conflict-warning" style={conflictBoxStyle}>
    <div style={{ fontWeight: 600 }}>
      การบันทึกนี้จะทำให้{LOAN_CONFLICT_LABEL} {conflicts.length} รายการ
    </div>
    <div style={{ marginTop: '0.25rem' }}>ระบบจะเก็บทั้งสองการยืมไว้และแสดงเครื่องหมาย จนกว่าจะแก้ไขรายการที่บันทึกผิดให้ช่วงไม่ทับกัน</div>
    <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
      {conflicts.map(({ asset_id: assetId, name, asset_number: assetNumber, conflicting }) => (
        <li key={`${assetId}-${conflicting.loan_item_id}`}>
          {name ?? assetNumber ?? assetId}: ทับกับการยืม {periodText(conflicting)}{' '}
          <Link to={`/loans/${conflicting.loan_id}`} target="_blank" rel="noreferrer">
            ดูการยืม
          </Link>
        </li>
      ))}
    </ul>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button type="button" id="loan-conflict-confirm" onClick={onConfirm} style={{ ...actionStyle, backgroundColor: '#b45309', color: '#ffffff', border: 'none' }}>
        ยืนยันบันทึก
      </button>
      <button type="button" id="loan-conflict-back" onClick={onBack} style={{ ...actionStyle, backgroundColor: '#ffffff', color: '#92400e', border: '1px solid #f59e0b' }}>
        กลับไปแก้ไข
      </button>
    </div>
  </div>
);
