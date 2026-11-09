import React, { useRef, useState } from 'react';
import { AssignmentConflictWarning } from './AssignmentConflictWarning';
import type { AssignmentConflict } from './assignmentFacts';

// What saving an assignment fact needs from the Asset page.
export interface AssignmentSaveProps {
  assetId: string;
  assignmentVersion: number;
  csrfToken: string | null;
  onRecorded: () => Promise<void>;
  // Reads the latest facts and returns their assignment version, or null when the read failed.
  onRefresh: () => Promise<number | null>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

export interface AssignmentSaveFormProps extends AssignmentSaveProps {
  heading: string;
  saveUrl: string;
  submitLabel?: string;
  cancelLabel?: string;
  // Why this request cannot be sent, or null when it can. The server decides again.
  requestError: () => string | null;
  requestBody: () => Record<string, unknown>;
  children: (isLocked: boolean) => React.ReactNode;
}

// A failed save, and what the form offers next: the same request again when its outcome is unknown,
// or a read of the latest facts when the save was refused as stale.
interface SaveFailure {
  message: string;
  next?: 'retry' | 'reload';
}

type SaveRequest = Record<string, unknown> & { retry_token: string };

// The conflicts a save would create, and the request they were found for.
interface ConflictWarning {
  request: SaveRequest;
  conflicts: AssignmentConflict[];
}

const recoveryButtonStyle = (isSubmitting: boolean): React.CSSProperties => ({
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
});

/**
 * The form around one assignment fact: its heading, save and cancel, and what happens to a save.
 * A retry after an unknown outcome resends the same request under the same token, so one action
 * records one event (US 28). A stale save is refused until the latest facts are read (US 27). A save
 * that would create Assignment Conflicts waits for confirmation, with the fields locked so that what
 * is confirmed is the request warned about (US 29, 37).
 */
export const AssignmentSaveForm: React.FC<AssignmentSaveFormProps> = ({
  assignmentVersion,
  csrfToken,
  onRecorded,
  onRefresh,
  onCancel,
  onPermissionRevoked,
  heading,
  saveUrl,
  submitLabel = 'บันทึก',
  cancelLabel = 'ยกเลิก',
  requestError,
  requestBody,
  children,
}) => {
  // The version this form was opened against: a later read never rebases it silently (US 27).
  const [expectedVersion, setExpectedVersion] = useState(assignmentVersion);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conflictWarning, setConflictWarning] = useState<ConflictWarning | null>(null);
  // The request whose outcome is unknown.
  const uncertainRef = useRef<SaveRequest | null>(null);

  const isLocked = isSubmitting || failure?.next === 'retry' || conflictWarning !== null;

  const send = async (request: SaveRequest) => {
    setIsSubmitting(true);
    setFailure(null);
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
      if (body?.code === 'ASSIGNMENT_CONFLICTS_FOUND') {
        setConflictWarning({ request, conflicts: body.conflicts });
        return;
      }
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
    void send({ expected_assignment_version: expectedVersion, ...requestBody(), retry_token: crypto.randomUUID() });
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

  return (
    <form
      id="assignment-form"
      noValidate
      onSubmit={handleSubmit}
      style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '1rem', marginBottom: '1rem' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
        {heading}
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
          {failure.next === 'retry' && (
            <button
              type="button"
              id="assignment-retry"
              disabled={isSubmitting}
              style={recoveryButtonStyle(isSubmitting)}
              onClick={() => {
                if (uncertainRef.current) {
                  void send(uncertainRef.current);
                }
              }}
            >
              ส่งซ้ำ
            </button>
          )}
          {failure.next === 'reload' && (
            <button
              type="button"
              id="assignment-reload"
              disabled={isSubmitting}
              style={recoveryButtonStyle(isSubmitting)}
              onClick={() => void handleReload()}
            >
              โหลดข้อมูลล่าสุด
            </button>
          )}
        </div>
      )}

      {conflictWarning && (
        <AssignmentConflictWarning
          conflicts={conflictWarning.conflicts}
          // The same request keeps its expected version, which ties the confirmation to the timeline warned about.
          onConfirm={() => void send({ ...conflictWarning.request, explicit_continuation: true })}
          onBack={() => setConflictWarning(null)}
        />
      )}

      {children(isLocked)}

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
          {isSubmitting ? 'กำลังบันทึก...' : submitLabel}
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
          {cancelLabel}
        </button>
      </div>
    </form>
  );
};
