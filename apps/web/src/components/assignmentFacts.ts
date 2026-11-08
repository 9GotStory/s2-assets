import { entryLabel, type REFERENCE_DIMENSIONS, type ReferenceEntry } from './ReferenceContextFields';

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
  changes: AssignmentChange[];
}

// Labels from GLOSSARY.md (#50 Q18).
export const KIND_LABELS: Record<AssignmentEvent['kind'], string> = {
  INITIAL: 'กำหนดครั้งแรก',
  REASSIGNMENT: 'ย้าย / เปลี่ยนผู้รับผิดชอบ',
};

const NO_VALUE: AssignmentValue = { entry: null, legacy_text: null };

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

/**
 * The value of each dimension in effect on a date, read from a timeline in the order of facts: a
 * preview of the prior values, which the server derives for itself when it records the fact.
 */
export const valuesAt = (timeline: AssignmentEvent[], date: string): Record<AssignmentDimension, AssignmentValue> => {
  const values: Record<AssignmentDimension, AssignmentValue> = {
    location: NO_VALUE,
    organization_unit: NO_VALUE,
    responsible_person: NO_VALUE,
  };
  for (const event of timeline) {
    if (event.effective_date === null || event.effective_date <= date) {
      for (const change of event.changes) {
        values[change.dimension] = change.new;
      }
    }
  }
  return values;
};
