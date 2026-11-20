import React, { useState } from 'react';
import { ListEntrySelect } from './ListEntryFields';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { BRAND_LABEL, MATERIAL_CORRECTION_LABEL, MODEL_LABEL, SPECIFICATION_LABEL, STOCK_MATERIAL_LABEL, type StockMaterialDetail } from './materialFacts';
import { useBrandList } from './materialQueries';

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

export interface StockMaterialCorrectionFormProps {
  material: StockMaterialDetail;
  // The session's CSRF token: the page offers the form only once it is in hand (#135).
  csrfToken: string;
  // Reads the Stock Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

/**
 * "แก้ไขรายการที่บันทึกผิด" (F008-T5, #181): a Material Correction of the Stock Material's name, ยี่ห้อ, รุ่น and
 * คุณลักษณะ at the version the page read, with a reason (#175 MC-03, Q11, Q23). It warns that a really different model
 * or specification is a new Stock Material (MC-11, MC-18), and a save with Duplicate Candidates waits for
 * "เป็นคนละรายการ" (MC-17).
 */
export const StockMaterialCorrectionForm: React.FC<StockMaterialCorrectionFormProps> = ({ material, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [name, setName] = useState(material.name);
  const [brandId, setBrandId] = useState(material.brand?.id ?? '');
  const [model, setModel] = useState(material.model ?? '');
  const [specification, setSpecification] = useState(material.specification ?? '');
  const [reason, setReason] = useState('');

  const brands = useBrandList();

  if (brands.isError) {
    return (
      <div role="alert" id="stock-material-correction-error" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
        เกิดข้อผิดพลาดในการโหลดรายการ{BRAND_LABEL}
      </div>
    );
  }
  if (!brands.data) {
    return (
      <div role="status" aria-busy="true" style={{ padding: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
        กำลังโหลด...
      </div>
    );
  }

  // The server stores each text trimmed and a blank one as none, so the same text with other spaces around it is no
  // change.
  const changesNothing = () =>
    name.trim() === material.name &&
    brandId === (material.brand?.id ?? '') &&
    model.trim() === (material.model ?? '') &&
    specification.trim() === (material.specification ?? '');

  return (
    <LoanSaveForm
      idPrefix="stock-material-correction"
      heading={MATERIAL_CORRECTION_LABEL}
      saveUrl={`/stock-materials/${encodeURIComponent(material.id)}/corrections`}
      csrfToken={csrfToken}
      requestError={() => {
        if (name.trim() === '') {
          return 'กรุณากรอกชื่อวัสดุ';
        }
        if (changesNothing()) {
          return 'ยังไม่มีข้อมูลที่เปลี่ยน';
        }
        return reason.trim() === '' ? 'กรุณากรอกเหตุผลที่แก้ไข' : null;
      }}
      requestBody={() => ({
        expected_version: material.version,
        name: name.trim(),
        brand_id: brandId || null,
        model: model.trim() || null,
        specification: specification.trim() || null,
        reason: reason.trim(),
      })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขข้อมูลวัสดุ"
      refusedMessage="ไม่สามารถบันทึกการแก้ไขได้"
      staleMessage="มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่"
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <div
            data-testid="stock-material-correction-notice"
            style={{ padding: '0.75rem 1rem', marginBottom: '0.75rem', borderRadius: '6px', backgroundColor: '#fef3c7', color: '#92400e', fontSize: '0.875rem' }}
          >
            ใช้แก้ชื่อ {BRAND_LABEL} {MODEL_LABEL} หรือ{SPECIFICATION_LABEL}ที่บันทึกผิดของ{STOCK_MATERIAL_LABEL}รายการเดิมเท่านั้น
            ถ้าเป็น{MODEL_LABEL}หรือ{SPECIFICATION_LABEL}ที่ต่างกันจริง ให้เพิ่มเป็น{STOCK_MATERIAL_LABEL}รายการใหม่
          </div>
          <div style={fieldStyle}>
            <label htmlFor="stock-material-correction-name" style={fieldLabelStyle}>
              ชื่อวัสดุ
            </label>
            <input id="stock-material-correction-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
          </div>
          <ListEntrySelect id="stock-material-correction-brand" label={BRAND_LABEL} entries={brands.data.items} value={brandId} onChange={setBrandId} />
          <div style={fieldStyle}>
            <label htmlFor="stock-material-correction-model" style={fieldLabelStyle}>
              {MODEL_LABEL} (ไม่บังคับ)
            </label>
            <input id="stock-material-correction-model" type="text" value={model} maxLength={200} onChange={(e) => setModel(e.target.value)} style={fieldInputStyle} />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="stock-material-correction-specification" style={fieldLabelStyle}>
              {SPECIFICATION_LABEL} (ไม่บังคับ)
            </label>
            <textarea
              id="stock-material-correction-specification"
              value={specification}
              maxLength={500}
              rows={2}
              onChange={(e) => setSpecification(e.target.value)}
              style={fieldInputStyle}
            />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="stock-material-correction-reason" style={fieldLabelStyle}>
              เหตุผลที่แก้ไข
            </label>
            <textarea id="stock-material-correction-reason" value={reason} maxLength={2000} rows={2} onChange={(e) => setReason(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
