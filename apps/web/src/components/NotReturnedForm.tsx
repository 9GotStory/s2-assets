import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { OutstandingItemPicker, ReasonField, RefusedOutstandingItems } from './OutstandingItemFields';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday } from './assignmentFacts';
import { NOT_RETURNED_LABEL, isOutstanding, type Loan } from './loanFacts';

export interface NotReturnedFormProps {
  loan: Loan;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Loan and returns its version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * Closes the Outstanding items the Custodian picks as Not Returned ("ปิดโดยไม่ได้รับคืน"), with the date
 * it became known and a reason (#74 Q21). No item is chosen until the Custodian picks it. The server
 * decides again everything this form checks.
 */
export const NotReturnedForm: React.FC<NotReturnedFormProps> = ({ loan, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  // The version this form was opened against: a later read never rebases it silently (#74 US 53).
  const [expectedVersion, setExpectedVersion] = useState(loan.version);
  const [notReturnedDate, setNotReturnedDate] = useState(bangkokToday);
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const outstanding = loan.items.filter(isOutstanding);
  const closing = outstanding.filter(({ id }) => selected[id]);

  const requestError = (): string | null => {
    if (closing.length === 0) {
      return 'กรุณาเลือกรายการที่ไม่ได้รับคืน';
    }
    if (notReturnedDate === '') {
      return 'กรุณาเลือกวันที่ทราบ';
    }
    if (notReturnedDate > bangkokToday()) {
      return 'วันที่ทราบต้องไม่เกินวันนี้';
    }
    if (notReturnedDate < loan.loan_date) {
      return 'วันที่ทราบต้องไม่ก่อนวันที่ยืม';
    }
    return reason.trim() === '' ? 'กรุณาระบุเหตุผล' : null;
  };

  return (
    <LoanSaveForm
      idPrefix="loan-not-returned"
      heading={NOT_RETURNED_LABEL}
      saveUrl={`/loans/${loan.id}/not-returned`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={() => ({
        expected_version: expectedVersion,
        not_returned_date: notReturnedDate,
        reason,
        items: closing.map(({ id }) => ({ loan_item_id: id })),
      })}
      refusedList={(body) =>
        body?.code === 'LOAN_ITEMS_NOT_OUTSTANDING' ? <RefusedOutstandingItems heading="ไม่ได้ปิดรายการ เพราะรายการต่อไปนี้ไม่อยู่ในสถานะยังไม่คืน" items={body.items} /> : null
      }
      forbiddenMessage="คุณไม่มีสิทธิ์ปิดรายการโดยไม่ได้รับคืน"
      refusedMessage="ไม่สามารถปิดรายการโดยไม่ได้รับคืนได้"
      onSaved={onRecorded}
      onRefresh={async () => {
        const latest = await onRefresh();
        if (latest === null) {
          return false;
        }
        setExpectedVersion(latest);
        return true;
      }}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#6b7280' }}>
            รายการที่ปิดไม่นับเป็นการคืน และครุภัณฑ์ชิ้นนั้นจะยืมใหม่ไม่ได้จนกว่าจะบันทึกคืน
          </p>
          <OutstandingItemPicker
            idPrefix="loan-not-returned"
            items={outstanding}
            selected={selected}
            onChange={(itemId, isSelected) => setSelected((current) => ({ ...current, [itemId]: isSelected }))}
          />
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="loan-not-returned-date" style={fieldLabelStyle}>
              วันที่ทราบ
            </label>
            <input
              id="loan-not-returned-date"
              type="date"
              value={notReturnedDate}
              min={loan.loan_date}
              max={bangkokToday()}
              onChange={(e) => setNotReturnedDate(e.target.value)}
              style={fieldInputStyle}
            />
          </div>
          <ReasonField idPrefix="loan-not-returned" label="เหตุผล" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
