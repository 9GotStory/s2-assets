import React, { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { RepairStartForm } from './RepairStartForm';
import { thaiDate } from './assignmentFacts';
import {
  NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL,
  OUTCOME_DATE_LABEL,
  REPAIR_KIND_LABELS,
  REPAIR_OUTCOME_LABEL,
  REPAIR_OUTCOME_LABELS,
  REPAIR_SECTION_LABEL,
  REPAIR_START_LABEL,
  UNDER_REPAIR_LABELS,
  repairerText,
  type RepairRecord,
  type UnderRepair,
} from './repairFacts';

export interface RepairSectionProps {
  assetId: string;
  underRepair: UnderRepair | null;
  // From the Asset's latest Repair Outcome that has one; nothing is scheduled from it (#98 Q7).
  nextRecommendedMaintenanceDate: string | null;
  // Whether the viewer holds 'repair:record'.
  canRecordRepair: boolean;
  actorId: string | null;
  // A new detail read also reads the Asset's Repair Records again.
  dataUpdatedAt?: number;
  csrfToken: string | null;
  onStarted: () => Promise<void>;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * Whether the Asset is Under Repair, its Next Recommended Maintenance Date and its Repair Records with
 * their outcomes (F005-T1, T2), apart from the assignment timeline and from "การยืม": a Repair Record
 * never changes a Permanent Assignment (RM-05).
 */
export const RepairSection: React.FC<RepairSectionProps> = ({
  assetId,
  underRepair,
  nextRecommendedMaintenanceDate,
  canRecordRepair,
  actorId,
  dataUpdatedAt,
  csrfToken,
  onStarted,
  onPermissionRevoked,
}) => {
  const [isFormOpen, setIsFormOpen] = useState(false);

  const history = useQuery<RepairRecord[], Error & { status?: number }>({
    queryKey: ['asset-repairs', actorId, assetId, dataUpdatedAt],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/assets/${assetId}/repairs`, { credentials: 'include', signal });
      if (!res.ok) {
        // A lost session or grant fails closed: the page re-verifies and hides protected facts.
        if (res.status === 401 || res.status === 403) {
          onPermissionRevoked?.(res.status);
        }
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()).records;
    },
    enabled: Boolean(actorId),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === actorId && previousQuery?.queryKey[2] === assetId ? previous : undefined,
  });

  // While the Asset is Under Repair, the page links to that Repair Record instead of offering another:
  // the server would refuse it (#98 Q3, Q21).
  const mayStart = canRecordRepair && !underRepair;

  return (
    <section aria-labelledby="repair-heading" id="repair-section" style={{ marginBottom: '2rem' }}>
      <h2 id="repair-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '1rem', color: '#374151' }}>
        {REPAIR_SECTION_LABEL}
      </h2>

      {underRepair && (
        <dl
          data-testid="repair-under-repair"
          style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 1rem 0', fontSize: '0.9375rem', backgroundColor: '#fef3c7', padding: '1.25rem', borderRadius: '6px' }}
        >
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>สถานะ:</dt>
          <dd style={{ margin: 0, color: '#92400e', fontWeight: 600 }}>{UNDER_REPAIR_LABELS[underRepair.repair_kind]}</dd>
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>วันที่ส่งซ่อม:</dt>
          <dd style={{ margin: 0, color: '#111827' }}>
            <time dateTime={underRepair.start_date}>{thaiDate(underRepair.start_date)}</time>
          </dd>
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>ผู้ซ่อม:</dt>
          <dd style={{ margin: 0, color: '#111827' }}>{repairerText(underRepair.repairer)}</dd>
          <dt style={{ fontWeight: 500, color: '#4b5563' }}>รายการซ่อม:</dt>
          <dd style={{ margin: 0 }}>
            <Link to={`/repairs/${underRepair.repair_record_id}`} id="repair-current-link" style={{ color: '#2563eb', textDecoration: 'underline' }}>
              ดูรายการซ่อม →
            </Link>
          </dd>
        </dl>
      )}

      {nextRecommendedMaintenanceDate && (
        <p data-testid="repair-next-maintenance-date" style={{ margin: '0 0 1rem 0', fontSize: '0.9375rem', color: '#374151' }}>
          {NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL}:{' '}
          <time dateTime={nextRecommendedMaintenanceDate} style={{ fontWeight: 600 }}>
            {thaiDate(nextRecommendedMaintenanceDate)}
          </time>
        </p>
      )}

      {mayStart && isFormOpen && (
        <RepairStartForm
          assetId={assetId}
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
          id="repair-action"
          onClick={() => setIsFormOpen(true)}
          style={{ padding: '0.5rem 1rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', marginBottom: '1rem' }}
        >
          {REPAIR_START_LABEL}
        </button>
      )}

      {history.isError && history.error?.status !== 401 && history.error?.status !== 403 && (
        <div role="alert" data-testid="repair-history-error" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
          ไม่สามารถโหลดประวัติการซ่อม/บำรุงรักษาได้{' '}
          <button type="button" id="repair-history-retry" onClick={() => history.refetch()}>
            ลองใหม่
          </button>
        </div>
      )}
      {history.data &&
        (history.data.length === 0 ? (
          <p data-testid="repair-history-empty" style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>
            ยังไม่มีประวัติการซ่อม/บำรุงรักษา
          </p>
        ) : (
          <ol data-testid="repair-history" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {history.data.map((record) => (
              <li key={record.id} style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
                <div style={{ fontWeight: 500, color: '#111827' }}>
                  {REPAIR_KIND_LABELS[record.repair_kind]} · {repairerText(record.repairer)}
                </div>
                <div>
                  วันที่ส่งซ่อม: <time dateTime={record.start_date}>{thaiDate(record.start_date)}</time>
                </div>
                {record.outcome && (
                  <div data-testid={`repair-history-outcome-${record.id}`}>
                    {REPAIR_OUTCOME_LABEL}: {REPAIR_OUTCOME_LABELS[record.repair_kind][record.outcome.outcome]} · {OUTCOME_DATE_LABEL}:{' '}
                    <time dateTime={record.outcome.outcome_date}>{thaiDate(record.outcome.outcome_date)}</time>
                    {record.outcome.next_recommended_maintenance_date && (
                      <>
                        {' '}
                        · {NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL}:{' '}
                        <time dateTime={record.outcome.next_recommended_maintenance_date}>{thaiDate(record.outcome.next_recommended_maintenance_date)}</time>
                      </>
                    )}
                    {record.outcome.note && <div style={{ whiteSpace: 'pre-line' }}>หมายเหตุของผล: {record.outcome.note}</div>}
                    {record.outcome.document_reference && <div style={{ whiteSpace: 'pre-line' }}>เอกสารอ้างอิงของผล: {record.outcome.document_reference}</div>}
                  </div>
                )}
                <div style={{ whiteSpace: 'pre-line' }}>
                  อาการ/งานที่ทำ: {record.symptom_or_work}{' '}
                  <Link to={`/repairs/${record.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                    ดูรายการซ่อม
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
};
