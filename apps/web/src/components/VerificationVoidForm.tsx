import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { ReasonField } from './OutstandingItemFields';
import { CORRECTION_LABELS } from './assignmentFacts';
import { VOIDED_LABEL } from './loanFacts';
import { RESULT_LABELS, latestResultText, resultText, type OpenVerificationRound, type VerificationRevision } from './verificationFacts';

export interface VerificationVoidFormProps {
  assetId: string;
  round: OpenVerificationRound;
  // The current revision the user saw, which the void names.
  revision: VerificationRevision;
  csrfToken: string;
  onVoided: () => Promise<void>;
  onClose: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * "ยกเลิกรายการ (บันทึกผิด)": a Verification Correction voids the Asset's current result, such as one recorded for
 * the wrong Asset, with a reason (F006-T4, #125 Q18). The result stays shown as ยกเลิกแล้ว, struck through, and the
 * previous result becomes current again, or the Asset is Not Yet Verified. The server decides every rule.
 */
export const VerificationVoidForm: React.FC<VerificationVoidFormProps> = ({ assetId, round, revision, csrfToken, onVoided, onClose, onPermissionRevoked }) => {
  const [reason, setReason] = useState('');
  return (
    <LoanSaveForm
      idPrefix="verification-void"
      heading={CORRECTION_LABELS.VOIDED}
      saveUrl={`/verification-rounds/${round.id}/assets/${assetId}/verification-corrections`}
      csrfToken={csrfToken}
      requestError={() => (reason.trim() === '' ? 'กรุณาระบุเหตุผลที่ยกเลิกรายการ' : null)}
      requestBody={() => ({ verification_revision_id: revision.id, reason })}
      refusedList={(body) => {
        if (body?.code === 'VERIFICATION_RESULT_CHANGED' || body?.code === 'VERIFICATION_REVISION_ALREADY_VOIDED') {
          return <>ยกเลิกไม่ได้ เพราะผลตรวจล่าสุดของครุภัณฑ์นี้เปลี่ยนไปแล้ว: {latestResultText(body.current ?? null)} กรุณาโหลดหน้าใหม่</>;
        }
        return body?.code === 'VERIFICATION_ROUND_NOT_OPEN' ? <>ยกเลิกไม่ได้ เพราะรอบตรวจนี้ไม่ได้เปิดอยู่แล้ว กรุณาโหลดหน้าใหม่</> : null;
      }}
      forbiddenMessage="คุณไม่มีสิทธิ์ยกเลิกผลตรวจ"
      refusedMessage="ไม่สามารถยกเลิกรายการได้"
      onSaved={onVoided}
      onCancel={onClose}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            ผลตรวจ {resultText(revision.result, revision.condition)} นี้จะยังแสดงแบบขีดฆ่าเป็น “{VOIDED_LABEL}” และไม่นับรวมในสถานะ ผลตรวจก่อนหน้าที่ไม่ได้ยกเลิกจะกลับเป็นผลปัจจุบัน
            หรือครุภัณฑ์จะกลับเป็น “{RESULT_LABELS.NOT_YET_VERIFIED}”
          </p>
          <ReasonField idPrefix="verification-void" label="เหตุผลที่ยกเลิก" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
