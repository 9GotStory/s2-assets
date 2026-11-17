import React from 'react';
import { AssignmentSaveForm, type AssignmentSaveProps } from './AssignmentSaveForm';
import { ReassignmentFields, useReassignmentDraft } from './ReassignmentFields';
import { REFERENCE_DIMENSIONS } from './ReferenceContextFields';
import { KIND_LABELS, effectiveDateError, thaiDate, valuesAt, type AssignmentEvent } from './assignmentFacts';
import type { OnLoan } from './loanFacts';
import type { UnderRepair } from './repairFacts';
import { VERIFICATION_DATE_LABEL } from './verificationFacts';

// The result with "Location ไม่ตรงทะเบียน" that "ย้าย" opens the form from, cited by the Reassignment (F006-T8, #125 Q13).
export interface ReassignmentSource {
  verificationRevisionId: string;
  roundName: string;
  verificationDate: string;
  observedLocationId: string;
}

// Why the server refused the result a Reassignment cites (F006-T8).
const CITED_REVISION_REFUSAL_LABELS: Record<string, string> = {
  NOT_VERIFICATION_REVISION: 'ไม่พบผลตรวจที่อ้างถึง',
  OTHER_ASSET: 'ผลตรวจนั้นเป็นของครุภัณฑ์อื่น',
  VOIDED: 'ผลตรวจนั้นยกเลิกแล้ว',
  NO_LOCATION_MISMATCH: 'ผลตรวจนั้นไม่มี Location ไม่ตรงทะเบียน',
};

const citedRevisionRefusal = (body: any): string | null =>
  body?.code === 'CITED_VERIFICATION_REVISION_REFUSED' ? `ย้ายจากผลตรวจนี้ไม่ได้ เพราะ${CITED_REVISION_REFUSAL_LABELS[body.verification_revision?.reason] ?? 'ผลตรวจนั้นอ้างถึงไม่ได้'}` : null;

export interface ReassignmentFormProps {
  save: AssignmentSaveProps;
  // Absent while the timeline cannot be read: the prior values are then not previewed.
  timeline?: AssignmentEvent[];
  actorId: string | null;
  // Who holds the Asset while it is On Loan (F004-T4).
  onLoan?: OnLoan | null;
  // The Repair Record that keeps the Asset Under Repair (F005-T4).
  underRepair?: UnderRepair | null;
  // The result "ย้าย" opens the form from: its Observed Location and Verification Date fill the form, which the user
  // may change, and the Reassignment cites it (F006-T8, #125 P2).
  source?: ReassignmentSource;
}

/**
 * "ย้าย / เปลี่ยนผู้รับผิดชอบ": one real change of an Asset's Permanent Assignment, effective today or
 * earlier. The server derives the prior values and decides every rule; this form previews them.
 */
export const ReassignmentForm: React.FC<ReassignmentFormProps> = ({ save, timeline, actorId, onLoan, underRepair, source }) => {
  const draft = useReassignmentDraft(actorId, source && { effectiveDate: source.verificationDate, locationId: source.observedLocationId });
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
      requestBody={() => ({ kind: 'REASSIGNMENT', ...requestFields, ...(source ? { verification_revision_id: source.verificationRevisionId } : {}) })}
      refusalMessage={citedRevisionRefusal}
    >
      {(isLocked) => (
        <>
          {source && (
            <p id="reassignment-verification-source" style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem', color: '#374151', overflowWrap: 'anywhere' }}>
              ที่มา: ผลตรวจประจำปี {source.roundName} พบที่สถานที่อื่น {VERIFICATION_DATE_LABEL}{' '}
              <time dateTime={source.verificationDate}>{thaiDate(source.verificationDate)}</time>
            </p>
          )}
          <ReassignmentFields
          draft={draft}
          isLocked={isLocked}
          priorValues={priorValues}
          onLoanAssets={onLoan ? [{ id: save.assetId, label: 'ครุภัณฑ์นี้', onLoan }] : []}
          underRepairAssets={underRepair ? [{ id: save.assetId, label: 'ครุภัณฑ์นี้', underRepair }] : []}
          />
        </>
      )}
    </AssignmentSaveForm>
  );
};
