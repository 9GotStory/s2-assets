import React from 'react';
import { Link } from 'react-router';
import { conflictActionStyle, conflictBoxStyle } from './AssignmentConflictWarning';
import { LOAN_CONFLICT_LABEL, type LoanConflict, type WarnedLoanConflict } from './loanFacts';
import { RepairConflictSide, periodText } from './RepairConflicts';
import { REPAIR_CONFLICT_LABEL, conflictingIdOf, type WarnedRepairConflict } from './repairFacts';

// The other item's period: from its Loan Date to its ending, or still open.
const loanPeriodText = ({ loan_date: loanDate, ending_date: endingDate }: LoanConflict): string => periodText(loanDate, endingDate);

/**
 * F004-T7 (#81): the Loan Conflicts of one LoanItem, each with the other Loan. The mark goes away by
 * itself once a correction removes the overlap (#74 Q20).
 */
export const LoanConflictMarks: React.FC<{ conflicts: LoanConflict[]; testId: string }> = ({ conflicts, testId }) =>
  conflicts.length > 0 && (
    <ul data-testid={testId} style={{ margin: '0.25rem 0', paddingLeft: '1.25rem', color: '#92400e', fontWeight: 500 }}>
      {conflicts.map((conflict) => (
        <li key={conflict.loan_item_id} data-testid={`${testId}-${conflict.loan_item_id}`}>
          {LOAN_CONFLICT_LABEL}กับการยืม {loanPeriodText(conflict)}{' '}
          <Link to={`/loans/${conflict.loan_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
            ดูการยืม
          </Link>
        </li>
      ))}
    </ul>
  );

export interface ConflictWarningProps {
  conflicts: WarnedLoanConflict[];
  repairConflicts: WarnedRepairConflict[];
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * F004-T7 (#81), F005-T7 (#105): the Loan Conflicts and Repair Conflicts a save would create, in one
 * warning. Nothing is saved until the user confirms them, and both sides of each are then kept and
 * marked (#74 Q20, Q25, #98 Q17).
 */
export const ConflictWarning: React.FC<ConflictWarningProps> = ({ conflicts, repairConflicts, onConfirm, onBack }) => (
  <div role="alert" data-testid="conflict-warning" style={conflictBoxStyle}>
    {conflicts.length > 0 && (
      <div style={{ fontWeight: 600 }}>
        การบันทึกนี้จะทำให้{LOAN_CONFLICT_LABEL} {conflicts.length} รายการ
      </div>
    )}
    {repairConflicts.length > 0 && (
      <div style={{ fontWeight: 600 }}>
        การบันทึกนี้จะทำให้{REPAIR_CONFLICT_LABEL} {repairConflicts.length} รายการ
      </div>
    )}
    <div style={{ marginTop: '0.25rem' }}>ระบบจะเก็บทั้งสองรายการไว้และแสดงเครื่องหมาย จนกว่าจะแก้ไขรายการที่บันทึกผิดให้ช่วงไม่ทับกัน</div>
    <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
      {conflicts.map(({ asset_id: assetId, name, asset_number: assetNumber, conflicting }) => (
        <li key={`${assetId}-${conflicting.loan_item_id}`}>
          {name ?? assetNumber ?? assetId}: ทับกับการยืม {loanPeriodText(conflicting)}{' '}
          <Link to={`/loans/${conflicting.loan_id}`} target="_blank" rel="noreferrer">
            ดูการยืม
          </Link>
        </li>
      ))}
      {repairConflicts.map(({ asset_id: assetId, name, asset_number: assetNumber, conflicting }) => (
        <li key={`${assetId}-${conflictingIdOf(conflicting)}`}>
          {name ?? assetNumber ?? assetId}: {REPAIR_CONFLICT_LABEL}กับ<RepairConflictSide conflicting={conflicting} newTab />
        </li>
      ))}
    </ul>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button type="button" id="conflict-confirm" onClick={onConfirm} style={{ ...conflictActionStyle, backgroundColor: '#b45309', color: '#ffffff', border: 'none' }}>
        ยืนยันบันทึก
      </button>
      <button type="button" id="conflict-back" onClick={onBack} style={{ ...conflictActionStyle, backgroundColor: '#ffffff', color: '#92400e', border: '1px solid #f59e0b' }}>
        กลับไปแก้ไข
      </button>
    </div>
  </div>
);
