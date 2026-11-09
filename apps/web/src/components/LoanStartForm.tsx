import React, { useRef, useState } from 'react';
import { Link } from 'react-router';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import { entryLabel, fieldInputStyle, fieldLabelStyle, useReferenceLists } from './ReferenceContextFields';
import { bangkokToday, isBeforeToday } from './assignmentFacts';
import { CONDITION_LABELS, ON_LOAN_LABEL, type LoanCondition, type RefusedAsset } from './loanFacts';

export interface LoanFormAsset {
  id: string;
  name: string | null;
  asset_number: string | null;
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

// A failed save, and whether the same request can be sent again because its outcome is unknown.
interface SaveFailure {
  message: string;
  canRetry?: boolean;
}

type SaveRequest = Record<string, unknown> & { retry_token: string };

const assetLabel = ({ name, asset_number: assetNumber, id }: LoanFormAsset): string => name ?? assetNumber ?? id;

const CONDITIONS = Object.keys(CONDITION_LABELS) as LoanCondition[];

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

/**
 * The form that starts one Loan of the Assets it is given. A retry after an unknown outcome resends
 * the same request under the same token, so one action records one Loan. The server decides again
 * everything this form checks.
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
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [refused, setRefused] = useState<RefusedAsset[] | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const uncertainRef = useRef<SaveRequest | null>(null);

  const { lists, error: listError } = useReferenceLists(true, actorId);

  // #74 Q7, Q14: deactivated Persons are for a Loan Date before today. A chosen one leaves the
  // selection as soon as it is no longer offered.
  const offerInactive = isBeforeToday(loanDate);
  const offeredPersons = lists.persons.filter((entry) => entry.is_active || offerInactive);
  const offered = (id: string): string => (offeredPersons.some((entry) => entry.id === id) ? id : '');
  const chosenPerson = offered(personId);
  const chosenAuthorizer = offered(authorizerId);

  const itemDraft = (assetId: string): ItemDraft => items[assetId] ?? { condition: 'NORMAL', note: '' };
  const setItemDraft = (assetId: string, change: Partial<ItemDraft>) =>
    setItems((current) => ({ ...current, [assetId]: { ...itemDraft(assetId), ...change } }));

  const isLocked = isSubmitting || failure?.canRetry === true;

  const send = async (request: SaveRequest) => {
    setIsSubmitting(true);
    setFailure(null);
    setRefused(null);
    uncertainRef.current = request;

    let res: Response;
    try {
      res = await fetch('/loans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-retry-token': request.retry_token,
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify(request),
      });
    } catch {
      setIsSubmitting(false);
      setFailure({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', canRetry: true });
      return;
    }

    if (res.ok) {
      uncertainRef.current = null;
      await onStarted();
      return;
    }

    setIsSubmitting(false);
    if (res.status === 401 || res.status === 403) {
      uncertainRef.current = null;
      setFailure({ message: res.status === 401 ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' : 'คุณไม่มีสิทธิ์บันทึกการยืม' });
      onPermissionRevoked?.(res.status);
      return;
    }
    if (res.status === 400 || res.status === 409) {
      uncertainRef.current = null;
      const body = await res.json().catch(() => null);
      if (body?.code === 'ASSETS_NOT_LENDABLE') {
        setRefused(body.assets);
        return;
      }
      setFailure({ message: body?.message || 'ไม่สามารถบันทึกการยืมได้' });
      return;
    }
    // A server failure leaves the outcome unknown, so the same request stays ready to resend.
    setFailure({ message: 'เกิดข้อผิดพลาดในการบันทึก กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', canRetry: true });
  };

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = requestError();
    if (problem) {
      setFailure({ message: problem });
      return;
    }
    void send({
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
      retry_token: crypto.randomUUID(),
    });
  };

  const personOptions = offeredPersons.map((entry) => (
    <option key={entry.id} value={entry.id}>
      {entryLabel(entry)}
    </option>
  ));

  return (
    <form
      id="loan-form"
      noValidate
      onSubmit={handleSubmit}
      style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '1rem', marginBottom: '1rem' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, color: '#111827' }}>บันทึกการยืม</h3>

      {failure && (
        <div
          role="alert"
          data-testid="loan-form-error"
          style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.875rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>{failure.message}</span>
          {failure.canRetry && (
            <button
              type="button"
              id="loan-retry"
              disabled={isSubmitting}
              onClick={() => {
                if (uncertainRef.current) {
                  void send(uncertainRef.current);
                }
              }}
              style={{ marginLeft: '1rem', padding: '0.375rem 0.75rem', backgroundColor: '#991b1b', color: '#ffffff', border: 'none', borderRadius: '4px', fontWeight: 600, fontSize: '0.8125rem', whiteSpace: 'nowrap' }}
            >
              ส่งซ้ำ
            </button>
          )}
        </div>
      )}

      {refused && (
        <div role="alert" data-testid="loan-refused" style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.875rem' }}>
          ไม่ได้บันทึกการยืม เพราะครุภัณฑ์ต่อไปนี้ยืมไม่ได้
          <ul style={{ margin: '0.5rem 0 0 1.25rem', padding: 0 }}>
            {refused.map((asset) => (
              <li key={asset.asset_id}>
                {asset.name ?? asset.asset_number ?? asset.asset_id}:{' '}
                {asset.reason === 'ON_LOAN' ? (
                  <>
                    {ON_LOAN_LABEL} <Link to={`/loans/${asset.loan_id}`}>ดูรายการยืม</Link>
                  </>
                ) : (
                  'ไม่พบครุภัณฑ์'
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

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
            <div key={asset.id} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem', ...fieldStyle }}>
              <div>
                <label htmlFor={`loan-condition-${asset.id}`} style={fieldLabelStyle}>
                  สภาพ: {assetLabel(asset)}
                </label>
                <select
                  id={`loan-condition-${asset.id}`}
                  value={condition}
                  onChange={(e) => setItemDraft(asset.id, { condition: e.target.value as LoanCondition })}
                  style={fieldInputStyle}
                >
                  {CONDITIONS.map((value) => (
                    <option key={value} value={value}>
                      {CONDITION_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`loan-condition-note-${asset.id}`} style={fieldLabelStyle}>
                  บันทึกสภาพ (ไม่บังคับ)
                </label>
                <input
                  id={`loan-condition-note-${asset.id}`}
                  type="text"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setItemDraft(asset.id, { note: e.target.value })}
                  style={fieldInputStyle}
                />
              </div>
            </div>
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

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          type="submit"
          id="loan-submit"
          disabled={isLocked}
          style={{ padding: '0.5rem 1.25rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: isLocked ? 'not-allowed' : 'pointer' }}
        >
          {isSubmitting ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
        <button
          type="button"
          id="loan-cancel"
          onClick={onCancel}
          disabled={isLocked}
          style={{ padding: '0.5rem 1rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem', cursor: isLocked ? 'not-allowed' : 'pointer' }}
        >
          ยกเลิก
        </button>
      </div>
    </form>
  );
};
