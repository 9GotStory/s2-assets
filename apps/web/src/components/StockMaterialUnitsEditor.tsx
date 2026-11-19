import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { UnitSetFields, alternateRequestOf, unitSetError, unitSetOf, type UnitSetValue } from './UnitSetFields';
import { EDIT_UNITS_LABEL, type StockMaterialDetail } from './materialFacts';
import { useCsrfToken, useUnitList } from './materialQueries';

export interface StockMaterialUnitsEditorProps {
  material: StockMaterialDetail;
  // Reads the Stock Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

/**
 * "แก้ไขหน่วยนับ" (F008-T3, #178): one save replaces the Stock Material's whole Unit set at the version the page read
 * (#175 P2, Q23). A Unit it already has is never removed, only made Inactive; changing the Base Unit clears every
 * อัตราแปลง and keeps the old Base Unit as an Alternate Unit, to get a factor or be made Inactive.
 */
export const StockMaterialUnitsEditor: React.FC<StockMaterialUnitsEditorProps> = ({ material, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [unitSet, setUnitSet] = useState<UnitSetValue>(() => unitSetOf(material.units));
  const [kept] = useState<ReadonlySet<string>>(() => new Set(material.units.map(({ unit_id }) => unit_id)));

  const units = useUnitList();
  const session = useCsrfToken(true);

  if (units.isError) {
    return (
      <div role="alert" id="stock-material-units-editor-error" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
        เกิดข้อผิดพลาดในการโหลดรายการหน่วยนับ
      </div>
    );
  }
  if (!units.data || session.isPending) {
    return (
      <div role="status" aria-busy="true" style={{ padding: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
        กำลังโหลด...
      </div>
    );
  }
  const unitList = units.data.items;

  return (
    <LoanSaveForm
      idPrefix="stock-material-units"
      heading={EDIT_UNITS_LABEL}
      saveUrl={`/stock-materials/${encodeURIComponent(material.id)}/units`}
      method="PUT"
      csrfToken={session.data ?? null}
      requestError={() => unitSetError(unitSet, unitList)}
      requestBody={() => ({
        expected_version: material.version,
        base_unit: { unit_id: unitSet.base_unit_id, whole_number_only: unitSet.base_whole_number_only },
        alternate_units: unitSet.alternates.map(alternateRequestOf),
      })}
      refusedList={() => null}
      forbiddenMessage="คุณไม่มีสิทธิ์แก้ไขหน่วยนับของวัสดุ"
      refusedMessage="ไม่สามารถบันทึกหน่วยนับได้"
      staleMessage="มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่"
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <UnitSetFields idPrefix="stock-material-units" value={unitSet} onChange={setUnitSet} units={unitList} kept={kept} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
