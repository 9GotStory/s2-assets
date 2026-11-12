import React from 'react';
import { badgeStyle } from './LoanBadges';
import { UNDER_REPAIR_LABELS, type RepairKind } from './repairFacts';

// "อยู่ระหว่างซ่อม" or "อยู่ระหว่างบำรุงรักษา", by the record's kind: derived by the server (F005-T4, #98 Q21).
export const UnderRepairBadge: React.FC<{ repairKind: RepairKind; testId: string }> = ({ repairKind, testId }) => (
  <span data-testid={testId} style={{ ...badgeStyle, backgroundColor: '#e0e7ff', color: '#3730a3' }}>
    {UNDER_REPAIR_LABELS[repairKind]}
  </span>
);
