import React from 'react';
import { Link } from 'react-router';
import { KIND_LABELS, thaiDate } from './assignmentFacts';
import { NOT_RETURNED_LABEL } from './loanFacts';
import { REPAIR_OUTCOME_LABEL, REPAIR_START_LABEL } from './repairFacts';
import { RETIREMENT_CONFLICT_LABEL, type RetirementConflict, type RetirementConflictKind } from './retirementFacts';
import { RESULT_LABELS, VERIFICATION_ROUND_LABEL } from './verificationFacts';

// What each fact a Retirement Conflict names is, as the Asset page and the warning say it.
const FACT_LABELS: Record<RetirementConflictKind, string> = {
  INITIAL_ASSIGNMENT: KIND_LABELS.INITIAL,
  REASSIGNMENT: KIND_LABELS.REASSIGNMENT,
  LOAN_DATE: 'ยืม',
  LOAN_RETURN: 'คืน',
  NOT_RETURNED: NOT_RETURNED_LABEL,
  REPAIR_START: REPAIR_START_LABEL,
  REPAIR_OUTCOME: REPAIR_OUTCOME_LABEL,
  FOUND: `ผลตรวจ ${RESULT_LABELS.FOUND}`,
};

const linkStyle: React.CSSProperties = { color: '#2563eb', textDecoration: 'underline' };

/**
 * One fact of a Retirement Conflict: what it is, its date, and a link to its record, where it can be corrected
 * (#154 Q21). An assignment fact is on the Asset page itself.
 */
export const RetirementConflictFact: React.FC<{ conflict: RetirementConflict; newTab?: boolean }> = ({ conflict, newTab = false }) => {
  const linkProps = newTab ? { target: '_blank', rel: 'noreferrer' } : {};
  const { kind, fact_date: factDate, record_id: recordId } = conflict;
  const link =
    kind === 'INITIAL_ASSIGNMENT' || kind === 'REASSIGNMENT' ? (
      <a href={`#assignment-event-${recordId}`} style={linkStyle}>
        ดูประวัติการย้าย
      </a>
    ) : kind === 'LOAN_DATE' || kind === 'LOAN_RETURN' || kind === 'NOT_RETURNED' ? (
      <Link to={`/loans/${recordId}`} style={linkStyle} {...linkProps}>
        ดูการยืม
      </Link>
    ) : kind === 'REPAIR_START' || kind === 'REPAIR_OUTCOME' ? (
      <Link to={`/repairs/${recordId}`} style={linkStyle} {...linkProps}>
        ดูรายการซ่อม
      </Link>
    ) : (
      <Link to={`/verification-rounds/${recordId}`} style={linkStyle} {...linkProps}>
        ดู{VERIFICATION_ROUND_LABEL}
      </Link>
    );
  return (
    <>
      {FACT_LABELS[kind]} <time dateTime={factDate}>{thaiDate(factDate)}</time> {link}
    </>
  );
};

/**
 * F007-T6 (#160): "วันจำหน่ายขัดกับประวัติ" on the current Retirement, with each later fact and a link to it. It goes
 * away by itself once a correction fixes whichever fact was wrong; there is nothing to resolve by hand (DR-19, Q21).
 */
export const RetirementConflictNotice: React.FC<{ conflicts: RetirementConflict[] }> = ({ conflicts }) =>
  conflicts.length > 0 && (
    <div role="note" data-testid="retirement-conflicts" style={{ marginTop: '0.5rem', padding: '0.5rem 0.75rem', backgroundColor: '#fef3c7', color: '#92400e', borderRadius: '6px' }}>
      <div style={{ fontWeight: 600 }}>{RETIREMENT_CONFLICT_LABEL}</div>
      <div>วันที่จำหน่ายอยู่ก่อนรายการต่อไปนี้ แก้ไขรายการที่บันทึกผิดเพื่อให้ข้อความนี้หายไป</div>
      <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem' }}>
        {conflicts.map((conflict) => (
          <li key={`${conflict.kind}-${conflict.fact_id}`} data-testid={`retirement-conflict-${conflict.fact_id}`}>
            <RetirementConflictFact conflict={conflict} />
          </li>
        ))}
      </ul>
    </div>
  );
