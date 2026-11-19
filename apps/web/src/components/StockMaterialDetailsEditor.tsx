import React, { useState } from 'react';
import { ListEntryAddField, ListEntrySelect } from './ListEntryFields';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { ADD_MATERIAL_CATEGORY_LABEL, EDIT_DETAILS_LABEL, MATERIAL_CATEGORY_LABEL, type StockMaterialDetail } from './materialFacts';
import { useCsrfToken, useMaterialCategoryList } from './materialQueries';

export interface StockMaterialDetailsEditorProps {
  material: StockMaterialDetail;
  // Reads the Stock Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

/**
 * "แก้ไขข้อมูลอื่น" (F008-T4, #179): changes the Stock Material's หมวดวัสดุ and หมายเหตุ at the version the page read,
 * without a reason (#175 Q11, Q23). Its name, ยี่ห้อ, รุ่น and คุณลักษณะ change only through a Material Correction.
 */
export const StockMaterialDetailsEditor: React.FC<StockMaterialDetailsEditorProps> = ({ material, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [materialCategoryId, setMaterialCategoryId] = useState(material.material_category?.id ?? '');
  const [note, setNote] = useState(material.note ?? '');

  const materialCategories = useMaterialCategoryList();
  const session = useCsrfToken(true);
  const csrfToken = session.data ?? null;

  if (materialCategories.isError) {
    return (
      <div role="alert" id="stock-material-details-editor-error" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
        เกิดข้อผิดพลาดในการโหลดรายการ{MATERIAL_CATEGORY_LABEL}
      </div>
    );
  }
  if (!materialCategories.data || session.isPending) {
    return (
      <div role="status" aria-busy="true" style={{ padding: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
        กำลังโหลด...
      </div>
    );
  }

  return (
    <LoanSaveForm
      idPrefix="stock-material-details"
      heading={EDIT_DETAILS_LABEL}
      saveUrl={`/stock-materials/${encodeURIComponent(material.id)}/details`}
      method="PUT"
      csrfToken={csrfToken}
      // The server stores the note trimmed, blank as none, so the same text with other spaces around it is no change.
      requestError={() =>
        materialCategoryId === (material.material_category?.id ?? '') && note.trim() === (material.note ?? '') ? 'ยังไม่มีข้อมูลที่เปลี่ยน' : null
      }
      requestBody={() => ({ expected_version: material.version, material_category_id: materialCategoryId || null, note: note.trim() || null })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขข้อมูลวัสดุ"
      refusedMessage="ไม่สามารถบันทึกข้อมูลวัสดุได้"
      staleMessage="มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่"
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <ListEntrySelect
            id="stock-material-details-material-category"
            label={MATERIAL_CATEGORY_LABEL}
            entries={materialCategories.data.items}
            value={materialCategoryId}
            onChange={setMaterialCategoryId}
          >
            <ListEntryAddField
              id="stock-material-details-new-material-category"
              path="/material-categories"
              concept={MATERIAL_CATEGORY_LABEL}
              addLabel={ADD_MATERIAL_CATEGORY_LABEL}
              placeholder="ชื่อหมวดวัสดุใหม่"
              csrfToken={csrfToken}
              disabled={isLocked || csrfToken === null}
              onAdded={async (category) => {
                await materialCategories.refetch();
                setMaterialCategoryId(category.id);
              }}
            />
          </ListEntrySelect>
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="stock-material-details-note" style={fieldLabelStyle}>
              หมายเหตุ (ไม่บังคับ)
            </label>
            <textarea id="stock-material-details-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
          </div>
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
