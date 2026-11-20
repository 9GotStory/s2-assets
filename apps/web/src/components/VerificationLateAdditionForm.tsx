import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { ReasonField } from './OutstandingItemFields';
import { retiredRefusal } from './RetiredReason';
import { LATE_ADDITION_LABEL, RESULT_LABELS, type OpenVerificationRound } from './verificationFacts';

export interface VerificationLateAdditionFormProps {
  assetId: string;
  round: OpenVerificationRound;
  csrfToken: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * "เพิ่มเข้ารอบภายหลัง": a Late Addition adds this Asset, which is not in the open Round, to its Scope Snapshot with
 * a reason, as it is now (F006-T5, #125 Q11, AV-21). The Asset is then Not Yet Verified. The server decides every rule.
 */
export const VerificationLateAdditionForm: React.FC<VerificationLateAdditionFormProps> = ({ assetId, round, csrfToken, onAdded, onClose, onPermissionRevoked }) => {
  const [reason, setReason] = useState('');
  return (
    <LoanSaveForm
      idPrefix="verification-late-addition"
      heading={LATE_ADDITION_LABEL}
      saveUrl={`/verification-rounds/${round.id}/late-additions`}
      csrfToken={csrfToken}
      requestError={() => (reason.trim() === '' ? 'กรุณาระบุเหตุผลที่เพิ่มเข้ารอบ' : null)}
      requestBody={() => ({ asset_id: assetId, reason })}
      refusedList={(body) => {
        if (body?.code === 'ASSET_ALREADY_IN_VERIFICATION_SCOPE') {
          return <>ครุภัณฑ์นี้อยู่ในรอบตรวจนี้แล้ว กรุณาโหลดหน้าใหม่</>;
        }
        if (body?.code === 'VERIFICATION_ROUND_NOT_OPEN') {
          return <>เพิ่มไม่ได้ เพราะรอบตรวจนี้ไม่ได้เปิดอยู่แล้ว กรุณาโหลดหน้าใหม่</>;
        }
        // Retired since the form opened (F007-T4, DR-10, #154 Q12).
        return retiredRefusal(body, 'เพิ่มไม่ได้');
      }}
      forbiddenMessage="คุณไม่มีสิทธิ์เพิ่มครุภัณฑ์เข้ารอบตรวจ"
      refusedMessage="ไม่สามารถเพิ่มเข้ารอบได้"
      onSaved={onAdded}
      onCancel={onClose}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            ครุภัณฑ์จะเข้ารอบตามข้อมูลทะเบียนขณะนี้ เป็น “{RESULT_LABELS.NOT_YET_VERIFIED}” และนำออกจากรอบไม่ได้ ระบบเก็บผู้เพิ่ม เวลา และเหตุผล
          </p>
          <ReasonField idPrefix="verification-late-addition" label="เหตุผลที่เพิ่มเข้ารอบ" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
