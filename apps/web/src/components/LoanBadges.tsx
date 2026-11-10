import React from 'react';
import { ON_LOAN_LABEL, OVERDUE_LABEL, RETURNED_LATE_LABEL } from './loanFacts';

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  marginLeft: '0.375rem',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 600,
};

// "เกินกำหนด", as the server derives it: nobody sets it (LR-06).
export const OverdueBadge: React.FC<{ id?: string; testId?: string }> = ({ id, testId = 'loan-overdue' }) => (
  <span id={id} data-testid={testId} style={{ ...badgeStyle, backgroundColor: '#fee2e2', color: '#991b1b' }}>
    {OVERDUE_LABEL}
  </span>
);

// "กำลังถูกยืม": the Asset has an Outstanding LoanItem (F004-T4).
export const OnLoanBadge: React.FC<{ testId: string }> = ({ testId }) => (
  <span data-testid={testId} style={{ ...badgeStyle, backgroundColor: '#fef3c7', color: '#92400e' }}>
    {ON_LOAN_LABEL}
  </span>
);

// "คืนเกินกำหนด": a Loan Return dated after the item's Due Date.
export const ReturnedLateBadge: React.FC<{ testId?: string }> = ({ testId = 'loan-returned-late' }) => (
  <span data-testid={testId} style={{ ...badgeStyle, backgroundColor: '#ffedd5', color: '#9a3412' }}>
    {RETURNED_LATE_LABEL}
  </span>
);
