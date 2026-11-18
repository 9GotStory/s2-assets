import React from 'react';
import { badgeStyle } from './LoanBadges';
import { RETIRED_LABEL } from './retirementFacts';

// "จำหน่ายแล้ว": the Asset has a Retirement not voided, as the server derives it (F007-T1, #154 Q10).
export const RetiredBadge: React.FC<{ testId: string }> = ({ testId }) => (
  <span data-testid={testId} style={{ ...badgeStyle, backgroundColor: '#e5e7eb', color: '#1f2937' }}>
    {RETIRED_LABEL}
  </span>
);
