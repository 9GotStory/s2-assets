import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { INACTIVE_LABEL, REACTIVATE_LABEL, type StockMaterialDetail } from './materialFacts';
import { useCsrfToken } from './materialQueries';

export interface StockMaterialStatusFormProps {
  material: StockMaterialDetail;
  // Reads the Stock Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

/**
 * "หยุดใช้" or "เปิดใช้อีกครั้ง" (F008-T7, #180): makes a Stock Material in use Inactive, with an optional หมายเหตุ, or
 * reactivates an Inactive one as the same record, at the version the page read (#175 MC-14, Q13, Q23). Nothing else
 * changes and nothing is deleted.
 */
export const StockMaterialStatusForm: React.FC<StockMaterialStatusFormProps> = ({ material, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [note, setNote] = useState('');

  const session = useCsrfToken(true);
  const csrfToken = session.data ?? null;

  if (session.isPending) {
    return (
      <div role="status" aria-busy="true" style={{ padding: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
        กำลังโหลด...
      </div>
    );
  }

  const inactivating = material.is_active;
  return (
    <LoanSaveForm
      idPrefix="stock-material-status"
      heading={inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}
      saveUrl={`/stock-materials/${encodeURIComponent(material.id)}/${inactivating ? 'inactivate' : 'reactivate'}`}
      csrfToken={csrfToken}
      requestError={() => null}
      // A reactivation takes no note (0025_material_catalog).
      requestBody={() => (inactivating ? { expected_version: material.version, note: note.trim() || null } : { expected_version: material.version })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์เปลี่ยนสถานะวัสดุ"
      refusedMessage="ไม่สามารถเปลี่ยนสถานะวัสดุได้"
      staleMessage="มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่"
      submitLabel={inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          {inactivating ? (
            <>
              <p data-testid="stock-material-status-notice" style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' }}>
                วัสดุที่หยุดใช้ยังอยู่ในระบบพร้อมประวัติ และเปิดใช้อีกครั้งได้ภายหลัง
              </p>
              <div style={{ marginBottom: '0.75rem' }}>
                <label htmlFor="stock-material-status-note" style={fieldLabelStyle}>
                  หมายเหตุ (ไม่บังคับ)
                </label>
                <textarea id="stock-material-status-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
              </div>
            </>
          ) : (
            <p data-testid="stock-material-status-notice" style={{ fontSize: '0.875rem', color: '#4b5563', margin: 0 }}>
              วัสดุนี้จะกลับมาใช้งานอยู่เป็นรายการเดิม พร้อมประวัติทั้งหมด
            </p>
          )}
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
