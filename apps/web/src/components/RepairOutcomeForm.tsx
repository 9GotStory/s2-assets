import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from './LoanSaveForm';
import { REFERENCE_DIMENSIONS, fieldInputStyle, fieldLabelStyle, type PermanentAssignment } from './ReferenceContextFields';
import { RepairOutcomeFields, emptyRepairOutcomeDraft, repairOutcomeDraftError, repairOutcomePayload, type RepairOutcomeDraft } from './RepairOutcomeFields';
import { valueText } from './assignmentFacts';
import { RECORD_REPAIR_OUTCOME_LABEL, costError, type RepairOutcomeRefusal, type RepairRecord } from './repairFacts';

export interface RepairOutcomeFormProps {
  record: RepairRecord;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest Repair Record and returns its version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const REFUSAL_LABELS: Record<RepairOutcomeRefusal['reason'], string> = {
  VOIDED: 'รายการนี้ถูกยกเลิกแล้ว',
  HAS_OUTCOME: 'รายการนี้บันทึกผลการซ่อมแล้ว',
};

/**
 * "บันทึกผลการซ่อม" (F005-T2): how the repair or maintenance ended, and the record's one cost, shown as
 * recorded for the Custodian to keep or change (#98 Q22). It shows where the Asset goes back to on the
 * Outcome Date, as the server derives it, and stores none of it (MR-16, MR-17). The server decides again
 * everything this form checks.
 */
export const RepairOutcomeForm: React.FC<RepairOutcomeFormProps> = ({ record, csrfToken, onRecorded, onRefresh, onCancel, onPermissionRevoked }) => {
  // The version this form was opened against: a later read never rebases it silently.
  const [expectedVersion, setExpectedVersion] = useState(record.version);
  const [draft, setDraft] = useState<RepairOutcomeDraft>(emptyRepairOutcomeDraft);
  const [cost, setCost] = useState(record.cost ?? '');

  // No placeholder: values read for another date must not show under this one.
  const assignmentOnOutcomeDate = useQuery<PermanentAssignment | undefined, Error & { status?: number }>({
    queryKey: ['repair-outcome-assignment', record.id, draft.outcomeDate],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/repairs/${record.id}?outcome_date=${draft.outcomeDate}`, { credentials: 'include', signal });
      if (!res.ok) {
        // A lost session or grant fails closed: the page re-verifies and hides protected facts.
        if (res.status === 401 || res.status === 403) {
          onPermissionRevoked?.(res.status);
        }
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()).assignment_on_outcome_date;
    },
    enabled: draft.outcomeDate !== '',
  });

  const requestError = (): string | null => {
    return costError(cost) ?? repairOutcomeDraftError(draft, record.start_date);
  };

  const requestBody = () => ({
    expected_version: expectedVersion,
    ...repairOutcomePayload(draft),
    cost: cost.trim() || null,
  });

  const assignment = assignmentOnOutcomeDate.data;

  return (
    <LoanSaveForm
      idPrefix="repair-outcome"
      heading={RECORD_REPAIR_OUTCOME_LABEL}
      saveUrl={`/repairs/${record.id}/outcome`}
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => (body?.code === 'REPAIR_OUTCOME_REFUSED' ? <>ไม่ได้บันทึกผลการซ่อม เพราะ{REFUSAL_LABELS[(body.record as RepairOutcomeRefusal).reason]}</> : null)}
      forbiddenMessage="คุณไม่มีสิทธิ์บันทึกผลการซ่อม"
      refusedMessage="ไม่สามารถบันทึกผลการซ่อมได้"
      onSaved={onRecorded}
      onRefresh={async () => {
        const latest = await onRefresh();
        if (latest === null) {
          return false;
        }
        setExpectedVersion(latest);
        return true;
      }}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
          <RepairOutcomeFields idPrefix="repair-outcome" repairKind={record.repair_kind} startDate={record.start_date} draft={draft} onChange={setDraft}>
            {assignmentOnOutcomeDate.isError && assignmentOnOutcomeDate.error?.status !== 401 && assignmentOnOutcomeDate.error?.status !== 403 && (
              <div role="alert" data-testid="repair-outcome-assignment-error" style={{ marginBottom: '0.75rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
                ไม่สามารถโหลดข้อมูลสถานที่ หน่วยงาน และผู้รับผิดชอบ ณ วันที่ได้ผลได้
              </div>
            )}
            {assignment && (
              <dl data-testid="repair-outcome-assignment" style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#6b7280' }}>
                {REFERENCE_DIMENSIONS.map(({ entryField, legacyField, label }) => (
                  <div key={entryField} style={{ display: 'flex', gap: '0.375rem' }}>
                    <dt>{label}:</dt>
                    <dd style={{ margin: 0 }}>{valueText({ entry: assignment[entryField], legacy_text: assignment[legacyField] })}</dd>
                  </div>
                ))}
              </dl>
            )}
          </RepairOutcomeFields>

          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="repair-outcome-cost" style={fieldLabelStyle}>
              ค่าใช้จ่าย (บาท, ไม่บังคับ)
            </label>
            <input id="repair-outcome-cost" type="text" inputMode="decimal" value={cost} maxLength={13} onChange={(e) => setCost(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
