import React, { useState } from 'react';
import { VoidedMark } from './LoanBadges';
import { RetirementAmendForm, RetirementVoidForm } from './RetirementCorrectionForms';
import { RetirementConflictNotice } from './RetirementConflicts';
import { RetirementCorrectionList } from './RetirementCorrectionList';
import { RetirementBlockedText, RetirementForm, type RetirementBlocker } from './RetirementForm';
import { CORRECTION_LABELS, thaiDate } from './assignmentFacts';
import { voidedStyle, type OnLoan } from './loanFacts';
import type { UnderRepair } from './repairFacts';
import {
  RETIREMENT_DATE_LABEL,
  RETIREMENT_LABEL,
  RETIREMENT_METHOD_LABELS,
  RETIREMENT_REFERENCE_LABEL,
  RETIREMENT_SECTION_LABEL,
  type Retirement,
  type RetirementConflict,
} from './retirementFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const correctionActionStyle: React.CSSProperties = {
  marginRight: '0.5rem',
  padding: '0.375rem 0.75rem',
  backgroundColor: '#ffffff',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.8125rem',
  cursor: 'pointer',
};

export interface RetirementSectionProps {
  assetId: string;
  // Every Retirement of the Asset, oldest first, voided ones included (#154 P3).
  retirements: Retirement[];
  // The Retirement Conflicts of the Retirement not voided (F007-T6).
  retirementConflicts: RetirementConflict[];
  // Whether the viewer holds 'retirement:record' and the Asset is not Retired.
  canRetire: boolean;
  // Whether the viewer holds 'retirement:correct' (F007-T5).
  canCorrectRetirement: boolean;
  // What keeps the Asset from a Retirement, as the server derives it (DR-14, DR-15).
  onLoan: OnLoan | null;
  underRepair: UnderRepair | null;
  csrfToken: string | null;
  // After a Retirement or a Retirement Correction is saved: reads the Asset again.
  onRetired: () => Promise<void>;
  // Reads the Asset again and returns the Retirement's version, or null when the read failed.
  onRefresh: (retirementId: string) => Promise<number | null>;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * "การจำหน่าย" (F007-T1, #154 Q22, P3): the Asset's Retirements, its own history apart from the register's,
 * and "จำหน่าย" for a Custodian. While the Asset is On Loan or Under Repair the section says why it cannot be
 * retired and links to what keeps it, instead of the form; the server refuses it there too. F007-T5: each
 * Retirement shows its corrections, and the one not voided offers "แก้ไขรายการที่บันทึกผิด" and "ยกเลิกรายการ"
 * to holders of 'retirement:correct'. F007-T6: the one not voided shows its Retirement Conflicts.
 */
export const RetirementSection: React.FC<RetirementSectionProps> = ({
  assetId,
  retirements,
  retirementConflicts,
  canRetire,
  canCorrectRetirement,
  onLoan,
  underRepair,
  csrfToken,
  onRetired,
  onRefresh,
  onPermissionRevoked,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [openCorrection, setOpenCorrection] = useState<'AMEND' | 'VOID' | null>(null);
  // The actions wait for the CSRF token, so that a save never goes without it (#135).
  const mayRetire = canRetire && csrfToken !== null;
  const mayCorrect = canCorrectRetirement && csrfToken !== null;
  const correctionFormProps = (retirement: Retirement) => ({
    retirement,
    onRecorded: async () => {
      await onRetired();
      setOpenCorrection(null);
    },
    onRefresh: () => onRefresh(retirement.id),
    onCancel: () => setOpenCorrection(null),
    onPermissionRevoked,
  });
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
              {!retirement.is_voided && <RetirementConflictNotice conflicts={retirementConflicts} />}
              {retirement.corrections.length > 0 && <RetirementCorrectionList retirementId={retirement.id} corrections={retirement.corrections} />}
              {/* A voided Retirement is neither amended nor voided again (#154 P2). */}
              {mayCorrect && !retirement.is_voided && openCorrection === null && (
                <div style={{ marginTop: '0.5rem' }}>
                  <button type="button" id="retirement-amend-action" onClick={() => setOpenCorrection('AMEND')} style={correctionActionStyle}>
                    {CORRECTION_LABELS.AMENDED}
                  </button>
                  <button type="button" id="retirement-void-action" onClick={() => setOpenCorrection('VOID')} style={correctionActionStyle}>
                    {CORRECTION_LABELS.VOIDED}
                  </button>
                </div>
              )}
              {mayCorrect && !retirement.is_voided && openCorrection !== null && (
                <div style={{ marginTop: '0.75rem' }}>
                  {openCorrection === 'AMEND' ? (
                    <RetirementAmendForm {...correctionFormProps(retirement)} csrfToken={csrfToken} />
                  ) : (
                    <RetirementVoidForm {...correctionFormProps(retirement)} csrfToken={csrfToken} />
                  )}
                </div>
              )}
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
