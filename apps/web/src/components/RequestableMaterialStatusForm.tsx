import React from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { INACTIVE_LABEL, REACTIVATE_LABEL } from './materialFacts';
import { PENDING_LABEL, REQUESTED_ITEM_LABEL, REQUESTER_LABEL } from './materialRequestFacts';
import { REQUESTABLE_MATERIAL_LABEL, type RequestableMaterialDetail } from './requestableMaterialFacts';

/**
 * F009-T7 (#209): how many Pending Requested Items ask for the Requestable Material, which stay Pending, shown before
 * a Supply Officer makes it Inactive or ends its last Compatible Stock Material (#202 Q16, P6).
 */
export const PendingCountNotice: React.FC<{ requestable: RequestableMaterialDetail; idPrefix: string }> = ({ requestable, idPrefix }) => (
  <p data-testid={`${idPrefix}-pending-count`} style={{ fontSize: '0.875rem', color: '#92400e', backgroundColor: '#fef3c7', borderRadius: '6px', padding: '0.5rem 0.75rem', margin: '0 0 1rem 0' }}>
    มี{REQUESTED_ITEM_LABEL} {requestable.pending_requested_item_count} รายการที่ยัง{PENDING_LABEL} ซึ่งจะยัง{PENDING_LABEL}ต่อไป
  </p>
);

export interface RequestableMaterialStatusFormProps {
  requestable: RequestableMaterialDetail;
  // The session's CSRF token: the page offers the form only once it is in hand (#135).
  csrfToken: string;
  // What the page offered: "หยุดใช้" or "เปิดใช้อีกครั้ง".
  action: 'inactivate' | 'reactivate';
  // Reads the Requestable Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

/**
 * "หยุดใช้" or "เปิดใช้อีกครั้ง" (F009-T7, #209): makes a Requestable Material Inactive, so Requesters are no longer
 * offered it, or reactivates it as the same record, at the version the page read (#202 MC-14, Q6, Q16). Nothing else
 * changes and nothing is deleted.
 */
export const RequestableMaterialStatusForm: React.FC<RequestableMaterialStatusFormProps> = ({ requestable, action, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const inactivating = action === 'inactivate';
  return (
    <LoanSaveForm
      idPrefix="requestable-material-status"
      heading={inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}
      saveUrl={`/requestable-materials/${encodeURIComponent(requestable.id)}/${action}`}
      csrfToken={csrfToken}
      requestError={() => null}
      requestBody={() => ({ expected_version: requestable.version })}
      refusedList={() => null}
      forbiddenMessage={`คุณไม่มีสิทธิ์เปลี่ยนสถานะ${REQUESTABLE_MATERIAL_LABEL}`}
      refusedMessage={`ไม่สามารถเปลี่ยนสถานะ${REQUESTABLE_MATERIAL_LABEL}ได้`}
      staleMessage="มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่"
      submitLabel={inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {() =>
        inactivating ? (
          <>
            <PendingCountNotice requestable={requestable} idPrefix="requestable-material-status" />
            <p data-testid="requestable-material-status-notice" style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
              {REQUESTER_LABEL}จะไม่เห็นวัสดุนี้อีก วัสดุที่หยุดใช้ยังอยู่ในระบบพร้อมประวัติ และเปิดใช้อีกครั้งได้ภายหลัง
            </p>
          </>
        ) : (
          <p data-testid="requestable-material-status-notice" style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
            วัสดุนี้จะกลับมาใช้งานอยู่เป็นรายการเดิม พร้อมประวัติและวัสดุที่ใช้จ่ายได้ทั้งหมด
          </p>
        )
      }
    </LoanSaveForm>
  );
};
