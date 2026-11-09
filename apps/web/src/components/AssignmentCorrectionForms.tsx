import React, { useState } from 'react';
import { AssignmentNoteFields } from './AssignmentNoteFields';
import { AssignmentSaveForm, type AssignmentSaveProps } from './AssignmentSaveForm';
import {
  REFERENCE_DIMENSIONS,
  ReferenceContextFields,
  entryLabel,
  fieldInputStyle,
  fieldLabelStyle,
  useReferenceLists,
  type ReferenceContextField,
  type ReferenceContextValues,
} from './ReferenceContextFields';
import { CORRECTION_LABELS, bangkokToday, effectiveDateError, type AssignmentDimension, type AssignmentEvent } from './assignmentFacts';

const correctionUrl = (save: AssignmentSaveProps, event: AssignmentEvent) => `/assets/${save.assetId}/assignments/${event.id}/corrections`;

const ReasonField: React.FC<{ label: string; reason: string; onChange: (reason: string) => void }> = ({ label, reason, onChange }) => (
  <div style={{ marginBottom: '0.75rem' }}>
    <label htmlFor="assignment-correction-reason" style={fieldLabelStyle}>
      {label}
    </label>
    <textarea
      id="assignment-correction-reason"
      value={reason}
      maxLength={2000}
      rows={2}
      onChange={(e) => onChange(e.target.value)}
      style={fieldInputStyle}
    />
  </div>
);

export interface AssignmentCorrectionFormProps {
  save: AssignmentSaveProps;
  event: AssignmentEvent;
  actorId: string | null;
}

/** "ยกเลิกรายการ (บันทึกผิด)": a fact that never happened. It stays in the timeline, struck through (MR-07). */
export const AssignmentVoidForm: React.FC<Omit<AssignmentCorrectionFormProps, 'actorId'>> = ({ save, event }) => {
  const [reason, setReason] = useState('');
  return (
    <AssignmentSaveForm
      {...save}
      heading={CORRECTION_LABELS.VOIDED}
      saveUrl={correctionUrl(save, event)}
      submitLabel="ยืนยันยกเลิกรายการ"
      cancelLabel="ไม่ยกเลิก"
      requestError={() => (reason.trim() === '' ? 'กรุณาระบุเหตุผลที่ยกเลิกรายการ' : null)}
      requestBody={() => ({ action: 'VOID', reason: reason.trim() })}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 0.5rem 0' }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
            รายการนี้จะยังอยู่ในประวัติแบบขีดฆ่า และจะไม่นับรวมในสถานที่ หน่วยงาน และผู้รับผิดชอบปัจจุบัน
          </p>
          <ReasonField label="เหตุผลที่ยกเลิก" reason={reason} onChange={setReason} />
        </fieldset>
      )}
    </AssignmentSaveForm>
  );
};

// The form's fields, named by dimension and side. Each holds text ('' is none, and a ticked box 'yes'),
// so that the fields the user changed can lie over the fact field by field (see amendmentOf).
type DraftField =
  | 'effective_date'
  | 'effective_date_unknown'
  | 'document_reference'
  | 'remark'
  | `${AssignmentDimension}.present`
  | `${AssignmentDimension}.${'prior' | 'new'}.${'entry' | 'legacy'}`;

type AmendmentDraft = Record<DraftField, string>;

const fieldsOf = (event: AssignmentEvent): AmendmentDraft => {
  const fields = {
    effective_date: event.effective_date ?? '',
    effective_date_unknown: event.effective_date === null ? 'yes' : '',
    document_reference: event.document_reference ?? '',
    remark: event.remark ?? '',
  } as AmendmentDraft;
  for (const { entryField } of REFERENCE_DIMENSIONS) {
    const change = event.changes.find(({ dimension }) => dimension === entryField);
    fields[`${entryField}.present`] = change ? 'yes' : '';
    for (const side of ['prior', 'new'] as const) {
      fields[`${entryField}.${side}.entry`] = change?.[side].entry?.id ?? '';
      fields[`${entryField}.${side}.legacy`] = change?.[side].legacy_text ?? '';
    }
  }
  return fields;
};

// One side of a dimension in the draft, as the API names it.
const draftValue = (draft: AmendmentDraft, entryField: AssignmentDimension, side: 'prior' | 'new') => ({
  entry_id: draft[`${entryField}.${side}.entry`] || null,
  legacy_text: draft[`${entryField}.${side}.legacy`].trim() || null,
});

// Whether the amended fact keeps a dimension: an Initial Assignment while it has a value, a
// Reassignment while its box stays ticked.
const keepsDimension = (event: AssignmentEvent, draft: AmendmentDraft, entryField: AssignmentDimension): boolean => {
  if (event.kind === 'INITIAL') {
    const value = draftValue(draft, entryField, 'new');
    return Boolean(value.entry_id || value.legacy_text);
  }
  return draft[`${entryField}.present`] !== '';
};

// What an amendment names: only the fields that differ from the fact as it stands, so that a read of
// the latest facts leaves a field the user did not touch at its latest value.
const amendmentOf = (event: AssignmentEvent, draft: AmendmentDraft): Record<string, unknown> => {
  const stored = fieldsOf(event);
  const differs = (field: DraftField) => draft[field].trim() !== stored[field];
  const amendment: Record<string, unknown> = {};
  if (differs('effective_date') || differs('effective_date_unknown')) {
    amendment.effective_date = draft.effective_date_unknown ? null : draft.effective_date;
  }
  for (const field of ['document_reference', 'remark'] as const) {
    if (differs(field)) {
      amendment[field] = draft[field].trim() || null;
    }
  }

  const changes: Record<string, unknown> = {};
  for (const { entryField } of REFERENCE_DIMENSIONS) {
    const sideDiffers = (side: 'prior' | 'new') => differs(`${entryField}.${side}.entry`) || differs(`${entryField}.${side}.legacy`);
    if (!keepsDimension(event, draft, entryField)) {
      if (stored[`${entryField}.present`]) {
        changes[entryField] = null;
      }
      continue;
    }
    const amended = {
      ...(event.kind !== 'INITIAL' && sideDiffers('prior') && { prior: draftValue(draft, entryField, 'prior') }),
      ...(sideDiffers('new') && { new: draftValue(draft, entryField, 'new') }),
    };
    if (Object.keys(amended).length > 0) {
      changes[entryField] = amended;
    }
  }
  if (Object.keys(changes).length > 0) {
    amendment.changes = changes;
  }
  return amendment;
};

/** "แก้ไขรายการที่บันทึกผิด": corrects any field of one fact, with a reason (MR-06). The server decides every rule. */
export const AssignmentAmendForm: React.FC<AssignmentCorrectionFormProps> = ({ save, event, actorId }) => {
  // The fields the user changed, over the fact as it stands (see amendmentOf).
  const [changedFields, setChangedFields] = useState<Partial<AmendmentDraft>>({});
  const [reason, setReason] = useState('');
  const { lists, error: listError } = useReferenceLists(true, actorId);

  const draft: AmendmentDraft = { ...fieldsOf(event), ...changedFields };
  const set = (field: DraftField, value: string) => setChangedFields((current) => ({ ...current, [field]: value }));
  const isInitial = event.kind === 'INITIAL';

  const requestError = (): string | null => {
    if (reason.trim() === '') {
      return 'กรุณาระบุเหตุผลที่แก้ไขรายการ';
    }
    if (!draft.effective_date_unknown) {
      const dateProblem = effectiveDateError(draft.effective_date, isInitial ? 'กรุณาระบุวันที่มีผล หรือเลือก “ไม่ทราบ”' : 'กรุณาระบุวันที่มีผล');
      if (dateProblem) {
        return dateProblem;
      }
    }
    const kept = REFERENCE_DIMENSIONS.filter(({ entryField }) => keepsDimension(event, draft, entryField));
    if (kept.length === 0) {
      return 'รายการต้องเหลือค่าอย่างน้อยหนึ่งรายการ หากรายการนี้ไม่เคยเกิดขึ้นจริงให้ใช้ “ยกเลิกรายการ (บันทึกผิด)”';
    }
    const unchanged = isInitial
      ? undefined
      : kept.find(({ entryField }) => {
          const prior = draftValue(draft, entryField, 'prior');
          const next = draftValue(draft, entryField, 'new');
          return prior.entry_id === next.entry_id && prior.legacy_text === next.legacy_text;
        });
    if (unchanged) {
      return `ค่าเดิมและค่าใหม่ของ${unchanged.label}เหมือนกัน ให้เอามิตินี้ออกจากรายการ หรือยกเลิกรายการ`;
    }
    return Object.keys(amendmentOf(event, draft)).length === 0 ? 'ยังไม่มีค่าที่แก้ไข' : null;
  };

  // ReferenceContextFields names entry and Legacy-text fields; the draft names dimensions.
  const initialAssignmentValues = Object.fromEntries(
    REFERENCE_DIMENSIONS.flatMap(({ idField, legacyField, entryField }) => [
      [idField, draft[`${entryField}.new.entry`]],
      [legacyField, draft[`${entryField}.new.legacy`]],
    ])
  ) as ReferenceContextValues;
  const setInitialAssignmentValue = (field: ReferenceContextField, value: string) => {
    const dimension = REFERENCE_DIMENSIONS.find(({ idField, legacyField }) => field === idField || field === legacyField)!;
    set(`${dimension.entryField}.new.${field === dimension.idField ? 'entry' : 'legacy'}`, value);
  };

  const entryOptions = (kind: (typeof REFERENCE_DIMENSIONS)[number]['kind']) =>
    lists[kind].map((entry) => (
      <option key={entry.id} value={entry.id}>
        {entryLabel(entry)}
      </option>
    ));

  return (
    <AssignmentSaveForm
      {...save}
      heading={CORRECTION_LABELS.AMENDED}
      saveUrl={correctionUrl(save, event)}
      requestError={requestError}
      requestBody={() => ({ action: 'AMEND', reason: reason.trim(), ...amendmentOf(event, draft) })}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 0.5rem 0' }}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="assignment-amend-effective_date" style={fieldLabelStyle}>
              วันที่มีผล
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input
                id="assignment-amend-effective_date"
                type="date"
                value={draft.effective_date_unknown ? '' : draft.effective_date}
                max={bangkokToday()}
                disabled={Boolean(draft.effective_date_unknown)}
                onChange={(e) => set('effective_date', e.target.value)}
                style={{ ...fieldInputStyle, width: 'auto' }}
              />
              {isInitial && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: '#374151' }}>
                  <input
                    id="assignment-amend-effective_date_unknown"
                    type="checkbox"
                    checked={Boolean(draft.effective_date_unknown)}
                    onChange={(e) => set('effective_date_unknown', e.target.checked ? 'yes' : '')}
                  />
                  ไม่ทราบ
                </label>
              )}
            </div>
          </div>

          {isInitial ? (
            <ReferenceContextFields
              idPrefix="assignment-amend"
              legend="ค่าที่กำหนดครั้งแรก"
              values={initialAssignmentValues}
              onChange={setInitialAssignmentValue}
              lists={lists}
              listError={listError}
              offerInactive
            />
          ) : (
            <>
              {listError && (
                <div role="alert" style={{ marginBottom: '0.75rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
                  {listError}
                </div>
              )}
              {REFERENCE_DIMENSIONS.filter(({ entryField }) => fieldsOf(event)[`${entryField}.present`] !== '').map(({ kind, entryField, label }) => (
                <div key={entryField} data-testid={`assignment-amend-${entryField}`} style={{ marginBottom: '0.75rem' }}>
                  <label style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <input
                      id={`assignment-amend-${entryField}-present`}
                      type="checkbox"
                      checked={keepsDimension(event, draft, entryField)}
                      onChange={(e) => set(`${entryField}.present`, e.target.checked ? 'yes' : '')}
                    />
                    {label}
                  </label>
                  {keepsDimension(event, draft, entryField) && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                      <div>
                        <label htmlFor={`assignment-amend-${entryField}-prior`} style={fieldLabelStyle}>
                          ค่าเดิม (จาก)
                        </label>
                        <select
                          id={`assignment-amend-${entryField}-prior`}
                          value={draft[`${entryField}.prior.entry`]}
                          onChange={(e) => set(`${entryField}.prior.entry`, e.target.value)}
                          style={fieldInputStyle}
                        >
                          <option value="">— ไม่ระบุ —</option>
                          {entryOptions(kind)}
                        </select>
                        <input
                          id={`assignment-amend-${entryField}-prior-legacy`}
                          aria-label={`ข้อความเดิมของค่าเดิม ${label}`}
                          type="text"
                          value={draft[`${entryField}.prior.legacy`]}
                          maxLength={500}
                          placeholder="ข้อความเดิม (เว้นว่างได้)"
                          onChange={(e) => set(`${entryField}.prior.legacy`, e.target.value)}
                          style={{ ...fieldInputStyle, marginTop: '0.375rem' }}
                        />
                      </div>
                      <div>
                        <label htmlFor={`assignment-amend-${entryField}-new`} style={fieldLabelStyle}>
                          ค่าใหม่ (ไป)
                        </label>
                        <select
                          id={`assignment-amend-${entryField}-new`}
                          value={draft[`${entryField}.new.entry`]}
                          onChange={(e) => set(`${entryField}.new.entry`, e.target.value)}
                          style={fieldInputStyle}
                        >
                          {/* #50 Q15: the Location is never emptied. */}
                          {entryField !== 'location' && <option value="">— ไม่ระบุ (ล้างค่า) —</option>}
                          {entryOptions(kind)}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          <AssignmentNoteFields
            idPrefix="assignment-amend"
            notes={{ documentReference: draft.document_reference, remark: draft.remark }}
            onChange={(notes) => {
              if (notes.documentReference !== draft.document_reference) {
                set('document_reference', notes.documentReference);
              }
              if (notes.remark !== draft.remark) {
                set('remark', notes.remark);
              }
            }}
          />
          <div style={{ marginTop: '0.75rem' }}>
            <ReasonField label="เหตุผลที่แก้ไข" reason={reason} onChange={setReason} />
          </div>
        </fieldset>
      )}
    </AssignmentSaveForm>
  );
};
