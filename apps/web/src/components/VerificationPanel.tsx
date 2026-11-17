import React, { useState } from 'react';
import { Link } from 'react-router';
import { RepairStartForm } from './RepairStartForm';
import { ResultReassignmentForm } from './ResultReassignmentForm';
import { VerificationLateAdditionForm } from './VerificationLateAdditionForm';
import { VerificationRecordForm } from './VerificationRecordForm';
import { VerificationVoidForm } from './VerificationVoidForm';
import { entryLabel } from './ReferenceContextFields';
import { CORRECTION_LABELS, thaiDate } from './assignmentFacts';
import { REPAIR_START_LABEL } from './repairFacts';
import {
  DISCREPANCY_LABEL,
  LATE_ADDITION_LABEL,
  OBSERVED_LOCATION_LABEL,
  REASSIGNED_LABEL,
  REASSIGN_LABEL,
  RESULT_LABELS,
  REVERIFICATION_LABEL,
  SENT_FOR_REPAIR_LABEL,
  VERIFICATION_DATE_LABEL,
  VERIFICATION_PANEL_LABEL,
  VERIFICATION_ROUND_LABEL,
  discrepancyText,
  hasLocationMismatch,
  isFoundDamaged,
  recordedByText,
  recordedContextText,
  resultText,
  roundLabel,
  type AssetVerificationPanel,
  type RecordingContext,
  type VerificationRevision,
} from './verificationFacts';

export interface VerificationPanelProps {
  assetId: string;
  panel: AssetVerificationPanel;
  // Whether the viewer holds 'verification:record'.
  canRecord: boolean;
  // Whether the viewer holds 'verification:correct' (F006-T4).
  canCorrect: boolean;
  // Whether the viewer holds 'verification:manage', which adds an Asset not in the Round (F006-T5).
  canManage: boolean;
  // Whether the viewer holds 'repair:record', which sends a result Found ชำรุด for repair (F006-T7, #125 Q22).
  canRecordRepair: boolean;
  // Whether the viewer holds 'assignment:reassign', which moves an Asset from a result with "Location ไม่ตรงทะเบียน"
  // (F006-T8, #125 Q22), and who they are, for the Reassignment form's reads.
  canReassign: boolean;
  actorId: string | null;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const actionStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  backgroundColor: '#ffffff',
  color: '#1d4ed8',
  border: '1px solid #2563eb',
  borderRadius: '6px',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const termStyle: React.CSSProperties = { fontWeight: 500, color: '#4b5563' };
const valueStyle: React.CSSProperties = { margin: 0, color: '#111827', minWidth: 0, overflowWrap: 'anywhere' };

// The Loan or Repair context as a line, linking the Repair Record it names (#125 Q14); nothing when there is none.
export const RecordingContextLine: React.FC<{ context: RecordingContext }> = ({ context }) => {
  const text = recordedContextText(context);
  if (!text) {
    return null;
  }
  return (
    <>
      {text}
      {context.repair_context && (
        <>
          {' '}
          <Link to={`/repairs/${context.repair_context.repair_record_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
            ดูรายการซ่อม
          </Link>
        </>
      )}
    </>
  );
};

// "ส่งซ่อมแล้ว" with a link to each Repair Record not voided that cites the result (F006-T7, #125 Q19); nothing when
// none does.
export const SentForRepairLine: React.FC<{ revision: VerificationRevision; testId: string }> = ({ revision, testId }) => {
  if (!revision.sent_for_repair) {
    return null;
  }
  return (
    <div data-testid={testId} style={{ color: '#166534', fontWeight: 600, overflowWrap: 'anywhere' }}>
      {SENT_FOR_REPAIR_LABEL}
      {revision.repair_records
        .filter(({ is_voided: isVoided }) => !isVoided)
        .map(({ id, start_date: startDate }) => (
          <React.Fragment key={id}>
            {' '}
            <Link to={`/repairs/${id}`} style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 400 }}>
              ดูรายการซ่อม ({thaiDate(startDate)})
            </Link>
          </React.Fragment>
        ))}
    </div>
  );
};

// "ย้ายแล้ว" with the Effective Date of each Reassignment not voided that cites the result (F006-T8, #125 Q19); nothing
// when none does.
export const ReassignedLine: React.FC<{ revision: VerificationRevision; testId: string }> = ({ revision, testId }) => {
  if (!revision.reassigned) {
    return null;
  }
  return (
    <div data-testid={testId} style={{ color: '#166534', fontWeight: 600, overflowWrap: 'anywhere' }}>
      {REASSIGNED_LABEL}
      {revision.reassignments
        .filter(({ is_voided: isVoided }) => !isVoided)
        .map(({ id, effective_date: effectiveDate }) => (
          <span key={id} style={{ fontWeight: 400 }}>
            {' '}
            (วันที่มีผล {thaiDate(effectiveDate)})
          </span>
        ))}
    </div>
  );
};

// What "ส่งซ่อม" opens the Repair Start form with: the result as its Repair Source (#125 Q12).
export const repairSourceOfResult = (revision: VerificationRevision, roundName: string) =>
  ({ kind: 'VERIFICATION_REVISION', verificationRevisionId: revision.id, roundName, verificationDate: revision.verification_date, note: revision.note }) as const;

// Every Discrepancy a result notes, a line each (#125 Q7, AV-08).
const DiscrepancyItems: React.FC<{ revision: VerificationRevision; testId: string }> = ({ revision, testId }) => (
  <ul data-testid={testId} style={{ margin: 0, paddingLeft: '1.25rem' }}>
    {revision.discrepancies.map((discrepancy) => (
      <li key={discrepancy} style={{ whiteSpace: 'pre-line' }}>
        {discrepancyText(discrepancy, revision)}
      </li>
    ))}
  </ul>
);

// A result's Observed Location and Discrepancies, as a list row shows them (F006-T3); nothing when it notes none
// and gives no Observed Location.
export const RevisionDiscrepancies: React.FC<{ revision: VerificationRevision; testId: string }> = ({ revision, testId }) => {
  if (revision.discrepancies.length === 0 && !revision.observed_location) {
    return null;
  }
  return (
    <div data-testid={testId} style={{ color: '#991b1b', overflowWrap: 'anywhere' }}>
      {revision.observed_location && (
        <div>
          {OBSERVED_LOCATION_LABEL}: {entryLabel(revision.observed_location)}
        </div>
      )}
      {revision.discrepancies.length > 0 && <DiscrepancyItems revision={revision} testId={`${testId}-items`} />}
    </div>
  );
};

// An Asset's current result, with when and by whom it was recorded (#125 AV-23, Q20), where it was seen and what
// differs from the register (Q7).
export const RevisionFacts: React.FC<{ revision: VerificationRevision; testId: string }> = ({ revision, testId }) => {
  const hasContext = recordedContextText(revision) !== null;
  return (
    <dl data-testid={testId} style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '0.375rem 0.75rem', margin: 0, fontSize: '0.9375rem' }}>
      <dt style={termStyle}>ผลตรวจ:</dt>
      <dd data-testid={`${testId}-result`} style={{ ...valueStyle, fontWeight: 600 }}>
        {resultText(revision.result, revision.condition)}
      </dd>
      {revision.observed_location && (
        <>
          <dt style={termStyle}>{OBSERVED_LOCATION_LABEL}:</dt>
          <dd data-testid={`${testId}-observed-location`} style={valueStyle}>
            {entryLabel(revision.observed_location)}
          </dd>
        </>
      )}
      {revision.discrepancies.length > 0 && (
        <>
          <dt style={termStyle}>{DISCREPANCY_LABEL}:</dt>
          <dd style={{ ...valueStyle, color: '#991b1b', fontWeight: 600 }}>
            <DiscrepancyItems revision={revision} testId={`${testId}-discrepancies`} />
            <SentForRepairLine revision={revision} testId={`${testId}-sent-for-repair`} />
            <ReassignedLine revision={revision} testId={`${testId}-reassigned`} />
          </dd>
        </>
      )}
      <dt style={termStyle}>{VERIFICATION_DATE_LABEL}:</dt>
      <dd style={valueStyle}>
        <time dateTime={revision.verification_date}>{thaiDate(revision.verification_date)}</time>
      </dd>
      <dt style={termStyle}>บันทึกเมื่อ:</dt>
      <dd style={valueStyle}>
        <time dateTime={revision.recorded_at}>{THAI_DATE_TIME.format(new Date(revision.recorded_at))}</time>
      </dd>
      <dt style={termStyle}>บันทึกโดย:</dt>
      <dd data-testid={`${testId}-recorded-by`} style={valueStyle}>
        {recordedByText(revision)}
      </dd>
      {revision.note && (
        <>
          <dt style={termStyle}>หมายเหตุ:</dt>
          <dd style={{ ...valueStyle, whiteSpace: 'pre-line' }}>{revision.note}</dd>
        </>
      )}
      {hasContext && (
        <>
          <dt style={termStyle}>ขณะตรวจ:</dt>
          <dd style={valueStyle}>
            <RecordingContextLine context={revision} />
          </dd>
        </>
      )}
    </dl>
  );
};

/**
 * "ตรวจประจำปี": the open Round's panel on the Asset page (F006-T2, #125 Q5). Scanning the QR label opens this
 * page and records nothing (AV-04). The panel shows the record form while the Asset has no result, the result
 * once it has one, or that the Asset is not in the Round; and the Loan or Repair context in each case. Beside the
 * result it offers "ตรวจซ้ำ" and, to holders of 'verification:correct', "ยกเลิกรายการ (บันทึกผิด)" (F006-T4, Q18, Q20).
 * Beside the note that the Asset is not in the Round it offers holders of 'verification:manage' "เพิ่มเข้ารอบภายหลัง"
 * (F006-T5, Q11). Beside a result Found ชำรุด it offers holders of 'repair:record' "ส่งซ่อม" (F006-T7, Q12, Q22), and
 * beside one with "Location ไม่ตรงทะเบียน" holders of 'assignment:reassign' "ย้าย" (F006-T8, Q13, Q22).
 */
export const VerificationPanel: React.FC<VerificationPanelProps> = ({
  assetId,
  panel,
  canRecord,
  canCorrect,
  canManage,
  canRecordRepair,
  canReassign,
  actorId,
  csrfToken,
  onRecorded,
  onPermissionRevoked,
}) => {
  const { open_round: round, entry, context } = panel;
  // The form open over the current result, or over the note that the Asset is not in the Round, if any.
  const [openForm, setOpenForm] = useState<'REVERIFY' | 'VOID' | 'LATE_ADDITION' | 'REPAIR' | 'REASSIGN' | null>(null);
  const current = entry?.current ?? null;
  const afterSave = async () => {
    await onRecorded();
    setOpenForm(null);
  };
  // The Asset page reads the Asset only once /auth/session-check has answered, so the CSRF token is there before
  // this form is (#135).
  const mayRecord = canRecord && entry !== null && entry.current === null;
  const mayRepair = canRecordRepair && current !== null && isFoundDamaged(current);
  const mayReassign = canReassign && current !== null && hasLocationMismatch(current);

  return (
    <section aria-labelledby="verification-panel-heading" id="verification-panel" style={{ marginBottom: '2rem', border: '2px solid #2563eb', borderRadius: '8px', padding: '1rem' }}>
      <h2 id="verification-panel-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '0.5rem', color: '#1e3a8a' }}>
        {VERIFICATION_PANEL_LABEL}
      </h2>
      <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem', color: '#374151', overflowWrap: 'anywhere' }}>
        {VERIFICATION_ROUND_LABEL}ที่เปิดอยู่:{' '}
        <Link to={`/verification-rounds/${round.id}`} id="verification-panel-round-link" style={{ color: '#2563eb', textDecoration: 'underline' }}>
          {roundLabel(round)}
        </Link>
      </p>

      {recordedContextText(context) && (
        <div data-testid="verification-panel-context" style={{ margin: '0 0 0.75rem 0', padding: '0.5rem 0.75rem', backgroundColor: '#fef3c7', borderRadius: '6px', fontSize: '0.875rem', color: '#92400e', overflowWrap: 'anywhere' }}>
          <div>
            ขณะนี้: <RecordingContextLine context={context} />
          </div>
          <div style={{ color: '#6b7280' }}>ข้อมูลนี้ใช้ประกอบเท่านั้น ไม่ถือเป็นการพบ และบันทึกผลได้ตามที่ตรวจจริง</div>
        </div>
      )}

      {entry === null && (
        <p data-testid="verification-panel-not-in-round" role="note" style={{ margin: 0, fontSize: '0.9375rem', color: '#991b1b' }}>
          {canManage ? 'ครุภัณฑ์นี้ไม่อยู่ในรายการของรอบตรวจนี้' : 'ครุภัณฑ์นี้ไม่อยู่ในรายการของรอบตรวจนี้ กรุณาแจ้งผู้ดูแลพัสดุ'}
        </p>
      )}
      {entry === null && canManage && (
        <div style={{ marginTop: '0.75rem' }}>
          {openForm === 'LATE_ADDITION' ? (
            <VerificationLateAdditionForm
              assetId={assetId}
              round={round}
              csrfToken={csrfToken}
              onAdded={afterSave}
              onClose={() => setOpenForm(null)}
              onPermissionRevoked={onPermissionRevoked}
            />
          ) : (
            <button type="button" id="verification-late-addition-action" onClick={() => setOpenForm('LATE_ADDITION')} style={actionStyle}>
              {LATE_ADDITION_LABEL}
            </button>
          )}
        </div>
      )}
      {current && <RevisionFacts revision={current} testId="verification-panel-current" />}
      {current && openForm === null && (canRecord || canCorrect || mayRepair || mayReassign) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
          {mayReassign && (
            <button type="button" id="verification-reassign-action" onClick={() => setOpenForm('REASSIGN')} style={actionStyle}>
              {REASSIGN_LABEL}
            </button>
          )}
          {mayRepair && (
            <button type="button" id="verification-repair-action" onClick={() => setOpenForm('REPAIR')} style={actionStyle}>
              {REPAIR_START_LABEL}
            </button>
          )}
          {canRecord && (
            <button type="button" id="verification-reverify-action" onClick={() => setOpenForm('REVERIFY')} style={actionStyle}>
              {REVERIFICATION_LABEL}
            </button>
          )}
          {canCorrect && (
            <button type="button" id="verification-void-action" onClick={() => setOpenForm('VOID')} style={{ ...actionStyle, color: '#991b1b', borderColor: '#991b1b' }}>
              {CORRECTION_LABELS.VOIDED}
            </button>
          )}
        </div>
      )}
      {current && openForm === 'REVERIFY' && canRecord && (
        <div style={{ marginTop: '0.75rem' }}>
          <VerificationRecordForm
            key={current.id}
            assetId={assetId}
            round={round}
            csrfToken={csrfToken}
            expectedRevisionId={current.id}
            onRecorded={afterSave}
            onClose={() => setOpenForm(null)}
            onPermissionRevoked={onPermissionRevoked}
          />
        </div>
      )}
      {current && openForm === 'REPAIR' && mayRepair && (
        <div style={{ marginTop: '0.75rem' }}>
          <RepairStartForm
            key={current.id}
            assetId={assetId}
            repairSource={repairSourceOfResult(current, round.name)}
            csrfToken={csrfToken}
            onStarted={afterSave}
            onCancel={() => setOpenForm(null)}
            onPermissionRevoked={onPermissionRevoked}
          />
        </div>
      )}
      {current && openForm === 'REASSIGN' && mayReassign && (
        <div style={{ marginTop: '0.75rem' }}>
          <ResultReassignmentForm
            key={current.id}
            assetId={assetId}
            revision={current}
            roundName={round.name}
            actorId={actorId}
            csrfToken={csrfToken}
            onRecorded={afterSave}
            onCancel={() => setOpenForm(null)}
            onPermissionRevoked={onPermissionRevoked}
          />
        </div>
      )}
      {current && openForm === 'VOID' && canCorrect && (
        <div style={{ marginTop: '0.75rem' }}>
          <VerificationVoidForm
            key={current.id}
            assetId={assetId}
            round={round}
            revision={current}
            csrfToken={csrfToken}
            onVoided={afterSave}
            onClose={() => setOpenForm(null)}
            onPermissionRevoked={onPermissionRevoked}
          />
        </div>
      )}
      {entry && !entry.current && !mayRecord && (
        <p data-testid="verification-panel-not-yet-verified" style={{ margin: 0, fontSize: '0.9375rem', color: '#92400e', fontWeight: 600 }}>
          {RESULT_LABELS.NOT_YET_VERIFIED}
        </p>
      )}
      {mayRecord && <VerificationRecordForm assetId={assetId} round={round} csrfToken={csrfToken} onRecorded={onRecorded} onPermissionRevoked={onPermissionRevoked} />}
    </section>
  );
};
