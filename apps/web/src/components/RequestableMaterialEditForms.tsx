import React, { useState } from 'react';
import { Link } from 'react-router';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { EDIT_DETAILS_LABEL, INACTIVE_LABEL, RENAME_LABEL, WHOLE_NUMBER_UNIT_LABEL } from './materialFacts';
import { useUnitList } from './materialQueries';
import { REQUESTED_ITEM_LABEL } from './materialRequestFacts';
import {
  ADD_REQUESTABLE_MATERIAL_LABEL,
  COMPATIBLE_STOCK_MATERIAL_LABEL,
  REQUEST_UNIT_LABEL,
  REQUESTABLE_MATERIAL_LABEL,
  type RequestableMaterialDetail,
  type RequestableMaterialNameTaken,
} from './requestableMaterialFacts';

export interface RequestableMaterialEditFormProps {
  requestable: RequestableMaterialDetail;
  // The session's CSRF token: the page offers the form only once it is in hand (#135).
  csrfToken: string;
  // Reads the Requestable Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

const STALE_MESSAGE = 'มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่';
const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };
const noticeStyle: React.CSSProperties = { fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' };

/**
 * "เปลี่ยนชื่อ" (F009-T8, #210): renames a Requestable Material to fix its spelling at the version the page read; a
 * different meaning needs a new Requestable Material (#202 Q6). Its history keeps the old name and the new (Q17).
 */
export const RequestableMaterialRenameForm: React.FC<RequestableMaterialEditFormProps> = ({ requestable, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [name, setName] = useState(requestable.name);

  // A name another Requestable Material holds names it, Inactive or not (Q6).
  const nameTaken = (body: RequestableMaterialNameTaken | null) =>
    body?.code === 'DUPLICATE_NAME' ? (
      <span data-testid="requestable-material-rename-name-taken">
        มี{REQUESTABLE_MATERIAL_LABEL}ชื่อนี้อยู่แล้ว:{' '}
        <Link to={`/requestable-materials/${body.entry.id}`} style={{ color: '#991b1b', fontWeight: 600 }}>
          {body.entry.name}
        </Link>
        {!body.entry.is_active && ` ซึ่งถูก${INACTIVE_LABEL}อยู่`}
      </span>
    ) : null;

  return (
    <LoanSaveForm
      idPrefix="requestable-material-rename"
      heading={RENAME_LABEL}
      saveUrl={`/requestable-materials/${encodeURIComponent(requestable.id)}/rename`}
      csrfToken={csrfToken}
      // The server compares the name as it stores it, trimmed (CODING_STANDARDS, an amend form).
      requestError={() => (name.trim() === '' ? 'กรุณากรอกชื่อใหม่' : name.trim() === requestable.name ? 'ชื่อใหม่ยังเหมือนชื่อเดิม' : null)}
      requestBody={() => ({ expected_version: requestable.version, name: name.trim() })}
      refusedList={nameTaken}
      forbiddenMessage={`คุณไม่มีสิทธิ์${RENAME_LABEL}${REQUESTABLE_MATERIAL_LABEL}`}
      refusedMessage={`ไม่สามารถ${RENAME_LABEL}${REQUESTABLE_MATERIAL_LABEL}ได้`}
      staleMessage={STALE_MESSAGE}
      submitLabel={RENAME_LABEL}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <p data-testid="requestable-material-rename-notice" style={noticeStyle}>
            {RENAME_LABEL}เพื่อแก้การสะกดเท่านั้น ถ้าความหมายเปลี่ยนเป็นวัสดุอื่น ให้{ADD_REQUESTABLE_MATERIAL_LABEL}ใหม่แทน ประวัติจะเก็บชื่อเดิมและชื่อใหม่ไว้
          </p>
          <div style={fieldStyle}>
            <label htmlFor="requestable-material-rename-name" style={fieldLabelStyle}>
              ชื่อใหม่
            </label>
            <input id="requestable-material-rename-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

/**
 * "แก้ไขข้อมูลอื่น" (F009-T8, #210): changes a Requestable Material's description and whole-number setting freely, and
 * its Request Unit while no Requested Item uses it and every current Compatible Stock Material has the new one (#202
 * Q17, P2), at the version the page read. Requested Quantities already recorded never change.
 */
export const RequestableMaterialDetailsForm: React.FC<RequestableMaterialEditFormProps> = ({ requestable, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [requestUnitId, setRequestUnitId] = useState(requestable.request_unit.unit_id);
  const [wholeNumberOnly, setWholeNumberOnly] = useState(requestable.whole_number_only);
  const [description, setDescription] = useState(requestable.description ?? '');

  const units = useUnitList();

  if (units.isError) {
    return (
      <div role="alert" id="requestable-material-details-error" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
        เกิดข้อผิดพลาดในการโหลดรายการหน่วยนับ
      </div>
    );
  }
  if (!units.data) {
    return (
      <div role="status" aria-busy="true" style={{ padding: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
        กำลังโหลด...
      </div>
    );
  }
  // A new Request Unit is an active Unit of the list; the one it has stays offered as itself, Inactive or not (Q15).
  const options = units.data.items.filter((unit) => unit.is_active || unit.id === requestable.request_unit.unit_id);

  return (
    <LoanSaveForm
      idPrefix="requestable-material-details"
      heading={EDIT_DETAILS_LABEL}
      saveUrl={`/requestable-materials/${encodeURIComponent(requestable.id)}/details`}
      method="PUT"
      csrfToken={csrfToken}
      // The server stores the description trimmed, blank as none, so the same text with other spaces around it is no change.
      requestError={() =>
        requestUnitId === requestable.request_unit.unit_id && wholeNumberOnly === requestable.whole_number_only && description.trim() === (requestable.description ?? '')
          ? 'ยังไม่มีข้อมูลที่เปลี่ยน'
          : null
      }
      requestBody={() => ({
        expected_version: requestable.version,
        description: description.trim() || null,
        whole_number_only: wholeNumberOnly,
        request_unit_id: requestUnitId,
      })}
      refusedList={() => null}
      forbiddenMessage={`คุณไม่มีสิทธิ์แก้ไขข้อมูล${REQUESTABLE_MATERIAL_LABEL}`}
      refusedMessage={`ไม่สามารถบันทึกข้อมูล${REQUESTABLE_MATERIAL_LABEL}ได้`}
      staleMessage={STALE_MESSAGE}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <div style={fieldStyle}>
            <label htmlFor="requestable-material-details-request-unit" style={fieldLabelStyle}>
              {REQUEST_UNIT_LABEL}
            </label>
            <select id="requestable-material-details-request-unit" value={requestUnitId} onChange={(e) => setRequestUnitId(e.target.value)} style={fieldInputStyle}>
              {options.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.is_active ? unit.name : `${unit.name} (${INACTIVE_LABEL})`}
                </option>
              ))}
            </select>
            <p data-testid="requestable-material-details-request-unit-notice" style={{ ...noticeStyle, margin: '0.25rem 0 0 0' }}>
              เปลี่ยน{REQUEST_UNIT_LABEL}ได้เฉพาะเมื่อยังไม่มี{REQUESTED_ITEM_LABEL}ใช้วัสดุนี้ และ{COMPATIBLE_STOCK_MATERIAL_LABEL}ทุกรายการมีหน่วยใหม่ที่ใช้งานอยู่
            </p>
          </div>
          <div style={fieldStyle}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#374151' }}>
              <input id="requestable-material-details-whole-number-only" type="checkbox" checked={wholeNumberOnly} onChange={(e) => setWholeNumberOnly(e.target.checked)} />
              {WHOLE_NUMBER_UNIT_LABEL}
            </label>
          </div>
          <div style={fieldStyle}>
            <label htmlFor="requestable-material-details-description" style={fieldLabelStyle}>
              รายละเอียด (ไม่บังคับ)
            </label>
            <textarea id="requestable-material-details-description" value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
