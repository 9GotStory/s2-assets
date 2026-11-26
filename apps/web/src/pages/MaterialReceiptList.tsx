import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { thaiDate } from '../components/assignmentFacts';
import { FiscalYearSelect } from '../components/FiscalYearSelect';
import { fieldInputStyle } from '../components/ReferenceContextFields';
import { MATERIAL_RECEIPT_LABEL, SOURCE_PARTY_LABEL, STOCK_MATERIAL_LABEL } from '../components/materialFacts';
import {
  ADD_MATERIAL_RECEIPT_LABEL,
  MATERIAL_RECEIPT_STATE_LABELS,
  RECEIPT_NUMBER_LABEL,
  RECEIPT_REFERENCE_LABEL,
  RECEIVED_DATE_LABEL,
  type MaterialReceiptList as ReceiptList,
} from '../components/materialReceiptFacts';
import { FISCAL_YEAR_LABEL } from '../components/verificationFacts';

const PAGE_SIZE = 25;

// #231 story 56: ทั้งหมด by default, ร่าง or รับแล้ว. F010-T4 (#235) adds the Fiscal Year filter.
const STATE_FILTERS = [
  { value: 'all', label: 'ทั้งหมด' },
  { value: 'draft', label: MATERIAL_RECEIPT_STATE_LABELS.DRAFT },
  { value: 'received', label: MATERIAL_RECEIPT_STATE_LABELS.RECEIVED },
  // F010-T7 (#238)
  { value: 'voided', label: MATERIAL_RECEIPT_STATE_LABELS.VOIDED },
];

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึง${MATERIAL_RECEIPT_LABEL} (403 Forbidden)`,
};

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const pageButtonStyle: React.CSSProperties = { padding: '0.375rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' };

const MaterialReceiptListContent: React.FC = () => {
  const navigate = useNavigate();
  // The search, the state, the Fiscal Year and the page live in the URL, so a reload or a link keeps them.
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const state = STATE_FILTERS.some((filter) => filter.value === params.get('state')) ? params.get('state')! : 'all';
  const fiscalYear = params.get('fiscal_year') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [searchInput, setSearchInput] = useState(search);

  const receipts = useQuery<ReceiptList, Error & { status?: number }>({
    queryKey: ['material-receipts', search, state, fiscalYear, offset],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), state });
      if (search.trim() !== '') {
        query.set('search', search.trim());
      }
      if (fiscalYear !== '') {
        query.set('fiscal_year', fiscalYear);
      }
      const res = await fetch(`/material-receipts?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = receipts.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const list = receipts.isError ? undefined : receipts.data;
  const isForbidden = receipts.error?.status === 403;

  const goTo = (next: { search?: string; state?: string; fiscalYear?: string; offset?: number }) => {
    const query = new URLSearchParams();
    const nextSearch = (next.search ?? search).trim();
    if (nextSearch !== '') {
      query.set('search', nextSearch);
    }
    const nextState = next.state ?? state;
    if (nextState !== 'all') {
      query.set('state', nextState);
    }
    const nextYear = next.fiscalYear ?? fiscalYear;
    if (nextYear !== '') {
      query.set('fiscal_year', nextYear);
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
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{MATERIAL_RECEIPT_LABEL}</h1>

        {receipts.isError && !isSignedOut && (
          <div role="alert" id="material-receipt-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[receipts.error.status ?? 0] ?? `เกิดข้อผิดพลาดในการโหลด${MATERIAL_RECEIPT_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="material-receipt-list-retry" onClick={() => receipts.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {receipts.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด{MATERIAL_RECEIPT_LABEL}...
          </div>
        )}

        {list && (
          <>
            {list.can_manage && (
              <Link
                to="/material-receipts/new"
                id="material-receipt-add-action"
                style={{ display: 'inline-block', padding: '0.5rem 1.25rem', marginBottom: '1.5rem', backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}
              >
                {ADD_MATERIAL_RECEIPT_LABEL}
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
              <label htmlFor="material-receipt-search" style={{ position: 'absolute', left: '-9999px' }}>
                ค้นหา{MATERIAL_RECEIPT_LABEL}
              </label>
              <input
                id="material-receipt-search"
                type="search"
                value={searchInput}
                maxLength={500}
                placeholder={`ค้นหาจาก${RECEIPT_NUMBER_LABEL} ${RECEIPT_REFERENCE_LABEL} ${SOURCE_PARTY_LABEL} หรือชื่อ${STOCK_MATERIAL_LABEL}`}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{ ...fieldInputStyle, flex: '1 1 16rem', width: 'auto' }}
              />
              <button type="submit" id="material-receipt-search-submit" style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                ค้นหา
              </button>
              <label htmlFor="material-receipt-state-filter" style={{ alignSelf: 'center', fontSize: '0.875rem', color: '#374151' }}>
                สถานะ
              </label>
              <select
                id="material-receipt-state-filter"
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
              <FiscalYearSelect id="material-receipt-fiscal-year-filter" value={fiscalYear} offered={list.fiscal_years} onChange={(year) => goTo({ fiscalYear: year, offset: 0 })} />
            </form>

            <section aria-label={MATERIAL_RECEIPT_LABEL} id="material-receipt-list-region">
              {list.items.length === 0 ? (
                <div
                  id="material-receipt-list-empty"
                  style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                >
                  {search.trim() === '' && state === 'all' && fiscalYear === '' ? `ยังไม่มี${MATERIAL_RECEIPT_LABEL}` : `ไม่พบ${MATERIAL_RECEIPT_LABEL}ที่ค้นหา`}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table id="material-receipt-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                        <th style={headStyle}>{RECEIPT_NUMBER_LABEL}</th>
                        <th style={headStyle}>{RECEIVED_DATE_LABEL}</th>
                        <th style={headStyle}>{FISCAL_YEAR_LABEL}</th>
                        <th style={headStyle}>{SOURCE_PARTY_LABEL}</th>
                        <th style={headStyle}>สถานะ</th>
                        <th style={headStyle}>จำนวนรายการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((receipt) => (
                        <tr key={receipt.id} data-testid={`material-receipt-row-${receipt.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ ...cellStyle, fontWeight: 500 }}>
                            <Link to={`/material-receipts/${receipt.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {receipt.receipt_number ?? MATERIAL_RECEIPT_STATE_LABELS.DRAFT}
                            </Link>
                          </td>
                          <td style={cellStyle}>{receipt.received_date === null ? '-' : thaiDate(receipt.received_date)}</td>
                          <td style={cellStyle}>{receipt.fiscal_year ?? '-'}</td>
                          <td style={cellStyle}>{receipt.source_party?.name ?? '-'}</td>
                          <td style={cellStyle}>{MATERIAL_RECEIPT_STATE_LABELS[receipt.state]}</td>
                          <td style={cellStyle}>{receipt.line_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list.total_count > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', fontSize: '0.875rem', color: '#4b5563' }}>
                  <span id="material-receipt-list-count">
                    รายการที่ {list.offset + 1}–{list.offset + list.items.length} จาก {list.total_count}
                  </span>
                  <button type="button" id="material-receipt-list-previous" disabled={offset === 0} onClick={() => goTo({ offset: Math.max(0, offset - PAGE_SIZE) })} style={pageButtonStyle}>
                    ก่อนหน้า
                  </button>
                  <button type="button" id="material-receipt-list-next" disabled={!list.has_more} onClick={() => goTo({ offset: offset + PAGE_SIZE })} style={pageButtonStyle}>
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
 * F010-T3 (#234): "รายการรับวัสดุ", the Material Receipts newest first with their Receipt Number, Received Date, Source
 * Party, state and line count, found by state and by text; "เพิ่มรายการรับวัสดุ" for a Supply Officer (#231 story 56,
 * Q24).
 */
export const MaterialReceiptList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialReceiptListContent />
    </QueryClientProvider>
  );
};
