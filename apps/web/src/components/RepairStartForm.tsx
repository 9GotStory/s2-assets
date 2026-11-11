import React, { useState } from 'react';
import { Link } from 'react-router';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import { LoanSaveForm } from './LoanSaveForm';
import { RepairOutcomeFields, emptyRepairOutcomeDraft, repairOutcomeDraftError, repairOutcomePayload, type RepairOutcomeDraft } from './RepairOutcomeFields';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { bangkokToday } from './assignmentFacts';
import { NOT_RETURNED_LABEL, ON_LOAN_LABEL } from './loanFacts';
import {
  REPAIR_KIND_LABELS,
  REPAIR_OUTCOME_LABEL,
  REPAIR_START_LABEL,
  UNDER_REPAIR_LABELS,
  UNDER_WARRANTY_LABELS,
  costError,
  type RepairKind,
  type RepairStartRefusal,
  type RepairerKind,
  type UnderWarranty,
} from './repairFacts';

export interface RepairStartFormProps {
  assetId: string;
  csrfToken: string | null;
  onStarted: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

// A refused Repair Start names the Loan or the Repair Record that keeps the Asset (#98 Q3).
const RefusedRepairStart: React.FC<{ asset: RepairStartRefusal }> = ({ asset }) => (
  <>
    ส่งซ่อมไม่ได้ เพราะ {asset.name ?? asset.asset_number ?? asset.asset_id}{' '}
    {asset.reason === 'UNDER_REPAIR' ? (
      <>
        {UNDER_REPAIR_LABELS[asset.repair_kind]} <Link to={`/repairs/${asset.repair_record_id}`}>ดูรายการซ่อม</Link>
      </>
    ) : (
      <>
        {asset.reason === 'ON_LOAN' ? ON_LOAN_LABEL : NOT_RETURNED_LABEL} ต้องบันทึกการคืนก่อน <Link to={`/loans/${asset.loan_id}`}>ดูการยืม</Link>
      </>
    )}
  </>
);

/**
 * "ส่งซ่อม": sends one Asset for repair or maintenance (F005-T1). Work already finished, on site or long
 * ago, is recorded with its Repair Outcome in the same write, so the Asset is never Under Repair
 * (F005-T2, #98 Q1, Q22). The server decides again everything this form checks.
 */
export const RepairStartForm: React.FC<RepairStartFormProps> = ({ assetId, csrfToken, onStarted, onCancel, onPermissionRevoked }) => {
  const [repairKind, setRepairKind] = useState<RepairKind | ''>('');
  const [startDate, setStartDate] = useState(bangkokToday);
  const [repairerKind, setRepairerKind] = useState<RepairerKind | ''>('');
  const [repairerName, setRepairerName] = useState('');
  const [symptomOrWork, setSymptomOrWork] = useState('');
  const [underWarranty, setUnderWarranty] = useState<UnderWarranty>('UNSPECIFIED');
  const [warrantyEndDate, setWarrantyEndDate] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState<AssignmentNotes>({ documentReference: '', remark: '' });
  const [withOutcome, setWithOutcome] = useState(false);
  const [outcome, setOutcome] = useState<RepairOutcomeDraft>(emptyRepairOutcomeDraft);

  const requestError = (): string | null => {
    if (repairKind === '') {
      return 'กรุณาเลือกประเภท ซ่อม หรือ บำรุงรักษา';
    }
    if (startDate === '') {
      return 'กรุณาเลือกวันที่ส่งซ่อม';
    }
    if (startDate > bangkokToday()) {
      return 'วันที่ส่งซ่อมต้องไม่เกินวันนี้';
    }
    if (repairerKind === '') {
      return 'กรุณาเลือกผู้ซ่อมภายในหรือภายนอก';
    }
    if (symptomOrWork.trim() === '') {
      return 'กรุณากรอกอาการ/งานที่ทำ';
    }
    return costError(cost) ?? (withOutcome ? repairOutcomeDraftError(outcome, startDate) : null);
  };

  const requestBody = () => ({
    asset_id: assetId,
    repair_kind: repairKind,
    start_date: startDate,
    repairer: { kind: repairerKind, name: repairerName.trim() || null },
    symptom_or_work: symptomOrWork,
    under_warranty: underWarranty,
    warranty_end_date: warrantyEndDate || null,
    cost: cost.trim() || null,
    ...assignmentNotesPayload(notes),
    ...(withOutcome ? { outcome: repairOutcomePayload(outcome) } : {}),
  });

  return (
    <LoanSaveForm
      idPrefix="repair"
      heading={REPAIR_START_LABEL}
      saveUrl="/repairs"
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => (body?.code === 'REPAIR_START_REFUSED' ? <RefusedRepairStart asset={body.asset} /> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์ส่งซ่อม"
      refusedMessage="ไม่สามารถบันทึกการส่งซ่อมได้"
      onSaved={onStarted}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div style={fieldStyle}>
              <label htmlFor="repair-repair_kind" style={fieldLabelStyle}>
                ประเภท
              </label>
              <select id="repair-repair_kind" value={repairKind} onChange={(e) => setRepairKind(e.target.value as RepairKind | '')} style={fieldInputStyle}>
                <option value="">— เลือกประเภท —</option>
                {(['REPAIR', 'MAINTENANCE'] as const).map((kind) => (
                  <option key={kind} value={kind}>
                    {REPAIR_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            <div style={fieldStyle}>
              <label htmlFor="repair-start_date" style={fieldLabelStyle}>
                วันที่ส่งซ่อม
              </label>
              <input id="repair-start_date" type="date" value={startDate} max={bangkokToday()} onChange={(e) => setStartDate(e.target.value)} style={fieldInputStyle} />
            </div>
          </div>

          <div role="radiogroup" aria-label="ผู้ซ่อม" style={{ ...fieldStyle, display: 'flex', gap: '1.5rem', fontSize: '0.875rem' }}>
            {(
              [
                ['INTERNAL', 'ผู้ซ่อมภายใน'],
                ['EXTERNAL', 'ผู้ซ่อมภายนอก'],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind}>
                <input type="radio" name="repair-repairer-kind" checked={repairerKind === kind} onChange={() => setRepairerKind(kind)} /> {label}
              </label>
            ))}
          </div>
          <div style={fieldStyle}>
            <label htmlFor="repair-repairer_name" style={fieldLabelStyle}>
              ชื่อร้านหรือช่าง (ไม่บังคับ)
            </label>
            <input id="repair-repairer_name" type="text" value={repairerName} maxLength={200} onChange={(e) => setRepairerName(e.target.value)} style={fieldInputStyle} />
          </div>

          <div style={fieldStyle}>
            <label htmlFor="repair-symptom_or_work" style={fieldLabelStyle}>
              อาการ/งานที่ทำ
            </label>
            <textarea id="repair-symptom_or_work" value={symptomOrWork} maxLength={2000} rows={3} onChange={(e) => setSymptomOrWork(e.target.value)} style={fieldInputStyle} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
            <div style={fieldStyle}>
              <label htmlFor="repair-under_warranty" style={fieldLabelStyle}>
                อยู่ในประกัน
              </label>
              <select id="repair-under_warranty" value={underWarranty} onChange={(e) => setUnderWarranty(e.target.value as UnderWarranty)} style={fieldInputStyle}>
                {(['UNSPECIFIED', 'YES', 'NO'] as const).map((value) => (
                  <option key={value} value={value}>
                    {UNDER_WARRANTY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div style={fieldStyle}>
              <label htmlFor="repair-warranty_end_date" style={fieldLabelStyle}>
                วันสิ้นสุดประกัน (ไม่บังคับ)
              </label>
              <input id="repair-warranty_end_date" type="date" value={warrantyEndDate} onChange={(e) => setWarrantyEndDate(e.target.value)} style={fieldInputStyle} />
            </div>
            <div style={fieldStyle}>
              <label htmlFor="repair-cost" style={fieldLabelStyle}>
                ค่าใช้จ่าย (บาท, ไม่บังคับ)
              </label>
              <input id="repair-cost" type="text" inputMode="decimal" value={cost} maxLength={13} onChange={(e) => setCost(e.target.value)} style={fieldInputStyle} />
            </div>
          </div>

          <AssignmentNoteFields idPrefix="repair" notes={notes} onChange={setNotes} />

          <label style={{ display: 'block', margin: '1rem 0 0.75rem 0', fontSize: '0.875rem', fontWeight: 500, color: '#374151' }}>
            <input type="checkbox" id="repair-with-outcome" checked={withOutcome} onChange={(e) => setWithOutcome(e.target.checked)} /> บันทึก{REPAIR_OUTCOME_LABEL}พร้อมกัน
            (งานที่เสร็จแล้ว)
          </label>
          {withOutcome && (
            <fieldset data-testid="repair-outcome-fields" style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.75rem', margin: 0 }}>
              <legend style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>{REPAIR_OUTCOME_LABEL}</legend>
              <RepairOutcomeFields idPrefix="repair" repairKind={repairKind} startDate={startDate} draft={outcome} onChange={setOutcome} />
            </fieldset>
          )}
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
