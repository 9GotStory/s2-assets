import React, { useState } from 'react';
import { AssignmentSaveForm, type AssignmentSaveProps } from './AssignmentSaveForm';
import {
  EMPTY_INITIAL_ASSIGNMENT,
  InitialAssignmentFields,
  effectiveDateOf,
  initialAssignmentError,
  initialAssignmentPayload,
  type InitialAssignmentDraft,
} from './InitialAssignmentFields';
import {
  EMPTY_REFERENCE_CONTEXT,
  ReferenceContextFields,
  hasReferenceValues,
  useClearClosedEntries,
  useReferenceLists,
  type ReferenceContextValues,
} from './ReferenceContextFields';
import { isBeforeToday } from './assignmentFacts';

export interface InitialAssignmentFormProps {
  save: AssignmentSaveProps;
  isLegacy: boolean;
  actorId: string | null;
}

/** "กำหนดครั้งแรก" from the Asset page, for an Asset that has no Initial Assignment yet. */
export const InitialAssignmentForm: React.FC<InitialAssignmentFormProps> = ({ save, isLegacy, actorId }) => {
  const [values, setValues] = useState<ReferenceContextValues>(EMPTY_REFERENCE_CONTEXT);
  const [draft, setDraft] = useState<InitialAssignmentDraft>(EMPTY_INITIAL_ASSIGNMENT);
  const { lists, error: listError } = useReferenceLists(true, actorId);

  const effectiveDate = effectiveDateOf(draft, isLegacy);
  // #50 Q16: deactivated entries are for facts dated before today, or of unknown date.
  const offerInactive = effectiveDate.unknown || isBeforeToday(effectiveDate.date);
  useClearClosedEntries(offerInactive, lists, setValues);

  return (
    <AssignmentSaveForm
      {...save}
      kind="INITIAL"
      requestError={() =>
        hasReferenceValues(values)
          ? initialAssignmentError(values, draft, isLegacy)
          : 'กรุณาระบุสถานที่ หน่วยงาน หรือผู้รับผิดชอบอย่างน้อยหนึ่งรายการ'
      }
      requestBody={() => initialAssignmentPayload(values, draft, isLegacy)}
    >
      {(isLocked) => (
        <ReferenceContextFields
          idPrefix="assignment"
          legend="สถานที่ หน่วยงาน และผู้รับผิดชอบ"
          values={values}
          onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
          lists={lists}
          listError={listError}
          disabled={isLocked}
          offerInactive={offerInactive}
        >
          <InitialAssignmentFields idPrefix="assignment" draft={draft} isLegacy={isLegacy} onChange={setDraft} />
        </ReferenceContextFields>
      )}
    </AssignmentSaveForm>
  );
};
