import React from 'react';
import { AssignmentSaveForm, type AssignmentSaveProps } from './AssignmentSaveForm';
import { ReassignmentFields, useReassignmentDraft } from './ReassignmentFields';
import { REFERENCE_DIMENSIONS } from './ReferenceContextFields';
import { KIND_LABELS, effectiveDateError, valuesAt, type AssignmentEvent } from './assignmentFacts';
import type { OnLoan } from './loanFacts';

export interface ReassignmentFormProps {
  save: AssignmentSaveProps;
  // Absent while the timeline cannot be read: the prior values are then not previewed.
  timeline?: AssignmentEvent[];
  actorId: string | null;
  // Who holds the Asset while it is On Loan (F004-T4).
  onLoan?: OnLoan | null;
}

/**
 * "ย้าย / เปลี่ยนผู้รับผิดชอบ": one real change of an Asset's Permanent Assignment, effective today or
 * earlier. The server derives the prior values and decides every rule; this form previews them.
 */
export const ReassignmentForm: React.FC<ReassignmentFormProps> = ({ save, timeline, actorId, onLoan }) => {
  const draft = useReassignmentDraft(actorId);
  const { effectiveDate, requested, requestFields } = draft;

  const priorValues = timeline && effectiveDate !== '' ? valuesAt(timeline, effectiveDate) : null;

  const requestError = (): string | null => {
    const dateProblem = effectiveDateError(effectiveDate, 'กรุณาระบุวันที่มีผล');
    if (dateProblem) {
      return dateProblem;
    }
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
      requestBody={() => ({ kind: 'REASSIGNMENT', ...requestFields })}
    >
      {(isLocked) => (
        <ReassignmentFields
          draft={draft}
          isLocked={isLocked}
          priorValues={priorValues}
          onLoan={onLoan ? [{ id: save.assetId, label: 'ครุภัณฑ์นี้', onLoan }] : []}
        />
      )}
    </AssignmentSaveForm>
  );
};
