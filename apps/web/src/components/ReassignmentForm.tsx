import React, { useState } from 'react';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import { AssignmentSaveForm, type AssignmentSaveProps } from './AssignmentSaveForm';
import {
  REFERENCE_DIMENSIONS,
  entryLabel,
  fieldInputStyle,
  fieldLabelStyle,
  useClearClosedEntries,
  useReferenceLists,
  type ReferenceIdField,
} from './ReferenceContextFields';
import { KIND_LABELS, bangkokToday, effectiveDateError, isBeforeToday, valueText, valuesAt, type AssignmentEvent } from './assignmentFacts';

// The new value chosen for each dimension: no change (''), CLEAR, or an entry id.
type ReassignmentTargets = Record<ReferenceIdField, string>;

const NO_CHANGE: ReassignmentTargets = { location_id: '', organization_unit_id: '', responsible_person_id: '' };

const CLEAR = '__clear__';

// #50 Q15: the Location is never cleared; "location unknown" is a verification finding.
const CLEARABLE = new Set<ReferenceIdField>(['organization_unit_id', 'responsible_person_id']);

// What a Reassignment names: a dimension left at no change stays out, and null clears.
const requestedTargets = (targets: ReassignmentTargets): Partial<Record<ReferenceIdField, string | null>> =>
  Object.fromEntries(
    REFERENCE_DIMENSIONS.filter(({ idField }) => targets[idField] !== '').map(({ idField }) => [
      idField,
      targets[idField] === CLEAR ? null : targets[idField],
    ])
  );

export interface ReassignmentFormProps {
  save: AssignmentSaveProps;
  // Absent while the timeline cannot be read: the prior values are then not previewed.
  timeline?: AssignmentEvent[];
  actorId: string | null;
}

/**
 * "ย้าย / เปลี่ยนผู้รับผิดชอบ": one real change of an Asset's Permanent Assignment, effective today or
 * earlier. The server derives the prior values and decides every rule; this form previews them.
 */
export const ReassignmentForm: React.FC<ReassignmentFormProps> = ({ save, timeline, actorId }) => {
  const [effectiveDate, setEffectiveDate] = useState(bangkokToday);
  const [targets, setTargets] = useState<ReassignmentTargets>(NO_CHANGE);
  const [notes, setNotes] = useState<AssignmentNotes>({ documentReference: '', remark: '' });
  const { lists, error: listError } = useReferenceLists(true, actorId);

  // #50 Q16: deactivated entries are for facts dated before today.
  const offerInactive = isBeforeToday(effectiveDate);
  useClearClosedEntries(offerInactive, lists, setTargets);

  const priorValues = timeline && effectiveDate !== '' ? valuesAt(timeline, effectiveDate) : null;

  const requestError = (): string | null => {
    const dateProblem = effectiveDateError(effectiveDate, 'กรุณาระบุวันที่มีผล');
    if (dateProblem) {
      return dateProblem;
    }
    const requested = requestedTargets(targets);
    if (Object.keys(requested).length === 0) {
      return 'กรุณาเลือกค่าใหม่อย่างน้อยหนึ่งรายการ';
    }
    const changesSomething =
      !priorValues ||
      REFERENCE_DIMENSIONS.some(({ idField, entryField }) => {
        const prior = priorValues[entryField];
        return idField in requested && (requested[idField] !== (prior.entry?.id ?? null) || prior.legacy_text !== null);
      });
    return changesSomething ? null : 'ค่าที่เลือกตรงกับค่า ณ วันที่มีผลอยู่แล้ว จึงไม่มีการเปลี่ยนแปลง';
  };

  return (
    <AssignmentSaveForm
      {...save}
      heading={KIND_LABELS.REASSIGNMENT}
      saveUrl={`/assets/${save.assetId}/assignments`}
      requestError={requestError}
      requestBody={() => ({ kind: 'REASSIGNMENT', effective_date: effectiveDate, ...requestedTargets(targets), ...assignmentNotesPayload(notes) })}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <p data-testid="assignment-loan-note" style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            การยืมชั่วคราวไม่ใช่การย้าย: บันทึกที่นี่เฉพาะเมื่อสถานที่ หน่วยงาน หรือผู้รับผิดชอบเปลี่ยนไปจริง
          </p>
          {listError && (
            <div role="alert" style={{ marginBottom: '0.75rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
              {listError}
            </div>
          )}
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="assignment-effective_date" style={fieldLabelStyle}>
              วันที่มีผล
            </label>
            <input
              id="assignment-effective_date"
              type="date"
              value={effectiveDate}
              max={bangkokToday()}
              onChange={(e) => setEffectiveDate(e.target.value)}
              style={{ ...fieldInputStyle, width: 'auto' }}
            />
          </div>
          {REFERENCE_DIMENSIONS.map(({ kind: list, idField, entryField, label }) => (
            <div key={idField} style={{ marginBottom: '0.75rem' }}>
              <label htmlFor={`assignment-${idField}`} style={fieldLabelStyle}>
                {label}
              </label>
              <div id={`assignment-prior-${entryField}`} style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>
                ค่า ณ วันที่มีผล: {priorValues ? valueText(priorValues[entryField]) : '—'}
              </div>
              <select
                id={`assignment-${idField}`}
                value={targets[idField]}
                onChange={(e) => setTargets((current) => ({ ...current, [idField]: e.target.value }))}
                style={fieldInputStyle}
              >
                <option value="">— ไม่เปลี่ยน —</option>
                {CLEARABLE.has(idField) && <option value={CLEAR}>ล้างค่า (ไม่ระบุ)</option>}
                {lists[list]
                  .filter((entry) => entry.is_active || offerInactive)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entryLabel(entry)}
                    </option>
                  ))}
              </select>
            </div>
          ))}
          <AssignmentNoteFields idPrefix="assignment" notes={notes} onChange={setNotes} />
        </fieldset>
      )}
    </AssignmentSaveForm>
  );
};
