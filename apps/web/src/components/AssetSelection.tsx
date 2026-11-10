import React from 'react';
import { BULK_REASSIGNMENT_LABEL } from './assignmentFacts';
import type { LoanCondition, OnLoan } from './loanFacts';

// #50 Q4, #74 Q9: as many as one Bulk Reassignment or one Loan takes.
export const SELECTION_MAX_ASSETS = 100;

// A row chosen in the Asset list, as the list last read it.
export interface SelectedAsset {
  id: string;
  name: string | null;
  asset_number: string | null;
  on_loan: OnLoan | null;
  latest_loan_return_condition: LoanCondition | null;
}

export const LOAN_FROM_LIST_LABEL = 'บันทึกการยืม';

export interface AssetSelectionBarProps {
  selectedCount: number;
  isPanelOpen: boolean;
  // Whether the viewer holds 'assignment:reassign' and 'loan:record'; the server decides again.
  canReassign: boolean;
  canRecordLoan: boolean;
  onOpenReassignment: () => void;
  onOpenLoan: () => void;
  onClear: () => void;
}

const actionStyle = (isDisabled: boolean): React.CSSProperties => ({
  padding: '0.375rem 0.75rem',
  backgroundColor: isDisabled ? '#9ca3af' : '#2563eb',
  color: '#ffffff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: isDisabled ? 'not-allowed' : 'pointer',
});

/** Above the Asset list: how many rows are selected, and what the viewer may do with them. */
export const AssetSelectionBar: React.FC<AssetSelectionBarProps> = ({
  selectedCount,
  isPanelOpen,
  canReassign,
  canRecordLoan,
  onOpenReassignment,
  onOpenLoan,
  onClear,
}) => {
  const cannotOpen = selectedCount === 0 || isPanelOpen;
  return (
    <div
      id="bulk-reassign-bar"
      style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.875rem', color: '#374151' }}
    >
      <span id="bulk-reassign-count">
        เลือกแล้ว {selectedCount} รายการ (ไม่เกิน {SELECTION_MAX_ASSETS})
      </span>
      {canReassign && (
        <button type="button" id="bulk-reassign-open" disabled={cannotOpen} onClick={onOpenReassignment} style={actionStyle(cannotOpen)}>
          {BULK_REASSIGNMENT_LABEL}
        </button>
      )}
      {canRecordLoan && (
        <button type="button" id="loan-from-list-open" disabled={cannotOpen} onClick={onOpenLoan} style={actionStyle(cannotOpen)}>
          {LOAN_FROM_LIST_LABEL}
        </button>
      )}
      {selectedCount > 0 && !isPanelOpen && (
        <button
          type="button"
          id="bulk-reassign-clear"
          onClick={onClear}
          style={{
            padding: '0.375rem 0.75rem',
            backgroundColor: '#ffffff',
            color: '#4b5563',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          ล้างการเลือก
        </button>
      )}
    </div>
  );
};
