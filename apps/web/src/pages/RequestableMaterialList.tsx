import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fieldInputStyle } from '../components/ReferenceContextFields';
import { ACTIVE_LABEL, INACTIVE_LABEL, WHOLE_NUMBER_UNIT_LABEL, wholeNumberLine } from '../components/materialFacts';
import {
  ADD_REQUESTABLE_MATERIAL_LABEL,
  REQUEST_UNIT_LABEL,
  REQUESTABLE_MATERIAL_LABEL,
  type RequestableMaterialList as RequestableList,
  NO_COMPATIBLE_STOCK_MATERIAL_LABEL,
  isActiveWithoutCompatibleStockMaterial,
  noCompatibleBadgeStyle,
} from '../components/requestableMaterialFacts';

const PAGE_SIZE = 25;

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึงรายการ${REQUESTABLE_MATERIAL_LABEL} (403 Forbidden)`,
};

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const pageButtonStyle: React.CSSProperties = { padding: '0.375rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' };

const RequestableMaterialListContent: React.FC = () => {
  const navigate = useNavigate();
  // The search and the page live in the URL, so a reload or a link keeps them.
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [searchInput, setSearchInput] = useState(search);

  const requestables = useQuery<RequestableList, Error & { status?: number }>({
    queryKey: ['requestable-materials', search, offset],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (search.trim() !== '') {
        query.set('search', search.trim());
      }
      const res = await fetch(`/requestable-materials?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = requestables.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const list = requestables.isError ? undefined : requestables.data;
  const isForbidden = requestables.error?.status === 403;

  const goTo = (next: { search?: string; offset?: number }) => {
    const query = new URLSearchParams();
    const nextSearch = (next.search ?? search).trim();
    if (nextSearch !== '') {
      query.set('search', nextSearch);
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
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{REQUESTABLE_MATERIAL_LABEL}</h1>

        {requestables.isError && !isSignedOut && (
          <div role="alert" id="requestable-material-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[requestables.error.status ?? 0] ?? `เกิดข้อผิดพลาดในการโหลดรายการ${REQUESTABLE_MATERIAL_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="requestable-material-list-retry" onClick={() => requestables.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {requestables.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดรายการ{REQUESTABLE_MATERIAL_LABEL}...
          </div>
        )}

        {list && (
          <>
            {list.can_manage && (
              <Link
                to="/requestable-materials/new"
                id="requestable-material-add-action"
                style={{ display: 'inline-block', padding: '0.5rem 1.25rem', marginBottom: '1.5rem', backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}
              >
                {ADD_REQUESTABLE_MATERIAL_LABEL}
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
              <label htmlFor="requestable-material-search" style={{ position: 'absolute', left: '-9999px' }}>
                ค้นหา{REQUESTABLE_MATERIAL_LABEL}
              </label>
              <input
                id="requestable-material-search"
                type="search"
                value={searchInput}
                maxLength={200}
                placeholder="ค้นหาจากชื่อ"
                onChange={(e) => setSearchInput(e.target.value)}
                style={{ ...fieldInputStyle, flex: '1 1 16rem', width: 'auto' }}
              />
              <button type="submit" id="requestable-material-search-submit" style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                ค้นหา
              </button>
            </form>

            <section aria-label={REQUESTABLE_MATERIAL_LABEL} id="requestable-material-list-region">
              {list.items.length === 0 ? (
                <div
                  id="requestable-material-list-empty"
                  style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                >
                  {search.trim() === '' ? `ยังไม่มี${REQUESTABLE_MATERIAL_LABEL}` : `ไม่พบ${REQUESTABLE_MATERIAL_LABEL}ที่ค้นหา`}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table id="requestable-material-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                        <th style={headStyle}>ชื่อ</th>
                        <th style={headStyle}>{REQUEST_UNIT_LABEL}</th>
                        <th style={headStyle}>{WHOLE_NUMBER_UNIT_LABEL}</th>
                        <th style={headStyle}>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((requestable) => (
                        <tr key={requestable.id} data-testid={`requestable-material-row-${requestable.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ ...cellStyle, fontWeight: 500 }}>
                            <Link to={`/requestable-materials/${requestable.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {requestable.name}
                            </Link>
                            {isActiveWithoutCompatibleStockMaterial(requestable) && (
                              <span data-testid={`requestable-material-no-compatible-badge-${requestable.id}`} style={noCompatibleBadgeStyle}>
                                {NO_COMPATIBLE_STOCK_MATERIAL_LABEL}
                              </span>
                            )}
                          </td>
                          <td style={cellStyle}>{requestable.request_unit.name}</td>
                          <td style={cellStyle}>{wholeNumberLine(requestable.whole_number_only)}</td>
                          <td style={cellStyle}>{requestable.is_active ? ACTIVE_LABEL : INACTIVE_LABEL}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list.total_count > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', fontSize: '0.875rem', color: '#4b5563' }}>
                  <span id="requestable-material-list-count">
                    รายการที่ {list.offset + 1}–{list.offset + list.items.length} จาก {list.total_count}
                  </span>
                  <button type="button" id="requestable-material-list-previous" disabled={offset === 0} onClick={() => goTo({ offset: Math.max(0, offset - PAGE_SIZE) })} style={pageButtonStyle}>
                    ก่อนหน้า
                  </button>
                  <button type="button" id="requestable-material-list-next" disabled={!list.has_more} onClick={() => goTo({ offset: offset + PAGE_SIZE })} style={pageButtonStyle}>
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
 * "วัสดุสำหรับขอเบิก" (F009-T1): the Requestable Materials by name, searchable by name, each with its Request Unit and
 * status, and "เพิ่มวัสดุสำหรับขอเบิก" for holders of material:manage (#202 Q19, P9).
 */
export const RequestableMaterialList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <RequestableMaterialListContent />
    </QueryClientProvider>
  );
};
