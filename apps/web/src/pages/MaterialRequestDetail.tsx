import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useCsrfToken } from '../components/materialQueries';
import { MaterialRequestCancelForm, RequestedItemCancelForm } from '../components/MaterialRequestCancelForms';
import { REQUESTABLE_MATERIAL_LABEL } from '../components/requestableMaterialFacts';
import {
  CANCEL_LABEL,
  CANCEL_MATERIAL_REQUEST_LABEL,
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
  type MaterialRequestHistoryEntry,
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
const factStyle: React.CSSProperties = { fontSize: '0.8125rem', color: '#6b7280', marginTop: '0.25rem', whiteSpace: 'pre-line' };
const actionStyle: React.CSSProperties = { padding: '0.375rem 0.75rem', backgroundColor: '#ffffff', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: '6px', fontSize: '0.8125rem', fontWeight: 500, cursor: 'pointer' };

// Which Cancel form is open: one Requested Item's, or the whole Material Request's.
type CancelAction = { kind: 'requested-item'; requestedItemId: string } | { kind: 'material-request' };

// A history entry: its kind, the Requested Items a Cancel named under their names now, its note, and who recorded it
// when (#202 P4).
const HistoryEntry: React.FC<{ entry: MaterialRequestHistoryEntry; detail: RequestDetail }> = ({ entry, detail }) => (
  <li data-testid={`material-request-history-${entry.version}`} style={{ borderLeft: '3px solid #d1d5db', padding: '0.25rem 0 0.75rem 0.75rem', marginBottom: '0.5rem' }}>
    <div style={{ fontWeight: 600, color: '#111827' }}>{MATERIAL_REQUEST_HISTORY_KIND_LABELS[entry.kind]}</div>
    {entry.requested_item_ids !== null && (
      <div style={{ fontSize: '0.875rem', color: '#374151' }}>
        {REQUESTED_ITEM_LABEL}:{' '}
        {entry.requested_item_ids.map((itemId) => detail.requested_items.find((requested) => requested.id === itemId)!.requestable_material_name).join(', ')}
      </div>
    )}
    {entry.note !== null && <div style={{ fontSize: '0.875rem', color: '#374151', whiteSpace: 'pre-line' }}>หมายเหตุ: {entry.note}</div>}
    <div style={{ fontSize: '0.8125rem', color: '#6b7280' }}>
      บันทึกเมื่อ <time dateTime={entry.recorded_at}>{THAI_DATE_TIME.format(new Date(entry.recorded_at))}</time> โดย {entry.recorded_by_username}
    </div>
  </li>
);

const MaterialRequestDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  const [cancelAction, setCancelAction] = useState<CancelAction | null>(null);

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
  // Each Cancel waits for the token: a request sent without it is refused as if the grant were gone (#135). The page
  // offers a Cancel from `can_cancel` alone (P9), so the token is read for every viewer.
  const session = useCsrfToken(true);
  const csrfToken = session.data ?? null;
  // The open form's target while it can still be Cancelled: a read after a stale save closes the form otherwise.
  const cancelling = cancelAction?.kind === 'requested-item' ? detail?.requested_items.find((requested) => requested.id === cancelAction.requestedItemId && requested.can_cancel) : undefined;
  const cancellingAll = cancelAction?.kind === 'material-request' && detail?.can_cancel === true;
  // The actions show while no Cancel form is open.
  const offersCancel = csrfToken !== null && cancelling === undefined && !cancellingAll;
  const formHandlers = {
    onRefresh: async () => (await request.refetch()).isSuccess,
    onSaved: async () => {
      await request.refetch();
      setCancelAction(null);
    },
    onCancel: () => setCancelAction(null),
    onPermissionRevoked: () => void request.refetch(),
  };

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
                      {/* The state, who Cancelled it, when and why (#202 P4), and its Cancel. */}
                      <td style={cellStyle}>
                        <div>{MATERIAL_REQUEST_STATE_LABELS[item.state]}</div>
                        {item.cancelled_at !== null && (
                          <div data-testid={`requested-item-cancelled-${item.position}`} style={factStyle}>
                            โดย {item.cancelled_by_username} เมื่อ <time dateTime={item.cancelled_at}>{THAI_DATE_TIME.format(new Date(item.cancelled_at))}</time>
                            {item.cancel_note !== null && `\nหมายเหตุ: ${item.cancel_note}`}
                          </div>
                        )}
                        {offersCancel && item.can_cancel && (
                          <button
                            type="button"
                            data-testid={`requested-item-cancel-${item.position}`}
                            aria-label={`${CANCEL_LABEL} ${item.requestable_material_name}`}
                            onClick={() => setCancelAction({ kind: 'requested-item', requestedItemId: item.id })}
                            style={{ ...actionStyle, marginTop: '0.375rem' }}
                          >
                            {CANCEL_LABEL}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {offersCancel && detail.can_cancel && (
              <button type="button" id="material-request-cancel-action" onClick={() => setCancelAction({ kind: 'material-request' })} style={{ ...actionStyle, marginTop: '0.75rem' }}>
                {CANCEL_MATERIAL_REQUEST_LABEL}
              </button>
            )}
            {/* A new read starts a form again from what it shows, so a Cancel never carries a version read before it. */}
            {csrfToken !== null && cancelling && (
              <div style={{ marginTop: '1rem' }}>
                <RequestedItemCancelForm key={detail.version} materialRequest={detail} requestedItem={cancelling} csrfToken={csrfToken} {...formHandlers} />
              </div>
            )}
            {csrfToken !== null && cancellingAll && (
              <div style={{ marginTop: '1rem' }}>
                <MaterialRequestCancelForm key={detail.version} materialRequest={detail} csrfToken={csrfToken} {...formHandlers} />
              </div>
            )}

            <h2 style={sectionHeadingStyle}>ประวัติ</h2>
            <ol id="material-request-history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {detail.history.map((entry) => (
                <HistoryEntry key={entry.version} entry={entry} detail={detail} />
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
 * F009-T5 (#207): "ยกเลิก" on each Pending Requested Item and "ยกเลิกคำขอเบิก" on the whole, each with an optional note,
 * and who Cancelled each Requested Item, when and why (MRQ-19, Q12, P4).
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
