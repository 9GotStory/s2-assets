import React from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { thaiDate } from './assignmentFacts';
import { RecordingContextLine, RevisionDiscrepancies } from './VerificationPanel';
import {
  ASSET_VERIFICATIONS_LABEL,
  ROUND_STATE_LABELS,
  VERIFICATION_DATE_LABEL,
  recordedByText,
  recordedContextText,
  resultText,
  roundLabel,
  type AssetVerification,
} from './verificationFacts';

export interface AssetVerificationSectionProps {
  assetId: string;
  actorId: string | null;
  // A new detail read also reads the Asset's results again.
  dataUpdatedAt?: number;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * "ผลตรวจประจำปี": the Asset's current result in every Round it belongs to, newest first (F006-T2, #125 Q21),
 * with its Observed Location and Discrepancies (F006-T3).
 */
export const AssetVerificationSection: React.FC<AssetVerificationSectionProps> = ({ assetId, actorId, dataUpdatedAt, onPermissionRevoked }) => {
  const verifications = useQuery<AssetVerification[], Error & { status?: number }>({
    queryKey: ['asset-verifications', actorId, assetId, dataUpdatedAt],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/assets/${assetId}/verifications`, { credentials: 'include', signal });
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
      previousQuery?.queryKey[1] === actorId && previousQuery?.queryKey[2] === assetId ? previous : undefined,
  });

  return (
    <section aria-labelledby="asset-verifications-heading" id="asset-verifications-section" style={{ marginBottom: '2rem' }}>
      <h2 id="asset-verifications-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '1rem', color: '#374151' }}>
        {ASSET_VERIFICATIONS_LABEL}
      </h2>
      {verifications.isError && verifications.error?.status !== 401 && verifications.error?.status !== 403 && (
        <div role="alert" data-testid="asset-verifications-error" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
          ไม่สามารถโหลด{ASSET_VERIFICATIONS_LABEL}ได้{' '}
          <button type="button" id="asset-verifications-retry" onClick={() => verifications.refetch()}>
            ลองใหม่
          </button>
        </div>
      )}
      {verifications.data &&
        (verifications.data.length === 0 ? (
          <p data-testid="asset-verifications-empty" style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>
            ยังไม่เคยอยู่ในรอบตรวจ
          </p>
        ) : (
          <ol data-testid="asset-verifications" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {verifications.data.map(({ round, entry_id: entryId, result, current }) => {
              return (
                <li key={entryId} data-testid={`asset-verification-${round.id}`} style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151', overflowWrap: 'anywhere' }}>
                  <div>
                    <Link to={`/verification-rounds/${round.id}`} style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 500 }}>
                      {roundLabel(round)}
                    </Link>{' '}
                    <span style={{ color: '#6b7280' }}>({ROUND_STATE_LABELS[round.state]})</span>
                  </div>
                  <div data-testid={`asset-verification-result-${round.id}`} style={{ fontWeight: 600, color: '#111827' }}>
                    {resultText(result, current?.condition)}
                    {current && (
                      <span style={{ fontWeight: 400, color: '#4b5563' }}>
                        {' '}
                        · {VERIFICATION_DATE_LABEL} <time dateTime={current.verification_date}>{thaiDate(current.verification_date)}</time> บันทึกโดย {recordedByText(current)}
                      </span>
                    )}
                  </div>
                  {current && <RevisionDiscrepancies revision={current} testId={`asset-verification-discrepancies-${round.id}`} />}
                  {current && recordedContextText(current) && (
                    <div style={{ color: '#92400e' }}>
                      ขณะตรวจ: <RecordingContextLine context={current} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ))}
    </section>
  );
};
