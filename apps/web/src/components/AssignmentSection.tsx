import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  REFERENCE_DIMENSIONS,
  entryLabel,
  type CurrentAssignment,
  type ReferenceEntry,
} from './ReferenceContextFields';

// One fact of an Asset's assignment timeline (GET /assets/:id/assignments, F003-T1).
export interface AssignmentValue {
  entry: ReferenceEntry | null;
  legacy_text: string | null;
}

export interface AssignmentChange {
  dimension: (typeof REFERENCE_DIMENSIONS)[number]['entryField'];
  prior: AssignmentValue;
  new: AssignmentValue;
}

export interface AssignmentEvent {
  id: string;
  kind: 'INITIAL' | 'REASSIGNMENT';
  effective_date: string | null;
  recorded_at: string;
  recorded_by: string;
  recorded_by_username: string | null;
  provenance: 'RECORDED' | 'CARRIED_OVER_F002';
  document_reference: string | null;
  remark: string | null;
  changes: AssignmentChange[];
}

// Labels from GLOSSARY.md (#50 Q18).
const KIND_LABELS: Record<AssignmentEvent['kind'], string> = {
  INITIAL: 'กำหนดครั้งแรก',
  REASSIGNMENT: 'ย้าย / เปลี่ยนผู้รับผิดชอบ',
};

const THAI_DATE = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'UTC' });
const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});
const THAI_RECORDED_DATE = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });

// A calendar date (YYYY-MM-DD) in Thai.
const thaiDate = (date: string) => THAI_DATE.format(new Date(`${date}T00:00:00Z`));

const valueText = (value: AssignmentValue): string => {
  const parts = [value.entry ? entryLabel(value.entry) : null, value.legacy_text ? `ข้อความเดิม: ${value.legacy_text}` : null];
  return parts.filter(Boolean).join(' / ') || 'ไม่ระบุ';
};

export interface AssignmentSectionProps {
  assetId: string;
  currentAssignment?: CurrentAssignment;
  actorId?: string | null;
  // A new detail read also reads the timeline again.
  dataUpdatedAt?: number;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * The Asset's Permanent Assignment (ADR 0001): the Current Assignment of each dimension and the
 * timeline of assignment facts, Effective Date ("วันที่มีผล") and Recorded At ("วันที่บันทึก") apart.
 */
export const AssignmentSection: React.FC<AssignmentSectionProps> = ({
  assetId,
  currentAssignment,
  actorId = null,
  dataUpdatedAt,
  onPermissionRevoked,
}) => {
  const timeline = useQuery<AssignmentEvent[], Error & { status?: number }>({
    queryKey: ['asset-assignments', actorId, assetId, dataUpdatedAt],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/assets/${assetId}/assignments`, { credentials: 'include', signal });
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
  });

  return (
    <section aria-labelledby="assignment-heading" id="assignment-section" style={{ marginBottom: '2rem' }}>
      <h2
        id="assignment-heading"
        style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '1rem', color: '#374151' }}
      >
        สถานที่ หน่วยงาน และผู้รับผิดชอบ
      </h2>

      <dl
        data-testid="current-assignment"
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '0.75rem 1.5rem',
          margin: '0 0 1rem 0',
          fontSize: '0.9375rem',
          backgroundColor: '#f9fafb',
          padding: '1.25rem',
          borderRadius: '6px',
        }}
      >
        {REFERENCE_DIMENSIONS.map(({ entryField, legacyField, label }) => {
          const entry = currentAssignment?.[entryField] ?? null;
          const legacyText = currentAssignment?.[legacyField] ?? null;
          return (
            <React.Fragment key={entryField}>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{label}:</dt>
              <dd id={`detail-${entryField}`} style={{ margin: 0, color: '#111827' }}>
                {entry ? entryLabel(entry) : !legacyText && <span style={{ color: '#9ca3af' }}>ไม่ระบุ</span>}
                {legacyText && (
                  <div style={{ fontSize: '0.8125rem', color: '#6b7280' }}>ข้อความเดิม: {legacyText}</div>
                )}
              </dd>
            </React.Fragment>
          );
        })}
      </dl>

      {timeline.isError && timeline.error?.status !== 401 && timeline.error?.status !== 403 && (
        <div role="alert" data-testid="assignment-timeline-error" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
          ไม่สามารถโหลดประวัติสถานที่ หน่วยงาน และผู้รับผิดชอบได้{' '}
          <button type="button" id="assignment-timeline-retry" onClick={() => timeline.refetch()}>
            ลองใหม่
          </button>
        </div>
      )}
      {timeline.data &&
        (timeline.data.length === 0 ? (
          <p data-testid="assignment-timeline-empty" style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>
            ยังไม่ได้กำหนดสถานที่ หน่วยงาน หรือผู้รับผิดชอบ
          </p>
        ) : (
          // The facts in the order of facts: Effective Date with unknown first, then Recorded At.
          <ol data-testid="assignment-timeline" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {timeline.data.map((event) => (
              <li
                key={event.id}
                data-testid={`assignment-event-${event.id}`}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: '6px',
                  padding: '0.75rem 1rem',
                  marginBottom: '0.5rem',
                  fontSize: '0.875rem',
                  color: '#374151',
                }}
              >
                <div style={{ fontWeight: 600, color: '#111827' }}>
                  {KIND_LABELS[event.kind]}
                  {event.provenance === 'CARRIED_OVER_F002' && (
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', fontWeight: 400, color: '#92400e' }}>
                      ยกมาจากทะเบียนเดิม
                    </span>
                  )}
                </div>
                <div>
                  วันที่มีผล:{' '}
                  {event.effective_date ? (
                    <time dateTime={event.effective_date}>{thaiDate(event.effective_date)}</time>
                  ) : (
                    `ไม่ทราบวันที่ (บันทึกเมื่อ ${THAI_RECORDED_DATE.format(new Date(event.recorded_at))})`
                  )}
                </div>
                <div style={{ color: '#4b5563' }}>
                  วันที่บันทึก: <time dateTime={event.recorded_at}>{THAI_DATE_TIME.format(new Date(event.recorded_at))}</time>{' '}
                  โดย {event.recorded_by_username ?? event.recorded_by}
                </div>
                <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem' }}>
                  {event.changes.map((change) => {
                    const { label } = REFERENCE_DIMENSIONS.find(({ entryField }) => entryField === change.dimension)!;
                    return (
                      <li key={change.dimension}>
                        {label}:{' '}
                        {event.kind === 'INITIAL'
                          ? valueText(change.new)
                          : `${valueText(change.prior)} → ${valueText(change.new)}`}
                      </li>
                    );
                  })}
                </ul>
                {event.document_reference && <div>เอกสารอ้างอิง: {event.document_reference}</div>}
                {event.remark && <div style={{ whiteSpace: 'pre-wrap' }}>หมายเหตุ: {event.remark}</div>}
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
};
