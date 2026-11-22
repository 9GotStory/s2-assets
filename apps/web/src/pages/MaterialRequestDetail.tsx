import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { REQUESTABLE_MATERIAL_LABEL } from '../components/requestableMaterialFacts';
import {
  MATERIAL_REQUEST_HISTORY_KIND_LABELS,
  MATERIAL_REQUEST_LABEL,
  MATERIAL_REQUEST_STATE_LABELS,
  MY_MATERIAL_REQUESTS_LABEL,
  REQUEST_NUMBER_LABEL,
  REQUESTED_ITEM_LABEL,
  REQUESTED_QUANTITY_LABEL,
  REQUESTER_LABEL,
  requestNumberLine,
  type MaterialRequestDetail as RequestDetail,
} from '../components/materialRequestFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// Another person's Material Request answers 404, as if it did not exist (#202 P5).
const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึงข้อมูล${MATERIAL_REQUEST_LABEL} (403 Forbidden)`,
  404: `ไม่พบ${MATERIAL_REQUEST_LABEL}ที่ระบุ (404 Not Found)`,
  400: `ไม่พบ${MATERIAL_REQUEST_LABEL}ที่ระบุ`,
};

const sectionHeadingStyle: React.CSSProperties = { fontSize: '1.125rem', fontWeight: 600, color: '#374151', margin: '1.5rem 0 0.75rem 0' };
const termStyle: React.CSSProperties = { fontWeight: 500, color: '#4b5563' };
const headStyle: React.CSSProperties = { textAlign: 'left', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', color: '#4b5563', borderBottom: '1px solid #e5e7eb' };
const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: '#111827', verticalAlign: 'top' };

const MaterialRequestDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();

  const request = useQuery<RequestDetail, Error & { status?: number }>({
    queryKey: ['material-request', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/material-requests/${encodeURIComponent(id)}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = request.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const detail = request.isError ? undefined : request.data;
  const isForbidden = request.error?.status === 403 || request.error?.status === 404 || request.error?.status === 400;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/my-material-requests" id="back-material-request-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่{MY_MATERIAL_REQUESTS_LABEL}
        </Link>

        {request.isError && (
          <div role="alert" id="material-request-error" style={{ padding: '0.75rem 1rem', margin: '1rem 0', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[Number(request.error.status)] ?? `เกิดข้อผิดพลาดในการโหลดข้อมูล${MATERIAL_REQUEST_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="material-request-retry" onClick={() => request.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {request.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดข้อมูล{MATERIAL_REQUEST_LABEL}...
          </div>
        )}

        {detail && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', margin: '1rem 0 1.5rem 0' }}>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: 0 }}>
                {MATERIAL_REQUEST_LABEL} {requestNumberLine(detail.request_number)}
              </h1>
              {/* The state beside the heading, not inside it, so the heading keeps its name (#204 lesson). */}
              <span id="material-request-state" style={{ padding: '0.125rem 0.5rem', backgroundColor: '#dbeafe', color: '#1f2937', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600 }}>
                {MATERIAL_REQUEST_STATE_LABELS[detail.state]}
              </span>
            </div>

            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem', margin: 0, fontSize: '0.875rem' }}>
              <dt style={termStyle}>{REQUEST_NUMBER_LABEL}</dt>
              <dd id="material-request-number" style={{ margin: 0 }}>
                {detail.request_number}
              </dd>
              <dt style={termStyle}>วันที่</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={detail.recorded_at}>{THAI_DATE_TIME.format(new Date(detail.recorded_at))}</time>
              </dd>
              <dt style={termStyle}>{REQUESTER_LABEL}</dt>
              <dd style={{ margin: 0 }}>{detail.requested_by_username}</dd>
              <dt style={termStyle}>หมายเหตุ</dt>
              <dd id="material-request-note" style={{ margin: 0, whiteSpace: 'pre-line' }}>
                {detail.note ?? '-'}
              </dd>
            </dl>

            <h2 style={sectionHeadingStyle}>{REQUESTED_ITEM_LABEL}</h2>
            <div style={{ overflowX: 'auto' }}>
              <table id="material-request-items" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={headStyle}>ที่</th>
                    <th style={headStyle}>{REQUESTABLE_MATERIAL_LABEL}</th>
                    <th style={headStyle}>{REQUESTED_QUANTITY_LABEL}</th>
                    <th style={headStyle}>หมายเหตุ</th>
                    <th style={headStyle}>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.requested_items.map((item) => (
                    <tr key={item.id} data-testid={`requested-item-${item.position}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <td style={cellStyle}>{item.position + 1}</td>
                      <td style={cellStyle}>{item.requestable_material_name}</td>
                      <td style={cellStyle}>
                        {item.requested_quantity} {item.request_unit.name}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: 'pre-line' }}>{item.note ?? '-'}</td>
                      {/* Who Cancelled it, when and why are T5's to show (#202 P4). */}
                      <td style={cellStyle}>{MATERIAL_REQUEST_STATE_LABELS[item.state]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 style={sectionHeadingStyle}>ประวัติ</h2>
            <ol id="material-request-history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {detail.history.map((entry) => (
                <li key={entry.version} data-testid={`material-request-history-${entry.version}`} style={{ borderLeft: '3px solid #d1d5db', padding: '0.25rem 0 0.75rem 0.75rem', marginBottom: '0.5rem' }}>
                  <div style={{ fontWeight: 600, color: '#111827' }}>{MATERIAL_REQUEST_HISTORY_KIND_LABELS[entry.kind]}</div>
                  <div style={{ fontSize: '0.8125rem', color: '#6b7280' }}>
                    บันทึกเมื่อ <time dateTime={entry.recorded_at}>{THAI_DATE_TIME.format(new Date(entry.recorded_at))}</time> โดย {entry.recorded_by_username}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </main>
  );
};

/**
 * A Material Request's page (F009-T4): its Request Number, date, note, each Requested Item with its Requestable Material,
 * Requested Quantity, Request Unit as recorded, note and state, and its history; there is no edit (#202 MRQ-04, Q11, Q19).
 */
export const MaterialRequestDetail: React.FC = () => {
  const { id = '' } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialRequestDetailContent id={id} />
    </QueryClientProvider>
  );
};
