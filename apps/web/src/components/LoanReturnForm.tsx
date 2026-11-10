import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import { LoanConditionFields } from './LoanConditionFields';
import { LoanSaveForm } from './LoanSaveForm';
import { REFERENCE_DIMENSIONS, fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday, thaiDate, valueText } from './assignmentFacts';
import { NOT_RETURNED_LABEL, assetLabel, isReturnable, type Loan, type LoanCondition, type LoanItem, type RefusedLoanItem } from './loanFacts';

export interface LoanReturnFormProps {
  loan: Loan;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Loan and returns its version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

// #74 Q10: '' is no Condition chosen yet, because a default could hide damage.
type ItemDraft = { isReturning: boolean; condition: LoanCondition | ''; note: string };

const NO_DRAFT: ItemDraft = { isReturning: false, condition: '', note: '' };

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

const REFUSAL_LABELS: Record<RefusedLoanItem['reason'], string> = {
  NOT_FOUND: 'ไม่พบรายการนี้ในการยืม',
  VOIDED: 'รายการนี้ถูกยกเลิกแล้ว',
  ALREADY_RETURNED: 'คืนแล้ว',
};

const RefusedItems: React.FC<{ items: RefusedLoanItem[] }> = ({ items }) => (
  <>
    ไม่ได้บันทึกการคืน เพราะรายการต่อไปนี้คืนไม่ได้
    <ul style={{ margin: '0.5rem 0 0 1.25rem', padding: 0 }}>
      {items.map((item) => (
        <li key={item.loan_item_id}>
          {item.name ?? item.asset_number ?? item.loan_item_id}: {REFUSAL_LABELS[item.reason]}
        </li>
      ))}
    </ul>
  </>
);

/**
 * Records a Loan Return for the items the Custodian picks, Outstanding or Not Returned and come back
 * later (#74 Q21): one Return Date, document
 * reference and remark, and each item's own Condition. It shows where each item goes back to on the
 * Return Date, as the server derives it (#74 Q27). The server decides again everything this form checks.
 */
export const LoanReturnForm: React.FC<LoanReturnFormProps> = ({ loan, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  // The version this form was opened against: a later read never rebases it silently (#74 US 53).
  const [expectedVersion, setExpectedVersion] = useState(loan.version);
  const [returnDate, setReturnDate] = useState(bangkokToday);
  const [notes, setNotes] = useState<AssignmentNotes>({ documentReference: '', remark: '' });
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});

  const outstanding = loan.items.filter(isReturnable);
  const draftOf = (itemId: string): ItemDraft => drafts[itemId] ?? NO_DRAFT;
  const setDraft = (itemId: string, change: Partial<ItemDraft>) =>
    setDrafts((current) => ({ ...current, [itemId]: { ...(current[itemId] ?? NO_DRAFT), ...change } }));
  const returning = outstanding.filter(({ id }) => draftOf(id).isReturning);

  const setEveryConditionNormal = () =>
    setDrafts((current) =>
      Object.fromEntries(outstanding.map(({ id }) => [id, { ...(current[id] ?? NO_DRAFT), condition: 'NORMAL' as const }]))
    );

  // No placeholder: values read for another date must not show under this one.
  const itemsOnReturnDate = useQuery<LoanItem[], Error & { status?: number }>({
    queryKey: ['loan-return-assignments', loan.id, returnDate],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/loans/${loan.id}?return_date=${returnDate}`, { credentials: 'include', signal });
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
    enabled: returnDate !== '',
  });
  const assignmentOf = (itemId: string) => itemsOnReturnDate.data?.find(({ id }) => id === itemId)?.assignment_on_return_date;

  const requestError = (): string | null => {
    if (returning.length === 0) {
      return 'กรุณาเลือกรายการที่คืน';
    }
    if (returnDate === '') {
      return 'กรุณาเลือกวันที่คืน';
    }
    if (returnDate > bangkokToday()) {
      return 'วันที่คืนต้องไม่เกินวันนี้';
    }
    if (returnDate < loan.loan_date) {
      return 'วันที่คืนต้องไม่ก่อนวันที่ยืม';
    }
    if (returning.some(({ not_returned: notReturned }) => notReturned && returnDate < notReturned.not_returned_date)) {
      return 'วันที่คืนต้องไม่ก่อนวันที่ทราบว่าไม่ได้รับคืน';
    }
    return returning.some(({ id }) => draftOf(id).condition === '') ? 'กรุณาเลือกสภาพของทุกรายการที่คืน' : null;
  };

  const requestBody = () => ({
    expected_version: expectedVersion,
    return_date: returnDate,
    ...assignmentNotesPayload(notes),
    items: returning.map(({ id }) => ({
      loan_item_id: id,
      condition: draftOf(id).condition,
      condition_note: draftOf(id).note.trim() || null,
    })),
  });

  return (
    <LoanSaveForm
      idPrefix="loan-return"
      heading="บันทึกการคืน"
      saveUrl={`/loans/${loan.id}/returns`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => (body?.code === 'LOAN_ITEMS_NOT_RETURNABLE' ? <RefusedItems items={body.items} /> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์บันทึกการคืน"
      refusedMessage="ไม่สามารถบันทึกการคืนได้"
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
          <div style={fieldStyle}>
            <label htmlFor="loan-return-return_date" style={fieldLabelStyle}>
              วันที่คืน
            </label>
            <input
              id="loan-return-return_date"
              type="date"
              value={returnDate}
              min={loan.loan_date}
              max={bangkokToday()}
              onChange={(e) => setReturnDate(e.target.value)}
              style={fieldInputStyle}
            />
          </div>

          {itemsOnReturnDate.isError && itemsOnReturnDate.error?.status !== 401 && itemsOnReturnDate.error?.status !== 403 && (
            <div role="alert" data-testid="loan-return-assignment-error" style={{ ...fieldStyle, fontSize: '0.8125rem', color: '#b91c1c' }}>
              ไม่สามารถโหลดข้อมูลสถานที่ หน่วยงาน และผู้รับผิดชอบ ณ วันที่คืนได้
            </div>
          )}

          <button
            type="button"
            id="loan-return-all-normal"
            onClick={setEveryConditionNormal}
            style={{ ...fieldStyle, padding: '0.375rem 0.75rem', backgroundColor: '#ffffff', color: '#374151', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.8125rem', cursor: 'pointer' }}
          >
            ตั้งปกติทั้งหมด
          </button>

          {outstanding.map((item) => {
            const { isReturning, condition, note } = draftOf(item.id);
            const assignment = assignmentOf(item.id);
            return (
              <div key={item.id} data-testid="loan-return-item" style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                  <input
                    type="checkbox"
                    id={`loan-return-select-${item.id}`}
                    checked={isReturning}
                    onChange={(e) => setDraft(item.id, { isReturning: e.target.checked })}
                  />{' '}
                  {assetLabel(item.asset)}
                </label>
                {item.not_returned && (
                  <div data-testid={`loan-return-not-returned-${item.id}`} style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', color: '#6b7280' }}>
                    {NOT_RETURNED_LABEL}เมื่อ <time dateTime={item.not_returned.not_returned_date}>{thaiDate(item.not_returned.not_returned_date)}</time>
                  </div>
                )}
                {assignment && (
                  <dl data-testid={`loan-return-assignment-${item.id}`} style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', color: '#6b7280' }}>
                    {REFERENCE_DIMENSIONS.map(({ entryField, legacyField, label }) => (
                      <div key={entryField} style={{ display: 'flex', gap: '0.375rem' }}>
                        <dt>{label}:</dt>
                        <dd style={{ margin: 0 }}>{valueText({ entry: assignment[entryField], legacy_text: assignment[legacyField] })}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <LoanConditionFields
                  idPrefix="loan-return"
                  itemId={item.id}
                  assetLabel={assetLabel(item.asset)}
                  condition={condition}
                  note={note}
                  offerNone
                  onChange={(change) => setDraft(item.id, change)}
                />
              </div>
            );
          })}

          <AssignmentNoteFields idPrefix="loan-return" notes={notes} onChange={setNotes} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
