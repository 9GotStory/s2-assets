import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ListEntryAddField, ListEntrySelect } from '../components/ListEntryFields';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { MinimumStockField } from '../components/MinimumStockField';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import { UnitSetFields, alternateRequestOf, emptyUnitSet, newAlternateRow, unitNameOf, unitSetError, withBaseUnit, type UnitSetValue } from '../components/UnitSetFields';
import { useBrandList, useCsrfToken, useMaterialCategoryList, useUnitList } from '../components/materialQueries';
import {
  ADD_BRAND_LABEL,
  ADD_MATERIAL_CATEGORY_LABEL,
  ADD_STOCK_MATERIAL_LABEL,
  ADD_UNIT_LABEL,
  BRAND_LABEL,
  MATERIAL_CATEGORY_LABEL,
  MODEL_LABEL,
  SPECIFICATION_LABEL,
  STOCK_MATERIAL_LABEL,
  UNIT_LABEL,
} from '../components/materialFacts';

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

const StockMaterialCreateContent: React.FC = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [specification, setSpecification] = useState('');
  const [note, setNote] = useState('');
  const [brandId, setBrandId] = useState('');
  const [materialCategoryId, setMaterialCategoryId] = useState('');
  const [unitSet, setUnitSet] = useState<UnitSetValue>(emptyUnitSet);
  const [minimumStock, setMinimumStock] = useState('');

  const units = useUnitList();
  const brands = useBrandList();
  const materialCategories = useMaterialCategoryList();
  const canManage = units.data?.can_manage === true && !units.isError;
  const session = useCsrfToken(canManage);
  // The form waits for the token: a request sent without it is refused as if the grant were gone.
  const csrfToken = session.data ?? null;

  const isSignedOut = units.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  const unitList = units.data?.items ?? [];

  const requestError = (): string | null => {
    if (name.trim() === '') {
      return 'กรุณากรอกชื่อวัสดุ';
    }
    return unitSetError(unitSet, unitList);
  };

  // Every Alternate Unit of a new Stock Material is active.
  const requestBody = () => ({
    name: name.trim(),
    model: model.trim() || null,
    specification: specification.trim() || null,
    note: note.trim() || null,
    brand_id: brandId || null,
    material_category_id: materialCategoryId || null,
    base_unit: { unit_id: unitSet.base_unit_id, whole_number_only: unitSet.base_whole_number_only },
    alternate_units: unitSet.alternates.map((row) => {
      const { is_active: _active, ...alternate } = alternateRequestOf(row);
      return alternate;
    }),
    minimum_stock: minimumStock.trim() || null,
  });

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/stock-materials" id="back-stock-material-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่รายการ{STOCK_MATERIAL_LABEL}
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{ADD_STOCK_MATERIAL_LABEL}</h1>

        {units.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด...
          </div>
        )}
        {canManage && (brands.isError || materialCategories.isError) && (
          <div role="alert" id="stock-material-lists-error" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            เกิดข้อผิดพลาดในการโหลดรายการ{BRAND_LABEL}หรือ{MATERIAL_CATEGORY_LABEL}
          </div>
        )}
        {(units.isError && !isSignedOut) || (units.data && !canManage) ? (
          <div role="alert" id="stock-material-create-forbidden" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {units.error?.status && units.error.status !== 403 ? 'เกิดข้อผิดพลาดในการโหลดรายการหน่วยนับ' : 'คุณไม่มีสิทธิ์เพิ่มวัสดุ'}
          </div>
        ) : null}

        {canManage && (
          <LoanSaveForm
            idPrefix="stock-material"
            heading="ข้อมูลวัสดุ"
            saveUrl="/stock-materials"
            csrfToken={csrfToken}
            requestError={requestError}
            requestBody={requestBody}
            refusedList={() => null}
            forbiddenMessage="คุณไม่มีสิทธิ์เพิ่มวัสดุ"
            refusedMessage="ไม่สามารถเพิ่มวัสดุได้"
            onSaved={async (body) => {
              navigate(`/stock-materials/${body.stock_material_id}`);
            }}
            onCancel={() => navigate('/stock-materials')}
            onPermissionRevoked={(status) => {
              if (status === 401) {
                navigate('/login', { replace: true });
                return;
              }
              void units.refetch();
            }}
          >
            {(isLocked) => (
              <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-name" style={fieldLabelStyle}>
                    ชื่อวัสดุ
                  </label>
                  <input id="stock-material-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
                </div>
                <ListEntrySelect id="stock-material-brand" label={BRAND_LABEL} entries={brands.data?.items ?? []} value={brandId} onChange={setBrandId}>
                  <ListEntryAddField
                    id="stock-material-new-brand"
                    path="/brands"
                    concept={BRAND_LABEL}
                    addLabel={ADD_BRAND_LABEL}
                    placeholder="ชื่อยี่ห้อใหม่"
                    csrfToken={csrfToken}
                    disabled={isLocked || csrfToken === null}
                    onAdded={async (brand) => {
                      await brands.refetch();
                      setBrandId(brand.id);
                    }}
                  />
                </ListEntrySelect>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-model" style={fieldLabelStyle}>
                    {MODEL_LABEL} (ไม่บังคับ)
                  </label>
                  <input id="stock-material-model" type="text" value={model} maxLength={200} onChange={(e) => setModel(e.target.value)} style={fieldInputStyle} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-specification" style={fieldLabelStyle}>
                    {SPECIFICATION_LABEL} เช่น ขนาด สี เกรด (ไม่บังคับ)
                  </label>
                  <textarea id="stock-material-specification" value={specification} maxLength={500} rows={2} onChange={(e) => setSpecification(e.target.value)} style={fieldInputStyle} />
                </div>
                <ListEntrySelect
                  id="stock-material-material-category"
                  label={MATERIAL_CATEGORY_LABEL}
                  entries={materialCategories.data?.items ?? []}
                  value={materialCategoryId}
                  onChange={setMaterialCategoryId}
                >
                  <ListEntryAddField
                    id="stock-material-new-material-category"
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
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-note" style={fieldLabelStyle}>
                    หมายเหตุ (ไม่บังคับ)
                  </label>
                  <textarea id="stock-material-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
                </div>
                <UnitSetFields
                  idPrefix="stock-material"
                  value={unitSet}
                  onChange={setUnitSet}
                  units={unitList}
                  kept={null}
                  unitAdder={
                    <ListEntryAddField
                      id="stock-material-new-unit"
                      path="/units"
                      concept={UNIT_LABEL}
                      addLabel={ADD_UNIT_LABEL}
                      placeholder="ชื่อหน่วยนับใหม่ เช่น รีม"
                      csrfToken={csrfToken}
                      disabled={isLocked || csrfToken === null}
                      onAdded={async (unit) => {
                        await units.refetch();
                        setUnitSet((current) =>
                          current.base_unit_id === ''
                            ? withBaseUnit(current, unit.id, null)
                            : current.base_unit_id === unit.id || current.alternates.some((row) => row.unit_id === unit.id)
                              ? current
                              : { ...current, alternates: [...current.alternates, newAlternateRow(unit.id)] }
                        );
                      }}
                    />
                  }
                />
                <MinimumStockField id="stock-material-minimum-stock" value={minimumStock} onChange={setMinimumStock} baseName={unitNameOf(unitList, unitSet.base_unit_id)} />
              </fieldset>
            )}
          </LoanSaveForm>
        )}
      </div>
    </main>
  );
};

/**
 * "เพิ่มวัสดุ" (F008-T1, T3, T4, T6): creates a Stock Material with its Base Unit and Alternate Units, its Brand, its
 * Material Category and its Minimum Stock, adding a missing Unit, Brand or Material Category straight from the form.
 */
export const StockMaterialCreate: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <StockMaterialCreateContent />
    </QueryClientProvider>
  );
};
