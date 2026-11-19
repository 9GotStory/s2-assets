import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fieldInputStyle } from '../components/ReferenceContextFields';
import { useMaterialCategoryList } from '../components/materialQueries';
import {
  ADD_STOCK_MATERIAL_LABEL,
  BASE_UNIT_LABEL,
  BRAND_LABEL,
  INACTIVE_LABEL,
  MATERIAL_CATEGORY_LABEL,
  MINIMUM_STOCK_LABEL,
  MODEL_LABEL,
  NO_MATERIAL_CATEGORY_LABEL,
  SPECIFICATION_LABEL,
  STOCK_MATERIAL_LABEL,
  minimumStockLine,
  type StockMaterialList as MaterialList,
} from '../components/materialFacts';

const PAGE_SIZE = 25;

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงรายการวัสดุ (403 Forbidden)',
};

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const pageButtonStyle: React.CSSProperties = { padding: '0.375rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' };

const StockMaterialListContent: React.FC = () => {
  const navigate = useNavigate();
  // The search, the filters and the page live in the URL, so a reload or a link keeps them.
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  // A Material Category's id, "none" for the Stock Materials with none, or empty for every one (F008-T4).
  const materialCategoryId = params.get('material_category_id') ?? '';
  // "set", "not_set", or empty for every one (F008-T6).
  const minimumStock = params.get('minimum_stock') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [searchInput, setSearchInput] = useState(search);

  const materials = useQuery<MaterialList, Error & { status?: number }>({
    queryKey: ['stock-materials', search, materialCategoryId, minimumStock, offset],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (search.trim() !== '') {
        query.set('search', search.trim());
      }
      if (materialCategoryId !== '') {
        query.set('material_category_id', materialCategoryId);
      }
      if (minimumStock !== '') {
        query.set('minimum_stock', minimumStock);
      }
      const res = await fetch(`/stock-materials?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = materials.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // The filter's options; an Inactive Material Category still groups the Stock Materials that have it (#175 Q21).
  const materialCategories = useMaterialCategoryList();

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const list = materials.isError ? undefined : materials.data;
  const isForbidden = materials.error?.status === 403;

  const goTo = (next: { search?: string; materialCategoryId?: string; minimumStock?: string; offset?: number }) => {
    const query = new URLSearchParams();
    const nextSearch = (next.search ?? search).trim();
    if (nextSearch !== '') {
      query.set('search', nextSearch);
    }
    const nextCategory = next.materialCategoryId ?? materialCategoryId;
    if (nextCategory !== '') {
      query.set('material_category_id', nextCategory);
    }
    const nextMinimumStock = next.minimumStock ?? minimumStock;
    if (nextMinimumStock !== '') {
      query.set('minimum_stock', nextMinimumStock);
    }
    if (next.offset) {
      query.set('offset', String(next.offset));
    }
    setParams(query);
  };

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/dashboard" id="back-dashboard-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่แดชบอร์ด
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{STOCK_MATERIAL_LABEL}</h1>

        {materials.isError && !isSignedOut && (
          <div role="alert" id="stock-material-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[materials.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดรายการวัสดุ'}{' '}
            {!isForbidden && (
              <button type="button" id="stock-material-list-retry" onClick={() => materials.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {materials.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดรายการวัสดุ...
          </div>
        )}

        {list && (
          <>
            {list.can_manage && (
              <Link
                to="/stock-materials/new"
                id="stock-material-add-action"
                style={{ display: 'inline-block', padding: '0.5rem 1.25rem', marginBottom: '1.5rem', backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}
              >
                {ADD_STOCK_MATERIAL_LABEL}
              </Link>
            )}

            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                goTo({ search: searchInput, offset: 0 });
              }}
              style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}
            >
              <label htmlFor="stock-material-search" style={{ position: 'absolute', left: '-9999px' }}>
                ค้นหาวัสดุ
              </label>
              <input
                id="stock-material-search"
                type="search"
                value={searchInput}
                maxLength={500}
                placeholder={`ค้นหาจากชื่อ ${BRAND_LABEL} ${MODEL_LABEL} หรือ${SPECIFICATION_LABEL}`}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{ ...fieldInputStyle, flex: '1 1 16rem', width: 'auto' }}
              />
              <button type="submit" id="stock-material-search-submit" style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                ค้นหา
              </button>
            </form>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <label htmlFor="stock-material-material-category-filter" style={{ fontSize: '0.875rem', color: '#374151' }}>
                {MATERIAL_CATEGORY_LABEL}
              </label>
              <select
                id="stock-material-material-category-filter"
                value={materialCategoryId}
                onChange={(e) => goTo({ materialCategoryId: e.target.value, offset: 0 })}
                style={{ ...fieldInputStyle, width: 'auto', flex: '0 1 16rem' }}
              >
                <option value="">ทั้งหมด</option>
                <option value="none">{NO_MATERIAL_CATEGORY_LABEL}</option>
                {(materialCategories.data?.items ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.is_active ? category.name : `${category.name} (${INACTIVE_LABEL})`}
                  </option>
                ))}
              </select>
              <label htmlFor="stock-material-minimum-stock-filter" style={{ fontSize: '0.875rem', color: '#374151' }}>
                {MINIMUM_STOCK_LABEL}
              </label>
              <select
                id="stock-material-minimum-stock-filter"
                value={minimumStock}
                onChange={(e) => goTo({ minimumStock: e.target.value, offset: 0 })}
                style={{ ...fieldInputStyle, width: 'auto', flex: '0 1 10rem' }}
              >
                <option value="">ทั้งหมด</option>
                <option value="set">ตั้งแล้ว</option>
                <option value="not_set">ยังไม่ตั้ง</option>
              </select>
            </div>

            <section aria-label={STOCK_MATERIAL_LABEL} id="stock-material-list-region">
              {list.items.length === 0 ? (
                <div
                  id="stock-material-list-empty"
                  style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                >
                  {search.trim() === '' && materialCategoryId === '' && minimumStock === '' ? 'ยังไม่มีวัสดุ' : 'ไม่พบวัสดุที่ค้นหา'}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table id="stock-material-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                        <th style={headStyle}>ชื่อวัสดุ</th>
                        <th style={headStyle}>{BRAND_LABEL}</th>
                        <th style={headStyle}>{MODEL_LABEL}</th>
                        <th style={headStyle}>{SPECIFICATION_LABEL}</th>
                        <th style={headStyle}>{MATERIAL_CATEGORY_LABEL}</th>
                        <th style={headStyle}>{BASE_UNIT_LABEL}</th>
                        <th style={headStyle}>{MINIMUM_STOCK_LABEL}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((material) => (
                        <tr key={material.id} data-testid={`stock-material-row-${material.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ ...cellStyle, fontWeight: 500 }}>
                            <Link to={`/stock-materials/${material.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {material.name}
                            </Link>
                          </td>
                          <td style={cellStyle}>{material.brand?.name ?? '-'}</td>
                          <td style={cellStyle}>{material.model ?? '-'}</td>
                          <td style={{ ...cellStyle, whiteSpace: 'pre-line' }}>{material.specification ?? '-'}</td>
                          <td style={cellStyle}>{material.material_category?.name ?? '-'}</td>
                          <td style={cellStyle}>{material.base_unit.name}</td>
                          <td style={cellStyle}>{minimumStockLine(material.minimum_stock, material.base_unit.name)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list.total_count > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', fontSize: '0.875rem', color: '#4b5563' }}>
                  <span id="stock-material-list-count">
                    รายการที่ {list.offset + 1}–{list.offset + list.items.length} จาก {list.total_count}
                  </span>
                  <button type="button" id="stock-material-list-previous" disabled={offset === 0} onClick={() => goTo({ offset: Math.max(0, offset - PAGE_SIZE) })} style={pageButtonStyle}>
                    ก่อนหน้า
                  </button>
                  <button type="button" id="stock-material-list-next" disabled={!list.has_more} onClick={() => goTo({ offset: offset + PAGE_SIZE })} style={pageButtonStyle}>
                    ถัดไป
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
};

/**
 * The Stock Material list ("วัสดุ", F008-T1, T4, T6): every Stock Material by name, searchable by name, Brand, Model and
 * Specification, filtered by Material Category and by whether a Minimum Stock is set, and "เพิ่มวัสดุ" for holders.
 */
export const StockMaterialList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <StockMaterialListContent />
    </QueryClientProvider>
  );
};
