import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from './LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import { STOCK_MATERIAL_LABEL } from './materialFacts';
import {
  ADD_COMPATIBLE_STOCK_MATERIAL_LABEL,
  CURRENT_COMPATIBLE_STOCK_MATERIAL_LABEL,
  END_COMPATIBLE_STOCK_MATERIAL_LABEL,
  lacksRequestUnitLine,
  type CompatibleStockMaterial,
  type RequestableMaterialDetail,
  type StockMaterialChoices,
} from './requestableMaterialFacts';

// What both forms take from the Requestable Material page.
interface CompatibleStockMaterialFormProps {
  requestable: RequestableMaterialDetail;
  // The session's CSRF token: the page offers a form only once it is in hand (#135).
  csrfToken: string;
  // Reads the Requestable Material again and returns whether it could.
  onRefresh: () => Promise<boolean>;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked: (statusCode?: number) => void;
}

// How many Stock Materials the picker shows: a search narrows a longer list.
const CHOICES_LIMIT = 25;

const STALE_MESSAGE = 'มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่';

/**
 * "เพิ่มวัสดุที่ใช้จ่ายได้" (F009-T2, #204): a search of the active Stock Materials, each one whose active Units lack the
 * Request Unit greyed with "ไม่มีหน่วย <Request Unit>" and one already current marked "ใช้อยู่", then the add at the
 * version the page read (#202 Q7, Q8, Q19, ADR 0002). It suggests nothing (MRQ-26).
 */
export const CompatibleStockMaterialAddForm: React.FC<CompatibleStockMaterialFormProps> = ({ requestable, csrfToken, onRefresh, onSaved, onCancel, onPermissionRevoked }) => {
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const current = new Set(requestable.compatible_stock_materials.filter((entry) => entry.is_current).map((entry) => entry.stock_material_id));

  const choices = useQuery<StockMaterialChoices, Error & { status?: number }>({
    queryKey: ['stock-material-choices', requestable.id, search],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(CHOICES_LIMIT) });
      if (search !== '') {
        query.set('search', search);
      }
      const res = await fetch(`/requestable-materials/${encodeURIComponent(requestable.id)}/stock-material-choices?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  // The same search again reads again, as after a failed read.
  const runSearch = () => {
    setChosen(null);
    const text = searchText.trim();
    if (text === search) {
      void choices.refetch();
    } else {
      setSearch(text);
    }
  };

  return (
    <LoanSaveForm
      idPrefix="compatible-stock-material-add"
      heading={ADD_COMPATIBLE_STOCK_MATERIAL_LABEL}
      saveUrl={`/requestable-materials/${encodeURIComponent(requestable.id)}/compatible-stock-materials`}
      csrfToken={csrfToken}
      requestError={() => (chosen === null ? `กรุณาเลือก${STOCK_MATERIAL_LABEL}` : null)}
      requestBody={() => ({ stock_material_id: chosen, expected_version: requestable.version })}
      refusedList={() => null}
      forbiddenMessage={`คุณไม่มีสิทธิ์${ADD_COMPATIBLE_STOCK_MATERIAL_LABEL}`}
      refusedMessage={`ไม่สามารถ${ADD_COMPATIBLE_STOCK_MATERIAL_LABEL}ได้`}
      staleMessage={STALE_MESSAGE}
      submitLabel={ADD_COMPATIBLE_STOCK_MATERIAL_LABEL}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <label htmlFor="compatible-stock-material-search" style={fieldLabelStyle}>
            ค้นหา{STOCK_MATERIAL_LABEL}ที่ใช้งานอยู่
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <input
              id="compatible-stock-material-search"
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              // Enter searches; only the save button saves.
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runSearch();
                }
              }}
              style={{ ...fieldInputStyle, flex: 1 }}
            />
            <button type="button" id="compatible-stock-material-search-submit" onClick={runSearch} style={{ padding: '0.5rem 1rem', borderRadius: '4px', border: '1px solid #d1d5db', backgroundColor: '#ffffff', cursor: 'pointer' }}>
              ค้นหา
            </button>
          </div>

          {choices.isError && (
            <div role="alert" id="compatible-stock-material-choices-error" style={{ color: '#991b1b', fontSize: '0.875rem' }}>
              {`เกิดข้อผิดพลาดในการโหลดรายการ${STOCK_MATERIAL_LABEL}`}
            </div>
          )}
          {choices.isPending && (
            <div role="status" aria-busy="true" style={{ color: '#6b7280', fontSize: '0.875rem' }}>
              {`กำลังโหลดรายการ${STOCK_MATERIAL_LABEL}...`}
            </div>
          )}
          {choices.data && choices.data.items.length === 0 && (
            <div id="compatible-stock-material-choices-empty" style={{ color: '#6b7280', fontSize: '0.875rem' }}>
              {`ไม่พบ${STOCK_MATERIAL_LABEL}ที่ใช้งานอยู่ที่ค้นหา`}
            </div>
          )}
          {choices.data && choices.data.items.length > 0 && (
            <ul id="compatible-stock-material-choices" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {choices.data.items.map((choice) => {
                // Why it cannot be chosen, or null when it can: already current, or lacking the Request Unit.
                const reason = current.has(choice.id) ? CURRENT_COMPATIBLE_STOCK_MATERIAL_LABEL : choice.handles_request_unit ? null : lacksRequestUnitLine(requestable.request_unit.name);
                const selectable = reason === null;
                return (
                  <li key={choice.id} data-testid={`stock-material-choice-${choice.id}`} style={{ padding: '0.375rem 0', color: selectable ? '#111827' : '#9ca3af' }}>
                    <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', cursor: selectable ? 'pointer' : 'not-allowed' }}>
                      <input type="radio" name="compatible-stock-material-choice" value={choice.id} checked={chosen === choice.id} disabled={!selectable} onChange={() => setChosen(choice.id)} />
                      <span>
                        {choice.name}
                        {choice.brand && ` · ${choice.brand.name}`}
                        {choice.model && ` · ${choice.model}`}
                      </span>
                      {reason !== null && <span data-testid={`stock-material-choice-reason-${choice.id}`}>({reason})</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {choices.data?.has_more && (
            <p style={{ color: '#6b7280', fontSize: '0.8125rem', margin: '0.5rem 0 0 0' }}>{`แสดง ${CHOICES_LIMIT} รายการแรกจาก ${choices.data.total_count} รายการ ค้นหาให้แคบลงเพื่อดูรายการอื่น`}</p>
          )}
        </fieldset>
      )}
    </LoanSaveForm>
  );
};

/**
 * "เลิก" (F009-T2, #204): ends a current Compatible Stock Material at the version the page read; it stays listed as
 * "เลิกแล้ว" and can be added again (#202 MRQ-30, Q8, P1).
 */
export const CompatibleStockMaterialEndForm: React.FC<CompatibleStockMaterialFormProps & { compatible: CompatibleStockMaterial }> = ({
  requestable,
  compatible,
  csrfToken,
  onRefresh,
  onSaved,
  onCancel,
  onPermissionRevoked,
}) => (
  <LoanSaveForm
    idPrefix="compatible-stock-material-end"
    heading={`${END_COMPATIBLE_STOCK_MATERIAL_LABEL} ${compatible.name}`}
    saveUrl={`/requestable-materials/${encodeURIComponent(requestable.id)}/compatible-stock-materials/${encodeURIComponent(compatible.stock_material_id)}/end`}
    csrfToken={csrfToken}
    requestError={() => null}
    requestBody={() => ({ expected_version: requestable.version })}
    refusedList={() => null}
    forbiddenMessage={`คุณไม่มีสิทธิ์${END_COMPATIBLE_STOCK_MATERIAL_LABEL}${STOCK_MATERIAL_LABEL}นี้`}
    refusedMessage={`ไม่สามารถ${END_COMPATIBLE_STOCK_MATERIAL_LABEL}${STOCK_MATERIAL_LABEL}นี้ได้`}
    staleMessage={STALE_MESSAGE}
    submitLabel={END_COMPATIBLE_STOCK_MATERIAL_LABEL}
    onRefresh={onRefresh}
    onSaved={onSaved}
    onCancel={onCancel}
    onPermissionRevoked={onPermissionRevoked}
  >
    {() => (
      <p data-testid="compatible-stock-material-end-notice" style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
        รายการนี้จะยังแสดงเป็นเลิกแล้วพร้อมประวัติ และเพิ่มกลับได้ภายหลัง
      </p>
    )}
  </LoanSaveForm>
);
