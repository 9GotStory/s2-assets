import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { thaiDate } from '../components/assignmentFacts';
import { fieldInputStyle } from '../components/ReferenceContextFields';
import {
  ADD_OPENING_BALANCE_LABEL,
  AS_OF_DATE_LABEL,
  OPENING_BALANCE_LABEL,
  OPENING_BALANCE_NUMBER_LABEL,
  OPENING_BALANCE_SOURCE_LABEL,
  OPENING_BALANCE_STATE_LABELS,
  type OpeningBalanceList as BalanceList,
} from '../components/openingBalanceFacts';

const PAGE_SIZE = 25;

// #233 start decision 4: ทั้งหมด by default, ร่าง or ยืนยันแล้ว.
const STATE_FILTERS = [
  { value: 'all', label: 'ทั้งหมด' },
  { value: 'draft', label: OPENING_BALANCE_STATE_LABELS.DRAFT },
  { value: 'confirmed', label: OPENING_BALANCE_STATE_LABELS.CONFIRMED },
  // F010-T7 (#238)
  { value: 'voided', label: OPENING_BALANCE_STATE_LABELS.VOIDED },
];

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึง${OPENING_BALANCE_LABEL} (403 Forbidden)`,
};

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const pageButtonStyle: React.CSSProperties = { padding: '0.375rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' };

const OpeningBalanceListContent: React.FC = () => {
  const navigate = useNavigate();
  // The search, the state and the page live in the URL, so a reload or a link keeps them.
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const state = STATE_FILTERS.some((filter) => filter.value === params.get('state')) ? params.get('state')! : 'all';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [searchInput, setSearchInput] = useState(search);

  const balances = useQuery<BalanceList, Error & { status?: number }>({
    queryKey: ['opening-balances', search, state, offset],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), state });
      if (search.trim() !== '') {
        query.set('search', search.trim());
      }
      const res = await fetch(`/opening-balances?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = balances.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const list = balances.isError ? undefined : balances.data;
  const isForbidden = balances.error?.status === 403;

  const goTo = (next: { search?: string; state?: string; offset?: number }) => {
    const query = new URLSearchParams();
    const nextSearch = (next.search ?? search).trim();
    if (nextSearch !== '') {
      query.set('search', nextSearch);
    }
    const nextState = next.state ?? state;
    if (nextState !== 'all') {
      query.set('state', nextState);
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
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{OPENING_BALANCE_LABEL}</h1>

        {balances.isError && !isSignedOut && (
          <div role="alert" id="opening-balance-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[balances.error.status ?? 0] ?? `เกิดข้อผิดพลาดในการโหลด${OPENING_BALANCE_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="opening-balance-list-retry" onClick={() => balances.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {balances.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด{OPENING_BALANCE_LABEL}...
          </div>
        )}

        {list && (
          <>
            {list.can_manage && (
              <Link
                to="/opening-balances/new"
                id="opening-balance-add-action"
                style={{ display: 'inline-block', padding: '0.5rem 1.25rem', marginBottom: '1.5rem', backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}
              >
                {ADD_OPENING_BALANCE_LABEL}
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
              <label htmlFor="opening-balance-search" style={{ position: 'absolute', left: '-9999px' }}>
                ค้นหา{OPENING_BALANCE_LABEL}
              </label>
              <input
                id="opening-balance-search"
                type="search"
                value={searchInput}
                maxLength={500}
                placeholder={`ค้นหาจาก${OPENING_BALANCE_NUMBER_LABEL} ${OPENING_BALANCE_SOURCE_LABEL} หรือชื่อวัสดุ`}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{ ...fieldInputStyle, flex: '1 1 16rem', width: 'auto' }}
              />
              <button type="submit" id="opening-balance-search-submit" style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                ค้นหา
              </button>
              <label htmlFor="opening-balance-state-filter" style={{ alignSelf: 'center', fontSize: '0.875rem', color: '#374151' }}>
                สถานะ
              </label>
              <select
                id="opening-balance-state-filter"
                value={state}
                onChange={(e) => goTo({ state: e.target.value, offset: 0 })}
                style={{ ...fieldInputStyle, width: 'auto', flex: '0 1 10rem' }}
              >
                {STATE_FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </select>
            </form>

            <section aria-label={OPENING_BALANCE_LABEL} id="opening-balance-list-region">
              {list.items.length === 0 ? (
                <div
                  id="opening-balance-list-empty"
                  style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                >
                  {search.trim() === '' && state === 'all' ? `ยังไม่มี${OPENING_BALANCE_LABEL}` : `ไม่พบ${OPENING_BALANCE_LABEL}ที่ค้นหา`}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table id="opening-balance-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                        <th style={headStyle}>{OPENING_BALANCE_NUMBER_LABEL}</th>
                        <th style={headStyle}>{AS_OF_DATE_LABEL}</th>
                        <th style={headStyle}>{OPENING_BALANCE_SOURCE_LABEL}</th>
                        <th style={headStyle}>สถานะ</th>
                        <th style={headStyle}>จำนวนรายการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((balance) => (
                        <tr key={balance.id} data-testid={`opening-balance-row-${balance.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ ...cellStyle, fontWeight: 500 }}>
                            <Link to={`/opening-balances/${balance.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {balance.opening_balance_number ?? OPENING_BALANCE_STATE_LABELS.DRAFT}
                            </Link>
                          </td>
                          <td style={cellStyle}>{balance.as_of_date === null ? '-' : thaiDate(balance.as_of_date)}</td>
                          <td style={{ ...cellStyle, whiteSpace: 'pre-line' }}>{balance.source ?? '-'}</td>
                          <td style={cellStyle}>{OPENING_BALANCE_STATE_LABELS[balance.state]}</td>
                          <td style={cellStyle}>{balance.line_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list.total_count > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', fontSize: '0.875rem', color: '#4b5563' }}>
                  <span id="opening-balance-list-count">
                    รายการที่ {list.offset + 1}–{list.offset + list.items.length} จาก {list.total_count}
                  </span>
                  <button type="button" id="opening-balance-list-previous" disabled={offset === 0} onClick={() => goTo({ offset: Math.max(0, offset - PAGE_SIZE) })} style={pageButtonStyle}>
                    ก่อนหน้า
                  </button>
                  <button type="button" id="opening-balance-list-next" disabled={!list.has_more} onClick={() => goTo({ offset: offset + PAGE_SIZE })} style={pageButtonStyle}>
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
 * F010-T2 (#233): "ยอดตั้งต้น", the Opening Balances newest first with their number, As-of Date, source, state and line
 * count, found by state and by text; "เพิ่มยอดตั้งต้น" for a Supply Officer (#231 Q24; #233 start decision 4).
 */
export const OpeningBalanceList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <OpeningBalanceListContent />
    </QueryClientProvider>
  );
};
