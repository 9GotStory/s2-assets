import React, { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { OverdueBadge, ReturnedLateBadge } from './LoanBadges';
import { LoanStartForm, type LoanFormAsset } from './LoanStartForm';
import { thaiDate } from './assignmentFacts';
import { CONDITION_LABELS, ON_LOAN_LABEL, borrowerText, loanReturnText, type AssetLoanItem, type OnLoan } from './loanFacts';

export interface LoanSectionProps {
  asset: LoanFormAsset;
  onLoan: OnLoan | null;
  // Whether the viewer holds 'loan:record'.
  canRecordLoan: boolean;
  actorId: string | null;
  // A new detail read also reads the Asset's Loans again.
  dataUpdatedAt?: number;
  csrfToken: string | null;
  onStarted: () => Promise<void>;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * Who holds the Asset now and its Loans (F004-T1), apart from the assignment timeline: a Loan never
 * changes a Permanent Assignment (LR-10).
 */
export const LoanSection: React.FC<LoanSectionProps> = ({
  asset,
  onLoan,
  canRecordLoan,
  actorId,
  dataUpdatedAt,
  csrfToken,
  onStarted,
  onPermissionRevoked,
}) => {
  const [isFormOpen, setIsFormOpen] = useState(false);

  const history = useQuery<AssetLoanItem[], Error & { status?: number }>({
    queryKey: ['asset-loans', actorId, asset.id, dataUpdatedAt],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/assets/${asset.id}/loans`, { credentials: 'include', signal });
      if (!res.ok) {
        // A lost session or grant fails closed: the page re-verifies and hides protected facts.
        if (res.status === 401 || res.status === 403) {
          onPermissionRevoked?.(res.status);
        }
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()).items;
    },
    enabled: Boolean(actorId),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === actorId && previousQuery?.queryKey[2] === asset.id ? previous : undefined,
  });

  // While the Asset is On Loan, the page links to that Loan instead of offering another.
  const mayStart = canRecordLoan && !onLoan;

  return (
    <section aria-labelledby="loan-heading" id="loan-section" style={{ marginBottom: '2rem' }}>
      <h2 id="loan-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '1rem', color: '#374151' }}>
        การยืม
      </h2>

      {onLoan && (
        <dl
          data-testid="loan-on-loan"
          style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 1rem 0', fontSize: '0.9375rem', backgroundColor: '#fef3c7', padding: '1.25rem', borderRadius: '6px' }}
        >
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>สถานะ:</dt>
          <dd style={{ margin: 0, color: '#92400e', fontWeight: 600 }}>{ON_LOAN_LABEL}</dd>
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>ผู้ยืม:</dt>
          <dd style={{ margin: 0, color: '#111827' }}>{borrowerText(onLoan.borrower)}</dd>
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>กำหนดคืน:</dt>
          <dd style={{ margin: 0, color: '#111827' }}>
            <time dateTime={onLoan.due_date}>{thaiDate(onLoan.due_date)}</time>
            {onLoan.is_overdue && (
              <>
                {' '}
                <OverdueBadge testId="loan-on-loan-overdue" />
              </>
            )}
          </dd>
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>การยืม:</dt>
          <dd style={{ margin: 0 }}>
            <Link to={`/loans/${onLoan.loan_id}`} id="loan-current-link" style={{ color: '#2563eb', textDecoration: 'underline' }}>
              ดูการยืม →
            </Link>
          </dd>
        </dl>
      )}

      {mayStart && isFormOpen && (
        <LoanStartForm
          assets={[asset]}
          actorId={actorId}
          csrfToken={csrfToken}
          onStarted={async () => {
            await onStarted();
            setIsFormOpen(false);
          }}
          onCancel={() => setIsFormOpen(false)}
          onPermissionRevoked={onPermissionRevoked}
        />
      )}
      {mayStart && !isFormOpen && (
        <button
          type="button"
          id="loan-action"
          onClick={() => setIsFormOpen(true)}
          style={{ padding: '0.5rem 1rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', marginBottom: '1rem' }}
        >
          บันทึกการยืม
        </button>
      )}

      {history.isError && history.error?.status !== 401 && history.error?.status !== 403 && (
        <div role="alert" data-testid="loan-history-error" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
          ไม่สามารถโหลดประวัติการยืมได้{' '}
          <button type="button" id="loan-history-retry" onClick={() => history.refetch()}>
            ลองใหม่
          </button>
        </div>
      )}
      {history.data &&
        (history.data.length === 0 ? (
          <p data-testid="loan-history-empty" style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>
            ยังไม่มีประวัติการยืม
          </p>
        ) : (
          <ol data-testid="loan-history" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {history.data.map((item) => (
              <li key={item.id} style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
                <div style={{ fontWeight: 500, color: '#111827' }}>{borrowerText(item.borrower)}</div>
                <div>
                  วันที่ยืม: <time dateTime={item.loan_date}>{thaiDate(item.loan_date)}</time> · กำหนดคืน:{' '}
                  <time dateTime={item.due_date}>{thaiDate(item.due_date)}</time>
                  {item.is_overdue && (
                    <>
                      {' '}
                      <OverdueBadge />
                    </>
                  )}
                </div>
                <div>
                  สภาพ: {CONDITION_LABELS[item.condition]}
                  {item.condition_note ? ` (${item.condition_note})` : ''}{' '}
                  <Link to={`/loans/${item.loan_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                    ดูการยืม
                  </Link>
                </div>
                {item.loan_return && (
                  <div>
                    คืนแล้ว: <time dateTime={item.loan_return.return_date}>{thaiDate(item.loan_return.return_date)}</time> · {loanReturnText(item.loan_return)}
                    {item.loan_return.returned_after_due_date && (
                      <>
                        {' '}
                        <ReturnedLateBadge />
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
};
