import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { OutstandingItemPicker, ReasonField, RefusedOutstandingItems } from './OutstandingItemFields';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { DUE_DATE_EXTENSION_LABEL, isOutstanding, type Loan } from './loanFacts';

export interface DueDateExtensionFormProps {
  loan: Loan;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Loan and returns its version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * Records a Due Date Extension ("เลื่อนกำหนดคืน") for the Outstanding items, all of them chosen until
 * the Custodian narrows them (#74 Q28). The new date must be later than each chosen item's current Due
 * Date, even one already passed. The server decides again everything this form checks.
 */
export const DueDateExtensionForm: React.FC<DueDateExtensionFormProps> = ({ loan, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  // The version this form was opened against: a later read never rebases it silently (#74 US 53).
  const [expectedVersion, setExpectedVersion] = useState(loan.version);
  const [newDueDate, setNewDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(loan.items.filter(isOutstanding).map(({ id }) => [id, true]))
  );

  const outstanding = loan.items.filter(isOutstanding);
  const extending = outstanding.filter(({ id }) => selected[id]);

  const requestError = (): string | null => {
    if (extending.length === 0) {
      return 'กรุณาเลือกรายการที่เลื่อนกำหนดคืน';
    }
    if (newDueDate === '') {
      return 'กรุณาเลือกกำหนดคืนใหม่';
    }
    return extending.some(({ due_date: dueDate }) => newDueDate <= dueDate) ? 'กำหนดคืนใหม่ต้องช้ากว่ากำหนดคืนเดิมของทุกรายการที่เลือก' : null;
  };

  return (
    <LoanSaveForm
      idPrefix="loan-extension"
      heading={DUE_DATE_EXTENSION_LABEL}
      saveUrl={`/loans/${loan.id}/due-date-extensions`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={() => ({
        expected_version: expectedVersion,
        new_due_date: newDueDate,
        reason: reason.trim() || null,
        items: extending.map(({ id }) => ({ loan_item_id: id })),
      })}
      refusedList={(body) =>
        body?.code === 'LOAN_ITEMS_NOT_OUTSTANDING' ? <RefusedOutstandingItems heading="ไม่ได้บันทึกการเลื่อนกำหนดคืน เพราะรายการต่อไปนี้ไม่อยู่ในสถานะยังไม่คืน" items={body.items} /> : null
      }
      forbiddenMessage="คุณไม่มีสิทธิ์เลื่อนกำหนดคืน"
      refusedMessage="ไม่สามารถเลื่อนกำหนดคืนได้"
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
          <OutstandingItemPicker
            idPrefix="loan-extension"
            items={outstanding}
            selected={selected}
            onChange={(itemId, isSelected) => setSelected((current) => ({ ...current, [itemId]: isSelected }))}
          />
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="loan-extension-new_due_date" style={fieldLabelStyle}>
              กำหนดคืนใหม่
            </label>
            <input id="loan-extension-new_due_date" type="date" value={newDueDate} onChange={(e) => setNewDueDate(e.target.value)} style={fieldInputStyle} />
          </div>
          <ReasonField idPrefix="loan-extension" label="เหตุผล (ไม่บังคับ)" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
