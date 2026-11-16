import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { VoidedMark } from './LoanBadges';
import { RevisionFacts } from './VerificationPanel';
import { voidedStyle } from './loanFacts';
import { VERIFICATION_REVISIONS_LABEL, recordedByText, type ListedVerificationRevision } from './verificationFacts';

export interface VerificationRevisionListProps {
  roundId: string;
  assetId: string;
  revisionCount: number;
  // The signed-in user on a page that tracks one: null while there is none, and nothing is read.
  actorId?: string | null;
  // A new read of the page reads the revisions again.
  dataUpdatedAt?: number;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

/**
 * An entry's revisions, newest first, read when opened (F006-T4, #125 Q21). A voided revision stays shown as
 * ยกเลิกแล้ว, struck through, with the reason, actor and time of its Verification Correction (Q18). A disclosure,
 * not a button: the Round page offers a Read-only User no action.
 */
export const VerificationRevisionList: React.FC<VerificationRevisionListProps> = ({ roundId, assetId, revisionCount, actorId, dataUpdatedAt, onPermissionRevoked }) => {
  const [isOpen, setIsOpen] = useState(false);
  const revisions = useQuery<ListedVerificationRevision[], Error & { status?: number }>({
    queryKey: ['verification-revisions', actorId, roundId, assetId, dataUpdatedAt],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/verification-rounds/${roundId}/assets/${assetId}/verifications`, { credentials: 'include', signal });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          onPermissionRevoked?.(res.status);
        }
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()).items;
    },
    enabled: isOpen && actorId !== null,
  });
  const testId = `verification-revisions-${roundId}-${assetId}`;

  return (
    <details data-testid={testId} onToggle={(e) => setIsOpen(e.currentTarget.open)} style={{ marginTop: '0.375rem' }}>
      <summary style={{ cursor: 'pointer', color: '#2563eb' }}>
        {VERIFICATION_REVISIONS_LABEL} ({revisionCount} ครั้ง)
      </summary>
      {revisions.isError && revisions.error?.status !== 401 && revisions.error?.status !== 403 && (
        <div role="alert" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
          ไม่สามารถโหลด{VERIFICATION_REVISIONS_LABEL}ได้{' '}
          <button type="button" onClick={() => revisions.refetch()}>
            ลองใหม่
          </button>
        </div>
      )}
      {revisions.data && (
        <ol style={{ listStyle: 'none', margin: '0.5rem 0 0 0', padding: 0 }}>
          {revisions.data.map((revision) => (
            <li key={revision.id} data-testid={`${testId}-${revision.revision_number}`} style={{ borderLeft: '3px solid #e5e7eb', padding: '0.25rem 0 0.25rem 0.75rem', marginBottom: '0.5rem' }}>
              <div style={{ fontWeight: 600, color: '#374151' }}>
                ครั้งที่ {revision.revision_number}
                {revision.is_voided && <VoidedMark testId={`${testId}-${revision.revision_number}-voided`} />}
              </div>
              <div style={revision.is_voided ? voidedStyle : undefined}>
                <RevisionFacts revision={revision} testId={`${testId}-${revision.revision_number}-facts`} />
              </div>
              {revision.correction && (
                <div data-testid={`${testId}-${revision.revision_number}-correction`} style={{ marginTop: '0.25rem', color: '#991b1b', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
                  ยกเลิกโดย {recordedByText(revision.correction)} เมื่อ{' '}
                  <time dateTime={revision.correction.recorded_at}>{THAI_DATE_TIME.format(new Date(revision.correction.recorded_at))}</time> เหตุผล: {revision.correction.reason}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
};
