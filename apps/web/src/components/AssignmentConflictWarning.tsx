import React from 'react';
import { KIND_LABELS, conflictText, dimensionLabel, thaiDate, type AssignmentConflict } from './assignmentFacts';

export interface AssignmentConflictWarningProps {
  conflicts: AssignmentConflict[];
  onConfirm: () => void;
  onBack: () => void;
  // Names each conflict's Asset, when a save covers several.
  assetLabel?: (assetId: string) => string;
}

// The amber box of an Assignment Conflict: the warning before a save, and the notice on the Asset page.
export const conflictBoxStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  backgroundColor: '#fef3c7',
  border: '1px solid #f59e0b',
  borderRadius: '6px',
  color: '#92400e',
  fontSize: '0.875rem',
  marginBottom: '1rem',
};

// The confirm and back buttons of a conflict warning, Assignment or Loan.
export const conflictActionStyle: React.CSSProperties = {
  padding: '0.375rem 0.75rem',
  borderRadius: '4px',
  fontSize: '0.8125rem',
  fontWeight: 600,
  cursor: 'pointer',
};

/**
 * F003-T4 (#54): the Assignment Conflicts a save would create. Nothing is saved until the user
 * confirms, and both facts are then kept (MR-05, #50 Q12).
 */
export const AssignmentConflictWarning: React.FC<AssignmentConflictWarningProps> = ({ conflicts, onConfirm, onBack, assetLabel }) => (
  <div role="alert" data-testid="assignment-conflict-warning" style={conflictBoxStyle}>
    <div style={{ fontWeight: 600 }}>การบันทึกนี้จะทำให้ประวัติขัดแย้งกัน {conflicts.length} รายการ</div>
    <div style={{ marginTop: '0.25rem' }}>ระบบจะเก็บทุกรายการไว้และแสดงเครื่องหมายขัดแย้ง จนกว่าจะแก้ไขรายการที่บันทึกผิด</div>
    <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
      {conflicts.map((conflict) => (
        <li key={`${conflict.asset_id}-${conflict.event_id}-${conflict.dimension}`}>
          {assetLabel && `${assetLabel(conflict.asset_id)}: `}
          {conflict.event_id === null ? 'รายการที่กำลังบันทึก' : KIND_LABELS[conflict.kind]} (
          {conflict.effective_date ? thaiDate(conflict.effective_date) : 'ไม่ทราบวันที่'}) {dimensionLabel(conflict.dimension)}:{' '}
          {conflictText(conflict.recorded_prior, conflict.value_just_before)}
        </li>
      ))}
    </ul>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button
        type="button"
        id="assignment-conflict-confirm"
        onClick={onConfirm}
        style={{ ...conflictActionStyle, backgroundColor: '#b45309', color: '#ffffff', border: 'none' }}
      >
        ยืนยันบันทึก
      </button>
      <button
        type="button"
        id="assignment-conflict-back"
        onClick={onBack}
        style={{ ...conflictActionStyle, backgroundColor: '#ffffff', color: '#92400e', border: '1px solid #f59e0b' }}
      >
        กลับไปแก้ไข
      </button>
    </div>
  </div>
);
