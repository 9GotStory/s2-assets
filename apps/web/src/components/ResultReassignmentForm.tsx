import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReassignmentForm } from './ReassignmentForm';
import type { AssignmentEvent } from './assignmentFacts';
import type { OnLoan } from './loanFacts';
import type { UnderRepair } from './repairFacts';
import type { VerificationRevision } from './verificationFacts';

// What the Reassignment form needs of the Asset besides its timeline: the version it is saved against, and the
// Loan and Repair notices it shows.
interface AssetAssignmentFacts {
  assignment_version: number;
  on_loan: OnLoan | null;
  under_repair: UnderRepair | null;
}

export interface ResultReassignmentFormProps {
  assetId: string;
  // A result with "Location ไม่ตรงทะเบียน", and its Round.
  revision: VerificationRevision;
  roundName: string;
  actorId: string | null;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const readJson = async <T,>(url: string, signal: AbortSignal, onPermissionRevoked?: (statusCode?: number) => void): Promise<T> => {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) {
    // A lost session or grant fails closed, as the Asset page does.
    if (res.status === 401 || res.status === 403) {
      onPermissionRevoked?.(res.status);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
};

/**
 * "ย้าย" from a result (F006-T8, #125 Q13, P2): the Reassignment form of Feature 003, opened with the Observed Location
 * and the Verification Date filled in and citing the result. It reads the Asset's assignment version and timeline
 * itself, so the Asset page panel and a Round page row open it alike; every Feature 003 rule still applies.
 */
export const ResultReassignmentForm: React.FC<ResultReassignmentFormProps> = ({
  assetId,
  revision,
  roundName,
  actorId,
  csrfToken,
  onRecorded,
  onCancel,
  onPermissionRevoked,
}) => {
  const asset = useQuery<AssetAssignmentFacts>({
    queryKey: ['result-reassignment-asset', actorId, assetId],
    queryFn: ({ signal }) => readJson<AssetAssignmentFacts>(`/assets/${assetId}`, signal, onPermissionRevoked),
    enabled: Boolean(actorId),
    retry: false,
  });
  const timeline = useQuery<AssignmentEvent[]>({
    queryKey: ['result-reassignment-timeline', actorId, assetId],
    queryFn: async ({ signal }) => (await readJson<{ items: AssignmentEvent[] }>(`/assets/${assetId}/assignments`, signal, onPermissionRevoked)).items,
    enabled: Boolean(actorId),
    retry: false,
  });

  if (asset.isError || timeline.isError) {
    return (
      <div role="alert" data-testid="result-reassignment-load-error" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
        ไม่สามารถโหลดข้อมูลสถานที่ของครุภัณฑ์ได้{' '}
        <button
          type="button"
          onClick={() => {
            void asset.refetch();
            void timeline.refetch();
          }}
        >
          ลองใหม่
        </button>{' '}
        <button type="button" onClick={onCancel}>
          ยกเลิก
        </button>
      </div>
    );
  }
  if (!asset.data || !timeline.data || !revision.observed_location) {
    return (
      <div role="status" style={{ color: '#4b5563', fontSize: '0.875rem' }}>
        กำลังโหลด...
      </div>
    );
  }

  return (
    <ReassignmentForm
      save={{
        assetId,
        assignmentVersion: asset.data.assignment_version,
        csrfToken,
        onRecorded,
        onRefresh: async () => {
          const [latest] = await Promise.all([asset.refetch(), timeline.refetch()]);
          return latest.isError ? null : (latest.data?.assignment_version ?? null);
        },
        onCancel,
        onPermissionRevoked,
      }}
      timeline={timeline.data}
      actorId={actorId}
      onLoan={asset.data.on_loan}
      underRepair={asset.data.under_repair}
      source={{
        verificationRevisionId: revision.id,
        roundName,
        verificationDate: revision.verification_date,
        observedLocationId: revision.observed_location.id,
      }}
    />
  );
};
