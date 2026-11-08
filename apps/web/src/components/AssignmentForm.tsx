import React, { useEffect, useRef, useState } from 'react';
import {
  EMPTY_REFERENCE_CONTEXT,
  REFERENCE_DIMENSIONS,
  ReferenceContextFields,
  entryLabel,
  fieldInputStyle,
  fieldLabelStyle,
  hasReferenceValues,
  useReferenceLists,
  type ReferenceContextValues,
} from './ReferenceContextFields';
import {
  EMPTY_INITIAL_ASSIGNMENT,
  InitialAssignmentFields,
  bangkokToday,
  effectiveDateOf,
  initialAssignmentError,
  initialAssignmentPayload,
  type EffectiveDateChoice,
  type InitialAssignmentDraft,
} from './InitialAssignmentFields';
import { NO_VALUE, valueText, valuesAt, type AssignmentEvent } from './assignmentFacts';

// A Reassignment target that clears the dimension, beside no change ('') and an entry id.
const CLEAR = '__clear__';

const CLEARABLE = new Set<string>(['organization_unit', 'responsible_person']);

// A failed save, and what the form offers next: the same request again when its outcome is unknown,
// or a read of the latest facts when the save was refused as stale.
interface SaveFailure {
  message: string;
  next?: 'retry' | 'reload';
}

type AssignmentPayload = Record<string, unknown> & { retry_token: string };

// What a Reassignment names: a dimension left at no change stays out, and null clears (#50 Q15).
const reassignmentTargets = (values: ReferenceContextValues): Record<string, string | null> =>
  Object.fromEntries(
    REFERENCE_DIMENSIONS.filter(({ idField }) => values[idField] !== '').map(({ idField }) => [
      idField,
      values[idField] === CLEAR ? null : values[idField],
    ])
  );

export interface AssignmentFormProps {
  assetId: string;
  kind: AssignmentEvent['kind'];
  isLegacy: boolean;
  assignmentVersion: number;
  // Absent while the timeline cannot be read: the prior values are then not previewed.
  timeline?: AssignmentEvent[];
  actorId: string | null;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest facts and returns their assignment version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

/**
 * Records an Initial Assignment ("กำหนดครั้งแรก") or a Reassignment ("ย้าย / เปลี่ยนผู้รับผิดชอบ")
 * for one Asset. The server derives the prior values and decides every rule; this form previews them.
 */
export const AssignmentForm: React.FC<AssignmentFormProps> = ({
  assetId,
  kind,
  isLegacy,
  assignmentVersion,
  timeline,
  actorId,
  csrfToken,
  onRecorded,
  onRefresh,
  onCancel,
  onPermissionRevoked,
}) => {
  // The version this form was opened against: a later read never rebases it silently (US 27).
  const [expectedVersion, setExpectedVersion] = useState(assignmentVersion);
  const [values, setValues] = useState<ReferenceContextValues>(EMPTY_REFERENCE_CONTEXT);
  const [draft, setDraft] = useState<InitialAssignmentDraft>(EMPTY_INITIAL_ASSIGNMENT);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The request whose outcome is unknown, resent as it is under the same retry token.
  const uncertainRef = useRef<AssignmentPayload | null>(null);

  const { lists, error: listError } = useReferenceLists(true, actorId);

  const today = bangkokToday();
  const effectiveDate: EffectiveDateChoice =
    kind === 'INITIAL' ? effectiveDateOf(draft, isLegacy) : (draft.effectiveDate ?? { date: today, unknown: false });
  // #50 Q16: deactivated entries are for facts dated before today, or of unknown date.
  const offerInactive = effectiveDate.unknown || (effectiveDate.date !== '' && effectiveDate.date < today);
  const priorValues = timeline && effectiveDate.date !== '' ? valuesAt(timeline, effectiveDate.date) : null;

  // A deactivated entry already chosen leaves the selection once it is no longer offered.
  useEffect(() => {
    if (offerInactive) {
      return;
    }
    setValues((current) => {
      const next = { ...current };
      for (const { kind: list, idField } of REFERENCE_DIMENSIONS) {
        if (lists[list].some((entry) => entry.id === current[idField] && !entry.is_active)) {
          next[idField] = '';
        }
      }
      return next;
    });
  }, [offerInactive, lists]);

  const isLocked = isSubmitting || failure?.next === 'retry';

  // Why this request cannot be sent, or null when it can. The server decides again.
  const requestError = (): string | null => {
    if (kind === 'INITIAL') {
      return hasReferenceValues(values)
        ? initialAssignmentError(values, draft, isLegacy)
        : 'กรุณาระบุสถานที่ หน่วยงาน หรือผู้รับผิดชอบอย่างน้อยหนึ่งรายการ';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate.date)) {
      return 'กรุณาระบุวันที่มีผล';
    }
    if (effectiveDate.date > today) {
      return 'วันที่มีผลต้องไม่เกินวันนี้';
    }
    const targets = reassignmentTargets(values);
    if (Object.keys(targets).length === 0) {
      return 'กรุณาเลือกค่าใหม่อย่างน้อยหนึ่งรายการ';
    }
    const changesSomething =
      !priorValues ||
      REFERENCE_DIMENSIONS.some(({ idField, entryField }) => {
        const prior = priorValues[entryField];
        return idField in targets && (targets[idField] !== (prior.entry?.id ?? null) || prior.legacy_text !== null);
      });
    return changesSomething ? null : 'ค่าที่เลือกตรงกับค่า ณ วันที่มีผลอยู่แล้ว จึงไม่มีการเปลี่ยนแปลง';
  };

  const requestBody = (): Record<string, unknown> =>
    kind === 'INITIAL'
      ? initialAssignmentPayload(values, draft, isLegacy)
      : {
          effective_date: effectiveDate.date,
          ...reassignmentTargets(values),
          document_reference: draft.documentReference.trim() || null,
          remark: draft.remark.trim() || null,
        };

  const send = async (payload: AssignmentPayload) => {
    setIsSubmitting(true);
    setFailure(null);
    uncertainRef.current = payload;

    let res: Response;
    try {
      res = await fetch(`/assets/${assetId}/assignments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-retry-token': payload.retry_token,
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
    } catch {
      setIsSubmitting(false);
      setFailure({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', next: 'retry' });
      return;
    }

    if (res.ok) {
      uncertainRef.current = null;
      await onRecorded();
      return;
    }

    setIsSubmitting(false);
    if (res.status === 401 || res.status === 403) {
      uncertainRef.current = null;
      setFailure({ message: res.status === 401 ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' : 'คุณไม่มีสิทธิ์บันทึกรายการนี้' });
      onPermissionRevoked?.(res.status);
      return;
    }
    if (res.status === 400 || res.status === 404 || res.status === 409) {
      uncertainRef.current = null;
      const body = await res.json().catch(() => null);
      setFailure(
        body?.code === 'STALE_BEFORE_CONFLICT'
          ? { message: 'มีการบันทึกรายการอื่นของครุภัณฑ์นี้หลังจากเปิดฟอร์ม กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง', next: 'reload' }
          : { message: body?.message || 'ไม่สามารถบันทึกรายการได้' }
      );
      return;
    }
    // A server failure leaves the outcome unknown, so the same request stays ready to resend.
    setFailure({ message: 'เกิดข้อผิดพลาดในการบันทึก กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', next: 'retry' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = requestError();
    if (problem) {
      setFailure({ message: problem });
      return;
    }
    void send({
      kind,
      expected_assignment_version: expectedVersion,
      ...requestBody(),
      retry_token: crypto.randomUUID(),
    });
  };

  const handleReload = async () => {
    const latest = await onRefresh();
    if (latest === null) {
      setFailure({ message: 'ไม่สามารถดึงข้อมูลล่าสุดได้ กรุณาลองใหม่อีกครั้ง', next: 'reload' });
      return;
    }
    setExpectedVersion(latest);
    setFailure(null);
  };

  const recoveryButton = (id: string, label: string, onClick: () => void) => (
    <button
      type="button"
      id={id}
      onClick={onClick}
      disabled={isSubmitting}
      style={{
        marginLeft: '1rem',
        padding: '0.375rem 0.75rem',
        backgroundColor: '#991b1b',
        color: '#ffffff',
        border: 'none',
        borderRadius: '4px',
        cursor: isSubmitting ? 'not-allowed' : 'pointer',
        fontWeight: 600,
        fontSize: '0.8125rem',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  return (
    <form
      id="assignment-form"
      noValidate
      onSubmit={handleSubmit}
      style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '1rem', marginBottom: '1rem' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
        {kind === 'INITIAL' ? 'กำหนดครั้งแรก' : 'ย้าย / เปลี่ยนผู้รับผิดชอบ'}
      </h3>

      {failure && (
        <div
          role="alert"
          data-testid="assignment-form-error"
          style={{
            padding: '0.75rem 1rem',
            backgroundColor: '#fee2e2',
            color: '#991b1b',
            borderRadius: '6px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{failure.message}</span>
          {failure.next === 'retry' &&
            recoveryButton('assignment-retry', 'ส่งซ้ำ', () => {
              if (uncertainRef.current) {
                void send(uncertainRef.current);
              }
            })}
          {failure.next === 'reload' && recoveryButton('assignment-reload', 'โหลดข้อมูลล่าสุด', () => void handleReload())}
        </div>
      )}

      {kind === 'INITIAL' ? (
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
      ) : (
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
              value={effectiveDate.date}
              max={today}
              onChange={(e) => setDraft({ ...draft, effectiveDate: { date: e.target.value, unknown: false } })}
              style={{ ...fieldInputStyle, width: 'auto' }}
            />
          </div>
          {REFERENCE_DIMENSIONS.map(({ kind: list, idField, entryField, label }) => (
            <div key={idField} style={{ marginBottom: '0.75rem' }}>
              <label htmlFor={`assignment-${idField}`} style={fieldLabelStyle}>
                {label}
              </label>
              <div id={`assignment-prior-${entryField}`} style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>
                ค่า ณ วันที่มีผล: {priorValues ? valueText(priorValues[entryField] ?? NO_VALUE) : '—'}
              </div>
              <select
                id={`assignment-${idField}`}
                value={values[idField]}
                onChange={(e) => setValues((current) => ({ ...current, [idField]: e.target.value }))}
                style={fieldInputStyle}
              >
                <option value="">— ไม่เปลี่ยน —</option>
                {CLEARABLE.has(entryField) && <option value={CLEAR}>ล้างค่า (ไม่ระบุ)</option>}
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label htmlFor="assignment-document_reference" style={fieldLabelStyle}>
                เอกสารอ้างอิง (ไม่บังคับ)
              </label>
              <input
                id="assignment-document_reference"
                type="text"
                value={draft.documentReference}
                maxLength={500}
                onChange={(e) => setDraft({ ...draft, documentReference: e.target.value })}
                placeholder="เช่น เลขที่บันทึกข้อความ"
                style={fieldInputStyle}
              />
            </div>
            <div>
              <label htmlFor="assignment-remark" style={fieldLabelStyle}>
                หมายเหตุ (ไม่บังคับ)
              </label>
              <textarea
                id="assignment-remark"
                value={draft.remark}
                maxLength={2000}
                rows={2}
                onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
                style={fieldInputStyle}
              />
            </div>
          </div>
        </fieldset>
      )}

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          type="submit"
          id="assignment-submit"
          disabled={isLocked}
          style={{
            padding: '0.5rem 1.25rem',
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: isLocked ? 'not-allowed' : 'pointer',
          }}
        >
          {isSubmitting ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
        <button
          type="button"
          id="assignment-cancel"
          onClick={onCancel}
          disabled={isLocked}
          style={{
            padding: '0.5rem 1rem',
            backgroundColor: '#f3f4f6',
            color: '#374151',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '0.875rem',
            cursor: isLocked ? 'not-allowed' : 'pointer',
          }}
        >
          ยกเลิก
        </button>
      </div>
    </form>
  );
};
