import React from 'react';
import { Link } from 'react-router';
import { KIND_LABELS, thaiDate } from './assignmentFacts';
import { NOT_RETURNED_LABEL } from './loanFacts';
import { REPAIR_OUTCOME_LABEL, REPAIR_START_LABEL } from './repairFacts';
import { RETIREMENT_CONFLICT_LABEL, type RetirementConflict, type RetirementConflictKind } from './retirementFacts';
import { RESULT_LABELS, VERIFICATION_ROUND_LABEL } from './verificationFacts';

// What each fact a Retirement Conflict names is, and where its record is: on the Asset page itself for an assignment
// fact, otherwise its own page.
const FACT_VIEWS: Record<RetirementConflictKind, { label: string; record: 'ASSIGNMENT' | 'LOAN' | 'REPAIR' | 'ROUND' }> = {
  INITIAL_ASSIGNMENT: { label: KIND_LABELS.INITIAL, record: 'ASSIGNMENT' },
  REASSIGNMENT: { label: KIND_LABELS.REASSIGNMENT, record: 'ASSIGNMENT' },
  LOAN_DATE: { label: 'ยืม', record: 'LOAN' },
  LOAN_RETURN: { label: 'คืน', record: 'LOAN' },
  NOT_RETURNED: { label: NOT_RETURNED_LABEL, record: 'LOAN' },
  REPAIR_START: { label: REPAIR_START_LABEL, record: 'REPAIR' },
  REPAIR_OUTCOME: { label: REPAIR_OUTCOME_LABEL, record: 'REPAIR' },
  FOUND: { label: `ผลตรวจ ${RESULT_LABELS.FOUND}`, record: 'ROUND' },
};

// The page of each kind of record, and what its link says.
const RECORD_LINKS = {
  LOAN: { path: '/loans/', text: 'ดูการยืม' },
  REPAIR: { path: '/repairs/', text: 'ดูรายการซ่อม' },
  ROUND: { path: '/verification-rounds/', text: `ดู${VERIFICATION_ROUND_LABEL}` },
} as const;

const linkStyle: React.CSSProperties = { color: '#2563eb', textDecoration: 'underline' };

/**
 * One fact of a Retirement Conflict: what it is, its date, and a link to its record, where it can be corrected
 * (#154 Q21).
 */
export const RetirementConflictFact: React.FC<{ conflict: RetirementConflict; newTab?: boolean }> = ({ conflict, newTab = false }) => {
  const { kind, fact_date: factDate, record_id: recordId } = conflict;
  const { label, record } = FACT_VIEWS[kind];
  return (
    <>
      {label} <time dateTime={factDate}>{thaiDate(factDate)}</time>{' '}
      {record === 'ASSIGNMENT' ? (
        <a href={`#assignment-event-${recordId}`} style={linkStyle}>
          ดูประวัติการย้าย
        </a>
      ) : (
        <Link to={`${RECORD_LINKS[record].path}${recordId}`} style={linkStyle} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>
          {RECORD_LINKS[record].text}
        </Link>
      )}
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
