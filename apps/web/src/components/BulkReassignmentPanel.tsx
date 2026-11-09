import React, { useRef, useState } from 'react';
import { Link } from 'react-router';
import { AssignmentConflictWarning } from './AssignmentConflictWarning';
import { ReassignmentFields, useReassignmentDraft } from './ReassignmentFields';
import {
  BULK_REASSIGNMENT_LABEL,
  dimensionLabel,
  effectiveDateError,
  valueText,
  type AssignmentChange,
  type AssignmentConflict,
} from './assignmentFacts';

// #50 Q4: as many as the server takes in one Bulk Reassignment.
export const BULK_REASSIGNMENT_MAX_ASSETS = 100;

// A row chosen in the asset list.
export interface BulkSelectedAsset {
  id: string;
  name: string | null;
  asset_number: string | null;
}

// What the batch would do, at the assignment versions it was read at.
interface BulkReassignmentPreview {
  changed: { asset_id: string; assignment_version: number; changes: Pick<AssignmentChange, 'dimension' | 'prior' | 'new'>[] }[];
  unchanged: { asset_id: string; assignment_version: number }[];
  conflicts: AssignmentConflict[];
}

interface BulkReassignmentResult {
  bulk_reference: string;
  changed: { asset_id: string }[];
  unchanged: { asset_id: string }[];
}

type Stage = { name: 'FORM' } | { name: 'PREVIEW'; preview: BulkReassignmentPreview } | { name: 'DONE'; result: BulkReassignmentResult };

// A refused or failed request, and what the panel offers next: the same save again when its outcome
// is unknown, or a new preview of the latest facts when the batch was refused as stale.
interface Failure {
  message: string;
  next?: 'retry' | 'reload';
  // The Assets that need "กำหนดครั้งแรก" first.
  needingInitial?: { asset_id: string; name: string | null; asset_number: string | null }[];
}

type SaveRequest = Record<string, unknown> & { retry_token: string };

const buttonStyle = (isPrimary: boolean, isDisabled: boolean): React.CSSProperties => ({
  padding: '0.5rem 1.25rem',
  backgroundColor: isPrimary ? '#2563eb' : '#f3f4f6',
  color: isPrimary ? '#ffffff' : '#374151',
  border: isPrimary ? 'none' : '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: isDisabled ? 'not-allowed' : 'pointer',
});

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

export const assetLabelOf = ({ name, asset_number }: { name: string | null; asset_number: string | null }, id: string): string =>
  name || asset_number || id;

export interface BulkReassignmentBarProps {
  selectedCount: number;
  isPanelOpen: boolean;
  onOpen: () => void;
  onClear: () => void;
}

/** Above the asset list: how many rows are selected, and "ย้ายหลายรายการ". */
export const BulkReassignmentBar: React.FC<BulkReassignmentBarProps> = ({ selectedCount, isPanelOpen, onOpen, onClear }) => {
  const cannotOpen = selectedCount === 0 || isPanelOpen;
  return (
    <div
      id="bulk-reassign-bar"
      style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.875rem', color: '#374151' }}
    >
      <span id="bulk-reassign-count">
        เลือกแล้ว {selectedCount} รายการ (ไม่เกิน {BULK_REASSIGNMENT_MAX_ASSETS})
      </span>
      <button
        type="button"
        id="bulk-reassign-open"
        disabled={cannotOpen}
        onClick={onOpen}
        style={{
          padding: '0.375rem 0.75rem',
          backgroundColor: cannotOpen ? '#9ca3af' : '#2563eb',
          color: '#ffffff',
          border: 'none',
          borderRadius: '4px',
          fontSize: '0.875rem',
          fontWeight: 500,
          cursor: cannotOpen ? 'not-allowed' : 'pointer',
        }}
      >
        {BULK_REASSIGNMENT_LABEL}
      </button>
      {selectedCount > 0 && !isPanelOpen && (
        <button
          type="button"
          id="bulk-reassign-clear"
          onClick={onClear}
          style={{
            padding: '0.375rem 0.75rem',
            backgroundColor: '#ffffff',
            color: '#4b5563',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          ล้างการเลือก
        </button>
      )}
    </div>
  );
};

export interface BulkReassignmentPanelProps {
  selected: BulkSelectedAsset[];
  actorId: string | null;
  csrfToken: string | null;
  // Leaves the panel with the selection as it is.
  onCancel: () => void;
  // Leaves the panel after a save, which reads the list again.
  onFinished: () => void;
  onPermissionRevoked: () => void;
}

/**
 * F003-T5 (#55), "ย้ายหลายรายการ": one Effective Date and the same new values for the selected Assets,
 * then a preview of what each would become, then one confirmation. The server derives the prior
 * values and decides every rule, and the save expects the versions the preview read (US 27). A retry
 * after an unknown outcome resends the same request under the same token, so one action records one batch.
 */
export const BulkReassignmentPanel: React.FC<BulkReassignmentPanelProps> = ({
  selected,
  actorId,
  csrfToken,
  onCancel,
  onFinished,
  onPermissionRevoked,
}) => {
  const draft = useReassignmentDraft(actorId);
  const [stage, setStage] = useState<Stage>({ name: 'FORM' });
  const [isBusy, setIsBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The save whose outcome is unknown.
  const uncertainRef = useRef<SaveRequest | null>(null);

  const assetById = new Map(selected.map((asset) => [asset.id, asset]));
  const assetLabel = (assetId: string): string => {
    const asset = assetById.get(assetId);
    return asset ? assetLabelOf(asset, assetId) : assetId;
  };

  const post = (url: string, body: Record<string, unknown>, retryToken?: string): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(retryToken ? { 'x-retry-token': retryToken } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });

  // What a refused request tells the user, or null for a failure that leaves the outcome unknown.
  const refusalOf = async (res: Response): Promise<Failure | null> => {
    if (res.status === 401 || res.status === 403) {
      onPermissionRevoked();
      return { message: res.status === 401 ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' : 'คุณไม่มีสิทธิ์บันทึกรายการนี้' };
    }
    if (res.status !== 400 && res.status !== 404 && res.status !== 409) {
      return null;
    }
    const body = await res.json().catch(() => null);
    if (body?.code === 'STALE_BEFORE_CONFLICT') {
      return { message: 'มีการบันทึกรายการอื่นของครุภัณฑ์ที่เลือกไว้หลังจากตรวจสอบ กรุณาโหลดข้อมูลล่าสุดแล้วตรวจสอบอีกครั้ง', next: 'reload' };
    }
    if (body?.code === 'INITIAL_ASSIGNMENT_REQUIRED') {
      return { message: 'ครุภัณฑ์ต่อไปนี้ยังไม่มีการกำหนดครั้งแรก จึงยังไม่ได้บันทึกรายการใด กรุณา "กำหนดครั้งแรก" จากหน้าครุภัณฑ์ก่อน', needingInitial: body.assets };
    }
    return { message: body?.message || 'ไม่สามารถดำเนินการได้' };
  };

  const runPreview = async () => {
    setIsBusy(true);
    setFailure(null);
    try {
      const res = await post('/assets/bulk-reassignments/preview', { asset_ids: selected.map(({ id }) => id), ...draft.requestFields });
      if (res.ok) {
        setStage({ name: 'PREVIEW', preview: await res.json() });
      } else {
        setFailure((await refusalOf(res)) ?? { message: 'เกิดข้อผิดพลาดในการตรวจสอบรายการ กรุณาลองใหม่อีกครั้ง' });
      }
    } catch {
      setFailure({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setIsBusy(false);
    }
  };

  const handlePreview = () => {
    const problem =
      effectiveDateError(draft.effectiveDate, 'กรุณาระบุวันที่มีผล') ??
      (Object.keys(draft.requested).length === 0 ? 'กรุณาเลือกค่าใหม่อย่างน้อยหนึ่งรายการ' : null);
    if (problem) {
      setFailure({ message: problem });
      return;
    }
    void runPreview();
  };

  const save = async (request: SaveRequest) => {
    setIsBusy(true);
    setFailure(null);
    uncertainRef.current = request;
    let res: Response;
    try {
      res = await post('/assets/bulk-reassignments', request, request.retry_token);
    } catch {
      setIsBusy(false);
      setFailure({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', next: 'retry' });
      return;
    }
    if (res.ok) {
      uncertainRef.current = null;
      setStage({ name: 'DONE', result: await res.json() });
      setIsBusy(false);
      return;
    }
    setIsBusy(false);
    const refusal = await refusalOf(res);
    if (refusal) {
      uncertainRef.current = null;
      setFailure(refusal);
      return;
    }
    // A server failure leaves the outcome unknown, so the same request stays ready to resend.
    setFailure({ message: 'เกิดข้อผิดพลาดในการบันทึก กดส่งซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย', next: 'retry' });
  };

  const handleConfirm = ({ changed, unchanged, conflicts }: BulkReassignmentPreview) =>
    void save({
      // The versions the preview read tie this confirmation to the facts it showed.
      assets: [...changed, ...unchanged].map(({ asset_id, assignment_version }) => ({ asset_id, expected_assignment_version: assignment_version })),
      ...draft.requestFields,
      ...(conflicts.length > 0 ? { explicit_continuation: true } : {}),
      retry_token: crypto.randomUUID(),
    });

  const backToForm = () => {
    setFailure(null);
    setStage({ name: 'FORM' });
  };

  const isSaveUncertain = failure?.next === 'retry';

  return (
    <section
      id="bulk-reassign-panel"
      aria-label={BULK_REASSIGNMENT_LABEL}
      style={{ border: '1px solid #bfdbfe', borderRadius: '6px', padding: '1rem', marginBottom: '1.5rem', backgroundColor: '#ffffff' }}
    >
      <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.125rem', fontWeight: 600, color: '#111827' }}>
        {BULK_REASSIGNMENT_LABEL} ({selected.length} รายการ)
      </h2>

      {failure && (
        <div
          role="alert"
          data-testid="bulk-reassign-error"
          style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.875rem' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{failure.message}</span>
            {failure.next === 'retry' && (
              <button
                type="button"
                id="bulk-reassign-retry"
                disabled={isBusy}
                style={recoveryButtonStyle}
                onClick={() => {
                  if (uncertainRef.current) {
                    void save(uncertainRef.current);
                  }
                }}
              >
                ส่งซ้ำ
              </button>
            )}
            {failure.next === 'reload' && (
              <button type="button" id="bulk-reassign-reload" disabled={isBusy} style={recoveryButtonStyle} onClick={() => void runPreview()}>
                โหลดข้อมูลล่าสุด
              </button>
            )}
          </div>
          {failure.needingInitial && (
            <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.25rem' }}>
              {failure.needingInitial.map((asset) => (
                <li key={asset.asset_id}>
                  <Link to={`/assets/${asset.asset_id}`}>{assetLabelOf(asset, asset.asset_id)}</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {stage.name === 'FORM' && (
        <>
          <ReassignmentFields draft={draft} isLocked={isBusy} />
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" id="bulk-reassign-preview" disabled={isBusy} onClick={handlePreview} style={buttonStyle(true, isBusy)}>
              {isBusy ? 'กำลังตรวจสอบ...' : 'ตรวจสอบก่อนบันทึก'}
            </button>
            <button type="button" id="bulk-reassign-cancel" disabled={isBusy} onClick={onCancel} style={buttonStyle(false, isBusy)}>
              ยกเลิก
            </button>
          </div>
        </>
      )}

      {stage.name === 'PREVIEW' && (
        <>
          {stage.preview.changed.length > 0 && (
            <>
              <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9375rem', fontWeight: 600, color: '#111827' }}>
                จะบันทึกการเปลี่ยนแปลง {stage.preview.changed.length} รายการ
              </h3>
              <ul style={{ margin: '0 0 1rem 0', paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
                {stage.preview.changed.map(({ asset_id, changes }) => (
                  <li key={asset_id} data-testid={`bulk-preview-changed-${asset_id}`}>
                    <div style={{ fontWeight: 600, color: '#111827' }}>{assetLabel(asset_id)}</div>
                    {changes.map((change) => (
                      <div key={change.dimension}>
                        {dimensionLabel(change.dimension)}: {valueText(change.prior)} → {valueText(change.new)}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}

          {stage.preview.unchanged.length > 0 && (
            <>
              <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9375rem', fontWeight: 600, color: '#111827' }}>
                ไม่มีการเปลี่ยนแปลง {stage.preview.unchanged.length} รายการ (มีค่าตรงกับค่าใหม่อยู่แล้ว)
              </h3>
              <ul style={{ margin: '0 0 1rem 0', paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
                {stage.preview.unchanged.map(({ asset_id }) => (
                  <li key={asset_id} data-testid={`bulk-preview-unchanged-${asset_id}`}>
                    {assetLabel(asset_id)}
                  </li>
                ))}
              </ul>
            </>
          )}

          {stage.preview.changed.length === 0 && (
            <p id="bulk-reassign-nothing" style={{ fontSize: '0.875rem', color: '#374151' }}>
              ทุกรายการมีค่าตรงกับค่าใหม่อยู่แล้ว จึงไม่มีสิ่งที่ต้องบันทึก
            </p>
          )}

          {stage.preview.conflicts.length > 0 && !isBusy && !isSaveUncertain ? (
            <AssignmentConflictWarning
              conflicts={stage.preview.conflicts}
              assetLabel={assetLabel}
              onConfirm={() => handleConfirm(stage.preview)}
              onBack={backToForm}
            />
          ) : (
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              {stage.preview.changed.length > 0 && (
                <button
                  type="button"
                  id="bulk-reassign-confirm"
                  disabled={isBusy || isSaveUncertain}
                  onClick={() => handleConfirm(stage.preview)}
                  style={buttonStyle(true, isBusy || isSaveUncertain)}
                >
                  {isBusy ? 'กำลังบันทึก...' : 'ยืนยันบันทึก'}
                </button>
              )}
              <button type="button" id="bulk-reassign-back" disabled={isBusy || isSaveUncertain} onClick={backToForm} style={buttonStyle(false, isBusy || isSaveUncertain)}>
                กลับไปแก้ไข
              </button>
            </div>
          )}
        </>
      )}

      {stage.name === 'DONE' && (
        <div id="bulk-reassign-done" style={{ fontSize: '0.875rem', color: '#374151' }}>
          <p style={{ marginTop: 0 }}>
            บันทึกแล้ว {stage.result.changed.length} รายการ · ไม่มีการเปลี่ยนแปลง {stage.result.unchanged.length} รายการ · ชุด{' '}
            {stage.result.bulk_reference.slice(0, 8)}
          </p>
          <ul style={{ margin: '0 0 1rem 0', paddingLeft: '1.25rem' }}>
            {stage.result.changed.map(({ asset_id }) => (
              <li key={asset_id}>
                <Link to={`/assets/${asset_id}`} data-testid={`bulk-done-link-${asset_id}`}>
                  {assetLabel(asset_id)}
                </Link>
              </li>
            ))}
          </ul>
          <button type="button" id="bulk-reassign-finish" onClick={onFinished} style={buttonStyle(true, false)}>
            ปิด
          </button>
        </div>
      )}
    </section>
  );
};
