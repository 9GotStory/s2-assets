import React, { useState } from 'react';
import { Link } from 'react-router';
import { LoanSaveForm } from './LoanSaveForm';
import { ReasonField } from './OutstandingItemFields';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { thaiDate } from './assignmentFacts';
import {
  DISCREPANCY_LABEL,
  FISCAL_YEAR_LABEL,
  RESULT_LABELS,
  ROUND_EVENT_LABELS,
  ROUND_STATE_LABELS,
  roundLabel,
  type OpenVerificationRound,
  type VerificationRound,
} from './verificationFacts';

type RoundAction = 'EDIT' | 'CLOSE' | 'REOPEN' | 'VOID';

export interface VerificationRoundActionsProps {
  round: VerificationRound;
  csrfToken: string | null;
  // Reads the Round and its entries again after a write.
  onChanged: () => Promise<void>;
  // Reads the Round again after a stale save, and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onPermissionRevoked: (statusCode?: number) => void;
}

const STALE_MESSAGE = 'มีการเปลี่ยนแปลงรอบตรวจนี้หลังจากเปิดฟอร์ม กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง';

const actionButtonStyle = (danger: boolean): React.CSSProperties => ({
  padding: '0.5rem 1rem',
  backgroundColor: danger ? '#ffffff' : '#2563eb',
  color: danger ? '#991b1b' : '#ffffff',
  border: danger ? '1px solid #fca5a5' : 'none',
  borderRadius: '6px',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
});

// What a refused write on the Round says, or null for a refusal the form shows by its message.
const roundRefusal = (body: any): React.ReactNode => {
  switch (body?.code) {
    case 'ANOTHER_VERIFICATION_ROUND_OPEN': {
      const openRound = body.open_round as OpenVerificationRound;
      return (
        <>
          เปิดรอบอีกครั้งไม่ได้ เพราะมีรอบที่เปิดอยู่แล้ว: <Link to={`/verification-rounds/${openRound.id}`}>{roundLabel(openRound)}</Link> เริ่ม{' '}
          <time dateTime={openRound.start_date}>{thaiDate(openRound.start_date)}</time>
        </>
      );
    }
    case 'VERIFICATION_ROUND_NOT_OPEN':
    case 'VERIFICATION_ROUND_NOT_CLOSED':
      return <>สถานะของรอบตรวจนี้เปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่</>;
    case 'VERIFICATION_ROUND_HAS_RESULTS':
      return <>ยกเลิกรอบไม่ได้ เพราะมีผลตรวจในรอบนี้แล้ว รอบที่มีผลตรวจให้ปิดรอบแทน</>;
    default:
      return null;
  }
};

// "ปิดรอบ": the summary the Custodian confirms before closing (#125 AV-22, Q9). No reason is asked.
const CloseRoundForm: React.FC<VerificationRoundActionsProps & { onClose: () => void }> = ({ round, csrfToken, onChanged, onRefresh, onPermissionRevoked, onClose }) => {
  const { counts } = round;
  return (
    <LoanSaveForm
      idPrefix="verification-round-close"
      heading={ROUND_EVENT_LABELS.CLOSED}
      saveUrl={`/verification-rounds/${round.id}/close`}
      csrfToken={csrfToken}
      requestError={() => null}
      requestBody={() => ({ expected_version: round.version })}
      refusedList={roundRefusal}
      forbiddenMessage="คุณไม่มีสิทธิ์ปิดรอบตรวจ"
      refusedMessage="ไม่สามารถปิดรอบได้"
      onSaved={onChanged}
      onRefresh={onRefresh}
      staleMessage={STALE_MESSAGE}
      submitLabel="ยืนยันปิดรอบ"
      onCancel={onClose}
      onPermissionRevoked={onPermissionRevoked}
    >
      {() => (
        <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: '#374151' }}>
          <ul data-testid="verification-round-close-summary" style={{ margin: '0 0 0.75rem 1.25rem', padding: 0 }}>
            <li>
              {RESULT_LABELS.FOUND} {counts.found} รายการ
            </li>
            <li>
              {RESULT_LABELS.NOT_FOUND} {counts.not_found} รายการ
            </li>
            <li style={{ fontWeight: 600, color: counts.not_yet_verified > 0 ? '#92400e' : undefined }}>
              {RESULT_LABELS.NOT_YET_VERIFIED} {counts.not_yet_verified} รายการ{' '}
              {counts.not_yet_verified > 0 && (
                <Link to="?result=NOT_YET_VERIFIED" id="verification-round-close-not-yet-verified-link" style={{ fontWeight: 400 }}>
                  ดูรายการ
                </Link>
              )}
            </li>
            <li>
              มี{DISCREPANCY_LABEL} {counts.with_discrepancy} รายการ
            </li>
          </ul>
          <p style={{ margin: 0, color: '#92400e' }}>
            รายการที่{RESULT_LABELS.NOT_YET_VERIFIED}จะยังเป็น “{RESULT_LABELS.NOT_YET_VERIFIED}” ไม่เปลี่ยนเป็น “{RESULT_LABELS.NOT_FOUND}” เมื่อปิดรอบแล้วจะบันทึกหรือแก้ไขผลตรวจไม่ได้
            จนกว่าจะ{ROUND_EVENT_LABELS.REOPENED}
          </p>
        </div>
      )}
    </LoanSaveForm>
  );
};

// "แก้ไขข้อมูลรอบ": an open Round's name, fiscal year and notes (#125 Q27). A field counts as changed only when the
// server would store a different value, and only changed fields are sent.
const EditRoundForm: React.FC<VerificationRoundActionsProps & { onClose: () => void }> = ({ round, csrfToken, onChanged, onRefresh, onPermissionRevoked, onClose }) => {
  const [name, setName] = useState(round.name);
  const [fiscalYear, setFiscalYear] = useState(String(round.fiscal_year));
  const [notes, setNotes] = useState(round.notes ?? '');

  const changes = (): Record<string, unknown> => ({
    ...(name.trim() !== round.name ? { name: name.trim() } : {}),
    ...(Number(fiscalYear.trim()) !== round.fiscal_year ? { fiscal_year: Number(fiscalYear.trim()) } : {}),
    ...((notes.trim() || null) !== round.notes ? { notes: notes.trim() || null } : {}),
  });

  const requestError = (): string | null => {
    if (name.trim() === '') {
      return 'กรุณากรอกชื่อรอบตรวจ';
    }
    if (!/^[1-9]\d{3}$/.test(fiscalYear.trim())) {
      return `กรุณากรอก${FISCAL_YEAR_LABEL}เป็นปี พ.ศ. 4 หลัก`;
    }
    return Object.keys(changes()).length === 0 ? 'ไม่มีข้อมูลที่เปลี่ยนแปลง' : null;
  };

  return (
    <LoanSaveForm
      idPrefix="verification-round-edit"
      heading={ROUND_EVENT_LABELS.EDITED}
      saveUrl={`/verification-rounds/${round.id}`}
      method="PATCH"
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={() => ({ expected_version: round.version, ...changes() })}
      refusedList={roundRefusal}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขข้อมูลรอบตรวจ"
      refusedMessage="ไม่สามารถแก้ไขข้อมูลรอบได้"
      onSaved={onChanged}
      onRefresh={onRefresh}
      staleMessage={STALE_MESSAGE}
      onCancel={onClose}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="verification-round-edit-name" style={fieldLabelStyle}>
              ชื่อรอบตรวจ
            </label>
            <input id="verification-round-edit-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
          </div>
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="verification-round-edit-fiscal_year" style={fieldLabelStyle}>
              {FISCAL_YEAR_LABEL} (พ.ศ.)
            </label>
            <input
              id="verification-round-edit-fiscal_year"
              type="text"
              inputMode="numeric"
              value={fiscalYear}
              maxLength={4}
              onChange={(e) => setFiscalYear(e.target.value)}
              style={{ ...fieldInputStyle, maxWidth: '10rem' }}
            />
          </div>
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="verification-round-edit-notes" style={fieldLabelStyle}>
              หมายเหตุ (ไม่บังคับ)
            </label>
            <textarea id="verification-round-edit-notes" value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} style={fieldInputStyle} />
          </div>
          <p style={{ margin: 0, fontSize: '0.8125rem', color: '#6b7280' }}>วันที่เริ่มตรวจและรายการในรอบแก้ไขไม่ได้</p>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

// "เปิดรอบอีกครั้ง" and "ยกเลิกรอบ": each with a reason (#125 Q25, Q28).
const ReasonedRoundForm: React.FC<VerificationRoundActionsProps & { action: 'REOPEN' | 'VOID'; onClose: () => void }> = ({
  round,
  csrfToken,
  onChanged,
  onRefresh,
  onPermissionRevoked,
  action,
  onClose,
}) => {
  const [reason, setReason] = useState('');
  const isReopen = action === 'REOPEN';
  const idPrefix = isReopen ? 'verification-round-reopen' : 'verification-round-void';
  return (
    <LoanSaveForm
      idPrefix={idPrefix}
      heading={isReopen ? ROUND_EVENT_LABELS.REOPENED : ROUND_EVENT_LABELS.VOIDED}
      saveUrl={`/verification-rounds/${round.id}/${isReopen ? 'reopen' : 'void'}`}
      csrfToken={csrfToken}
      requestError={() => (reason.trim() === '' ? `กรุณาระบุเหตุผลที่${isReopen ? ROUND_EVENT_LABELS.REOPENED : ROUND_EVENT_LABELS.VOIDED}` : null)}
      requestBody={() => ({ expected_version: round.version, reason })}
      refusedList={roundRefusal}
      forbiddenMessage={isReopen ? 'คุณไม่มีสิทธิ์เปิดรอบตรวจอีกครั้ง' : 'คุณไม่มีสิทธิ์ยกเลิกรอบตรวจ'}
      refusedMessage={isReopen ? 'ไม่สามารถเปิดรอบอีกครั้งได้' : 'ไม่สามารถยกเลิกรอบได้'}
      onSaved={onChanged}
      onRefresh={onRefresh}
      staleMessage={STALE_MESSAGE}
      onCancel={onClose}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            {isReopen
              ? `รอบนี้จะกลับเป็น “${ROUND_STATE_LABELS.OPEN}” โดยรายการในรอบและผลตรวจยังเหมือนเดิม แล้วจึงบันทึก ตรวจซ้ำ หรือแก้ไขผลได้ตามปกติ และปิดรอบอีกครั้งได้`
              : `รอบนี้จะยังแสดงในรายการเป็น “${ROUND_STATE_LABELS.VOIDED}” และรับผลตรวจหรือการแก้ไขใด ๆ ไม่ได้อีก`}
          </p>
          <ReasonField idPrefix={idPrefix} label={isReopen ? 'เหตุผลที่เปิดรอบอีกครั้ง' : 'เหตุผลที่ยกเลิกรอบ'} value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

/**
 * The Round page's actions for holders (F006-T6): "แก้ไขข้อมูลรอบ" and "ปิดรอบ" while open for 'verification:manage';
 * "ยกเลิกรอบ" while open with no result and "เปิดรอบอีกครั้ง" once closed for 'verification:correct'. The server decides
 * every rule again; the page only leaves out what it would refuse.
 */
export const VerificationRoundActions: React.FC<VerificationRoundActionsProps> = (props) => {
  const { round } = props;
  const [action, setAction] = useState<RoundAction | null>(null);
  const hasResults = round.counts.found + round.counts.not_found > 0;
  const offered: { action: RoundAction; label: string; danger: boolean }[] = [
    ...(round.state === 'OPEN' && round.can_manage_verification
      ? [
          { action: 'EDIT' as const, label: ROUND_EVENT_LABELS.EDITED, danger: false },
          { action: 'CLOSE' as const, label: ROUND_EVENT_LABELS.CLOSED, danger: false },
        ]
      : []),
    ...(round.state === 'OPEN' && round.can_correct_verification && !hasResults ? [{ action: 'VOID' as const, label: ROUND_EVENT_LABELS.VOIDED, danger: true }] : []),
    ...(round.state === 'CLOSED' && round.can_correct_verification ? [{ action: 'REOPEN' as const, label: ROUND_EVENT_LABELS.REOPENED, danger: false }] : []),
  ];
  // A form whose action the Round no longer offers, such as after a write elsewhere, closes.
  const current = offered.some((offer) => offer.action === action) ? action : null;
  if (offered.length === 0) {
    return null;
  }

  const onClose = () => setAction(null);
  const formProps = {
    ...props,
    onChanged: async () => {
      setAction(null);
      await props.onChanged();
    },
    onClose,
  };

  return (
    <section aria-label="การดำเนินการกับรอบตรวจ" id="verification-round-actions" className="verification-round-no-print" style={{ marginTop: '1.25rem' }}>
      {current === null && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {offered.map((offer) => (
            <button key={offer.action} type="button" id={`verification-round-${offer.action.toLowerCase()}-action`} onClick={() => setAction(offer.action)} style={actionButtonStyle(offer.danger)}>
              {offer.label}
            </button>
          ))}
        </div>
      )}
      {current === 'CLOSE' && <CloseRoundForm {...formProps} />}
      {current === 'EDIT' && <EditRoundForm {...formProps} />}
      {(current === 'REOPEN' || current === 'VOID') && <ReasonedRoundForm {...formProps} action={current} />}
    </section>
  );
};
