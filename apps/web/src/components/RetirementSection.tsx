import React, { useState } from 'react';
import { VoidedMark } from './LoanBadges';
import { RetirementBlockedText, RetirementForm, type RetirementBlocker } from './RetirementForm';
import { thaiDate } from './assignmentFacts';
import { voidedStyle, type OnLoan } from './loanFacts';
import type { UnderRepair } from './repairFacts';
import { RETIREMENT_DATE_LABEL, RETIREMENT_LABEL, RETIREMENT_METHOD_LABELS, RETIREMENT_REFERENCE_LABEL, RETIREMENT_SECTION_LABEL, type Retirement } from './retirementFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

export interface RetirementSectionProps {
  assetId: string;
  // Every Retirement of the Asset, oldest first, voided ones included (#154 P3).
  retirements: Retirement[];
  // Whether the viewer holds 'retirement:record' and the Asset is not Retired.
  canRetire: boolean;
  // What keeps the Asset from a Retirement, as the server derives it (DR-14, DR-15).
  onLoan: OnLoan | null;
  underRepair: UnderRepair | null;
  csrfToken: string | null;
  onRetired: () => Promise<void>;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * "การจำหน่าย" (F007-T1, #154 Q22, P3): the Asset's Retirements, its own history apart from the register's,
 * and "จำหน่าย" for a Custodian. While the Asset is On Loan or Under Repair the section says why it cannot be
 * retired and links to what keeps it, instead of the form; the server refuses it there too.
 */
export const RetirementSection: React.FC<RetirementSectionProps> = ({ assetId, retirements, canRetire, onLoan, underRepair, csrfToken, onRetired, onPermissionRevoked }) => {
  const [isOpen, setIsOpen] = useState(false);
  // The action waits for the CSRF token, so that a save never goes without it (#135).
  const mayRetire = canRetire && csrfToken !== null;
  const blocker: RetirementBlocker | null = onLoan
    ? { reason: 'ON_LOAN', loan_id: onLoan.loan_id }
    : underRepair
      ? { reason: 'UNDER_REPAIR', repair_record_id: underRepair.repair_record_id, repair_kind: underRepair.repair_kind }
      : null;

  return (
    <section aria-labelledby="retirement-heading" id="retirement-section" style={{ marginBottom: '2rem' }}>
      <h2 id="retirement-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '1rem', color: '#374151' }}>
        {RETIREMENT_SECTION_LABEL}
      </h2>

      {retirements.length === 0 ? (
        <p data-testid="retirement-history-empty" style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#9ca3af' }}>
          ยังไม่มีการจำหน่าย
        </p>
      ) : (
        <ol data-testid="retirement-history" style={{ listStyle: 'none', margin: '0 0 1rem 0', padding: 0 }}>
          {retirements.map((retirement) => (
            <li
              key={retirement.id}
              data-testid={`retirement-${retirement.id}`}
              style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}
            >
              <div style={{ fontWeight: 500, color: '#111827' }}>
                <span style={retirement.is_voided ? voidedStyle : undefined}>
                  {RETIREMENT_METHOD_LABELS[retirement.retirement_method]} · {RETIREMENT_DATE_LABEL}:{' '}
                  <time dateTime={retirement.retirement_date}>{thaiDate(retirement.retirement_date)}</time>
                </span>
                {retirement.is_voided && <VoidedMark testId={`retirement-voided-${retirement.id}`} />}
              </div>
              {retirement.retirement_reference && (
                <div style={{ whiteSpace: 'pre-line', ...(retirement.is_voided ? voidedStyle : {}) }}>
                  {RETIREMENT_REFERENCE_LABEL}: {retirement.retirement_reference}
                </div>
              )}
              {retirement.note && <div style={{ whiteSpace: 'pre-line', ...(retirement.is_voided ? voidedStyle : {}) }}>หมายเหตุ: {retirement.note}</div>}
              <div style={{ color: '#6b7280' }}>
                บันทึกเมื่อ <time dateTime={retirement.recorded_at}>{THAI_DATE_TIME.format(new Date(retirement.recorded_at))}</time> โดย{' '}
                {retirement.recorded_by_username ?? retirement.recorded_by}
              </div>
            </li>
          ))}
        </ol>
      )}

      {mayRetire && !isOpen && (
        <button
          type="button"
          id="retirement-action"
          onClick={() => setIsOpen(true)}
          style={{ padding: '0.5rem 1rem', backgroundColor: '#b91c1c', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
        >
          {RETIREMENT_LABEL}
        </button>
      )}
      {mayRetire && isOpen && blocker && (
        <div role="note" data-testid="retirement-blocked" style={{ padding: '0.75rem 1rem', backgroundColor: '#fef3c7', color: '#92400e', borderRadius: '6px', fontSize: '0.875rem' }}>
          <RetirementBlockedText blocker={blocker} linkId="retirement-blocked-link" />{' '}
          <button type="button" id="retirement-blocked-close" onClick={() => setIsOpen(false)}>
            ปิด
          </button>
        </div>
      )}
      {mayRetire && isOpen && !blocker && (
        <RetirementForm
          assetId={assetId}
          csrfToken={csrfToken}
          onRetired={async () => {
            await onRetired();
            setIsOpen(false);
          }}
          onCancel={() => setIsOpen(false)}
          onPermissionRevoked={onPermissionRevoked}
        />
      )}
    </section>
  );
};
