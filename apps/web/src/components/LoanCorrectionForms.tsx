import React, { useState } from 'react';
import { Link } from 'react-router';
import { LoanConditionFields } from './LoanConditionFields';
import { LoanSaveForm } from './LoanSaveForm';
import { ReasonField } from './OutstandingItemFields';
import { entryLabel, fieldInputStyle, fieldLabelStyle, useReferenceLists } from './ReferenceContextFields';
import { CORRECTION_LABELS, bangkokToday } from './assignmentFacts';
import { NOT_RETURNED_LABEL, ON_LOAN_LABEL, type Loan, type LoanCondition, type LoanCorrectionTarget } from './loanFacts';

export interface LoanCorrectionFormProps {
  loan: Loan;
  target: LoanCorrectionTarget;
  // What the form calls the fact it corrects, such as "การยืม" or "การคืน: โน้ตบุ๊ก A".
  targetLabel: string;
  actorId: string | null;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Loan and returns its version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

const correctionUrl = (loan: Loan) => `/loans/${loan.id}/corrections`;

// The version a correction form was opened against: a later read never rebases it silently (#74 US 53).
const useExpectedVersion = (loan: Loan, onRefresh: () => Promise<number | null>) => {
  const [expectedVersion, setExpectedVersion] = useState(loan.version);
  const refresh = async () => {
    const latest = await onRefresh();
    if (latest === null) {
      return false;
    }
    setExpectedVersion(latest);
    return true;
  };
  return { expectedVersion, refresh };
};

// Voiding an ending refused because another Loan now holds its Asset (LR-11, #74 Q25).
const AssetOnAnotherLoan: React.FC<{ asset: { name: string | null; asset_number: string | null; asset_id: string; loan_id: string; reason: 'ON_LOAN' | 'NOT_RETURNED' } }> = ({ asset }) => (
  <>
    ยกเลิกไม่ได้ เพราะ {asset.name ?? asset.asset_number ?? asset.asset_id} {asset.reason === 'ON_LOAN' ? ON_LOAN_LABEL : NOT_RETURNED_LABEL}ในการยืมอื่น
    ต้องจัดการการยืมนั้นก่อน <Link to={`/loans/${asset.loan_id}`}>ดูการยืม</Link>
  </>
);

/** "ยกเลิกรายการ (บันทึกผิด)": a fact that never happened. It stays shown, struck through, and counts in nothing (#74 Q25). */
export const LoanVoidForm: React.FC<LoanCorrectionFormProps> = ({ loan, target, targetLabel, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  const [reason, setReason] = useState('');
  const { expectedVersion, refresh } = useExpectedVersion(loan, onRefresh);
  return (
    <LoanSaveForm
      idPrefix="loan-void"
      heading={`${CORRECTION_LABELS.VOIDED}: ${targetLabel}`}
      saveUrl={correctionUrl(loan)}
      csrfToken={csrfToken}
      requestError={() => (reason.trim() === '' ? 'กรุณาระบุเหตุผลที่ยกเลิกรายการ' : null)}
      requestBody={() => ({ expected_version: expectedVersion, action: 'VOID', target, reason })}
      refusedList={(body) => (body?.code === 'ASSET_ON_ANOTHER_LOAN' ? <AssetOnAnotherLoan asset={body.asset} /> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขรายการยืม"
      refusedMessage="ไม่สามารถยกเลิกรายการได้"
      onSaved={onRecorded}
      onRefresh={refresh}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            {target.kind === 'LOAN'
              ? 'การยืมนี้และทุกรายการในการยืมจะยังแสดงแบบขีดฆ่า และไม่นับรวมในสถานะ เกินกำหนด และกำลังถูกยืม'
              : 'รายการนี้จะยังแสดงแบบขีดฆ่า และไม่นับรวมในสถานะ เกินกำหนด และกำลังถูกยืม'}
          </p>
          <ReasonField idPrefix="loan-void" label="เหตุผลที่ยกเลิก" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

// The fields of one fact as the form holds them: text, with '' for none.
type Draft = Record<string, string>;

const BORROWER_FIELDS = ['borrower_kind', 'borrower_person_id', 'contact_name', 'organization_name', 'phone'];

// The fact as it stands, as a draft.
const fieldsOf = (loan: Loan, target: LoanCorrectionTarget): Draft | null => {
  if (target.kind === 'LOAN') {
    const { borrower } = loan;
    return {
      borrower_kind: borrower.kind,
      borrower_person_id: borrower.kind === 'INTERNAL' ? borrower.person.id : '',
      contact_name: borrower.kind === 'EXTERNAL' ? borrower.contact_name : '',
      organization_name: borrower.kind === 'EXTERNAL' ? (borrower.organization_name ?? '') : '',
      phone: borrower.kind === 'EXTERNAL' ? (borrower.phone ?? '') : '',
      loan_date: loan.loan_date,
      authorizer_person_id: loan.authorizer?.id ?? '',
      document_reference: loan.document_reference ?? '',
      remark: loan.remark ?? '',
    };
  }
  for (const item of loan.items) {
    if (target.kind === 'LOAN_ITEM' && item.id === target.id) {
      return { due_date: item.first_due_date, condition: item.condition, condition_note: item.condition_note ?? '' };
    }
    if (target.kind === 'LOAN_RETURN' && item.loan_return?.id === target.id) {
      return { return_date: item.loan_return.return_date, condition: item.loan_return.condition, condition_note: item.loan_return.condition_note ?? '' };
    }
    if (target.kind === 'NOT_RETURNED' && item.not_returned?.id === target.id) {
      return { not_returned_date: item.not_returned.not_returned_date, reason: item.not_returned.reason };
    }
  }
  return null;
};

// What an amendment names: only the fields that differ from the fact as it stands, so that a read of the
// latest facts leaves a field the user did not touch at its latest value. A Borrower is named whole.
const changesOf = (stored: Draft, draft: Draft): Record<string, unknown> => {
  const differs = (field: string) => draft[field].trim() !== stored[field].trim();
  const changes: Record<string, unknown> = {};
  if (BORROWER_FIELDS.some((field) => field in stored && differs(field))) {
    changes.borrower =
      draft.borrower_kind === 'INTERNAL'
        ? { kind: 'INTERNAL', person_id: draft.borrower_person_id }
        : { kind: 'EXTERNAL', contact_name: draft.contact_name.trim(), organization_name: draft.organization_name.trim() || null, phone: draft.phone.trim() || null };
  }
  for (const field of Object.keys(stored).filter((field) => !BORROWER_FIELDS.includes(field))) {
    if (differs(field)) {
      changes[field] = field === 'reason' ? draft[field] : draft[field].trim() || null;
    }
  }
  return changes;
};

const DateField: React.FC<{ id: string; label: string; value: string; min?: string; onChange: (value: string) => void }> = ({ id, label, value, min, onChange }) => (
  <div style={fieldStyle}>
    <label htmlFor={id} style={fieldLabelStyle}>
      {label}
    </label>
    <input id={id} type="date" value={value} min={min} max={bangkokToday()} onChange={(e) => onChange(e.target.value)} style={fieldInputStyle} />
  </div>
);

const TextField: React.FC<{ id: string; label: string; value: string; maxLength: number; type?: string; onChange: (value: string) => void }> = ({ id, label, value, maxLength, type = 'text', onChange }) => (
  <div style={fieldStyle}>
    <label htmlFor={id} style={fieldLabelStyle}>
      {label}
    </label>
    <input id={id} type={type} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} style={fieldInputStyle} />
  </div>
);

/**
 * "แก้ไขรายการที่บันทึกผิด": corrects the fields of one fact, with a reason (#74 Q25). A LoanItem's Asset is
 * never offered, and a Due Date Extension is voided instead. The server decides every rule again.
 */
export const LoanAmendForm: React.FC<LoanCorrectionFormProps> = ({ loan, target, targetLabel, actorId, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  // The fields the user changed, over the fact as it stands (see changesOf).
  const [changedFields, setChangedFields] = useState<Draft>({});
  const [reason, setReason] = useState('');
  const { expectedVersion, refresh } = useExpectedVersion(loan, onRefresh);
  // Corrections may name deactivated Person entries (#74).
  const { lists, error: listError } = useReferenceLists(true, target.kind === 'LOAN' ? actorId : null);

  const stored = fieldsOf(loan, target);
  if (!stored) {
    return null;
  }
  const draft: Draft = { ...stored, ...changedFields };
  const set = (field: string) => (value: string) => setChangedFields((current) => ({ ...current, [field]: value }));

  const requestError = (): string | null => {
    if (reason.trim() === '') {
      return 'กรุณาระบุเหตุผลที่แก้ไขรายการ';
    }
    if (target.kind === 'LOAN' && draft.borrower_kind === 'INTERNAL' && draft.borrower_person_id === '') {
      return 'กรุณาเลือกผู้ยืม';
    }
    if (target.kind === 'LOAN' && draft.borrower_kind === 'EXTERNAL' && draft.contact_name.trim() === '') {
      return 'กรุณากรอกชื่อผู้ติดต่อของผู้ยืมภายนอก';
    }
    if (['loan_date', 'due_date', 'return_date', 'not_returned_date'].some((field) => field in draft && draft[field] === '')) {
      return 'กรุณาระบุวันที่';
    }
    if (target.kind === 'NOT_RETURNED' && draft.reason.trim() === '') {
      return 'กรุณาระบุเหตุผลที่ไม่ได้รับคืน';
    }
    return Object.keys(changesOf(stored, draft)).length === 0 ? 'ยังไม่มีค่าที่แก้ไข' : null;
  };

  const personOptions = lists.persons.map((entry) => (
    <option key={entry.id} value={entry.id}>
      {entryLabel(entry)}
    </option>
  ));
  const conditionFields = (
    <LoanConditionFields
      idPrefix="loan-amend"
      itemId={'id' in target ? target.id : loan.id}
      assetLabel={targetLabel}
      condition={draft.condition as LoanCondition}
      note={draft.condition_note}
      onChange={({ condition, note }) => {
        if (condition !== undefined) set('condition')(condition);
        if (note !== undefined) set('condition_note')(note);
      }}
    />
  );

  return (
    <LoanSaveForm
      idPrefix="loan-amend"
      heading={`${CORRECTION_LABELS.AMENDED}: ${targetLabel}`}
      saveUrl={correctionUrl(loan)}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={() => ({ expected_version: expectedVersion, action: 'AMEND', target, reason, changes: changesOf(stored, draft) })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขรายการยืม"
      refusedMessage="ไม่สามารถแก้ไขรายการได้"
      onSaved={onRecorded}
      onRefresh={refresh}
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
          {target.kind === 'LOAN' && (
            <>
              <div role="radiogroup" aria-label="ผู้ยืม" style={{ ...fieldStyle, display: 'flex', gap: '1.5rem', fontSize: '0.875rem' }}>
                {(
                  [
                    ['INTERNAL', 'ผู้ยืมภายใน'],
                    ['EXTERNAL', 'ผู้ยืมภายนอก'],
                  ] as const
                ).map(([kind, label]) => (
                  <label key={kind}>
                    <input type="radio" name="loan-amend-borrower-kind" checked={draft.borrower_kind === kind} onChange={() => set('borrower_kind')(kind)} /> {label}
                  </label>
                ))}
              </div>
              {draft.borrower_kind === 'INTERNAL' ? (
                <div style={fieldStyle}>
                  <label htmlFor="loan-amend-borrower_person_id" style={fieldLabelStyle}>
                    ผู้ยืม
                  </label>
                  <select id="loan-amend-borrower_person_id" value={draft.borrower_person_id} onChange={(e) => set('borrower_person_id')(e.target.value)} style={fieldInputStyle}>
                    <option value="">— เลือกผู้ยืม —</option>
                    {personOptions}
                  </select>
                </div>
              ) : (
                <>
                  <TextField id="loan-amend-contact_name" label="ชื่อผู้ติดต่อ" value={draft.contact_name} maxLength={200} onChange={set('contact_name')} />
                  <TextField id="loan-amend-organization_name" label="ชื่อหน่วยงาน (ไม่บังคับ)" value={draft.organization_name} maxLength={200} onChange={set('organization_name')} />
                  <TextField id="loan-amend-phone" label="เบอร์โทร (ไม่บังคับ ลบออกได้)" type="tel" value={draft.phone} maxLength={32} onChange={set('phone')} />
                </>
              )}
              <DateField id="loan-amend-loan_date" label="วันที่ยืม" value={draft.loan_date} onChange={set('loan_date')} />
              <div style={fieldStyle}>
                <label htmlFor="loan-amend-authorizer_person_id" style={fieldLabelStyle}>
                  ผู้อนุญาต (ไม่บังคับ)
                </label>
                <select id="loan-amend-authorizer_person_id" value={draft.authorizer_person_id} onChange={(e) => set('authorizer_person_id')(e.target.value)} style={fieldInputStyle}>
                  <option value="">— ไม่ระบุ —</option>
                  {personOptions}
                </select>
              </div>
              <TextField id="loan-amend-document_reference" label="เอกสารอ้างอิง" value={draft.document_reference} maxLength={500} onChange={set('document_reference')} />
              <div style={fieldStyle}>
                <label htmlFor="loan-amend-remark" style={fieldLabelStyle}>
                  หมายเหตุ
                </label>
                <textarea id="loan-amend-remark" value={draft.remark} maxLength={2000} rows={2} onChange={(e) => set('remark')(e.target.value)} style={fieldInputStyle} />
              </div>
            </>
          )}
          {target.kind === 'LOAN_ITEM' && (
            <>
              <DateField id="loan-amend-due_date" label="กำหนดคืนที่บันทึกครั้งแรก" value={draft.due_date} min={loan.loan_date} onChange={set('due_date')} />
              {conditionFields}
            </>
          )}
          {target.kind === 'LOAN_RETURN' && (
            <>
              <DateField id="loan-amend-return_date" label="วันที่คืน" value={draft.return_date} min={loan.loan_date} onChange={set('return_date')} />
              {conditionFields}
            </>
          )}
          {target.kind === 'NOT_RETURNED' && (
            <>
              <DateField id="loan-amend-not_returned_date" label="วันที่ทราบ" value={draft.not_returned_date} min={loan.loan_date} onChange={set('not_returned_date')} />
              <ReasonField idPrefix="loan-amend-not-returned" label="เหตุผลที่ไม่ได้รับคืน" value={draft.reason} onChange={set('reason')} />
            </>
          )}
          <ReasonField idPrefix="loan-amend" label="เหตุผลที่แก้ไข" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
