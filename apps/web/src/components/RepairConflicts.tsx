import React from 'react';
import { Link } from 'react-router';
import { thaiDate } from './assignmentFacts';
import { REPAIR_CONFLICT_LABEL, REPAIR_KIND_LABELS, type RepairConflict } from './repairFacts';

// A period from its start to its end, or still open.
const periodText = (start: string, end: string | null): string => `${thaiDate(start)} – ${end ? thaiDate(end) : 'ยังไม่สิ้นสุด'}`;

/** The other side of a Repair Conflict: what it is, its period, and a link to it. */
export const RepairConflictSide: React.FC<{ conflicting: RepairConflict; newTab?: boolean }> = ({ conflicting, newTab = false }) => {
  const linkProps = newTab ? { target: '_blank', rel: 'noreferrer' } : {};
  return conflicting.kind === 'LOAN_ITEM' ? (
    <>
      การยืม {periodText(conflicting.loan_date, conflicting.ending_date)}{' '}
      <Link to={`/loans/${conflicting.loan_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }} {...linkProps}>
        ดูการยืม
      </Link>
    </>
  ) : (
    <>
      รายการ{REPAIR_KIND_LABELS[conflicting.repair_kind]} {periodText(conflicting.start_date, conflicting.outcome_date)}{' '}
      <Link to={`/repairs/${conflicting.repair_record_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }} {...linkProps}>
        ดูรายการซ่อม
      </Link>
    </>
  );
};

const sideId = (conflicting: RepairConflict): string => (conflicting.kind === 'LOAN_ITEM' ? conflicting.loan_item_id : conflicting.repair_record_id);

/**
 * F005-T7 (#105): the Repair Conflicts of one Repair Record, each with the other Repair Record or Loan.
 * The mark goes away by itself once a correction removes the overlap (#98 Q17).
 */
export const RepairConflictMarks: React.FC<{ conflicts: RepairConflict[]; testId: string }> = ({ conflicts, testId }) =>
  conflicts.length > 0 && (
    <ul data-testid={testId} style={{ margin: '0.25rem 0', paddingLeft: '1.25rem', color: '#92400e', fontWeight: 500 }}>
      {conflicts.map((conflicting) => (
        <li key={sideId(conflicting)} data-testid={`${testId}-${sideId(conflicting)}`}>
          {REPAIR_CONFLICT_LABEL}กับ<RepairConflictSide conflicting={conflicting} />
        </li>
      ))}
    </ul>
  );
