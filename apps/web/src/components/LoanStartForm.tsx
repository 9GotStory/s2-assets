import React, { useState } from 'react';
import { Link } from 'react-router';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import { LoanConditionFields } from './LoanConditionFields';
import { LoanSaveForm } from './LoanSaveForm';
import { entryLabel, fieldInputStyle, fieldLabelStyle, useReferenceLists } from './ReferenceContextFields';
import { bangkokToday, isBeforeToday, thaiDate } from './assignmentFacts';
import { NOT_RETURNED_LABEL, ON_LOAN_LABEL, START_LOAN_LABEL, assetLabel, type LoanCondition, type RefusedAsset, type StartLoanWarning } from './loanFacts';
import { REPAIR_OUTCOME_LABELS, UNDER_REPAIR_LABELS } from './repairFacts';

export interface LoanFormAsset {
  id: string;
  name: string | null;
  asset_number: string | null;
  // Why a new Loan of it warns, from its latest Loan Return or Repair Outcome; it never blocks (#98 Q20).
  start_loan_warning?: StartLoanWarning | null;
}

export interface LoanStartFormProps {
  assets: LoanFormAsset[];
  actorId: string | null;
  csrfToken: string | null;
  onStarted: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

type ItemDraft = { condition: LoanCondition; note: string };

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };
const warningStyle: React.CSSProperties = { marginTop: '0.375rem', fontSize: '0.8125rem', color: '#92400e' };

const RefusedAssets: React.FC<{ assets: RefusedAsset[] }> = ({ assets }) => (
  <>
    ไม่ได้บันทึกการยืม เพราะครุภัณฑ์ต่อไปนี้ยืมไม่ได้
    <ul style={{ margin: '0.5rem 0 0 1.25rem', padding: 0 }}>
      {assets.map((asset) => (
        <li key={asset.asset_id}>
          {asset.name ?? asset.asset_number ?? asset.asset_id}:{' '}
          {asset.reason === 'NOT_FOUND' && 'ไม่พบครุภัณฑ์'}
          {asset.reason === 'UNDER_REPAIR' && (
            <>
              {UNDER_REPAIR_LABELS[asset.repair_kind]} <Link to={`/repairs/${asset.repair_record_id}`}>ดูรายการซ่อม</Link>
            </>
          )}
          {(asset.reason === 'ON_LOAN' || asset.reason === 'NOT_RETURNED') && (
            <>
              {asset.reason === 'ON_LOAN' ? ON_LOAN_LABEL : NOT_RETURNED_LABEL} <Link to={`/loans/${asset.loan_id}`}>ดูการยืม</Link>
            </>
          )}
        </li>
      ))}
    </ul>
  </>
);

/**
 * The form that starts one Loan of the Assets it is given. The server decides again everything this
 * form checks.
 */
export const LoanStartForm: React.FC<LoanStartFormProps> = ({ assets, actorId, csrfToken, onStarted, onCancel, onPermissionRevoked }) => {
  const [loanDate, setLoanDate] = useState(bangkokToday);
  const [dueDate, setDueDate] = useState('');
  const [borrowerKind, setBorrowerKind] = useState<'INTERNAL' | 'EXTERNAL'>('INTERNAL');
  const [personId, setPersonId] = useState('');
  const [contactName, setContactName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [phone, setPhone] = useState('');
  const [authorizerId, setAuthorizerId] = useState('');
  const [notes, setNotes] = useState<AssignmentNotes>({ documentReference: '', remark: '' });
  const [items, setItems] = useState<Record<string, ItemDraft>>({});

  const { lists, error: listError } = useReferenceLists(true, actorId);

  // #74 Q7, Q14: deactivated Persons are for a Loan Date before today. A chosen one leaves the
  // selection as soon as it is no longer offered.
  const offerInactive = isBeforeToday(loanDate);
  const offeredPersons = lists.persons.filter((entry) => entry.is_active || offerInactive);
  const offeredOrNone = (id: string): string => (offeredPersons.some((entry) => entry.id === id) ? id : '');
  const chosenPerson = offeredOrNone(personId);
  const chosenAuthorizer = offeredOrNone(authorizerId);

  const itemDraft = (assetId: string): ItemDraft => items[assetId] ?? { condition: 'NORMAL', note: '' };
  const setItemDraft = (assetId: string, change: Partial<ItemDraft>) =>
    setItems((current) => ({ ...current, [assetId]: { ...itemDraft(assetId), ...change } }));

  const requestError = (): string | null => {
    if (borrowerKind === 'INTERNAL' && chosenPerson === '') {
      return 'กรุณาเลือกผู้ยืม';
    }
    if (borrowerKind === 'EXTERNAL' && contactName.trim() === '') {
      return 'กรุณากรอกชื่อผู้ติดต่อของผู้ยืมภายนอก';
    }
    if (loanDate === '') {
      return 'กรุณาเลือกวันที่ยืม';
    }
    if (loanDate > bangkokToday()) {
      return 'วันที่ยืมต้องไม่เกินวันนี้';
    }
    if (dueDate === '') {
      return 'กรุณาเลือกกำหนดคืน';
    }
    return dueDate < loanDate ? 'กำหนดคืนต้องไม่ก่อนวันที่ยืม' : null;
  };

  const requestBody = () => ({
    assets: assets.map(({ id }) => ({
      asset_id: id,
      condition: itemDraft(id).condition,
      condition_note: itemDraft(id).note.trim() || null,
    })),
    borrower:
      borrowerKind === 'INTERNAL'
        ? { kind: 'INTERNAL', person_id: chosenPerson }
        : {
            kind: 'EXTERNAL',
            contact_name: contactName.trim(),
            organization_name: organizationName.trim() || null,
            phone: phone.trim() || null,
          },
    loan_date: loanDate,
    due_date: dueDate,
    authorizer_person_id: chosenAuthorizer || null,
    ...assignmentNotesPayload(notes),
  });

  const personOptions = offeredPersons.map((entry) => (
    <option key={entry.id} value={entry.id}>
      {entryLabel(entry)}
    </option>
  ));

  return (
    <LoanSaveForm
      idPrefix="loan"
      heading={START_LOAN_LABEL}
      saveUrl="/loans"
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => (body?.code === 'ASSETS_NOT_LENDABLE' ? <RefusedAssets assets={body.assets} /> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์บันทึกการยืม"
      refusedMessage="ไม่สามารถบันทึกการยืมได้"
      onSaved={onStarted}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          {listError && (
            <div role="alert" style={{ marginBottom: '0.75rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
              {listError}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div style={fieldStyle}>
              <label htmlFor="loan-loan_date" style={fieldLabelStyle}>
                วันที่ยืม
              </label>
              <input id="loan-loan_date" type="date" value={loanDate} max={bangkokToday()} onChange={(e) => setLoanDate(e.target.value)} style={fieldInputStyle} />
            </div>
            <div style={fieldStyle}>
              <label htmlFor="loan-due_date" style={fieldLabelStyle}>
                กำหนดคืน
              </label>
              <input id="loan-due_date" type="date" value={dueDate} min={loanDate || undefined} onChange={(e) => setDueDate(e.target.value)} style={fieldInputStyle} />
            </div>
          </div>

          <div role="radiogroup" aria-label="ผู้ยืม" style={{ ...fieldStyle, display: 'flex', gap: '1.5rem', fontSize: '0.875rem' }}>
            {(
              [
                ['INTERNAL', 'ผู้ยืมภายใน'],
                ['EXTERNAL', 'ผู้ยืมภายนอก'],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind}>
                <input type="radio" name="loan-borrower-kind" checked={borrowerKind === kind} onChange={() => setBorrowerKind(kind)} /> {label}
              </label>
            ))}
          </div>

          {borrowerKind === 'INTERNAL' ? (
            <div style={fieldStyle}>
              <label htmlFor="loan-borrower_person_id" style={fieldLabelStyle}>
                ผู้ยืม
              </label>
              <select id="loan-borrower_person_id" value={chosenPerson} onChange={(e) => setPersonId(e.target.value)} style={fieldInputStyle}>
                <option value="">— เลือกผู้ยืม —</option>
                {personOptions}
              </select>
            </div>
          ) : (
            <>
              <div style={fieldStyle}>
                <label htmlFor="loan-contact_name" style={fieldLabelStyle}>
                  ชื่อผู้ติดต่อ
                </label>
                <input id="loan-contact_name" type="text" value={contactName} maxLength={200} onChange={(e) => setContactName(e.target.value)} style={fieldInputStyle} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={fieldStyle}>
                  <label htmlFor="loan-organization_name" style={fieldLabelStyle}>
                    ชื่อหน่วยงาน (ไม่บังคับ)
                  </label>
                  <input id="loan-organization_name" type="text" value={organizationName} maxLength={200} onChange={(e) => setOrganizationName(e.target.value)} style={fieldInputStyle} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="loan-phone" style={fieldLabelStyle}>
                    เบอร์โทร (ไม่บังคับ)
                  </label>
                  <input id="loan-phone" type="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} style={fieldInputStyle} />
                </div>
              </div>
            </>
          )}

          {assets.map((asset) => {
            const { condition, note } = itemDraft(asset.id);
            return (
              <LoanConditionFields
                key={asset.id}
                idPrefix="loan"
                itemId={asset.id}
                assetLabel={assetLabel(asset)}
                condition={condition}
                note={note}
                onChange={(change) => setItemDraft(asset.id, change)}
              >
                {asset.start_loan_warning?.source === 'LOAN_RETURN' && (
                  <div data-testid={`loan-damaged-warning-${asset.id}`} style={warningStyle}>
                    คืนครั้งล่าสุดสภาพชำรุด กรุณาตรวจสอบก่อนให้ยืม
                  </div>
                )}
                {asset.start_loan_warning?.source === 'REPAIR_OUTCOME' && (
                  <div data-testid={`loan-repair-outcome-warning-${asset.id}`} style={warningStyle}>
                    ผลการซ่อมล่าสุด {REPAIR_OUTCOME_LABELS[asset.start_loan_warning.repair_kind].NOT_USABLE} เมื่อ{' '}
                    <time dateTime={asset.start_loan_warning.date}>{thaiDate(asset.start_loan_warning.date)}</time> กรุณาตรวจสอบก่อนให้ยืม
                  </div>
                )}
              </LoanConditionFields>
            );
          })}

          <div style={fieldStyle}>
            <label htmlFor="loan-authorizer_person_id" style={fieldLabelStyle}>
              ผู้อนุญาต (ไม่บังคับ)
            </label>
            <select id="loan-authorizer_person_id" value={chosenAuthorizer} onChange={(e) => setAuthorizerId(e.target.value)} style={fieldInputStyle}>
              <option value="">— ไม่ระบุ —</option>
              {personOptions}
            </select>
          </div>

          <AssignmentNoteFields idPrefix="loan" notes={notes} onChange={setNotes} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
