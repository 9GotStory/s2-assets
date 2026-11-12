import React, { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from './LoanSaveForm';
import { ReasonField } from './OutstandingItemFields';
import { RepairOutcomeFields, repairOutcomeDraftError, type RepairOutcomeDraft } from './RepairOutcomeFields';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { CORRECTION_LABELS, bangkokToday, thaiDate } from './assignmentFacts';
import { CONDITION_LABELS, NOT_RETURNED_LABEL, ON_LOAN_LABEL, type AssetLoanItem } from './loanFacts';
import {
  REPAIR_KIND_LABELS,
  REPAIR_SOURCE_LABEL,
  REPAIR_SOURCE_REFUSAL_LABELS,
  UNDER_REPAIR_LABELS,
  UNDER_WARRANTY_LABELS,
  costError,
  type RepairCorrectionTarget,
  type RepairKind,
  type RepairOutcomeValue,
  type RepairRecord,
  type RepairSourceRefusal,
  type RepairStartRefusal,
} from './repairFacts';

export interface RepairCorrectionFormProps {
  record: RepairRecord;
  target: RepairCorrectionTarget;
  // What the form calls the fact it corrects: "รายการซ่อม" or "ผลการซ่อม".
  targetLabel: string;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Repair Record and returns its version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

const correctionUrl = (record: RepairRecord) => `/repairs/${record.id}/corrections`;

// What a voided Repair fact still is: shown struck through, and counted in nothing (#98 Q18).
const VOIDED_REPAIR_COUNTS_IN_NOTHING = 'ไม่นับรวมในสถานะ อยู่ระหว่างซ่อม และวันที่แนะนำบำรุงรักษาครั้งถัดไป';

// The version a correction form was opened against: a later read never rebases it silently.
const useExpectedVersion = (record: RepairRecord, onRefresh: () => Promise<number | null>) => {
  const [expectedVersion, setExpectedVersion] = useState(record.version);
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

// Voiding a Repair Outcome refused because a Loan or another Repair Record now keeps the Asset (#98 Q18).
const AssetHeld: React.FC<{ asset: RepairStartRefusal }> = ({ asset }) => (
  <>
    ยกเลิกผลการซ่อมไม่ได้ เพราะ {asset.name ?? asset.asset_number ?? asset.asset_id}{' '}
    {asset.reason === 'UNDER_REPAIR' ? (
      <>
        {UNDER_REPAIR_LABELS[asset.repair_kind]}ในรายการอื่น ต้องจัดการรายการนั้นก่อน <Link to={`/repairs/${asset.repair_record_id}`}>ดูรายการซ่อม</Link>
      </>
    ) : (
      <>
        {asset.reason === 'ON_LOAN' ? ON_LOAN_LABEL : NOT_RETURNED_LABEL} ต้องจัดการการยืมนั้นก่อน <Link to={`/loans/${asset.loan_id}`}>ดูการยืม</Link>
      </>
    )}
  </>
);

/**
 * "ยกเลิกรายการ (บันทึกผิด)": a Repair Record or Repair Outcome that never happened. It stays shown, struck
 * through, and counts in nothing; voiding the record voids its outcome with it (#98 Q18).
 */
export const RepairVoidForm: React.FC<RepairCorrectionFormProps> = ({ record, target, targetLabel, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  const [reason, setReason] = useState('');
  const { expectedVersion, refresh } = useExpectedVersion(record, onRefresh);
  return (
    <LoanSaveForm
      idPrefix="repair-void"
      heading={`${CORRECTION_LABELS.VOIDED}: ${targetLabel}`}
      saveUrl={correctionUrl(record)}
      csrfToken={csrfToken}
      requestError={() => (reason.trim() === '' ? 'กรุณาระบุเหตุผลที่ยกเลิกรายการ' : null)}
      requestBody={() => ({ expected_version: expectedVersion, action: 'VOID', target, reason })}
      refusedList={(body) => (body?.code === 'REPAIR_OUTCOME_VOID_REFUSED' ? <AssetHeld asset={body.asset} /> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขรายการซ่อม"
      refusedMessage="ไม่สามารถยกเลิกรายการได้"
      onSaved={onRecorded}
      onRefresh={refresh}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            {target.kind === 'REPAIR_RECORD'
              ? `รายการซ่อมนี้และผลการซ่อมของรายการจะยังแสดงแบบขีดฆ่า และ${VOIDED_REPAIR_COUNTS_IN_NOTHING}`
              : `ผลการซ่อมนี้จะยังแสดงแบบขีดฆ่า รายการกลับเป็นยังไม่มีผล ครุภัณฑ์จะ${UNDER_REPAIR_LABELS[record.repair_kind]}อีกครั้ง และค่าใช้จ่ายกลับเป็นค่าก่อนบันทึกผล`}
          </p>
          <ReasonField idPrefix="repair-void" label="เหตุผลที่ยกเลิก" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

// The fields of one fact as the form holds them: text, with '' for none.
type Draft = Record<string, string>;

// The fact as it stands, as a draft.
const fieldsOf = (record: RepairRecord, target: RepairCorrectionTarget): Draft | null => {
  if (target.kind === 'REPAIR_RECORD') {
    return {
      repair_kind: record.repair_kind,
      start_date: record.start_date,
      repairer_kind: record.repairer.kind,
      repairer_name: record.repairer.name ?? '',
      symptom_or_work: record.symptom_or_work,
      under_warranty: record.under_warranty,
      warranty_end_date: record.warranty_end_date ?? '',
      cost: record.cost ?? '',
      document_reference: record.document_reference ?? '',
      remark: record.remark ?? '',
      repair_source: record.repair_source?.loan_return_id ?? '',
    };
  }
  const { outcome } = record;
  if (!outcome || outcome.id !== target.id) {
    return null;
  }
  return {
    outcome: outcome.outcome,
    outcome_date: outcome.outcome_date,
    note: outcome.note ?? '',
    document_reference: outcome.document_reference ?? '',
    next_recommended_maintenance_date: outcome.next_recommended_maintenance_date ?? '',
  };
};

const REPAIRER_FIELDS = ['repairer_kind', 'repairer_name'];

// What an amendment names: only the fields that differ from the fact as it stands, so that a read of the
// latest facts leaves a field the user did not touch at its latest value. A Repairer is named whole, and a
// cost compares as an amount, so that "500" over a stored "500.00" is no change.
const changesOf = (stored: Draft, draft: Draft): Record<string, unknown> => {
  const differs = (field: string) => {
    const [before, after] = [stored[field].trim(), draft[field].trim()];
    return field === 'cost' && before !== '' && after !== '' ? Number(before) !== Number(after) : before !== after;
  };
  const changes: Record<string, unknown> = {};
  if (REPAIRER_FIELDS.some((field) => field in stored && differs(field))) {
    changes.repairer = { kind: draft.repairer_kind, name: draft.repairer_name.trim() || null };
  }
  for (const field of Object.keys(stored).filter((field) => !REPAIRER_FIELDS.includes(field) && differs(field))) {
    if (field === 'repair_source') {
      changes.repair_source = draft.repair_source ? { loan_return_id: draft.repair_source } : null;
    } else {
      changes[field] = field === 'symptom_or_work' ? draft[field] : draft[field].trim() || null;
    }
  }
  return changes;
};

// The Asset's Loan Returns recorded ชำรุด that a record may cite (F005-T5), from its LoanItems.
const useDamagedLoanReturns = (record: RepairRecord, enabled: boolean, onPermissionRevoked?: (statusCode?: number) => void) =>
  useQuery<{ id: string; loan_id: string; return_date: string }[], Error & { status?: number }>({
    queryKey: ['repair-source-options', record.asset.id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/assets/${record.asset.id}/loans`, { credentials: 'include', signal });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          onPermissionRevoked?.(res.status);
        }
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const { items } = (await res.json()) as { items: AssetLoanItem[] };
      return items.flatMap(({ is_voided: isVoided, loan_id: loanId, loan_return: loanReturn }) =>
        !isVoided && loanReturn?.condition === 'DAMAGED' ? [{ id: loanReturn.id, loan_id: loanId, return_date: loanReturn.return_date }] : []
      );
    },
    enabled,
  });

const DateField: React.FC<{ id: string; label: string; value: string; min?: string; max?: string; onChange: (value: string) => void }> = ({ id, label, value, min, max, onChange }) => (
  <div style={fieldStyle}>
    <label htmlFor={id} style={fieldLabelStyle}>
      {label}
    </label>
    <input id={id} type="date" value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} style={fieldInputStyle} />
  </div>
);

/**
 * "แก้ไขรายการที่บันทึกผิด": corrects the fields of a Repair Record or its Repair Outcome, with a reason
 * (#98 Q18). A record's Asset is never offered: a wrong Asset is voided and sent again. The server decides
 * every rule again.
 */
export const RepairAmendForm: React.FC<RepairCorrectionFormProps> = ({ record, target, targetLabel, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  // The fields the user changed, over the fact as it stands (see changesOf).
  const [changedFields, setChangedFields] = useState<Draft>({});
  const [reason, setReason] = useState('');
  const { expectedVersion, refresh } = useExpectedVersion(record, onRefresh);
  const sources = useDamagedLoanReturns(record, target.kind === 'REPAIR_RECORD', onPermissionRevoked);

  const stored = fieldsOf(record, target);
  if (!stored) {
    return null;
  }
  const draft: Draft = { ...stored, ...changedFields };
  const set = (field: string) => (value: string) => setChangedFields((current) => ({ ...current, [field]: value }));

  const outcomeDraft: RepairOutcomeDraft = {
    outcome: draft.outcome as RepairOutcomeValue,
    outcomeDate: draft.outcome_date,
    nextRecommendedMaintenanceDate: draft.next_recommended_maintenance_date,
    documentReference: draft.document_reference,
    note: draft.note,
  };

  const requestError = (): string | null => {
    if (reason.trim() === '') {
      return 'กรุณาระบุเหตุผลที่แก้ไขรายการ';
    }
    if (target.kind === 'REPAIR_RECORD') {
      if (draft.start_date === '') {
        return 'กรุณาเลือกวันที่ส่งซ่อม';
      }
      if (draft.start_date > bangkokToday()) {
        return 'วันที่ส่งซ่อมต้องไม่เกินวันนี้';
      }
      if (draft.symptom_or_work.trim() === '') {
        return 'กรุณากรอกอาการ/งานที่ทำ';
      }
      const error = costError(draft.cost);
      if (error) {
        return error;
      }
    } else {
      const error = repairOutcomeDraftError(outcomeDraft, record.start_date);
      if (error) {
        return error;
      }
    }
    return Object.keys(changesOf(stored, draft)).length === 0 ? 'ยังไม่มีค่าที่แก้ไข' : null;
  };

  // The current Repair Source stays offered, voided or not, so that leaving it alone changes nothing.
  const current = record.repair_source;
  const sourceOptions = [
    ...(current && !sources.data?.some(({ id }) => id === current.loan_return_id) ? [{ id: current.loan_return_id, return_date: current.return_date }] : []),
    ...(sources.data ?? []),
  ];

  return (
    <LoanSaveForm
      idPrefix="repair-amend"
      heading={`${CORRECTION_LABELS.AMENDED}: ${targetLabel}`}
      saveUrl={correctionUrl(record)}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={() => ({ expected_version: expectedVersion, action: 'AMEND', target, reason, changes: changesOf(stored, draft) })}
      refusedList={(body) =>
        body?.code === 'REPAIR_SOURCE_REFUSED' ? <>แก้ไขไม่ได้ เพราะ{REPAIR_SOURCE_REFUSAL_LABELS[body.repair_source.reason as RepairSourceRefusal['reason']]}</> : null
      }
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขรายการซ่อม"
      refusedMessage="ไม่สามารถแก้ไขรายการได้"
      onSaved={onRecorded}
      onRefresh={refresh}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          {target.kind === 'REPAIR_RECORD' ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={fieldStyle}>
                  <label htmlFor="repair-amend-repair_kind" style={fieldLabelStyle}>
                    ประเภท
                  </label>
                  <select id="repair-amend-repair_kind" value={draft.repair_kind} onChange={(e) => set('repair_kind')(e.target.value)} style={fieldInputStyle}>
                    {(['REPAIR', 'MAINTENANCE'] as const).map((kind) => (
                      <option key={kind} value={kind}>
                        {REPAIR_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <DateField id="repair-amend-start_date" label="วันที่ส่งซ่อม" value={draft.start_date} max={bangkokToday()} onChange={set('start_date')} />
              </div>
              <div role="radiogroup" aria-label="ผู้ซ่อม" style={{ ...fieldStyle, display: 'flex', gap: '1.5rem', fontSize: '0.875rem' }}>
                {(
                  [
                    ['INTERNAL', 'ผู้ซ่อมภายใน'],
                    ['EXTERNAL', 'ผู้ซ่อมภายนอก'],
                  ] as const
                ).map(([kind, label]) => (
                  <label key={kind}>
                    <input type="radio" name="repair-amend-repairer-kind" checked={draft.repairer_kind === kind} onChange={() => set('repairer_kind')(kind)} /> {label}
                  </label>
                ))}
              </div>
              <div style={fieldStyle}>
                <label htmlFor="repair-amend-repairer_name" style={fieldLabelStyle}>
                  ชื่อร้านหรือช่าง (ไม่บังคับ)
                </label>
                <input id="repair-amend-repairer_name" type="text" value={draft.repairer_name} maxLength={200} onChange={(e) => set('repairer_name')(e.target.value)} style={fieldInputStyle} />
              </div>
              <div style={fieldStyle}>
                <label htmlFor="repair-amend-symptom_or_work" style={fieldLabelStyle}>
                  อาการ/งานที่ทำ
                </label>
                <textarea id="repair-amend-symptom_or_work" value={draft.symptom_or_work} maxLength={2000} rows={3} onChange={(e) => set('symptom_or_work')(e.target.value)} style={fieldInputStyle} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                <div style={fieldStyle}>
                  <label htmlFor="repair-amend-under_warranty" style={fieldLabelStyle}>
                    อยู่ในประกัน
                  </label>
                  <select id="repair-amend-under_warranty" value={draft.under_warranty} onChange={(e) => set('under_warranty')(e.target.value)} style={fieldInputStyle}>
                    {(['UNSPECIFIED', 'YES', 'NO'] as const).map((value) => (
                      <option key={value} value={value}>
                        {UNDER_WARRANTY_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
                <DateField id="repair-amend-warranty_end_date" label="วันสิ้นสุดประกัน (ไม่บังคับ)" value={draft.warranty_end_date} onChange={set('warranty_end_date')} />
                <div style={fieldStyle}>
                  <label htmlFor="repair-amend-cost" style={fieldLabelStyle}>
                    ค่าใช้จ่าย (บาท, ไม่บังคับ)
                  </label>
                  <input id="repair-amend-cost" type="text" inputMode="decimal" value={draft.cost} maxLength={13} onChange={(e) => set('cost')(e.target.value)} style={fieldInputStyle} />
                </div>
              </div>
              <div style={fieldStyle}>
                <label htmlFor="repair-amend-document_reference" style={fieldLabelStyle}>
                  เอกสารอ้างอิง
                </label>
                <input id="repair-amend-document_reference" type="text" value={draft.document_reference} maxLength={500} onChange={(e) => set('document_reference')(e.target.value)} style={fieldInputStyle} />
              </div>
              <div style={fieldStyle}>
                <label htmlFor="repair-amend-remark" style={fieldLabelStyle}>
                  หมายเหตุ
                </label>
                <textarea id="repair-amend-remark" value={draft.remark} maxLength={2000} rows={2} onChange={(e) => set('remark')(e.target.value)} style={fieldInputStyle} />
              </div>
              <div style={fieldStyle}>
                <label htmlFor="repair-amend-repair_source" style={fieldLabelStyle}>
                  {REPAIR_SOURCE_LABEL}
                </label>
                <select id="repair-amend-repair_source" value={draft.repair_source} onChange={(e) => set('repair_source')(e.target.value)} style={fieldInputStyle}>
                  <option value="">— ไม่มี —</option>
                  {sourceOptions.map(({ id, return_date: returnDate }) => (
                    <option key={id} value={id}>
                      การคืนสภาพ{CONDITION_LABELS.DAMAGED} วันที่ {thaiDate(returnDate)}
                    </option>
                  ))}
                </select>
                {sources.isError && sources.error?.status !== 401 && sources.error?.status !== 403 && (
                  <div role="alert" style={{ marginTop: '0.25rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
                    ไม่สามารถโหลดการคืนที่บันทึกสภาพชำรุดของครุภัณฑ์นี้ได้
                  </div>
                )}
              </div>
            </>
          ) : (
            <RepairOutcomeFields
              idPrefix="repair-amend"
              repairKind={record.repair_kind as RepairKind}
              startDate={record.start_date}
              draft={outcomeDraft}
              onChange={(next) => {
                // Only the field the user touched joins the changed fields (see changesOf).
                const touched = Object.entries({
                  outcome: next.outcome,
                  outcome_date: next.outcomeDate,
                  next_recommended_maintenance_date: next.nextRecommendedMaintenanceDate,
                  document_reference: next.documentReference,
                  note: next.note,
                }).filter(([field, value]) => value !== draft[field]);
                setChangedFields((currentFields) => ({ ...currentFields, ...Object.fromEntries(touched) }));
              }}
            />
          )}
          <ReasonField idPrefix="repair-amend" label="เหตุผลที่แก้ไข" value={reason} onChange={setReason} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
