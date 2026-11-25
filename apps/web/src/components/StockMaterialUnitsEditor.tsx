import React, { useState } from 'react';
import { LoanSaveForm } from './LoanSaveForm';
import { MinimumStockField } from './MinimumStockField';
import { UnitSetFields, alternateRequestOf, unitNameOf, unitSetError, unitSetOf, type UnitSetValue } from './UnitSetFields';
import { BASE_UNIT_LABEL, EDIT_UNITS_LABEL, MINIMUM_STOCK_LABEL, STOCK_MATERIAL_LABEL, minimumStockLine, type StockMaterialDetail } from './materialFacts';
import { useUnitList } from './materialQueries';
import { STOCK_MOVEMENT_LABEL } from './openingBalanceFacts';

// F010-T5 (#236): why a Stock Material with a Stock Movement keeps its Base Unit (#231 Q15; start decision 2, comment
// 7157351764).
const BASE_UNIT_LOCKED_REASON = `เปลี่ยน${BASE_UNIT_LABEL}ไม่ได้ เพราะ${STOCK_MATERIAL_LABEL}นี้มี${STOCK_MOVEMENT_LABEL}แล้ว`;

export interface StockMaterialUnitsEditorProps {
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
 * "แก้ไขหน่วยนับ" (F008-T3, #178): one save replaces the Stock Material's whole Unit set at the version the page read
 * (#175 P2, Q23). A Unit it already has is never removed, only made Inactive; changing the Base Unit clears every
 * อัตราแปลง and keeps the old Base Unit as an Alternate Unit, to get a factor or be made Inactive. F008-T6 (#182
 * decision 2): it also asks for the จำนวนขั้นต่ำ again in the new Base Unit, blank for none, when there is one.
 * F010-T5 (#236): once the Stock Material has a Stock Movement, its หน่วยนับหลัก is shown locked, with the reason; the
 * Alternate Units still change (MC-09, MC-21).
 */
export const StockMaterialUnitsEditor: React.FC<StockMaterialUnitsEditorProps> = ({ material, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [unitSet, setUnitSet] = useState<UnitSetValue>(() => unitSetOf(material.units));
  const [kept] = useState<ReadonlySet<string>>(() => new Set(material.units.map(({ unit_id }) => unit_id)));
  const [minimumStock, setMinimumStock] = useState('');

  const units = useUnitList();

  if (units.isError) {
    return (
      <div role="alert" id="stock-material-units-editor-error" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
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
  const unitList = units.data.items;
  const oldBase = material.units.find((unit) => unit.is_base);
  // Another Base Unit takes a Minimum Stock again, so that 10 รีม never becomes 10 กล่อง.
  const asksMinimumStock = material.minimum_stock !== null && unitSet.base_unit_id !== oldBase?.unit_id;

  return (
    <LoanSaveForm
      idPrefix="stock-material-units"
      heading={EDIT_UNITS_LABEL}
      saveUrl={`/stock-materials/${encodeURIComponent(material.id)}/units`}
      method="PUT"
      csrfToken={csrfToken}
      requestError={() => unitSetError(unitSet, unitList)}
      requestBody={() => ({
        expected_version: material.version,
        base_unit: { unit_id: unitSet.base_unit_id, whole_number_only: unitSet.base_whole_number_only },
        alternate_units: unitSet.alternates.map(alternateRequestOf),
        ...(asksMinimumStock ? { minimum_stock: minimumStock.trim() || null } : {}),
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
          <UnitSetFields
            idPrefix="stock-material-units"
            value={unitSet}
            onChange={setUnitSet}
            units={unitList}
            kept={kept}
            baseUnitLocked={material.has_stock_movement ? BASE_UNIT_LOCKED_REASON : undefined}
          />
          {asksMinimumStock && (
            <MinimumStockField
              id="stock-material-units-minimum-stock"
              value={minimumStock}
              onChange={setMinimumStock}
              baseName={unitNameOf(unitList, unitSet.base_unit_id)}
              hint={`${MINIMUM_STOCK_LABEL}เดิม ${minimumStockLine(material.minimum_stock, oldBase?.name ?? '')}: กรอกใหม่ในหน่วยนับหลักใหม่ หรือเว้นว่างเพื่อไม่ตั้ง`}
            />
          )}
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
