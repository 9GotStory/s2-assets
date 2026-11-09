import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AssignmentAmendForm, AssignmentVoidForm } from './AssignmentCorrectionForms';
import { AssignmentFactItem } from './AssignmentFactItem';
import type { AssignmentSaveProps } from './AssignmentSaveForm';
import { InitialAssignmentForm } from './InitialAssignmentForm';
import { ReassignmentForm } from './ReassignmentForm';
import { REFERENCE_DIMENSIONS, entryLabel, type CurrentAssignment } from './ReferenceContextFields';
import { CORRECTION_LABELS, KIND_LABELS, type AssignmentEvent } from './assignmentFacts';

// The one form open in the section: recording a new fact, or correcting a fact of the timeline.
type OpenForm = { type: 'RECORD'; kind: AssignmentEvent['kind'] } | { type: 'AMEND' | 'VOID'; eventId: string };

const CORRECTION_ACTIONS = [
  { type: 'AMEND', testId: 'assignment-amend', label: CORRECTION_LABELS.AMENDED },
  { type: 'VOID', testId: 'assignment-void', label: CORRECTION_LABELS.VOIDED },
] as const;

const correctionActionStyle: React.CSSProperties = {
  padding: '0.25rem 0.625rem',
  backgroundColor: '#ffffff',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  fontSize: '0.8125rem',
  cursor: 'pointer',
};

export interface AssignmentSectionProps {
  assetId: string;
  currentAssignment?: CurrentAssignment;
  actorId?: string | null;
  // A new detail read also reads the timeline again.
  dataUpdatedAt?: number;
  onPermissionRevoked?: (statusCode?: number) => void;
  // Whether the viewer holds 'assignment:reassign', and what recording a fact needs (F003-T2).
  canReassign: boolean;
  // Whether the viewer holds 'assignment:correct' (F003-T3).
  canCorrectAssignment: boolean;
  assignmentVersion: number;
  // Whether any Assignment Conflict stands (F003-T4).
  hasAssignmentConflict: boolean;
  isLegacy: boolean;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  onRefresh: () => Promise<number | null>;
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
  canReassign,
  canCorrectAssignment,
  assignmentVersion,
  hasAssignmentConflict,
  isLegacy,
  csrfToken,
  onRecorded,
  onRefresh,
}) => {
  const [openForm, setOpenForm] = useState<OpenForm | null>(null);
  const [wasRecorded, setWasRecorded] = useState(false);

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
    // A new detail read keeps this actor's timeline, and so an open form, until the new one arrives.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === actorId && previousQuery?.queryKey[2] === assetId ? previous : undefined,
  });

  // The action on offer: an Initial Assignment while the Asset has none standing, a Reassignment after it.
  const offeredKind: AssignmentEvent['kind'] | null =
    canReassign && timeline.data
      ? timeline.data.some(({ kind, is_voided }) => kind === 'INITIAL' && !is_voided)
        ? 'REASSIGNMENT'
        : 'INITIAL'
      : null;

  // A form stays open only while its action is still allowed: a correction closes if its fact is voided meanwhile.
  const activeForm =
    openForm &&
    (openForm.type === 'RECORD'
      ? canReassign
      : canCorrectAssignment && timeline.data?.some(({ id, is_voided }) => id === openForm.eventId && !is_voided))
      ? openForm
      : null;

  const save: AssignmentSaveProps = {
    assetId,
    assignmentVersion,
    csrfToken,
    onRecorded: async () => {
      await onRecorded();
      setOpenForm(null);
      setWasRecorded(true);
    },
    onRefresh,
    onCancel: () => setOpenForm(null),
    onPermissionRevoked,
  };

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

      {hasAssignmentConflict && (
        <div
          role="status"
          data-testid="assignment-conflict-notice"
          style={{
            padding: '0.75rem 1rem',
            backgroundColor: '#fef3c7',
            border: '1px solid #f59e0b',
            borderRadius: '6px',
            color: '#92400e',
            fontSize: '0.875rem',
            marginBottom: '1rem',
          }}
        >
          มีประวัติขัดแย้งค้างตรวจ: ค่าเดิมที่บันทึกไว้ในบางรายการไม่ตรงกับค่าก่อนหน้า ดูรายการที่มีเครื่องหมายในประวัติด้านล่าง
        </div>
      )}

      {wasRecorded && (
        <div role="status" data-testid="assignment-recorded" style={{ color: '#065f46', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
          บันทึกรายการเรียบร้อยแล้ว
        </div>
      )}

      {activeForm?.type === 'RECORD' && activeForm.kind === 'INITIAL' && (
        <InitialAssignmentForm save={save} isLegacy={isLegacy} actorId={actorId} />
      )}
      {activeForm?.type === 'RECORD' && activeForm.kind === 'REASSIGNMENT' && (
        <ReassignmentForm save={save} timeline={timeline.data} actorId={actorId} />
      )}
      {!activeForm &&
        offeredKind && (
          <button
            type="button"
            id="assignment-action"
            onClick={() => {
              setWasRecorded(false);
              setOpenForm({ type: 'RECORD', kind: offeredKind });
            }}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
              marginBottom: '1rem',
            }}
          >
            {KIND_LABELS[offeredKind]}
          </button>
        )}

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
              <AssignmentFactItem
                key={event.id}
                event={event}
                actions={
                  canCorrectAssignment &&
                  !activeForm &&
                  !event.is_voided && (
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                      {CORRECTION_ACTIONS.map(({ type, testId, label }) => (
                        <button
                          key={type}
                          type="button"
                          data-testid={`${testId}-${event.id}`}
                          onClick={() => {
                            setWasRecorded(false);
                            setOpenForm({ type, eventId: event.id });
                          }}
                          style={correctionActionStyle}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )
                }
              >
                {activeForm?.type === 'AMEND' && activeForm.eventId === event.id && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <AssignmentAmendForm save={save} event={event} actorId={actorId} />
                  </div>
                )}
                {activeForm?.type === 'VOID' && activeForm.eventId === event.id && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <AssignmentVoidForm save={save} event={event} />
                  </div>
                )}
              </AssignmentFactItem>
            ))}
          </ol>
        ))}
    </section>
  );
};
