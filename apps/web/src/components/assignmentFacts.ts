import { REFERENCE_DIMENSIONS, entryLabel, type ReferenceEntry } from './ReferenceContextFields';

// One fact of an Asset's assignment timeline (GET /assets/:id/assignments, F003-T1).
export interface AssignmentValue {
  entry: ReferenceEntry | null;
  legacy_text: string | null;
}

export type AssignmentDimension = (typeof REFERENCE_DIMENSIONS)[number]['entryField'];

export interface AssignmentChange {
  dimension: AssignmentDimension;
  prior: AssignmentValue;
  new: AssignmentValue;
  // The value just before this change, when its recorded prior value differs from it (F003-T4).
  conflict: { value_just_before: AssignmentValue } | null;
}

// The before and after of one field an Assignment Correction changed. A dimension is null where the
// fact does not have it.
export type AssignmentCorrectionField =
  | { field: 'effective_date' | 'document_reference' | 'remark'; before: string | null; after: string | null }
  | {
      field: AssignmentDimension;
      before: Pick<AssignmentChange, 'prior' | 'new'> | null;
      after: Pick<AssignmentChange, 'prior' | 'new'> | null;
    };

export interface AssignmentCorrection {
  id: string;
  action: 'AMENDED' | 'VOIDED';
  reason: string;
  recorded_at: string;
  recorded_by: string;
  recorded_by_username: string | null;
  changes: AssignmentCorrectionField[];
}

export interface AssignmentEvent {
  id: string;
  kind: 'INITIAL' | 'REASSIGNMENT';
  effective_date: string | null;
  recorded_at: string;
  recorded_by: string;
  recorded_by_username: string | null;
  provenance: 'RECORDED' | 'CARRIED_OVER_F002';
  document_reference: string | null;
  remark: string | null;
  is_voided: boolean;
  // What the events of one Bulk Reassignment share (F003-T5).
  bulk_reference: string | null;
  changes: AssignmentChange[];
  corrections: AssignmentCorrection[];
}

// One Assignment Conflict a write would create (F003-T4). A null event_id is the fact being saved.
export interface AssignmentConflict {
  asset_id: string;
  event_id: string | null;
  kind: AssignmentEvent['kind'];
  effective_date: string | null;
  dimension: AssignmentDimension;
  recorded_prior: AssignmentValue;
  value_just_before: AssignmentValue;
}

// Labels from GLOSSARY.md (#50 Q18).
export const BULK_REASSIGNMENT_LABEL = 'ย้ายหลายรายการ';

export const KIND_LABELS: Record<AssignmentEvent['kind'], string> = {
  INITIAL: 'กำหนดครั้งแรก',
  REASSIGNMENT: 'ย้าย / เปลี่ยนผู้รับผิดชอบ',
};

export const CORRECTION_LABELS: Record<AssignmentCorrection['action'], string> = {
  AMENDED: 'แก้ไขรายการที่บันทึกผิด',
  VOIDED: 'ยกเลิกรายการ (บันทึกผิด)',
};

const NO_VALUE: AssignmentValue = { entry: null, legacy_text: null };

const THAI_DATE = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'UTC' });

// A calendar date (YYYY-MM-DD) in Thai.
export const thaiDate = (date: string): string => THAI_DATE.format(new Date(`${date}T00:00:00Z`));

// A period from its start to its end, or still open: a Loan Conflict's or a Repair Conflict's other side.
export const periodText = (start: string, end: string | null): string => `${thaiDate(start)} – ${end ? thaiDate(end) : 'ยังไม่สิ้นสุด'}`;

export const dimensionLabel = (dimension: AssignmentDimension): string =>
  REFERENCE_DIMENSIONS.find(({ entryField }) => entryField === dimension)!.label;

const BANGKOK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Today's Asia/Bangkok date as YYYY-MM-DD: the latest Effective Date a fact may have (#50 Q2).
export const bangkokToday = (): string => {
  const parts = Object.fromEntries(BANGKOK_DATE.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

// Whether a chosen date is before today, as a date input gives it ('' when none is chosen).
export const isBeforeToday = (date: string): boolean => date !== '' && date < bangkokToday();

// Why an Effective Date cannot be sent, or null when it can. `missing` is the message for no date.
export const effectiveDateError = (date: string, missing: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return missing;
  }
  return date > bangkokToday() ? 'วันที่มีผลต้องไม่เกินวันนี้' : null;
};

export const valueText = (value: AssignmentValue): string => {
  const parts = [value.entry ? entryLabel(value.entry) : null, value.legacy_text ? `ข้อความเดิม: ${value.legacy_text}` : null];
  return parts.filter(Boolean).join(' / ') || 'ไม่ระบุ';
};

// One dimension of a fact: an Initial Assignment shows its new value alone, having no prior value.
export const changeText = (kind: AssignmentEvent['kind'], change: Pick<AssignmentChange, 'prior' | 'new'>): string =>
  kind === 'INITIAL' ? valueText(change.new) : `${valueText(change.prior)} → ${valueText(change.new)}`;

// One Assignment Conflict: the prior value a fact recorded, against the value just before it.
export const conflictText = (recordedPrior: AssignmentValue, valueJustBefore: AssignmentValue): string =>
  `บันทึกค่าเดิมไว้ว่า ${valueText(recordedPrior)} แต่ค่าก่อนหน้าคือ ${valueText(valueJustBefore)}`;

/**
 * The value of each dimension in effect on a date, read from a timeline in the order of facts: a
 * preview of the prior values, which the server derives for itself when it records the fact. A
 * voided fact takes no part.
 */
export const valuesAt = (timeline: AssignmentEvent[], date: string): Record<AssignmentDimension, AssignmentValue> => {
  const values: Record<AssignmentDimension, AssignmentValue> = {
    location: NO_VALUE,
    organization_unit: NO_VALUE,
    responsible_person: NO_VALUE,
  };
  for (const event of timeline) {
    if (!event.is_voided && (event.effective_date === null || event.effective_date <= date)) {
      for (const change of event.changes) {
        values[change.dimension] = change.new;
      }
    }
  }
  return values;
};
