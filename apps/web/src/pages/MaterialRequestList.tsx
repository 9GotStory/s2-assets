import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fieldInputStyle } from '../components/ReferenceContextFields';
import {
  CREATE_MATERIAL_REQUEST_LABEL,
  MATERIAL_REQUEST_LABEL,
  MATERIAL_REQUEST_STATE_LABELS,
  MY_MATERIAL_REQUESTS_LABEL,
  REQUEST_NUMBER_LABEL,
  REQUESTED_ITEM_LABEL,
  type MaterialRequestList as RequestList,
} from '../components/materialRequestFacts';

const PAGE_SIZE = 25;

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึง${MY_MATERIAL_REQUESTS_LABEL} (403 Forbidden)`,
};

// The state filter, every state by default (#202 Q19).
const STATE_FILTERS = [
  { value: 'all', label: 'ทั้งหมด' },
  { value: 'pending', label: MATERIAL_REQUEST_STATE_LABELS.PENDING },
  { value: 'cancelled', label: MATERIAL_REQUEST_STATE_LABELS.CANCELLED },
];

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const pageButtonStyle: React.CSSProperties = { padding: '0.375rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' };

const MaterialRequestListContent: React.FC = () => {
  const navigate = useNavigate();
  // The state and the page live in the URL, so a reload or a link keeps them.
  const [params, setParams] = useSearchParams();
  const state = STATE_FILTERS.some((filter) => filter.value === params.get('state')) ? params.get('state')! : 'all';
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  const requests = useQuery<RequestList, Error & { status?: number }>({
    queryKey: ['my-material-requests', state, offset],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), state });
      const res = await fetch(`/my-material-requests?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = requests.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const list = requests.isError ? undefined : requests.data;
  const isForbidden = requests.error?.status === 403;

  const goTo = (next: { state?: string; offset?: number }) => {
    const query = new URLSearchParams();
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
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{MY_MATERIAL_REQUESTS_LABEL}</h1>

        {requests.isError && (
          <div role="alert" id="material-request-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[Number(requests.error.status)] ?? `เกิดข้อผิดพลาดในการโหลด${MY_MATERIAL_REQUESTS_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="material-request-list-retry" onClick={() => requests.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {requests.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด{MY_MATERIAL_REQUESTS_LABEL}...
          </div>
        )}

        {list && (
          <>
            <Link
              to="/my-material-requests/new"
              id="material-request-create-action"
              style={{ display: 'inline-block', padding: '0.5rem 1.25rem', marginBottom: '1.5rem', backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}
            >
              {CREATE_MATERIAL_REQUEST_LABEL}
            </Link>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <label htmlFor="material-request-state-filter" style={{ fontSize: '0.875rem', color: '#374151' }}>
                สถานะ
              </label>
              <select
                id="material-request-state-filter"
                value={state}
                onChange={(e) => goTo({ state: e.target.value, offset: 0 })}
                style={{ ...fieldInputStyle, width: 'auto' }}
              >
                {STATE_FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </select>
            </div>

            <section aria-label={MY_MATERIAL_REQUESTS_LABEL} id="material-request-list-region">
              {list.items.length === 0 ? (
                <div
                  id="material-request-list-empty"
                  style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                >
                  {state === 'all' ? `ยังไม่มี${MATERIAL_REQUEST_LABEL}` : `ไม่มี${MATERIAL_REQUEST_LABEL}ในสถานะนี้`}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table id="material-request-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                        <th style={headStyle}>{REQUEST_NUMBER_LABEL}</th>
                        <th style={headStyle}>วันที่</th>
                        <th style={headStyle}>สถานะ</th>
                        <th style={headStyle}>{REQUESTED_ITEM_LABEL}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((request) => (
                        <tr key={request.id} data-testid={`material-request-row-${request.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ ...cellStyle, fontWeight: 500 }}>
                            <Link to={`/material-requests/${request.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {request.request_number}
                            </Link>
                          </td>
                          <td style={cellStyle}>
                            <time dateTime={request.recorded_at}>{THAI_DATE_TIME.format(new Date(request.recorded_at))}</time>
                          </td>
                          <td style={cellStyle}>{MATERIAL_REQUEST_STATE_LABELS[request.state]}</td>
                          <td style={cellStyle}>{request.requested_item_count} รายการ</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {list.total_count > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', fontSize: '0.875rem', color: '#4b5563' }}>
                  <span id="material-request-list-count">
                    รายการที่ {list.offset + 1}–{list.offset + list.items.length} จาก {list.total_count}
                  </span>
                  <button type="button" id="material-request-list-previous" disabled={offset === 0} onClick={() => goTo({ offset: Math.max(0, offset - PAGE_SIZE) })} style={pageButtonStyle}>
                    ก่อนหน้า
                  </button>
                  <button type="button" id="material-request-list-next" disabled={!list.has_more} onClick={() => goTo({ offset: offset + PAGE_SIZE })} style={pageButtonStyle}>
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
 * "คำขอของฉัน" (F009-T4): the Requester's own Material Requests, newest first, by state, each with its Request Number,
 * date, state and Requested Item count, and "สร้างคำขอเบิก" (#202 Q19).
 */
export const MaterialRequestList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialRequestListContent />
    </QueryClientProvider>
  );
};
