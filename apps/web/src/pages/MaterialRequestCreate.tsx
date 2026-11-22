import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import { useCsrfToken } from '../components/materialQueries';
import { wholeNumberLine } from '../components/materialFacts';
import { REQUESTABLE_MATERIAL_LABEL } from '../components/requestableMaterialFacts';
import {
  CREATE_MATERIAL_REQUEST_LABEL,
  MATERIAL_REQUEST_LABEL,
  MY_MATERIAL_REQUESTS_LABEL,
  REQUESTED_ITEM_LABEL,
  REQUESTED_QUANTITY_LABEL,
  requestedItemAt,
  type OfferedRequestableMaterial,
  type OfferedRequestableMaterialList,
} from '../components/materialRequestFacts';

// #202 Q10, P7: at most 50 Requested Items; a note of at most 2000 characters, a Requested Item's of at most 500.
const MAX_REQUESTED_ITEMS = 50;
const CHOICES_PAGE_SIZE = 10;

// A row of the form: the Requestable Material chosen, the Requested Quantity as typed and its note.
interface RequestedRow {
  requestable: OfferedRequestableMaterial;
  quantity: string;
  note: string;
}

// What a refusal of a Requested Quantity says, by the end of the server's message.
const QUANTITY_REFUSALS: [string, string][] = [
  ['must be a whole number', `${REQUESTED_QUANTITY_LABEL}ต้องเป็นจำนวนเต็ม`],
  ['must be greater than 0', `${REQUESTED_QUANTITY_LABEL}ต้องมากกว่า 0`],
  ['must have at most four decimal places', `${REQUESTED_QUANTITY_LABEL}มีทศนิยมได้ไม่เกิน 4 ตำแหน่ง`],
  ['must be a decimal number', `${REQUESTED_QUANTITY_LABEL}ต้องเป็นตัวเลข`],
  ['is too large', `${REQUESTED_QUANTITY_LABEL}มากเกินไป`],
];

// A refusal that names a Requested Item, in the words of the form, or null for any other.
const refusedRequestedItem = (body: { code?: string; message?: string; position?: number } | null): React.ReactNode => {
  if (body?.code === 'NOT_OFFERED' && typeof body.position === 'number') {
    return <span data-testid="material-request-refused-item">{`${requestedItemAt(body.position)}: ${REQUESTABLE_MATERIAL_LABEL}นี้ไม่เปิดให้ขอเบิกแล้ว`}</span>;
  }
  const named = /^requested_items\[(\d+)\]\.(\w+) (.*)$/.exec(body?.message ?? '');
  if (body?.code !== 'VALIDATION_FAILED' || named === null) {
    return null;
  }
  const [, position, field, reason] = named;
  const quantityRefusal = field === 'requested_quantity' ? QUANTITY_REFUSALS.find(([start]) => reason.startsWith(start)) : undefined;
  return <span data-testid="material-request-refused-item">{`${requestedItemAt(Number(position))}: ${quantityRefusal ? quantityRefusal[1] : body.message}`}</span>;
};

const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { textAlign: 'left', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', color: '#4b5563', borderBottom: '1px solid #e5e7eb' };

const MaterialRequestCreateContent: React.FC = () => {
  const navigate = useNavigate();
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<RequestedRow[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // The offered search answers with material-request:create, which creating a Material Request needs too: its first
  // page tells the page whether to show the form, apart from the search the Requester types (#202 P9).
  const readOffered = async (query: URLSearchParams, signal: AbortSignal): Promise<OfferedRequestableMaterialList> => {
    const res = await fetch(`/offered-requestable-materials?${query}`, { credentials: 'include', signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  const grant = useQuery<OfferedRequestableMaterialList, Error & { status?: number }>({
    queryKey: ['material-request-grant'],
    queryFn: ({ signal }) => readOffered(new URLSearchParams({ limit: '1' }), signal),
  });
  const choices = useQuery<OfferedRequestableMaterialList, Error & { status?: number }>({
    queryKey: ['offered-requestable-materials', search],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ limit: String(CHOICES_PAGE_SIZE) });
      if (search.trim() !== '') {
        query.set('search', search.trim());
      }
      return readOffered(query, signal);
    },
    enabled: grant.isSuccess,
  });
  // A failed read of the grant hides the form: a lost grant fails closed.
  const mayAsk = grant.isSuccess && !grant.isError;
  const session = useCsrfToken(mayAsk);
  // The form waits for the token: a request sent without it is refused as if the grant were gone (#135).
  const csrfToken = session.data ?? null;
  const mayCreate = mayAsk && csrfToken !== null;

  const isSignedOut = grant.error?.status === 401 || choices.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  const isChosen = (id: string) => rows.some((row) => row.requestable.id === id);
  const choose = (requestable: OfferedRequestableMaterial) => setRows((current) => [...current, { requestable, quantity: '', note: '' }]);
  const change = (index: number, next: Partial<RequestedRow>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...next } : row)));
  const remove = (index: number) => setRows((current) => current.filter((_, i) => i !== index));

  const requestError = (): string | null => {
    if (rows.length === 0) {
      return `กรุณาเลือก${REQUESTABLE_MATERIAL_LABEL}อย่างน้อย 1 รายการ`;
    }
    const blank = rows.findIndex((row) => row.quantity.trim() === '');
    return blank === -1 ? null : `${requestedItemAt(blank)}: กรุณากรอก${REQUESTED_QUANTITY_LABEL}`;
  };

  const requestBody = () => ({
    note: note.trim() || null,
    requested_items: rows.map((row) => ({ requestable_material_id: row.requestable.id, requested_quantity: row.quantity.trim(), note: row.note.trim() || null })),
  });

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/my-material-requests" id="back-material-request-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่{MY_MATERIAL_REQUESTS_LABEL}
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{CREATE_MATERIAL_REQUEST_LABEL}</h1>

        {grant.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด...
          </div>
        )}
        {grant.isError && !isSignedOut && (
          <div role="alert" id="material-request-create-forbidden" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {grant.error.status && grant.error.status !== 403 ? `เกิดข้อผิดพลาดในการโหลดรายการ${REQUESTABLE_MATERIAL_LABEL}` : `คุณไม่มีสิทธิ์${CREATE_MATERIAL_REQUEST_LABEL}`}
          </div>
        )}

        {mayCreate && (
          <LoanSaveForm
            idPrefix="material-request"
            heading={`ข้อมูล${MATERIAL_REQUEST_LABEL}`}
            saveUrl="/material-requests"
            csrfToken={csrfToken}
            requestError={requestError}
            requestBody={requestBody}
            refusedList={refusedRequestedItem}
            forbiddenMessage={`คุณไม่มีสิทธิ์${CREATE_MATERIAL_REQUEST_LABEL}`}
            refusedMessage={`ไม่สามารถ${CREATE_MATERIAL_REQUEST_LABEL}ได้`}
            onSaved={async (body) => {
              navigate(`/material-requests/${body.material_request_id}`);
            }}
            onCancel={() => navigate('/my-material-requests')}
            onPermissionRevoked={(status) => {
              if (status === 401) {
                navigate('/login', { replace: true });
                return;
              }
              void grant.refetch();
            }}
          >
            {(isLocked) => (
              <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                <section aria-label={`ค้นหา${REQUESTABLE_MATERIAL_LABEL}`} style={{ marginBottom: '1rem' }}>
                  <label htmlFor="material-request-search" style={fieldLabelStyle}>
                    ค้นหา{REQUESTABLE_MATERIAL_LABEL}
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <input
                      id="material-request-search"
                      type="search"
                      value={searchInput}
                      maxLength={200}
                      placeholder="ค้นหาจากชื่อ"
                      onChange={(e) => setSearchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          setSearch(searchInput);
                        }
                      }}
                      style={{ ...fieldInputStyle, flex: '1 1 16rem', width: 'auto' }}
                    />
                    <button type="button" id="material-request-search-submit" onClick={() => setSearch(searchInput)} style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                      ค้นหา
                    </button>
                  </div>
                  {choices.isError && (
                    <p role="alert" id="material-request-choices-error" style={{ fontSize: '0.875rem', color: '#991b1b' }}>
                      ค้นหา{REQUESTABLE_MATERIAL_LABEL}ไม่สำเร็จ กรุณาตรวจคำค้นแล้วลองใหม่
                    </p>
                  )}
                  {choices.data && choices.data.items.length === 0 && (
                    <p id="material-request-choices-empty" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                      ไม่พบ{REQUESTABLE_MATERIAL_LABEL}ที่เปิดให้ขอเบิก
                    </p>
                  )}
                  <ul id="material-request-choices" style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0 0' }}>
                    {choices.data?.items.map((requestable) => (
                      <li key={requestable.id} data-testid={`material-request-choice-${requestable.id}`} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.375rem 0', borderBottom: '1px solid #f3f4f6' }}>
                        <span style={{ flex: 1, fontSize: '0.875rem' }}>
                          <span style={{ fontWeight: 500 }}>{requestable.name}</span> ({requestable.request_unit.name})
                          {requestable.description && <span style={{ display: 'block', color: '#6b7280', whiteSpace: 'pre-line' }}>{requestable.description}</span>}
                        </span>
                        <button
                          type="button"
                          aria-label={`เลือก ${requestable.name}`}
                          disabled={isChosen(requestable.id) || rows.length >= MAX_REQUESTED_ITEMS}
                          onClick={() => choose(requestable)}
                          style={{ padding: '0.25rem 0.75rem', borderRadius: '4px', border: '1px solid #d1d5db', backgroundColor: '#ffffff', fontSize: '0.8125rem' }}
                        >
                          {isChosen(requestable.id) ? 'เลือกแล้ว' : 'เลือก'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>

                <h4 style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#374151', margin: '0 0 0.5rem 0' }}>
                  {REQUESTED_ITEM_LABEL} ({rows.length}/{MAX_REQUESTED_ITEMS})
                </h4>
                {rows.length === 0 ? (
                  <p id="material-request-rows-empty" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                    ยังไม่ได้เลือก{REQUESTABLE_MATERIAL_LABEL}
                  </p>
                ) : (
                  <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
                    <table id="material-request-rows" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={headStyle}>ที่</th>
                          <th style={headStyle}>{REQUESTABLE_MATERIAL_LABEL}</th>
                          <th style={headStyle}>{REQUESTED_QUANTITY_LABEL}</th>
                          <th style={headStyle}>หมายเหตุ (ไม่บังคับ)</th>
                          <th style={headStyle} />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={row.requestable.id} data-testid={`material-request-row-${index}`}>
                            <td style={cellStyle}>{index + 1}</td>
                            <td style={cellStyle}>
                              {row.requestable.name}
                              <span style={{ display: 'block', fontSize: '0.75rem', color: '#6b7280' }}>{wholeNumberLine(row.requestable.whole_number_only)}</span>
                            </td>
                            <td style={cellStyle}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                                <input
                                  aria-label={`${REQUESTED_QUANTITY_LABEL} ${row.requestable.name}`}
                                  type="text"
                                  inputMode="decimal"
                                  value={row.quantity}
                                  onChange={(e) => change(index, { quantity: e.target.value })}
                                  style={{ ...fieldInputStyle, width: '7rem' }}
                                />
                                <span>{row.requestable.request_unit.name}</span>
                              </span>
                            </td>
                            <td style={cellStyle}>
                              <input
                                aria-label={`หมายเหตุ ${row.requestable.name}`}
                                type="text"
                                value={row.note}
                                maxLength={500}
                                onChange={(e) => change(index, { note: e.target.value })}
                                style={fieldInputStyle}
                              />
                            </td>
                            <td style={cellStyle}>
                              <button type="button" aria-label={`นำ ${row.requestable.name} ออก`} onClick={() => remove(index)} style={{ padding: '0.25rem 0.75rem', borderRadius: '4px', border: '1px solid #d1d5db', backgroundColor: '#ffffff', fontSize: '0.8125rem' }}>
                                นำออก
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div>
                  <label htmlFor="material-request-note" style={fieldLabelStyle}>
                    หมายเหตุ{MATERIAL_REQUEST_LABEL} (ไม่บังคับ)
                  </label>
                  <textarea id="material-request-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
                </div>
              </fieldset>
            )}
          </LoanSaveForm>
        )}
      </div>
    </main>
  );
};

/**
 * "สร้างคำขอเบิก" (F009-T4): the Requester picks offered Requestable Materials, enters each Requested Quantity in the
 * Request Unit shown beside it with an optional note, and saves one Material Request (#202 MRQ-16, MRQ-28, Q10, Q19).
 */
export const MaterialRequestCreate: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialRequestCreateContent />
    </QueryClientProvider>
  );
};
