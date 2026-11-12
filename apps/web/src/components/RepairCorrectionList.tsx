import React from 'react';
import { CORRECTION_LABELS, thaiDate } from './assignmentFacts';
import { CONDITION_LABELS, VOIDED_LABEL } from './loanFacts';
import {
  REPAIRER_KIND_LABELS,
  REPAIR_KIND_LABELS,
  REPAIR_OUTCOME_LABEL,
  REPAIR_OUTCOME_LABELS,
  REPAIR_RECORD_LABEL,
  UNDER_WARRANTY_LABELS,
  costText,
  type RepairCorrection,
  type RepairCorrectionField,
  type RepairKind,
  type RepairOutcomeValue,
  type RepairSource,
  type UnderWarranty,
} from './repairFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const FIELD_LABELS: Record<string, string> = {
  repair_kind: 'ประเภท',
  start_date: 'วันที่ส่งซ่อม',
  repairer_kind: 'ผู้ซ่อม',
  repairer_name: 'ชื่อร้านหรือช่าง',
  symptom_or_work: 'อาการ/งานที่ทำ',
  under_warranty: 'อยู่ในประกัน',
  warranty_end_date: 'วันสิ้นสุดประกัน',
  cost: 'ค่าใช้จ่าย',
  document_reference: 'เอกสารอ้างอิง',
  remark: 'หมายเหตุ',
  repair_source_loan_return_id: 'ที่มา',
  outcome: REPAIR_OUTCOME_LABEL,
  outcome_date: 'วันที่ได้ผล',
  note: 'หมายเหตุของผล',
  next_recommended_maintenance_date: 'วันที่แนะนำบำรุงรักษาครั้งถัดไป',
};

const DATE_FIELDS = new Set(['start_date', 'warranty_end_date', 'outcome_date', 'next_recommended_maintenance_date']);

const sourceText = (source: RepairSource): string =>
  `การคืนสภาพ${CONDITION_LABELS[source.condition]} วันที่ ${thaiDate(source.return_date)}${source.is_voided ? ` (${VOIDED_LABEL})` : ''}`;

// A value as the Repair Record page shows it. An outcome reads by the record's kind (#98 Q16).
const valueText = (field: string, value: string | RepairSource | null, repairKind: RepairKind): string => {
  if (value === null) {
    return 'ไม่ระบุ';
  }
  if (typeof value !== 'string') {
    return sourceText(value);
  }
  if (DATE_FIELDS.has(field)) {
    return thaiDate(value);
  }
  switch (field) {
    case 'repair_kind':
      return REPAIR_KIND_LABELS[value as RepairKind];
    case 'repairer_kind':
      return REPAIRER_KIND_LABELS[value as 'INTERNAL' | 'EXTERNAL'];
    case 'under_warranty':
      return UNDER_WARRANTY_LABELS[value as UnderWarranty];
    case 'cost':
      return costText(value);
    case 'outcome':
      return REPAIR_OUTCOME_LABELS[repairKind][value as RepairOutcomeValue];
    default:
      return value;
  }
};

// One changed field, as "before แก้เป็น after".
const changeText = (change: RepairCorrectionField, repairKind: RepairKind): string =>
  `${FIELD_LABELS[change.field] ?? change.field}: ${valueText(change.field, change.before, repairKind)} แก้เป็น ${valueText(change.field, change.after, repairKind)}`;

/** The Repair Record's corrections, oldest first, each with its fact, reason, who, when, and before and after. */
export const RepairCorrectionList: React.FC<{ repairKind: RepairKind; corrections: RepairCorrection[] }> = ({ repairKind, corrections }) => (
  <section aria-labelledby="repair-corrections-heading" style={{ marginTop: '1.5rem' }}>
    <h2 id="repair-corrections-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '0.75rem', color: '#374151' }}>
      การแก้ไขรายการที่บันทึกผิด
    </h2>
    <ol id="repair-corrections" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {corrections.map((correction) => (
        <li key={correction.id} data-testid="repair-correction" style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
          <div style={{ fontWeight: 600 }}>
            {CORRECTION_LABELS[correction.action]}: {correction.target.kind === 'REPAIR_RECORD' ? REPAIR_RECORD_LABEL : REPAIR_OUTCOME_LABEL}
          </div>
          <div style={{ color: '#4b5563' }}>
            บันทึกเมื่อ <time dateTime={correction.recorded_at}>{THAI_DATE_TIME.format(new Date(correction.recorded_at))}</time> โดย{' '}
            {correction.recorded_by_username ?? correction.recorded_by}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>เหตุผล: {correction.reason}</div>
          {correction.changes.length > 0 && (
            <ul style={{ margin: '0.125rem 0 0 0', paddingLeft: '1.25rem' }}>
              {correction.changes.map((change) => (
                <li key={change.field} style={{ whiteSpace: 'pre-wrap' }}>
                  {changeText(change, repairKind)}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  </section>
);
