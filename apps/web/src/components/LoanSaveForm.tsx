import React, { useRef, useState } from 'react';
import { ConflictWarning } from './LoanConflicts';
import type { WarnedLoanConflict } from './loanFacts';
import type { WarnedRepairConflict } from './repairFacts';

export interface LoanSaveFormProps {
  // Names this form's elements: `${idPrefix}-form`, `${idPrefix}-submit`, and so on.
  idPrefix: string;
  heading: string;
  saveUrl: string;
  csrfToken: string | null;
  // Why this request cannot be sent, or null when it can. The server decides again.
  requestError: () => string | null;
  requestBody: () => Record<string, unknown>;
  // What a refusal naming Assets or items shows, or null for any other refusal.
  refusedList: (body: any) => React.ReactNode;
  forbiddenMessage: string;
  refusedMessage: string;
  onSaved: () => Promise<void>;
  // Reads the latest facts and returns whether it could. A form on a Loan that exists passes this,
  // and a save refused as stale then offers it.
  onRefresh?: () => Promise<boolean>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
  children: (isLocked: boolean) => React.ReactNode;
}

// A failed save, and what the form offers next: the same request again when its outcome is unknown,
// or a read of the latest facts when the save was refused as stale.
interface SaveFailure {
  message: string;
  next?: 'retry' | 'reload';
}

type SaveRequest = Record<string, unknown> & { retry_token: string };

// The Loan Conflicts and Repair Conflicts a save would create, and the request they were found for.
interface PendingConflicts {
  request: SaveRequest;
  conflicts: WarnedLoanConflict[];
  repairConflicts: WarnedRepairConflict[];
}

// What a confirmation names: the other side of each conflict the warning listed (#74 Q20, #98 Q17).
const confirmedConflictsOf = ({ conflicts, repairConflicts }: PendingConflicts) => [
  ...conflicts.map(({ conflicting }) => ({ conflicting_loan_item_id: conflicting.loan_item_id })),
  ...repairConflicts.map(({ conflicting }) =>
    conflicting.kind === 'LOAN_ITEM' ? { conflicting_loan_item_id: conflicting.loan_item_id } : { conflicting_repair_record_id: conflicting.repair_record_id }
  ),
];

const recoveryButtonStyle: React.CSSProperties = {
  marginLeft: '1rem',
  padding: '0.375rem 0.75rem',
  backgroundColor: '#991b1b',
  color: '#ffffff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 600,
  fontSize: '0.8125rem',
  whiteSpace: 'nowrap',
};

/**
 * The form around one Loan write: its heading, save and cancel, and what happens to a save. A retry
 * after an unknown outcome resends the same request under the same token, so one action records one
 * fact. A stale save is refused until the latest facts are read. A save that would create Loan Conflicts
 * or Repair Conflicts waits for confirmation, with the fields locked so that what is confirmed is the
 * request warned about, under the same retry token (#74 Q20, #98 Q17).
 */
export const LoanSaveForm: React.FC<LoanSaveFormProps> = ({
  idPrefix,
  heading,
  saveUrl,
  csrfToken,
  requestError,
  requestBody,
  refusedList,
  forbiddenMessage,
  refusedMessage,
  onSaved,
  onRefresh,
  onCancel,
  onPermissionRevoked,
  children,
}) => {
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [refused, setRefused] = useState<React.ReactNode>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conflictWarning, setConflictWarning] = useState<PendingConflicts | null>(null);
  // The request whose outcome is unknown.
  const uncertainRef = useRef<SaveRequest | null>(null);

  const isLocked = isSubmitting || failure?.next === 'retry' || conflictWarning !== null;

  const send = async (request: SaveRequest) => {
    setIsSubmitting(true);
    setFailure(null);
    setRefused(null);
    setConflictWarning(null);
    uncertainRef.current = request;

    let res: Response;
    try {
      res = await fetch(saveUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-retry-token': request.retry_token,
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify(request),
      });
    } catch {
      setIsSubmitting(false);
      setFailure({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', next: 'retry' });
      return;
    }

    if (res.ok) {
      uncertainRef.current = null;
      await onSaved();
      return;
    }

    setIsSubmitting(false);
    if (res.status === 401 || res.status === 403) {
      uncertainRef.current = null;
      setFailure({ message: res.status === 401 ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' : forbiddenMessage });
      onPermissionRevoked?.(res.status);
      return;
    }
    if (res.status === 400 || res.status === 404 || res.status === 409) {
      uncertainRef.current = null;
      const body = await res.json().catch(() => null);
      if (body?.code === 'LOAN_CONFLICTS_FOUND' || body?.code === 'REPAIR_CONFLICTS_FOUND') {
        setConflictWarning({ request, conflicts: body.conflicts ?? [], repairConflicts: body.repair_conflicts ?? [] });
        return;
      }
      if (body?.code === 'STALE_BEFORE_CONFLICT' && onRefresh) {
        setFailure({ message: 'มีการบันทึกรายการอื่นของการยืมนี้หลังจากเปิดฟอร์ม กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง', next: 'reload' });
        return;
      }
      const list = refusedList(body);
      if (list) {
        setRefused(list);
        return;
      }
      setFailure({ message: body?.message || refusedMessage });
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
    void send({ ...requestBody(), retry_token: crypto.randomUUID() });
  };

  const handleReload = async () => {
    if (await onRefresh?.()) {
      setFailure(null);
      return;
    }
    setFailure({ message: 'ไม่สามารถดึงข้อมูลล่าสุดได้ กรุณาลองใหม่อีกครั้ง', next: 'reload' });
  };

  return (
    <form
      id={`${idPrefix}-form`}
      noValidate
      onSubmit={handleSubmit}
      style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '1rem', marginBottom: '1rem' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, color: '#111827' }}>{heading}</h3>

      {failure && (
        <div
          role="alert"
          data-testid={`${idPrefix}-form-error`}
          style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.875rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>{failure.message}</span>
          {failure.next === 'retry' && (
            <button
              type="button"
              id={`${idPrefix}-retry`}
              disabled={isSubmitting}
              onClick={() => {
                if (uncertainRef.current) {
                  void send(uncertainRef.current);
                }
              }}
              style={recoveryButtonStyle}
            >
              ส่งซ้ำ
            </button>
          )}
          {failure.next === 'reload' && (
            <button type="button" id={`${idPrefix}-reload`} disabled={isSubmitting} onClick={() => void handleReload()} style={recoveryButtonStyle}>
              โหลดข้อมูลล่าสุด
            </button>
          )}
        </div>
      )}

      {refused && (
        <div role="alert" data-testid={`${idPrefix}-refused`} style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.875rem' }}>
          {refused}
        </div>
      )}

      {conflictWarning && (
        <ConflictWarning
          conflicts={conflictWarning.conflicts}
          repairConflicts={conflictWarning.repairConflicts}
          // The refused warning stored nothing, so the same token carries the confirmed request.
          onConfirm={() => void send({ ...conflictWarning.request, confirmed_conflicts: confirmedConflictsOf(conflictWarning) })}
          onBack={() => setConflictWarning(null)}
        />
      )}

      {children(isLocked)}

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          type="submit"
          id={`${idPrefix}-submit`}
          disabled={isLocked}
          style={{ padding: '0.5rem 1.25rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: isLocked ? 'not-allowed' : 'pointer' }}
        >
          {isSubmitting ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
        <button
          type="button"
          id={`${idPrefix}-cancel`}
          onClick={onCancel}
          disabled={isLocked}
          style={{ padding: '0.5rem 1rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem', cursor: isLocked ? 'not-allowed' : 'pointer' }}
        >
          ยกเลิก
        </button>
      </div>
    </form>
  );
};
