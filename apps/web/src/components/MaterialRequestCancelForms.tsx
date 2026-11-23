import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import {
  CANCEL_MATERIAL_REQUEST_LABEL,
  CANCEL_NOTE_LABEL,
  CANCEL_NOTE_MAX_LENGTH,
  CANCEL_REQUESTED_ITEM_LABEL,
  CONFIRM_CANCEL_LABEL,
  MATERIAL_REQUEST_LABEL,
  REQUESTED_ITEM_LABEL,
  requestNumberLine,
  type MaterialRequestDetail,
  type RequestedItem,
} from './materialRequestFacts';

// What both forms take from the Material Request page.
interface CancelFormProps {
  materialRequest: MaterialRequestDetail;
  // The session's CSRF token: the page offers a form only once it is in hand (#135).
  csrfToken: string;
  // Reads the Material Request again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

const STALE_MESSAGE = `${MATERIAL_REQUEST_LABEL}นี้เปลี่ยนไปหลังจากเปิดฟอร์ม กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง`;

// One Cancel at the version the page read, with its optional note (#202 P4, P7). The server refuses a note over the
// limit too; the field stops at it.
const CancelForm: React.FC<
  CancelFormProps & { idPrefix: string; heading: string; saveUrl: string; noun: string; notice: React.ReactNode }
> = ({ materialRequest, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked, idPrefix, heading, saveUrl, noun, notice }) => {
  const [note, setNote] = useState('');
  return (
    <LoanSaveForm
      idPrefix={idPrefix}
      heading={heading}
      saveUrl={saveUrl}
      csrfToken={csrfToken}
      requestError={() => null}
      requestBody={() => ({ expected_version: materialRequest.version, note })}
      refusedList={() => null}
      forbiddenMessage={`คุณไม่มีสิทธิ์ยกเลิก${noun}นี้`}
      refusedMessage={`ไม่สามารถยกเลิก${noun}นี้ได้`}
      staleMessage={STALE_MESSAGE}
      submitLabel={CONFIRM_CANCEL_LABEL}
      dismissLabel="ปิด"
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <>
          <p data-testid={`${idPrefix}-notice`} style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
            {notice}
          </p>
          <label htmlFor={`${idPrefix}-note`} style={fieldLabelStyle}>
            {CANCEL_NOTE_LABEL} (ไม่บังคับ)
          </label>
          <textarea
            id={`${idPrefix}-note`}
            value={note}
            maxLength={CANCEL_NOTE_MAX_LENGTH}
            rows={3}
            disabled={isLocked}
            onChange={(e) => setNote(e.target.value)}
            style={{ ...fieldInputStyle, marginBottom: '1rem' }}
          />
        </>
      )}
    </LoanSaveForm>
  );
};

/**
 * "ยกเลิก" on a Requested Item's row (F009-T5, #207): Cancels that Pending Requested Item; it stays listed with its
 * Requested Quantity, who Cancelled it, when and why (#202 MRQ-19, Q12, P4).
 */
export const RequestedItemCancelForm: React.FC<CancelFormProps & { requestedItem: RequestedItem }> = ({ requestedItem, ...props }) => (
  <CancelForm
    {...props}
    idPrefix="requested-item-cancel"
    heading={`${CANCEL_REQUESTED_ITEM_LABEL} ${requestedItem.requestable_material_name}`}
    saveUrl={`/material-requests/${encodeURIComponent(props.materialRequest.id)}/requested-items/${encodeURIComponent(requestedItem.id)}/cancel`}
    noun={REQUESTED_ITEM_LABEL}
    notice="รายการที่ขอนี้จะยังแสดงพร้อมจำนวนที่ขอ ผู้ยกเลิก และเวลาที่ยกเลิก"
  />
);

/**
 * "ยกเลิกคำขอเบิก" (F009-T5, #207): Cancels every Pending Requested Item of the Material Request at once, with one
 * note (#202 MRQ-19, Q12, P4).
 */
export const MaterialRequestCancelForm: React.FC<CancelFormProps> = (props) => {
  const pendingCount = props.materialRequest.requested_items.filter((requested) => requested.state === 'PENDING').length;
  return (
    <CancelForm
      {...props}
      idPrefix="material-request-cancel"
      heading={`${CANCEL_MATERIAL_REQUEST_LABEL} ${requestNumberLine(props.materialRequest.request_number)}`}
      saveUrl={`/material-requests/${encodeURIComponent(props.materialRequest.id)}/cancel`}
      noun={MATERIAL_REQUEST_LABEL}
      notice={`${REQUESTED_ITEM_LABEL}ที่รอพิจารณาทั้ง ${pendingCount} รายการจะถูกยกเลิก`}
    />
  );
};
